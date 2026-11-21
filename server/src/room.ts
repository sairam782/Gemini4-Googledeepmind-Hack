import type { WebSocket } from "ws";
import {
  PUBLIC_EVENTS,
  type CallState,
  type ClientMsg,
  type Floor,
  type Role,
  type ServerMsg,
} from "../../shared/protocol.ts";

/**
 * One live call. Application code owns the floor and the revision;
 * models only ever propose content.
 */
export class CallRoom {
  readonly callId: string;
  floor: Floor = "alex";
  revision = 0;
  private peers = new Map<Role, WebSocket>();
  private consumed = new Set<string>();
  private lastTakebackAt: number | null = null;

  constructor(callId: string) {
    this.callId = callId;
  }

  get state(): CallState {
    return {
      callId: this.callId,
      floor: this.floor,
      revision: this.revision,
      peers: [...this.peers.keys()],
    };
  }

  join(role: Role, ws: WebSocket) {
    const existing = this.peers.get(role);
    if (existing && existing !== ws) existing.close(4000, "replaced by a newer connection");
    this.peers.set(role, ws);

    // Reconnect in listening mode: if Alex rejoins, the floor goes back to Alex.
    if (role === "alex" && this.floor === "revoice") this.setFloor("alex", "alex reconnected");
    if (this.floor === "ended") {
      this.floor = "alex";
      this.revision++;
      this.consumed.clear();
    }

    this.send(role, {
      type: "joined",
      role,
      callId: this.callId,
      state: role === "alex" ? this.state : undefined,
    });
    const other: Role = role === "alex" ? "caller" : "alex";
    if (this.peers.has(other)) {
      // Alex is always the WebRTC offerer, so tell Alex whenever both are present.
      this.send("alex", { type: "peer.joined", role: role === "alex" ? "caller" : role });
      if (role === "alex") this.send("caller", { type: "peer.joined", role: "alex" });
    }
    this.broadcastState();
  }

  leave(role: Role, ws: WebSocket) {
    if (this.peers.get(role) !== ws) return;
    this.peers.delete(role);
    const other: Role = role === "alex" ? "caller" : "alex";
    this.send(other, { type: "peer.left", role });
    if (role === "alex" && this.floor === "revoice") this.setFloor("alex", "alex disconnected");
    this.broadcastState();
  }

  handle(role: Role, msg: ClientMsg) {
    switch (msg.type) {
      case "signal": {
        const other: Role = role === "alex" ? "caller" : "alex";
        this.send(other, { type: "signal", data: msg.data });
        return;
      }
      case "control.delegate":
      case "control.takeback":
      case "call.end":
        return this.control(role, msg);
      case "probe.silent": {
        if (role !== "caller" || this.lastTakebackAt == null) return;
        const ms = Date.now() - this.lastTakebackAt;
        this.lastTakebackAt = null;
        // Ignore stray edges long after a takeback.
        if (ms < 3000) this.send("alex", { type: "metric", name: "takeback.remoteSilenceMs", value: ms });
        return;
      }
      case "ping":
        this.send(role, { type: "pong", t: msg.t, serverT: Date.now() });
        return;
    }
  }

  private control(
    role: Role,
    msg: Extract<ClientMsg, { type: "control.delegate" | "control.takeback" | "call.end" }>,
  ) {
    const reject = (reason: string) =>
      this.send(role, { type: "action.rejected", actionId: msg.actionId, revision: msg.revision, reason });

    if (role !== "alex") return reject("only Alex controls the call");
    if (this.consumed.has(msg.actionId)) return reject("duplicate");

    // Takeback and end always win, even if the revision is stale: silence is never refused.
    const alwaysAllowed = msg.type === "control.takeback" || msg.type === "call.end";
    if (!alwaysAllowed && msg.revision !== this.revision) return reject("stale");

    this.consumed.add(msg.actionId);

    if (msg.type === "control.delegate") {
      if (this.floor !== "alex") return reject(`floor is ${this.floor}`);
      this.setFloor("revoice", "alex delegated");
      this.send("alex", { type: "action.accepted", actionId: msg.actionId, revision: this.revision });
      this.send("alex", { type: "control.delegate", revision: this.revision });
    } else if (msg.type === "control.takeback") {
      // Browser already silenced locally; the server just advances the revision so any
      // late generation tied to the old revision can never be played.
      this.lastTakebackAt = Date.now();
      if (this.floor === "revoice") this.setFloor("alex", "takeback");
      else this.revision++;
      this.send("alex", { type: "action.accepted", actionId: msg.actionId, revision: this.revision });
      this.send("alex", { type: "control.takeback", revision: this.revision, reason: "alex" });
    } else {
      this.setFloor("ended", "alex ended the call");
      this.send("alex", { type: "action.accepted", actionId: msg.actionId, revision: this.revision });
      this.send("alex", { type: "call.end", revision: this.revision, reason: "Alex ended the call" });
    }
    this.broadcastState();
  }

  private setFloor(floor: Floor, _reason: string) {
    this.floor = floor;
    this.revision++;
  }

  private broadcastState() {
    this.send("alex", { type: "state", state: this.state });
  }

  /** The only way anything leaves the server. Enforces the private/public split. */
  send(role: Role, msg: ServerMsg) {
    if (role === "caller" && !PUBLIC_EVENTS.has(msg.type)) return;
    const ws = this.peers.get(role);
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  get empty() {
    return this.peers.size === 0;
  }
}
