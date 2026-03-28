/**
 * Local camera + mic, triple-buffer swapchain, WebRTC to a peer via WebSocket signaling.
 */

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
    const buffer = this.buffers[this.writeIndex];
    return { buffer, index: this.writeIndex };
  }

  commitWrite() {
    this.readIndex = this.writeIndex;
    this.frameSequence += 1;
    this.writeIndex = (this.writeIndex + 1) % this.bufferCount;
  }

  getReadSnapshot() {
    const buffer = this.buffers[this.readIndex];
    if (this.frameSequence === 0) return null;
    return { buffer, index: this.readIndex, sequence: this.frameSequence };
  }
}

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const canvas = document.getElementById("feed-canvas");
const placeholder = document.getElementById("feed-placeholder");
const placeholderMsg = document.getElementById("placeholder-msg");
const btnStartCamera = document.getElementById("btn-start-camera");
const micFill = document.getElementById("mic-meter-fill");
const btnMic = document.getElementById("btn-mic");
const btnHangup = document.getElementById("btn-hangup");
const statusToast = document.getElementById("status-toast");
const roomInput = document.getElementById("room-input");
const btnJoin = document.getElementById("btn-join");
const rtcStatus = document.getElementById("rtc-status");
const remoteVideo = document.getElementById("remote-video");
const remotePlaceholder = document.getElementById("remote-placeholder");

const ctx = canvas.getContext("2d", { willReadFrequently: true });

/** @type {MediaStream | null} */
let stream = null;
/** @type {HTMLVideoElement | null} */
let video = null;
/** @type {FrameSwapchain | null} */
let swapchain = null;
/** @type {number} */
let rafId = 0;

/** @type {RTCPeerConnection | null} */
let pc = null;
/** @type {WebSocket | null} */
let sigWs = null;
/** @type {RTCIceCandidateInit[]} */
let iceBuffer = [];

/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {AnalyserNode | null} */
let analyser = null;
/** @type {Uint8Array | null} */
let timeDomainData = null;

