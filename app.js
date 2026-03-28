/**
 * WebRTC via WebSocket signaling; session key in URL.
 * Audio-only by default; camera added/removed dynamically via renegotiation
 * over the same WebSocket and PeerConnection.
 */

import { createPeerConnection as createPcBase, ICE_SERVERS } from "./js/peerConnection.js";

const DISPLAY_NAME_KEY = "vcall.displayName";
const SIG_CONNECT_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// i18n — detect browser language, fall back to English
// ---------------------------------------------------------------------------

const TRANSLATIONS = {
  en: {
    // Lobby
    namePlaceholder:   "Your name",
    startSession:      "Start a session",
    joinSession:       "Join a session",
    cancelJoin:        "Cancel",
    sessionCodePlaceholder: "Session code",
    joinBtn:           "Join",
    // Session-waiting panel
    sessionReady:      "Session ready",
    shareHint:         "Share the code or link with who you want to call",
    copyLink:          "Copy link",
    cancel:            "Cancel",
    // In-call UI
    micLabel:          "Mic",
    youLabel:          "You",
    chatTitle:         "Chat",
    messagePlaceholder: "Message…",
    // Toasts
    requestingMic:     "Requesting microphone…",
    micError:          (m) => `Microphone: ${m}`,
    startingCamera:    "Starting camera…",
    cameraError:       (m) => `Could not open camera: ${m}`,
    cameraOn:          "Camera on",
    cameraOff:         "Camera off",
    micOn:             "Mic on",
    micMuted:          "Mic muted",
    callEnded:         "Call ended",
    peerLeft:          "The other person left the call",
    linkCopied:        "Link copied",
    copyManually:      "Select the field and copy manually",
    chatNotReady:      "Chat not ready yet",
    enterValidCode:    "Enter a valid session code",
    roomFull:          "Invalid or expired session code",
    signalingError:    "Signaling error",
    connectionState:   (s) => `Connection ${s}`,
    // Status / RTC bar
    startingMic:       "Starting microphone…",
    noMic:             "No microphone — you can still share your camera.",
    connectingSignaling: "Connecting to signaling server…",
    waitingForPeer:    "Waiting for peer to join…",
    connecting:        "Connecting…",
    rtcUpdating:       "WebRTC: updating media…",
    rtcOfferSent:      "WebRTC: offer sent",
    rtcAnswerSent:     "WebRTC: answer sent",
    rtcWaiting:        "Waiting for peer…",
    rtcPairing:        "Pairing…",
    rtcUnreachable:    "Signaling unreachable",
  },
  ru: {
    namePlaceholder:   "Ваше имя",
    startSession:      "Начать сессию",
    joinSession:       "Войти в сессию",
    cancelJoin:        "Отмена",
    sessionCodePlaceholder: "Код сессии",
    joinBtn:           "Войти",
    sessionReady:      "Сессия готова",
    shareHint:         "Поделитесь кодом или ссылкой с собеседником",
    copyLink:          "Копировать ссылку",
    cancel:            "Отмена",
    micLabel:          "Микр.",
    youLabel:          "Вы",
    chatTitle:         "Чат",
    messagePlaceholder: "Сообщение…",
    requestingMic:     "Запрос микрофона…",
    micError:          (m) => `Микрофон: ${m}`,
    startingCamera:    "Включение камеры…",
    cameraError:       (m) => `Не удалось открыть камеру: ${m}`,
    cameraOn:          "Камера включена",
    cameraOff:         "Камера выключена",
    micOn:             "Микрофон включён",
    micMuted:          "Микрофон выключен",
    callEnded:         "Звонок завершён",
    peerLeft:          "Собеседник покинул звонок",
    linkCopied:        "Ссылка скопирована",
    copyManually:      "Выделите поле и скопируйте вручную",
    chatNotReady:      "Чат ещё не готов",
    enterValidCode:    "Введите корректный код сессии",
    roomFull:          "Неверный или устаревший код сессии",
    signalingError:    "Ошибка сигнального сервера",
    connectionState:   (s) => `Соединение: ${s}`,
    startingMic:       "Запрос микрофона…",
    noMic:             "Нет микрофона — можно включить камеру.",
    connectingSignaling: "Подключение к серверу…",
    waitingForPeer:    "Ожидание собеседника…",
    connecting:        "Подключение…",
    rtcUpdating:       "WebRTC: обновление медиа…",
    rtcOfferSent:      "WebRTC: оффер отправлен",
    rtcAnswerSent:     "WebRTC: ответ отправлен",
    rtcWaiting:        "Ожидание…",
    rtcPairing:        "Соединение…",
    rtcUnreachable:    "Сигнальный сервер недоступен",
  },
};

const LANG = (navigator.language || "en").toLowerCase().startsWith("ru") ? "ru" : "en";
const T = TRANSLATIONS[LANG];

// Production signaling server URL.
// Set this to your deployed Fly.io address after running `fly deploy`, e.g.:
//   "wss://vcall-signal.fly.dev"
// Leave empty to fall back to auto-detection (localhost dev) or ?signal= query param.
const SIGNAL_URL = "wss://vcall-signal.fly.dev";

// ---------------------------------------------------------------------------
// Triple-buffer swapchain for native frame consumers (window.__vcallSwapchain)
// ---------------------------------------------------------------------------

class FrameSwapchain {
  constructor(width, height, bufferCount = 3) {
    this.width = width;
    this.height = height;
    this.bytesPerPixel = 4;
    this.stride = width * height * this.bytesPerPixel;
    this.bufferCount = bufferCount;
    this.buffers = Array.from({ length: bufferCount }, () => new Uint8ClampedArray(this.stride));
    this.writeIndex = 0;
    this.readIndex = 0;
    this.frameSequence = 0;
  }

