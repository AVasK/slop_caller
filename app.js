/**
 * Triple-buffered RGBA frame swapchain for camera frames (JS-side; WASM can adopt same layout).
 */
class FrameSwapchain {
  /**
   * @param {number} width
   * @param {number} height
   * @param {number} [bufferCount=3]
   */
  constructor(width, height, bufferCount = 3) {
    this.width = width;
    this.height = height;
    this.bytesPerPixel = 4;
    this.stride = width * height * this.bytesPerPixel;
    this.bufferCount = bufferCount;
    this.buffers = Array.from({ length: bufferCount }, () =>
      new Uint8ClampedArray(this.stride)
    );
    /** @type {number[]} parallel view for future WASM heap mapping */
    this.bufferIds = this.buffers.map((_, i) => i);
    this.writeIndex = 0;
    /** Index of last fully written frame (safe for readers). */
    this.readIndex = 0;
    this.frameSequence = 0;
  }

  /** Byte length of one slot. */
  get slotByteLength() {
    return this.stride;
  }

  /**
   * @returns {{ buffer: Uint8ClampedArray, index: number }}
   */
  acquireWriteSlot() {
    const buffer = this.buffers[this.writeIndex];
    return { buffer, index: this.writeIndex };
  }

  /** Call after copying a full frame into the current write slot. */
  commitWrite() {
    this.readIndex = this.writeIndex;
    this.frameSequence += 1;
    this.writeIndex = (this.writeIndex + 1) % this.bufferCount;
  }

  /**
   * @returns {{ buffer: Uint8ClampedArray, index: number, sequence: number } | null}
   */
  getReadSnapshot() {
    const buffer = this.buffers[this.readIndex];
    if (this.frameSequence === 0) return null;
    return {
      buffer,
      index: this.readIndex,
      sequence: this.frameSequence,
    };
  }
}

const canvas = document.getElementById("feed-canvas");
const placeholder = document.getElementById("feed-placeholder");
const placeholderMsg = document.getElementById("placeholder-msg");
const btnStartCamera = document.getElementById("btn-start-camera");
const micFill = document.getElementById("mic-meter-fill");
const btnMic = document.getElementById("btn-mic");
const btnHangup = document.getElementById("btn-hangup");
const statusToast = document.getElementById("status-toast");

const ctx = canvas.getContext("2d", { willReadFrequently: true });

/** @type {MediaStream | null} */
let stream = null;
/** @type {HTMLVideoElement | null} */
let video = null;
/** @type {FrameSwapchain | null} */
let swapchain = null;
/** @type {number} */
let rafId = 0;

/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {AnalyserNode | null} */
let analyser = null;
/** @type {Uint8Array | null} */
let timeDomainData = null;

function setStartButtonVisible(visible) {
  if (btnStartCamera) btnStartCamera.hidden = !visible;
}

function setPlaceholderMessage(msg) {
  if (placeholderMsg) placeholderMsg.textContent = msg;
}

function showToast(msg, ms = 2200) {
  statusToast.textContent = msg;
  statusToast.classList.add("visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => statusToast.classList.remove("visible"), ms);
}

function stopTracks() {
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
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  timeDomainData = null;
  micFill.style.width = "0%";
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
      swapchain = new FrameSwapchain(vw, vh, 3);
      window.__vcallSwapchain = swapchain;
    }
    ctx.drawImage(video, 0, 0, vw, vh);
    const { buffer } = swapchain.acquireWriteSlot();
    const imageData = ctx.getImageData(0, 0, vw, vh);
    buffer.set(imageData.data);
    swapchain.commitWrite();
  }

  updateMicMeter();
  rafId = requestAnimationFrame(renderLoop);
}

/**
 * videoWidth/height stay 0 until loadedmetadata on many browsers.
 * @param {HTMLVideoElement} el
 * @returns {Promise<void>}
 */
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
  showToast("Requesting camera & mic…");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast(
      "Camera needs a secure page. Use http://localhost or https (not file://).",
      8000
    );
    setPlaceholderMessage("Open this page via localhost or HTTPS (not file://).");
    setStartButtonVisible(false);
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
      showToast("Could not open camera/mic: " + err, 4000);
      setPlaceholderMessage("Permission denied or no camera.");
      setStartButtonVisible(true);
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
    showToast("Could not play video: " + (e && e.message ? e.message : String(e)), 5000);
    setPlaceholderMessage("Tap “Start camera” after allowing permissions, or try again.");
    setStartButtonVisible(true);
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.remove();
    video = null;
    return;
  }

  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  canvas.width = vw;
  canvas.height = vh;
  swapchain = new FrameSwapchain(vw, vh, 3);

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
  showToast("Connected");

  window.__vcallSwapchain = swapchain;

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
  setPlaceholderMessage("Call ended. Tap Start camera to go again.");
  setStartButtonVisible(true);
  btnMic.classList.remove("muted");
  btnMic.setAttribute("aria-pressed", "false");
  showToast("Call ended");
});

if (btnStartCamera) {
  btnStartCamera.addEventListener("click", () => {
    startCall();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
});

/** First load may not count as a user gesture; offer retry. */
function boot() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setPlaceholderMessage("Use http://localhost or HTTPS (not file://).");
    setStartButtonVisible(false);
    showToast("Serve this folder and open http://localhost:…", 8000);
    return;
  }
  startCall();
}

boot();