function signalUrl() {
  const params = new URLSearchParams(location.search);
  const custom = params.get("signal");
  if (custom) return custom;
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${location.hostname}:8787`;
}

function currentRoomId() {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get("room");
  const fromInput = roomInput && roomInput.value.trim();
  return (fromQuery || fromInput || "demo").slice(0, 64);
}

function setRtcStatus(text) {
  if (rtcStatus) rtcStatus.textContent = text;
}

function setRemotePlaceholderVisible(visible) {
  if (remotePlaceholder) remotePlaceholder.hidden = !visible;
}

function getMediaAccessError() {
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
    return null;
  }
  if (location.protocol === "file:") {
    return {
      toast: "Serve this folder and open http://localhost:… — not a local file URL.",
      placeholder: "Use a local server (python -m http.server), not file://.",
    };
  }
  const insecureHttp =
    location.protocol === "http:" &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1";
  if (typeof window.isSecureContext === "boolean" && !window.isSecureContext && insecureHttp) {
    return {
      toast:
        "Safari hides the camera on plain http:// to your Wi‑Fi IP. Use HTTPS (e.g. ngrok, mkcert) or test on your Mac with http://localhost.",
      placeholder:
        "http://192.168.… is not a secure context on iPhone. Use an https:// URL or localhost on desktop.",
    };
  }
  if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
    return {
      toast: "Camera needs a secure page: HTTPS or http://localhost on this machine.",
      placeholder: "Use https://… or open via http://localhost from the same computer.",
    };
  }
  return {
    toast: "This browser does not expose the camera API (mediaDevices).",
    placeholder: "Try Safari or Chrome, or update the OS/browser.",
  };
}

function setStartButtonVisible(visible) {
  if (btnStartCamera) btnStartCamera.hidden = !visible;
}

function setPlaceholderMessage(msg) {
  if (placeholderMsg) placeholderMsg.textContent = msg;
}

/** No local camera/mic — still allow signaling + WebRTC (recv-only) to verify connectivity. */
function enterReceiveOnlyMode(placeholderText, toastText) {
  stopTracks();
  placeholder.hidden = false;
  setPlaceholderMessage(placeholderText);
  setStartButtonVisible(true);
  if (btnJoin) btnJoin.disabled = false;
  if (btnMic) btnMic.disabled = true;
  setRemotePlaceholderVisible(true);
  if (toastText) showToast(toastText, 5000);
}

function showToast(msg, ms = 2200) {
  statusToast.textContent = msg;
  statusToast.classList.add("visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => statusToast.classList.remove("visible"), ms);
}

function makePeerConnection() {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  conn.ontrack = (ev) => {
    const [ms] = ev.streams;
    if (ms && remoteVideo) {
      remoteVideo.srcObject = ms;
      setRemotePlaceholderVisible(false);
    }
  };
  conn.onicecandidate = (ev) => {
    if (ev.candidate && sigWs && sigWs.readyState === WebSocket.OPEN) {
      sigWs.send(JSON.stringify({ type: "ice", candidate: ev.candidate.toJSON() }));
    }
  };
  conn.onconnectionstatechange = () => {
    const s = conn.connectionState;
    setRtcStatus(`WebRTC: ${s}`);
    if (s === "failed" || s === "disconnected") {
      showToast("Connection " + s, 3500);
    }
  };
  return conn;
}

/** Add outgoing tracks, or recv-only transceivers if there is no local camera/mic. */
function addMediaToPeerConnection() {
  if (!pc) return;
  if (stream) {
    stream.getTracks().forEach((t) => {
      pc.addTrack(t, stream);
    });
  } else {
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
  }
}

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

async function startAsOfferer() {
  if (!sigWs || sigWs.readyState !== WebSocket.OPEN) return;
  iceBuffer = [];
  pc = makePeerConnection();
  addMediaToPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sigWs.send(JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp }));
  setRtcStatus("WebRTC: offer sent");
}

async function handleIncomingOffer(sdpText) {
  if (!sigWs || sigWs.readyState !== WebSocket.OPEN) return;
  if (!pc) {
    pc = makePeerConnection();
    addMediaToPeerConnection();
  }
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sdpText }));
  await flushIceBuffer();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sigWs.send(JSON.stringify({ type: "answer", sdp: pc.localDescription.sdp }));
  setRtcStatus("WebRTC: answer sent");
}

async function handleIncomingAnswer(sdpText) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: sdpText }));
  await flushIceBuffer();
  setRtcStatus("WebRTC: connected");
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

function teardownPeerConnection() {
  iceBuffer = [];
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  if (sigWs) {
    sigWs.onopen = null;
    sigWs.onmessage = null;
    sigWs.onerror = null;
    sigWs.onclose = null;
    if (sigWs.readyState === WebSocket.OPEN || sigWs.readyState === WebSocket.CONNECTING) {
      sigWs.close();
    }
    sigWs = null;
  }
  if (remoteVideo) {
    remoteVideo.srcObject = null;
  }
  setRemotePlaceholderVisible(true);
  setRtcStatus("");
}

function connectSignaling() {
  teardownPeerConnection();
  const url = signalUrl();
  setRtcStatus(`Signaling: connecting… (${url})`);
  try {
    sigWs = new WebSocket(url);
  } catch (e) {
    showToast("Bad signal URL: " + e, 4000);
    setRtcStatus("");
    return;
  }

  sigWs.onopen = () => {
    const room = currentRoomId();
    if (roomInput) roomInput.value = room;
    sigWs.send(JSON.stringify({ type: "join", room }));
    showToast("Signaling: joined room “" + room + "”", 2500);
  };

  sigWs.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "joined") {
      setRtcStatus(msg.peers < 2 ? "Waiting for peer in this room…" : "Pairing…");
      return;
    }
    if (msg.type === "error") {
      showToast(msg.message || "Signaling error", 4000);
      return;
    }
    if (msg.type === "peer") {
      if (msg.role === "offer") {
        await startAsOfferer();
      }
      return;
    }
    if (msg.type === "peer-left") {
      teardownPeerConnection();
      showToast("Peer left — tap Join peer to call again", 4000);
      setRtcStatus("Peer disconnected");
      return;
    }
    if (msg.type === "offer" && msg.sdp) {
      await handleIncomingOffer(msg.sdp);
      return;
    }
    if (msg.type === "answer" && msg.sdp) {
      await handleIncomingAnswer(msg.sdp);
      return;
    }
    if (msg.type === "ice") {
      await handleIncomingIce(msg.candidate);
    }
  };

  sigWs.onerror = () => {
    showToast("Signaling WebSocket error — is signaling_server.py running?", 5000);
    setRtcStatus("Signaling failed");
  };

  sigWs.onclose = () => {
    if (!pc) setRtcStatus("");
  };
}

function stopTracks() {
  teardownPeerConnection();
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (video) {
    video.srcObject = null;
    video.remove();
    video = null;
  }
  swapchain = null;
  window.__vcallSwapchain = null;
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  timeDomainData = null;
  micFill.style.width = "0%";
}

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
  const rms = Math.sqrt(sum / timeDomainData.length);
  const level = Math.min(1, rms * 3.2);
  micFill.style.width = `${Math.round(level * 100)}%`;
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
    const imageData = ctx.getImageData(0, 0, vw, vh);
    commitFrameToSwapchain(imageData);
  }

  updateMicMeter();
  rafId = requestAnimationFrame(renderLoop);
}

function waitForVideoMetadata(el) {
  if (el.readyState >= HTMLMediaElement.HAVE_METADATA && el.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onMeta = () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("error", onErr);
      reject(new Error("Video element error"));
    };
    el.addEventListener("loadedmetadata", onMeta, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

async function startCall() {
  stopTracks();
  placeholder.hidden = false;
  setPlaceholderMessage("Starting camera…");
  setStartButtonVisible(false);
  if (btnMic) btnMic.disabled = true;
  showToast("Requesting camera & mic…");

  const mediaErr = getMediaAccessError();
  if (mediaErr) {
    if (location.protocol === "file:") {
      showToast(mediaErr.toast, 10000);
      setPlaceholderMessage(mediaErr.placeholder);
      setStartButtonVisible(false);
      return;
    }
    enterReceiveOnlyMode(
      "No camera API on this page. Tap Join peer to test signaling / WebRTC (receive only).",
      mediaErr.toast
    );
    return;
  }

  const audioOpts = { echoCancellation: true, noiseSuppression: true };
  const videoIdeal = { width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { ...videoIdeal, facingMode: "user" },
      audio: audioOpts,
    });
  } catch (e1) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoIdeal,
        audio: audioOpts,
      });
    } catch (e2) {
      const err = e2 && e2.message ? e2.message : String(e2);
      enterReceiveOnlyMode(
        "No camera/mic — tap Join peer to test connection (receive only). You can try Start camera again later.",
        "Could not open camera: " + err
      );
      return;
    }
  }

  video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);

  video.srcObject = stream;

  try {
    await waitForVideoMetadata(video);
    await video.play();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.remove();
    video = null;
    enterReceiveOnlyMode(
      "Could not play local preview — tap Join peer to test connection (receive only).",
      msg
    );
    return;
  }

  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  canvas.width = vw;
  canvas.height = vh;
  ensureSwapchainForSize(vw, vh);

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);
  timeDomainData = new Uint8Array(analyser.fftSize);

  if (audioCtx.state === "suspended") {
    await audioCtx.resume().catch(() => {});
  }

  placeholder.hidden = true;
  showToast("Camera ready — tap Join peer with the same room on the other device");
  if (btnJoin) btnJoin.disabled = false;
  if (btnMic) btnMic.disabled = false;
  setRemotePlaceholderVisible(true);

  rafId = requestAnimationFrame(renderLoop);
}

btnMic.addEventListener("click", () => {
  if (!stream) return;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) return;
  const enabled = !audioTracks[0].enabled;
  audioTracks.forEach((t) => {
    t.enabled = enabled;
  });
  btnMic.classList.toggle("muted", !enabled);
  btnMic.setAttribute("aria-pressed", String(!enabled));
  showToast(enabled ? "Mic on" : "Mic muted");
});

btnHangup.addEventListener("click", () => {
  stopTracks();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  placeholder.hidden = false;
  setPlaceholderMessage("Call ended. Tap Join peer or Start camera again.");
  setStartButtonVisible(true);
  if (btnJoin) btnJoin.disabled = false;
  if (btnMic) {
    btnMic.disabled = true;
    btnMic.classList.remove("muted");
    btnMic.setAttribute("aria-pressed", "false");
  }
  showToast("Call ended");
});

if (btnStartCamera) {
  btnStartCamera.addEventListener("click", () => {
    startCall();
  });
}

if (btnJoin) {
  btnJoin.addEventListener("click", () => {
    connectSignaling();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
});

function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get("room") && roomInput) {
    roomInput.value = params.get("room");
  }
  const mediaErr = getMediaAccessError();
  if (mediaErr) {
    if (location.protocol === "file:") {
      setPlaceholderMessage(mediaErr.placeholder);
      setStartButtonVisible(false);
      showToast(mediaErr.toast, 10000);
      return;
    }
    enterReceiveOnlyMode(mediaErr.placeholder, mediaErr.toast);
    return;
  }
  startCall();
}

boot();