  get slotByteLength() {
    return this.stride;
  }

  acquireWriteSlot() {
    return { buffer: this.buffers[this.writeIndex], index: this.writeIndex };
  }

  commitWrite() {
    this.readIndex = this.writeIndex;
    this.frameSequence += 1;
    this.writeIndex = (this.writeIndex + 1) % this.bufferCount;
  }

  getReadSnapshot() {
    if (this.frameSequence === 0) return null;
    return { buffer: this.buffers[this.readIndex], index: this.readIndex, sequence: this.frameSequence };
  }
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const canvas = document.getElementById("feed-canvas");
const placeholder = document.getElementById("feed-placeholder");
const lobby = document.getElementById("lobby");
const joinCodeForm = document.getElementById("join-code-form");
const placeholderMsg = document.getElementById("placeholder-msg");
const sessionWaiting = document.getElementById("session-waiting");
const sessionCodeDisplay = document.getElementById("session-code-display");
const sessionStatusMsg = document.getElementById("session-status-msg");
const btnCopySessionLink = document.getElementById("btn-copy-session-link");
const btnCancelSession = document.getElementById("btn-cancel-session");
const micFill = document.getElementById("mic-meter-fill");
const btnMic = document.getElementById("btn-mic");
const btnCamera = document.getElementById("btn-camera");
const btnHangup = document.getElementById("btn-hangup");
const statusToast = document.getElementById("status-toast");
const btnStartSession = document.getElementById("btn-start-session");
const btnShowJoin = document.getElementById("btn-show-join");
const btnJoinSession = document.getElementById("btn-join-session");
const joinCodeInput = document.getElementById("join-code-input");
const rtcStatus = document.getElementById("rtc-status");
const remoteVideo = document.getElementById("remote-video");
const remoteNameOverlay = document.getElementById("remote-name-overlay");
const remoteNameText = document.getElementById("remote-name-text");
const localPip = document.getElementById("local-pip");
const audioOnlyCall = document.getElementById("audio-only-call");
const audioOnlyRemoteName = document.getElementById("audio-only-remote-name");
const displayNameInput = document.getElementById("display-name-input");

// Chat
const chatPanel = document.getElementById("chat-panel");
const chatMessages = document.getElementById("chat-messages");
const chatInputField = document.getElementById("chat-input");
const chatForm = document.getElementById("chat-form");
const chatBadge = document.getElementById("chat-badge");
const btnChat = document.getElementById("btn-chat");
const btnChatClose = document.getElementById("btn-chat-close");

const ctx = canvas.getContext("2d", { willReadFrequently: true });
const appEl = document.getElementById("app");
const controlsEl = document.getElementById("controls");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {MediaStream | null} */
let stream = null;
/** @type {HTMLVideoElement | null} — hidden video element for local camera preview */
let video = null;
/** @type {FrameSwapchain | null} */
let swapchain = null;
/** @type {number} — canvas render loop RAF id */
let rafId = 0;
/** @type {number} — mic meter RAF id */
let micRafId = 0;

/** @type {RTCPeerConnection | null} */
let pc = null;
/**
 * The video transceiver created when the PC is set up (recvonly initially).
 * Promoted to sendrecv / back to recvonly when camera is toggled.
 * @type {RTCRtpTransceiver | null}
 */
let videoTransceiver = null;

/** @type {WebSocket | null} */
let sigWs = null;
/** @type {RTCIceCandidateInit[]} */
let iceBuffer = [];
/** @type {number | null} */
let sigConnectTimer = null;
let sigOpened = false;
let sigUnreachableToastShown = false;

/** @type {string} */
let peerDisplayName = "Peer";
/** True once RTCPeerConnection reaches "connected" — drives layout without requiring live tracks. */
let peerConnected = false;

// Chat
/** @type {RTCDataChannel | null} */
let chatChannel = null;
let chatOpen = false;
let chatUnread = 0;

// ---------------------------------------------------------------------------
// UI state — discriminated union
//
// Inspired by tagged unions in Rust/C++: each state carries only the data it
// needs, and every transition is explicit. Call applyUiState(s) to switch.
// ---------------------------------------------------------------------------

const UiState = Object.freeze({
  LOBBY:     "lobby",      // no session — show name input + start/join buttons
  WAITING:   "waiting",    // session created, showing code, waiting for peer
  JOINING:   "joining",    // typing / loading a join code
  LIVE:      "live",       // call active (placeholder hidden)
});

/** @type {{ kind: string, [extra: string]: any }} */
let uiState = { kind: UiState.LOBBY };

function applyUiState(next) {
  uiState = next;
  // DOM work lives here — wrapper functions call applyUiState, never the other way around.
  switch (next.kind) {
    case UiState.LOBBY:
      placeholder.hidden = false;
      if (lobby) lobby.hidden = false;
      if (sessionWaiting) sessionWaiting.hidden = true;
      if (placeholderMsg) placeholderMsg.hidden = true;
      if (chatPanel) chatPanel.hidden = true;
      break;
    case UiState.WAITING:
      placeholder.hidden = false;
      if (lobby) lobby.hidden = true;
      if (sessionWaiting) sessionWaiting.hidden = false;
      if (placeholderMsg) placeholderMsg.hidden = true;
      if (sessionCodeDisplay) sessionCodeDisplay.textContent = next.code ?? "";
      if (sessionStatusMsg) sessionStatusMsg.textContent = next.status ?? "";
      if (chatPanel) chatPanel.hidden = true;
      break;
    case UiState.JOINING:
      placeholder.hidden = false;
      if (lobby) lobby.hidden = true;
      if (sessionWaiting) sessionWaiting.hidden = true;
      if (placeholderMsg) {
        placeholderMsg.hidden = false;
        placeholderMsg.textContent = next.status ?? "";
      }
      if (chatPanel) chatPanel.hidden = true;
      break;
    case UiState.LIVE:
      placeholder.hidden = true;
      // Reveal the chat panel (still closed until the user clicks the button)
      if (chatPanel) chatPanel.hidden = false;
      break;
  }
}

function setWaitingStatus(msg) {
  if (uiState.kind === UiState.WAITING) {
    uiState = { ...uiState, status: msg };
    if (sessionStatusMsg) sessionStatusMsg.textContent = msg;
  } else if (uiState.kind === UiState.JOINING) {
    uiState = { ...uiState, status: msg };
    if (placeholderMsg) { placeholderMsg.hidden = false; placeholderMsg.textContent = msg; }
  }
}

/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {AnalyserNode | null} */
let analyser = null;
/** @type {Uint8Array | null} */
let timeDomainData = null;

// ---------------------------------------------------------------------------
// Signaling URL helpers
// ---------------------------------------------------------------------------

function wsHostFromLocation() {
  const h = location.hostname || "";
  if (!h) return "localhost";
  return h.includes(":") ? `[${h}]` : h;
}

function signalUrl() {
  if (SIGNAL_URL) return SIGNAL_URL;
  const params = new URLSearchParams(location.search);
  const custom = params.get("signal");
  if (custom) return custom;
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${wsHostFromLocation()}:8787`;
}

function signalingUnreachableToast(url) {
  const pageHost = location.hostname || "this computer";
  const pageAt = location.host ? `http://${location.host}` : `http://${pageHost}`;
  if (location.protocol === "https:") {
    return `Could not connect to signaling at ${url}. HTTPS pages require WSS. Run: python3 signaling_server.py <cert.pem> <key.pem> (same files as serve_https.py), open port 8787 in the firewall, and use your Mac's LAN IP in the address bar (not localhost on the phone).`;
  }
  return `Could not connect to signaling at ${url}. You opened ${pageAt} — the HTML is only that server; WebRTC signaling is separate on port 8787 on your Mac (${url}). Run python3 signaling_server.py there, allow incoming TCP 8787 in macOS Firewall (same Wi‑Fi as the iPhone; avoid guest networks). On iOS, allow "Local Network" for Safari if asked. Manual URL: ?signal=ws://${pageHost.includes(":") ? `[${pageHost}]` : pageHost}:8787`;
}

function showSignalingUnreachableOnce(url) {
  if (sigUnreachableToastShown) return;
  sigUnreachableToastShown = true;
  showToast(signalingUnreachableToast(url), 14000);
}

// ---------------------------------------------------------------------------
// Session key — short 6-digit numeric code
// ---------------------------------------------------------------------------

function generateSessionKey() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

function getSessionFromUrl() {
  const p = new URLSearchParams(location.search);
  return (p.get("session") || "").trim().slice(0, 64);
}

function setSessionInUrl(sessionKey) {
  const u = new URL(location.href);
  u.searchParams.set("session", sessionKey);
  history.replaceState(null, "", u.toString());
}

function clearSessionFromUrl() {
  const u = new URL(location.href);
  u.searchParams.delete("session");
  history.replaceState(null, "", u.toString());
}

function buildSessionShareUrl() {
  const key = getSessionFromUrl();
  if (!key) return "";
  const u = new URL(location.href);
  u.hash = "";
  u.searchParams.set("session", key);
  return u.toString();
}

// ---------------------------------------------------------------------------
// UI sync — thin wrappers; all DOM work is in applyUiState
// ---------------------------------------------------------------------------

const showLobby          = () => applyUiState({ kind: UiState.LOBBY });
const showSessionWaiting = () => applyUiState({ kind: UiState.WAITING, code: getSessionFromUrl(), status: "" });
const showPlaceholderStatus = (msg) => applyUiState({ kind: UiState.JOINING, status: msg });
const setSessionStatus   = (msg) => setWaitingStatus(msg);

function syncSessionUi() {
  if (!getSessionFromUrl()) showLobby();
}

function getLocalDisplayName() {
  const raw = (displayNameInput && displayNameInput.value.trim()) || localStorage.getItem(DISPLAY_NAME_KEY) || "";
  return raw.slice(0, 32) || "Guest";
}

function sendPeerInfo() {
  if (!sigWs || sigWs.readyState !== WebSocket.OPEN) return;
  sigWs.send(JSON.stringify({ type: "peer-info", displayName: getLocalDisplayName() }));
}

function setRtcStatus(text) {
  if (rtcStatus) rtcStatus.textContent = text;
}

function updateCallControlsVisibility() {
  const live = !!getSessionFromUrl() && sigWs && sigWs.readyState === WebSocket.OPEN;
  if (appEl) appEl.classList.toggle("session-live", live);
  if (controlsEl) controlsEl.setAttribute("aria-hidden", live ? "false" : "true");
}

function triggerSessionSetupTransition() {
  if (!appEl) return;
  appEl.classList.remove("session-setup-enter");
  void appEl.offsetWidth;
  appEl.classList.add("session-setup-enter");
  setTimeout(() => appEl.classList.remove("session-setup-enter"), 520);
}

function setPlaceholderMessage(msg) {
  setWaitingStatus(msg);
}

function showToast(msg, ms = 2200) {
  statusToast.textContent = msg;
  statusToast.classList.add("visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => statusToast.classList.remove("visible"), ms);
}

function applyTranslations() {
  document.documentElement.lang = LANG;
  if (btnStartSession)     btnStartSession.textContent     = T.startSession;
  if (btnShowJoin)         btnShowJoin.textContent         = T.joinSession;
  if (btnJoinSession)      btnJoinSession.textContent      = T.joinBtn;
  if (btnCopySessionLink)  btnCopySessionLink.textContent  = T.copyLink;
  if (btnCancelSession)    btnCancelSession.textContent    = T.cancel;
  if (displayNameInput)    displayNameInput.placeholder    = T.namePlaceholder;
  if (joinCodeInput)       joinCodeInput.placeholder       = T.sessionCodePlaceholder;
  if (chatInputField)      chatInputField.placeholder      = T.messagePlaceholder;
  const sessionReadyTitle = sessionWaiting?.querySelector(".lobby-title");
  if (sessionReadyTitle)   sessionReadyTitle.textContent   = T.sessionReady;
  const shareHintEl = sessionWaiting?.querySelector(".session-share-hint");
  if (shareHintEl)         shareHintEl.textContent         = T.shareHint;
  const micLabelEl = document.getElementById("mic-meter-label");
  if (micLabelEl)          micLabelEl.textContent          = T.micLabel;
  const youLabelEl = document.querySelector(".audio-only-you");
  if (youLabelEl)          youLabelEl.textContent          = T.youLabel;
  const chatTitleEl = document.querySelector(".chat-title");
  if (chatTitleEl)         chatTitleEl.textContent         = T.chatTitle;
}

// ---------------------------------------------------------------------------
// Chat — RTCDataChannel
// ---------------------------------------------------------------------------

function setupChatChannel(ch) {
  ch.onclose = () => { chatChannel = null; };
  ch.onerror = () => { chatChannel = null; };
  ch.onmessage = (ev) => {
    try {
      const { text, from } = JSON.parse(ev.data);
      if (typeof text === "string" && text.trim()) {
        appendChatMsg(text.trim(), from || "Peer", false);
      }
    } catch { /* ignore malformed */ }
  };
}

function appendChatMsg(text, from, isSelf) {
  if (!chatMessages) return;
  const wrap = document.createElement("div");
  wrap.className = "chat-msg " + (isSelf ? "chat-msg-self" : "chat-msg-peer");
  const nameEl = document.createElement("span");
  nameEl.className = "chat-msg-name";
  nameEl.textContent = isSelf ? T.youLabel : from;
  const textEl = document.createElement("p");
  textEl.className = "chat-msg-text";
  textEl.textContent = text;
  wrap.append(nameEl, textEl);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (!isSelf && !chatOpen) {
    chatUnread++;
    if (chatBadge) {
      chatBadge.textContent = chatUnread > 9 ? "9+" : String(chatUnread);
      chatBadge.hidden = false;
    }
    // Brief toast preview when chat is closed
    const preview = text.length > 55 ? text.slice(0, 55) + "…" : text;
    showToast(`${from}: ${preview}`, 4000);
  }
}

function openChat() {
  chatOpen = true;
  chatUnread = 0;
  if (chatPanel) chatPanel.classList.add("open");
  if (btnChat) btnChat.classList.add("chat-open");
  if (chatBadge) { chatBadge.hidden = true; chatBadge.textContent = ""; }
  setTimeout(() => chatInputField?.focus(), 50);
}

function closeChat() {
  chatOpen = false;
  if (chatPanel) chatPanel.classList.remove("open");
  if (btnChat) btnChat.classList.remove("chat-open");
}

function toggleChat() {
  chatOpen ? closeChat() : openChat();
}

function sendChatMessage() {
  const text = (chatInputField?.value ?? "").trim();
  if (!text) return;
  if (!chatChannel || chatChannel.readyState !== "open") {
    showToast(T.chatNotReady, 2500);
    return;
  }
  chatChannel.send(JSON.stringify({ text, from: getLocalDisplayName() }));
  appendChatMsg(text, getLocalDisplayName(), true);
  if (chatInputField) chatInputField.value = "";
}

/** Close channel, clear messages, reset badge. Visibility is handled by applyUiState. */
function cleanupChat() {
  closeChat();
  if (chatChannel) { try { chatChannel.close(); } catch { /* ignore */ } chatChannel = null; }
  chatUnread = 0;
  if (chatMessages) chatMessages.innerHTML = "";
  if (chatBadge) { chatBadge.hidden = true; chatBadge.textContent = ""; }
}

// ---------------------------------------------------------------------------
// Return to start screen
// ---------------------------------------------------------------------------

function returnToSessionCreation(opts = {}) {
  const toastMsg = opts.toast != null ? opts.toast : T.callEnded;
  const toastMs = opts.toastMs != null ? opts.toastMs : 2800;
  cleanupChat();
  stopTracks();
  clearSessionFromUrl();
  if (canvas.width && canvas.height) ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyUiState({ kind: UiState.LOBBY });
  if (btnMic) {
    btnMic.disabled = true;
    btnMic.classList.remove("muted");
    btnMic.setAttribute("aria-pressed", "false");
  }
  if (btnCamera) {
    btnCamera.classList.remove("cam-on");
    btnCamera.setAttribute("aria-pressed", "false");
  }
  showToast(toastMsg, toastMs);
  triggerSessionSetupTransition();
  updateCallControlsVisibility();
}

// ---------------------------------------------------------------------------
// Media access check
// ---------------------------------------------------------------------------

function getMediaAccessError() {
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") return null;
  if (location.protocol === "file:") {
    return {
      toast: "Serve this folder and open http://localhost:… — not a local file URL.",
      placeholder: "Use a local server (python -m http.server), not file://.",
    };
  }
  const insecureHttp =
    location.protocol === "http:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1";
  if (typeof window.isSecureContext === "boolean" && !window.isSecureContext && insecureHttp) {
    return {
      toast: "Safari hides the camera on plain http:// to your Wi‑Fi IP. Use HTTPS (e.g. ngrok, mkcert) or test on your Mac with http://localhost.",
      placeholder: "http://192.168.… is not a secure context on iPhone. Use an https:// URL or localhost on desktop.",
    };
  }
  if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
    return {
      toast: "Microphone/camera need HTTPS or http://localhost on this machine.",
      placeholder: "Use https://… or open via http://localhost from the same computer.",
    };
  }
  return {
    toast: "This browser does not expose getUserMedia.",
    placeholder: "Try Safari or Chrome, or update the OS/browser.",
  };
}

// ---------------------------------------------------------------------------
// Mic meter — independent RAF loop, no dependency on camera
// ---------------------------------------------------------------------------

function updateMicMeter() {
  if (!analyser || !timeDomainData) return;
  if (btnMic.classList.contains("muted")) {
    micFill.style.width = "0%";
    return;
  }
  analyser.getByteTimeDomainData(timeDomainData);
  let sum = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const v = (timeDomainData[i] - 128) / 128;
    sum += v * v;
  }
  const level = Math.min(1, Math.sqrt(sum / timeDomainData.length) * 3.2);
  micFill.style.width = `${Math.round(level * 100)}%`;
}

