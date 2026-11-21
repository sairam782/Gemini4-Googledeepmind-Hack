import type { ServerMsg } from "../../../shared/protocol.ts";
import type { Signaling } from "./signaling.ts";

const ICE: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};

/**
 * One audio-only peer connection. Alex always offers; the caller always answers.
 * `outgoing` is the track this side publishes (for Alex: the mixer output, never the raw mic).
 */
export class AudioCall {
  pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  onRemoteStream: (s: MediaStream) => void = () => {};
  onState: (s: RTCPeerConnectionState | "idle") => void = () => {};

  constructor(
    private sig: Signaling,
    private outgoing: MediaStreamTrack,
    private isOfferer: boolean,
  ) {
    sig.on((m) => void this.onSignal(m));
  }

  private fresh() {
    this.pc?.close();
    const pc = new RTCPeerConnection(ICE);
    this.pc = pc;
    (window as unknown as { __pc?: RTCPeerConnection }).__pc = pc; // debugging aid
    this.pendingIce = [];
    pc.addTrack(this.outgoing, new MediaStream([this.outgoing]));
    pc.ontrack = (e) => this.onRemoteStream(e.streams[0] ?? new MediaStream([e.track]));
    pc.onicecandidate = (e) => {
      if (e.candidate) this.sig.send({ type: "signal", data: { kind: "ice", candidate: e.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => this.onState(pc.connectionState);
    return pc;
  }

  private async onSignal(m: ServerMsg) {
    if (m.type === "peer.joined" && this.isOfferer) {
      const pc = this.fresh();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sig.send({ type: "signal", data: { kind: "offer", sdp: offer.sdp! } });
    } else if (m.type === "peer.left") {
      this.pc?.close();
      this.pc = null;
      this.onState("idle");
    } else if (m.type === "signal") {
      const d = m.data;
      if (d.kind === "offer") {
        const pc = this.fresh();
        await pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
        await this.flushIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sig.send({ type: "signal", data: { kind: "answer", sdp: answer.sdp! } });
      } else if (d.kind === "answer" && this.pc) {
        await this.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
        await this.flushIce();
      } else if (d.kind === "ice") {
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(d.candidate).catch(() => {});
        else this.pendingIce.push(d.candidate);
      }
    }
  }

  private async flushIce() {
    for (const c of this.pendingIce.splice(0)) await this.pc?.addIceCandidate(c).catch(() => {});
  }

  close() {
    this.pc?.close();
    this.pc = null;
  }
}
