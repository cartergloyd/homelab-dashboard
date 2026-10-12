// Minimal Source RCON client (the protocol Minecraft uses). One connection per
// command: authenticate, send, collect the response, close.
import net from "node:net";
import { cfg } from "../config.js";
import * as demo from "../demo.js";

const TYPE_RESPONSE = 0;
const TYPE_COMMAND = 2;
const TYPE_AUTH = 3;

const ID_AUTH = 1;
const ID_COMMAND = 2;
const ID_MARKER = 3;

function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, 12 + payload.length); // two null terminators
  return buf;
}

export async function rconCommand(command: string, timeoutMs = 6000): Promise<string> {
  if (cfg.demo) return demo.rcon(command);
  const { host, port, password } = cfg.minecraft.rcon;
  if (!password) throw new Error("RCON_PASSWORD is not set");

  return new Promise<string>((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let authed = false;
    let output = "";
    let settle: NodeJS.Timeout | null = null;

    const finish = (err?: Error) => {
      clearTimeout(timer);
      if (settle) clearTimeout(settle);
      sock.destroy();
      if (err) reject(err);
      else resolve(output);
    };
    const timer = setTimeout(() => finish(authed ? undefined : new Error("RCON timed out")), timeoutMs);

    sock.on("error", (e) => finish(e));
    sock.on("connect", () => sock.write(encode(ID_AUTH, TYPE_AUTH, password)));
    sock.on("close", () => finish(authed ? undefined : new Error("RCON connection closed before authentication")));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (len < 10 || buf.length < 4 + len) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + len - 2).toString("utf8");
        buf = buf.subarray(4 + len);

        if (!authed) {
          if (type === TYPE_RESPONSE && body === "") continue; // some servers echo an empty response first
          if (id === -1) return finish(new Error("RCON authentication failed (check RCON_PASSWORD)"));
          authed = true;
          sock.write(encode(ID_COMMAND, TYPE_COMMAND, command));
          // Minecraft answers an unexpected packet type with "Unknown request", which
          // tells us the (possibly multi-packet) command response is complete.
          sock.write(encode(ID_MARKER, TYPE_RESPONSE, ""));
          continue;
        }
        if (id === ID_COMMAND) {
          output += body;
          if (settle) clearTimeout(settle);
          settle = setTimeout(() => finish(), 300); // fallback if no marker reply arrives
        } else if (id === ID_MARKER) {
          return finish();
        }
      }
    });
  });
}

/** Strips Minecraft § colour codes from command output. */
export function stripColour(s: string): string {
  return s.replace(/§[0-9a-fk-or]/gi, "");
}