function micMeterLoop() {
  updateMicMeter();
  micRafId = requestAnimationFrame(micMeterLoop);
}

function startMicMeterLoop() {
  if (!micRafId) micRafId = requestAnimationFrame(micMeterLoop);
}

function stopMicMeterLoop() {
  if (micRafId) {
    cancelAnimationFrame(micRafId);
    micRafId = 0;
  }
  micFill.style.width = "0%";
}

function setupMicMeterFromStream(mediaStream) {
  if (audioCtx && audioCtx.state !== "closed") audioCtx.close().catch(() => {});
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);
  timeDomainData = new Uint8Array(analyser.fftSize);
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  startMicMeterLoop();
}

// ---------------------------------------------------------------------------
// PeerConnection
// ---------------------------------------------------------------------------

function makePeerConnection() {
  return createPcBase({
    iceServers: ICE_SERVERS,
    iceViaWebSocket: true,
    sendIceCandidate: (c) => {
      if (sigWs && sigWs.readyState === WebSocket.OPEN) {
        sigWs.send(JSON.stringify({ type: "ice", candidate: c }));
      }
    },
    onTrack: (ev) => {
      // ev.streams[0] is absent when the sender used addTransceiver+replaceTrack
      // without associating a stream (no msid in the SDP).  Recover by attaching
      // the track to the existing remote stream so the video element stays unified.
      let ms = ev.streams[0];
      if (!ms) {
        const existing = remoteVideo?.srcObject;
        ms = (existing instanceof MediaStream) ? existing : new MediaStream();
        if (!ms.getTrackById(ev.track.id)) ms.addTrack(ev.track);
      }
      if (remoteVideo) {
        if (remoteVideo.srcObject !== ms) {
          remoteVideo.srcObject = ms;
          // Only wire video-element events once per stream assignment
          const bump = () => updateCallLayout();
          remoteVideo.addEventListener("loadedmetadata", bump);
          remoteVideo.addEventListener("resize", bump);
        }
        remoteVideo.play().catch(() => {});
        // Wire track-level events for this specific new track
        const bump = () => updateCallLayout();
        ev.track.addEventListener("ended", bump);
        ev.track.addEventListener("mute", bump);
        ev.track.addEventListener("unmute", bump);
        bump();
      }
    },
    onConnectionStateChange: (s) => {
      setRtcStatus(`WebRTC: ${s}`);
      if (s === "connected") {
        peerConnected = true;
        applyUiState({ kind: UiState.LIVE });
        updateCallLayout();
      }
      if (s === "failed" || s === "disconnected") showToast(T.connectionState(s), 3500);
    },
  });
}

