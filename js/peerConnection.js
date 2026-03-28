/**
 * Browser RTCPeerConnection factory — no DOM; wire callbacks from the UI layer.
 */

export const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

export function waitForIceGatheringComplete(conn) {
  if (conn.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (conn.iceGatheringState === "complete") {
        conn.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    conn.addEventListener("icegatheringstatechange", done);
    setTimeout(() => {
      conn.removeEventListener("icegatheringstatechange", done);
      resolve();
    }, 10000);
  });
}

/**
 * @param {{
 *   iceServers?: RTCIceServer[];
 *   iceViaWebSocket?: boolean;
 *   sendIceCandidate?: (init: RTCIceCandidateInit) => void;
 *   onTrack?: (ev: RTCTrackEvent) => void;
 *   onConnectionStateChange?: (state: RTCPeerConnectionState, pc: RTCPeerConnection) => void;
 * }} opts
 */
export function createPeerConnection(opts = {}) {
  const {
    iceServers = ICE_SERVERS,
    iceViaWebSocket = true,
    sendIceCandidate,
    onTrack,
    onConnectionStateChange,
  } = opts;

  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (ev) => {
    if (ev.candidate && iceViaWebSocket && sendIceCandidate) {
      sendIceCandidate(ev.candidate.toJSON());
    }
  };
  if (onTrack) {
    pc.ontrack = onTrack;
  }
  pc.onconnectionstatechange = () => {
    if (onConnectionStateChange) {
      onConnectionStateChange(pc.connectionState, pc);
    }
  };
  return pc;
}
