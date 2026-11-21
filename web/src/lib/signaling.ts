import type { ClientMsg, Role, ServerMsg } from "../../../shared/protocol.ts";

type Listener = (msg: ServerMsg) => void;

/** WebSocket to the server. Reconnects and rejoins automatically. */
export class Signaling {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private closed = false;
  onStatus: (s: "connecting" | "open" | "closed") => void = () => {};

  constructor(
    private role: Role,
    private callId: string,
  ) {
    this.connect();
  }

  private connect() {
    this.onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus("open");
      this.send({ type: "join", role: this.role, callId: this.callId });
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMsg;
      this.listeners.forEach((l) => l(msg));
    };
    ws.onclose = () => {
      this.onStatus("closed");
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    };
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