function resetPeerConnection() {
  iceBuffer = [];
  videoTransceiver = null;
  peerConnected = false;
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  if (remoteVideo) remoteVideo.srcObject = null;
  updateCallLayout();
}

function teardownPeerConnection() {
  resetPeerConnection();
  peerDisplayName = "Peer";
  if (sigWs) {
    sigWs.onopen = null;
    sigWs.onmessage = null;
    sigWs.onerror = null;
    sigWs.onclose = null;
    if (sigWs.readyState === WebSocket.OPEN || sigWs.readyState === WebSocket.CONNECTING) sigWs.close();
    sigWs = null;
  }
  clearSigTimers();
  sigOpened = false;
  sigUnreachableToastShown = false;
  setRtcStatus("");
}

function clearSigTimers() {
  if (sigConnectTimer != null) {
    clearTimeout(sigConnectTimer);
    sigConnectTimer = null;
  }
}

/**
 * Set up initial transceivers when PC is first created.
 * At this point stream always has audio (mic was started before signaling).
 * We create a recvonly video transceiver so we can receive the peer's video
 * even before we turn on our own camera; it is promoted to sendrecv in addCameraTrack().
 */
function addMediaToPeerConnection() {
  if (!pc) return;
  if (stream) {
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    if (!stream.getVideoTracks().length) {
      videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
    }
  } else {
    videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
  }
}

