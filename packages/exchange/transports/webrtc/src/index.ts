// @kyneta/webrtc-transport — BYODC WebRTC data channel transport.
//
// Bring Your Own Data Channel: the application manages WebRTC connections
// (signaling, ICE, media streams). This transport attaches to data channels
// for kyneta document synchronization.
//
// Native RTCDataChannel satisfies DataChannelLike structurally — no wrapper
// needed. Libraries like simple-peer can conform via a trivial bridge function.

export type { DataChannelLike } from "./data-channel-like.js"
export {
  createWebrtcTransport,
  DEFAULT_FRAGMENT_THRESHOLD,
  WebrtcTransport,
  type WebrtcTransportOptions,
} from "./webrtc-transport.js"