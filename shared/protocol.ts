// Wire protocol between browsers and the server.
// Event names follow the build guide's event contract.

export type Role = "alex" | "caller";
export type Floor = "alex" | "revoice" | "ended";
export type Speaker = "alex" | "caller" | "agent";

/** Messages a browser sends to the server. */
export type ClientMsg =
  | { type: "join"; role: Role; callId: string }
  // WebRTC signaling, relayed verbatim to the other peer
  | { type: "signal"; data: SignalData }
  // Control (Alex only). Every control carries the revision it was issued at.
  | { type: "control.delegate"; actionId: string; revision: number }
  | { type: "control.takeback"; actionId: string; revision: number; localSilenceMs: number }
  | { type: "call.end"; actionId: string; revision: number }
  // Caller laptop reports each time incoming audio goes from loud to quiet.
  // The server matches it to the latest takeback to measure takeback-to-silence.
  // (The caller never learns that a takeback happened; this is just a level edge.)
  | { type: "probe.silent" }
  | { type: "ping"; t: number };

export type SignalData =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

/** Events the server sends. `channel` says who may receive it. */
export type ServerMsg =
  // `state` is only included for Alex: floor and revision are private.
  | { type: "joined"; role: Role; callId: string; state?: CallState }
  | { type: "peer.joined"; role: Role }
  | { type: "peer.left"; role: Role }
  | { type: "signal"; data: SignalData }
  | { type: "state"; state: CallState }
  | { type: "action.accepted"; actionId: string; revision: number }
  | { type: "action.rejected"; actionId: string; revision: number; reason: string }
  | { type: "control.delegate"; revision: number }
  | { type: "control.takeback"; revision: number; reason: string }
  | { type: "call.end"; revision: number; reason: string }
  | { type: "metric"; name: "takeback.remoteSilenceMs"; value: number }
  | { type: "pong"; t: number; serverT: number }
  | { type: "error"; message: string };

export interface CallState {
  callId: string;
  floor: Floor;
  revision: number;
  peers: Role[];
}

/** Events that may be sent to the caller. Everything else is Alex-only. */
export const PUBLIC_EVENTS = new Set<ServerMsg["type"]>([
  "joined",
  "peer.joined",
  "peer.left",
  "signal",
  "pong",
  "error",
]);