/**
 * Send a renegotiation offer over the existing WebSocket.
 * Used when camera is toggled to add/remove the video track in-place.
 */
async function renegotiate() {
  if (!pc || !sigWs || sigWs.readyState !== WebSocket.OPEN) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sigWs.send(JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp }));
    setRtcStatus(T.rtcUpdating);
  } catch (e) {
    console.warn("renegotiate", e);
  }
}

// ---------------------------------------------------------------------------
// Call layout
// ---------------------------------------------------------------------------

function liveVideoTracks(ms) {
  if (!ms) return [];
  return ms.getVideoTracks().filter((t) => t.readyState === "live" && t.enabled);
}

function updateCallLayout() {
  const remoteMs = remoteVideo?.srcObject;
  const localHasVideo = !!(stream && stream.getVideoTracks().some((t) => t.readyState === "live" && t.enabled));
  if (localPip) localPip.hidden = !localHasVideo;

  // Show peer name once WebRTC is connected, regardless of whether media tracks are flowing yet.
  // A peer with no mic/camera still deserves a name label.
  const name = peerDisplayName || "Peer";
  if (remoteNameText) remoteNameText.textContent = name;
  if (audioOnlyRemoteName) audioOnlyRemoteName.textContent = name;

  if (!peerConnected) {
    if (remoteNameOverlay) remoteNameOverlay.hidden = true;
    if (audioOnlyCall) audioOnlyCall.hidden = true;
    if (remoteVideo) remoteVideo.style.visibility = "hidden";
    return;
  }

  const remoteHasVideo = !!(remoteMs && liveVideoTracks(remoteMs).length > 0);

  // Audio-only view: neither side is sending video
  if (audioOnlyCall) audioOnlyCall.hidden = remoteHasVideo || localHasVideo;
  // Name overlay: local has video, remote doesn't (remote shows as a label over the black bg)
  if (remoteNameOverlay) remoteNameOverlay.hidden = remoteHasVideo || !localHasVideo;
  if (remoteVideo) remoteVideo.style.visibility = remoteHasVideo ? "visible" : "hidden";
}

