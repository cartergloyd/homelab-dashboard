import net from "node:net";

interface ConnectionConfig {
  host: string;
  port: number;
  password: string | undefined;
}

interface Request {
  command: string;
  commandId: number;
  markerId: number;
  output: string;
  sent: boolean;
  timer: NodeJS.Timeout;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
}

function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

/** One authenticated connection; commands are serialized and never replayed. */
export class RconClient {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private authenticated = false;
  private authId = 0;
  private sequence = 0;
  private configKey = "";
  private active: Request | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disconnectListeners = new Set<(error: Error) => void>();

  constructor(private readonly config: () => ConnectionConfig) {}

  get connected(): boolean {
    return this.authenticated && this.socket !== null && !this.socket.destroyed;
  }

  onDisconnect(fn: (error: Error) => void): () => void {
    this.disconnectListeners.add(fn);
    return () => this.disconnectListeners.delete(fn);
  }

  command(command: string, timeoutMs = 6000): Promise<string> {
    const result = this.queue.then(() => this.execute(command, timeoutMs));
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  close(error = new Error("RCON connection closed")): void {
    const hadSocket = this.socket !== null;
    const sock = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.buffer = Buffer.alloc(0);
    sock?.destroy();
    this.finish(error);
    if (hadSocket) for (const fn of this.disconnectListeners) {
      try { fn(error); } catch { /* A subscriber must not break command cleanup. */ }
    }
  }

  private nextId(): number {
    this.sequence = this.sequence % 0x7ffffffe + 1;
    return this.sequence;
  }

  private execute(command: string, timeoutMs: number): Promise<string> {
    const config = this.config();
    const key = JSON.stringify(config);
    if (this.socket && key !== this.configKey) this.close(new Error("RCON settings changed"));
    if (!config.password) return Promise.reject(new Error("RCON_PASSWORD is not set"));
    return new Promise((resolve, reject) => {
      this.active = {
        command, commandId: this.nextId(), markerId: this.nextId(), output: "", sent: false,
        timer: setTimeout(() => this.close(new Error("RCON command timed out; it was not retried")), timeoutMs),
        resolve, reject,
      };
      if (this.connected) {
        this.send();
        return;
      }
      this.configKey = key;
      this.authId = this.nextId();
      const sock = net.connect({ host: config.host, port: config.port });
      this.socket = sock;
      sock.setKeepAlive(true, 30_000);
      sock.unref();
      sock.on("connect", () => {
        if (this.socket === sock) sock.write(encode(this.authId, 3, config.password!));
      });
      sock.on("error", (error) => { if (this.socket === sock) this.close(error); });
      sock.on("close", () => { if (this.socket === sock) this.close(new Error("RCON connection closed")); });
      sock.on("data", (chunk) => {
        if (this.socket !== sock) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const len = this.buffer.readInt32LE(0);
          if (len < 10 || len > 4 * 1024 * 1024) {
            this.close(new Error("Invalid RCON response length"));
            return;
          }
          if (this.buffer.length < len + 4) break;
          const id = this.buffer.readInt32LE(4);
          const type = this.buffer.readInt32LE(8);
          const body = this.buffer.subarray(12, len + 2).toString("utf8");
          this.buffer = this.buffer.subarray(len + 4);
          this.receive(id, type, body);
          if (this.socket !== sock) return;
        }
      });
    });
  }

  private send(): void {
    const request = this.active;
    if (!request || request.sent || !this.socket) return;
    request.sent = true;
    this.socket.write(encode(request.commandId, 2, request.command));
    // Minecraft replies to this unexpected packet type after the command output.
    this.socket.write(encode(request.markerId, 0, ""));
  }

  private receive(id: number, type: number, body: string): void {
    if (id === -1) {
      this.close(new Error("RCON authentication failed (check RCON_PASSWORD)"));
      return;
    }
    if (!this.authenticated) {
      if (id !== this.authId || type !== 2) return;
      this.authenticated = true;
      this.send();
      return;
    }
    const request = this.active;
    if (!request || !request.sent) return;
    if (id === request.commandId) {
      request.output += body;
    } else if (id === request.markerId) {
      this.finish();
    }
  }

  private finish(error?: Error): void {
    const request = this.active;
    if (!request) return;
    this.active = null;
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(request.output);
  }
}