// ---------------------------------------------------------------------------
// ICE
// ---------------------------------------------------------------------------

async function flushIceBuffer() {
  if (!pc) return;
  while (iceBuffer.length) {
    const c = iceBuffer.shift();
    try {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (e) {
      console.warn("addIceCandidate", e);
    }
  }
}

// ---------------------------------------------------------------------------
// WebRTC offer/answer
// ---------------------------------------------------------------------------

async function startAsOfferer() {
  if (!sigWs || sigWs.readyState !== WebSocket.OPEN) return;
  iceBuffer = [];
  pc = makePeerConnection();
  // Create the data channel before createOffer so it's included in the SDP negotiation
  chatChannel = pc.createDataChannel("chat", { ordered: true });
  setupChatChannel(chatChannel);
  addMediaToPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sigWs.send(JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp }));
  setRtcStatus(T.rtcOfferSent);
}

async function handleIncomingOffer(sdpText) {
  if (!sigWs || sigWs.readyState !== WebSocket.OPEN) return;
  if (!pc) {
    pc = makePeerConnection();
    // Receive the chat data channel created by the offerer
    pc.ondatachannel = (ev) => { chatChannel = ev.channel; setupChatChannel(chatChannel); };
    addMediaToPeerConnection();
  }
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sdpText }));
  await flushIceBuffer();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sigWs.send(JSON.stringify({ type: "answer", sdp: pc.localDescription.sdp }));
  // Don't overwrite "connected" status during a renegotiation offer
  if (!peerConnected) setRtcStatus(T.rtcAnswerSent);
}

async function handleIncomingAnswer(sdpText) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: sdpText }));
  await flushIceBuffer();
  // Status is set by onConnectionStateChange — don't prematurely show "connected" here
}

async function handleIncomingIce(candidate) {
  if (!candidate) return;
  if (!pc || !pc.remoteDescription) {
    iceBuffer.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.warn("ICE", e);
  }
}

// ---------------------------------------------------------------------------
// Signaling WebSocket
// ---------------------------------------------------------------------------

function connectSignaling() {
  const room = getSessionFromUrl();
  if (!room) {
    showToast("No session — start or join a session first.", 4000);
    return;
  }
  teardownPeerConnection();
  updateCallControlsVisibility();
  const url = signalUrl();
  setRtcStatus(`Signaling: connecting… (${url})`); // URL kept for debug; not translated
  try {
    sigWs = new WebSocket(url);
  } catch {
    showSignalingUnreachableOnce(url);
    setRtcStatus("Signaling unreachable");
    updateCallControlsVisibility();
    return;
  }

  sigOpened = false;
  sigUnreachableToastShown = false;
  clearSigTimers();
  sigConnectTimer = setTimeout(() => {
    if (!sigOpened && sigWs && sigWs.readyState !== WebSocket.OPEN) {
      showSignalingUnreachableOnce(url);
      setRtcStatus(T.rtcUnreachable);
      try { sigWs.close(); } catch { /* ignore */ }
    }
    sigConnectTimer = null;
  }, SIG_CONNECT_TIMEOUT_MS);

  sigWs.onopen = () => {
    sigOpened = true;
    clearSigTimers();
    sigWs.send(JSON.stringify({ type: "join", room }));
    sendPeerInfo();
    updateCallControlsVisibility();
  };

  sigWs.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "joined") {
      if (msg.peers < 2) setWaitingStatus(T.waitingForPeer);
      setRtcStatus(msg.peers < 2 ? T.rtcWaiting : T.rtcPairing);
      return;
    }
    if (msg.type === "error") {
      if (msg.message === "room full") {
        returnToSessionCreation({ toast: T.roomFull, toastMs: 5000 });
      } else {
        showToast(msg.message || T.signalingError, 4000);
      }
      return;
    }
    if (msg.type === "peer-info") {
      const n = (msg.displayName && String(msg.displayName).trim()) || "Peer";
      peerDisplayName = n.slice(0, 32) || "Peer";
      updateCallLayout();
      return;
    }
    if (msg.type === "peer") {
      setWaitingStatus(T.connecting);
      if (msg.role === "offer") await startAsOfferer();
      return;
    }
    if (msg.type === "peer-left") {
      returnToSessionCreation({ toast: T.peerLeft, toastMs: 3800 });
      return;
    }
    if (msg.type === "offer" && msg.sdp) { await handleIncomingOffer(msg.sdp); return; }
    if (msg.type === "answer" && msg.sdp) { await handleIncomingAnswer(msg.sdp); return; }
    if (msg.type === "ice") await handleIncomingIce(msg.candidate);
  };

  sigWs.onerror = () => { /* rely on onclose + timeout */ };

  sigWs.onclose = () => {
    clearSigTimers();
    sigWs = null;
    if (!sigOpened) {
      showSignalingUnreachableOnce(url);
      setRtcStatus(T.rtcUnreachable);
    } else if (!pc) {
      setRtcStatus("");
    }
    updateCallControlsVisibility();
  };
}

// ---------------------------------------------------------------------------
// Media: mic (always on), camera (dynamic)
// ---------------------------------------------------------------------------

/**
 * Request microphone access and set up the audio stream.
 * Idempotent — returns true immediately if mic is already active.
 */
async function startMic() {
  if (stream) return true;
  const err = getMediaAccessError();
  if (err) { showToast(err.toast, 8000); return false; }
  showToast(T.requestingMic);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch (e) {
    showToast(T.micError(e?.message ?? String(e)), 6000);
    return false;
  }
  setupMicMeterFromStream(stream);
  if (btnMic) btnMic.disabled = false;
  return true;
}

/**
 * Add a video track to the session.
 * Works whether or not mic was successfully started — if there is no existing
 * stream, a video-only stream is created.  The existing recvonly video
 * transceiver is promoted to sendrecv so no new m-line is added.
 */
async function addCameraTrack() {
  const err = getMediaAccessError();
  if (err) { showToast(err.toast, 8000); return; }
  showToast(T.startingCamera);

  let videoTrack;
  try {
    const vs = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    });
    [videoTrack] = vs.getVideoTracks();
  } catch {
    try {
      const vs2 = await navigator.mediaDevices.getUserMedia({ video: true });
      [videoTrack] = vs2.getVideoTracks();
    } catch (e2) {
      showToast(T.cameraError(e2?.message ?? String(e2)), 6000);
      return;
    }
  }

  if (!stream) {
    // Mic was never started (permission denied or skipped) — create a stream
    // with video only so everything else keeps working.
    stream = new MediaStream([videoTrack]);
  } else {
    stream.addTrack(videoTrack);
  }

  // Hidden video element drives the local canvas preview / swapchain
  video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);
  video.srcObject = new MediaStream([videoTrack]);
  try {
    await waitForVideoMetadata(video);
    await video.play();
  } catch { /* non-fatal */ }

  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  canvas.width = vw;
  canvas.height = vh;
  ensureSwapchainForSize(vw, vh);
  rafId = requestAnimationFrame(renderLoop);

  if (pc) {
    if (videoTransceiver?.sender.track !== null) {
      // Re-enabling after camera was turned off: stream association already in SDP, replaceTrack is safe.
      await videoTransceiver.sender.replaceTrack(videoTrack);
      videoTransceiver.direction = "sendrecv";
    } else {
      // First add (or after replaceTrack(null)): use addTrack so the stream ID is written into
      // the SDP msid attribute — this is what makes ev.streams[0] available on the remote ontrack.
      // Per spec, addTrack reuses the existing recvonly video transceiver and sets it to sendrecv.
      pc.addTrack(videoTrack, stream);
    }
    await renegotiate();
  }

  if (btnCamera) {
    btnCamera.classList.add("cam-on");
    btnCamera.setAttribute("aria-pressed", "true");
  }
  updateCallLayout();
  showToast(T.cameraOn);
}

/**
 * Remove the video track and renegotiate back to audio-only.
 * The video transceiver stays in the SDP but reverts to recvonly,
 * so the peer's video (if any) can still be received.
 */
async function removeCameraTrack() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (video) { video.srcObject = null; video.remove(); video = null; }
  swapchain = null;
  window.__vcallSwapchain = null;

  if (stream) {
    stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
  }

  if (pc && videoTransceiver?.sender) {
    await videoTransceiver.sender.replaceTrack(null);
    videoTransceiver.direction = "recvonly";
    await renegotiate();
  }

  if (btnCamera) {
    btnCamera.classList.remove("cam-on");
    btnCamera.setAttribute("aria-pressed", "false");
  }
  updateCallLayout();
  showToast(T.cameraOff);
}

async function toggleCamera() {
  const cameraIsOn = !!(stream && stream.getVideoTracks().some((t) => t.readyState === "live" && t.enabled));
  if (cameraIsOn) {
    await removeCameraTrack();
  } else {
    await addCameraTrack();
  }
}

// ---------------------------------------------------------------------------
// Stop all local media and tear down connection
// ---------------------------------------------------------------------------

function stopTracks() {
  teardownPeerConnection();
  stopMicMeterLoop();
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (video) { video.srcObject = null; video.remove(); video = null; }
  swapchain = null;
  window.__vcallSwapchain = null;
  if (audioCtx && audioCtx.state !== "closed") { audioCtx.close().catch(() => {}); audioCtx = null; }
  analyser = null;
  timeDomainData = null;
  updateCallLayout();
  updateCallControlsVisibility();
}

// ---------------------------------------------------------------------------
// Canvas / swapchain helpers
// ---------------------------------------------------------------------------

function ensureSwapchainForSize(w, h) {
  swapchain = new FrameSwapchain(w, h);
  window.__vcallSwapchain = swapchain;
}

function commitFrameToSwapchain(imageData) {
  if (!swapchain) return;
  const { buffer } = swapchain.acquireWriteSlot();
  buffer.set(imageData.data);
  swapchain.commitWrite();
}

function renderLoop() {
  if (!video || !swapchain) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw > 0 && vh > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
      ensureSwapchainForSize(vw, vh);
    }
    ctx.drawImage(video, 0, 0, vw, vh);
    commitFrameToSwapchain(ctx.getImageData(0, 0, vw, vh));
  }
  rafId = requestAnimationFrame(renderLoop);
}

function waitForVideoMetadata(el) {
  if (el.readyState >= HTMLMediaElement.HAVE_METADATA && el.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onMeta = () => { el.removeEventListener("loadedmetadata", onMeta); el.removeEventListener("error", onErr); resolve(); };
    const onErr = () => { el.removeEventListener("loadedmetadata", onMeta); el.removeEventListener("error", onErr); reject(new Error("Video element error")); };
    el.addEventListener("loadedmetadata", onMeta, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Session start / join
// ---------------------------------------------------------------------------

async function startSession() {
  if (getSessionFromUrl()) return;
  const key = generateSessionKey();
  setSessionInUrl(key);
  applyUiState({ kind: UiState.WAITING, code: key, status: T.startingMic });
  const micOk = await startMic();
  setWaitingStatus(micOk ? T.connectingSignaling : T.noMic);
  connectSignaling();
}

async function joinSession() {
  const code = (joinCodeInput?.value ?? "").trim().replace(/\D/g, "");
  if (!code || code.length < 4) {
    showToast(T.enterValidCode, 3000);
    joinCodeInput?.focus();
    return;
  }
  if (getSessionFromUrl() === code) return;
  setSessionInUrl(code);
  applyUiState({ kind: UiState.JOINING, status: T.startingMic });
  const micOk = await startMic();
  if (!micOk) setWaitingStatus(T.noMic);
  connectSignaling();
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

btnMic.addEventListener("click", () => {
  if (!stream) return;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) return;
  const enabled = !audioTracks[0].enabled;
  audioTracks.forEach((t) => { t.enabled = enabled; });
  btnMic.classList.toggle("muted", !enabled);
  btnMic.setAttribute("aria-pressed", String(!enabled));
  showToast(enabled ? T.micOn : T.micMuted);
});

btnHangup.addEventListener("click", () => returnToSessionCreation({ toast: T.callEnded }));

if (btnCancelSession) {
  btnCancelSession.addEventListener("click", () => returnToSessionCreation({ toast: "" }));
}

if (btnCamera) btnCamera.addEventListener("click", () => toggleCamera());

if (btnStartSession) btnStartSession.addEventListener("click", () => startSession());

  if (btnShowJoin) {
  btnShowJoin.addEventListener("click", () => {
    if (!joinCodeForm) return;
    const open = !joinCodeForm.hidden;
    joinCodeForm.hidden = open;
    btnShowJoin.textContent = open ? T.joinSession : T.cancelJoin;
    if (!open) joinCodeInput?.focus();
  });
}

if (btnJoinSession) btnJoinSession.addEventListener("click", () => joinSession());

if (joinCodeInput) {
  joinCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinSession(); });
  // Allow only digits
  joinCodeInput.addEventListener("input", () => {
    joinCodeInput.value = joinCodeInput.value.replace(/\D/g, "").slice(0, 6);
  });
}

if (btnCopySessionLink) {
  btnCopySessionLink.addEventListener("click", async () => {
    const url = buildSessionShareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast(T.linkCopied, 2000);
    } catch {
      showToast(T.copyManually, 3000);
    }
  });
}

if (displayNameInput) {
  const saved = localStorage.getItem(DISPLAY_NAME_KEY);
  if (saved) displayNameInput.value = saved;
  displayNameInput.addEventListener("change", () => {
    localStorage.setItem(DISPLAY_NAME_KEY, getLocalDisplayName());
    sendPeerInfo();
  });
  displayNameInput.addEventListener("input", () => {
    localStorage.setItem(DISPLAY_NAME_KEY, displayNameInput.value.trim().slice(0, 32));
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
});

if (btnChat) btnChat.addEventListener("click", toggleChat);
if (btnChatClose) btnChatClose.addEventListener("click", closeChat);
if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendChatMessage();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  applyTranslations();
  const mediaErr = getMediaAccessError();

  if (getSessionFromUrl()) {
    // Opened via shared link — auto-join as the other party
    updateCallLayout();
    applyUiState({ kind: UiState.JOINING, status: T.startingMic });
    if (mediaErr) {
      showToast(mediaErr.toast, 8000);
    } else {
      const micOk = await startMic();
      if (!micOk) setWaitingStatus(T.noMic);
    }
    connectSignaling();
    return;
  }

  updateCallLayout();
  updateCallControlsVisibility();
  applyUiState({ kind: UiState.LOBBY });

  if (mediaErr) {
    if (location.protocol === "file:") {
      showToast(mediaErr.toast, 10000);
      return;
    }
    showToast(mediaErr.toast, 8000);
  }
}

boot();
