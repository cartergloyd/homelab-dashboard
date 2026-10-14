// Minecraft Server List Ping (the status query the multiplayer screen uses).
// Works without RCON and returns players, MOTD and version.
import net from "node:net";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import type { McPing } from "../types.js";

function varInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
    if (shift > 35) throw new Error("VarInt too long");
  }
  return { value: result, size: pos - offset };
}

function packet(...parts: Buffer[]): Buffer {
  const data = Buffer.concat(parts);
  return Buffer.concat([varInt(data.length), data]);
}

function mcString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([varInt(b.length), b]);
}

interface ChatComponent {
  text?: string;
  extra?: (ChatComponent | string)[];
}

function flattenText(c: ChatComponent | string | undefined): string {
  if (!c) return "";
  if (typeof c === "string") return c;
  return (c.text ?? "") + (c.extra ?? []).map(flattenText).join("");
}

export async function pingServer(host = cfg.minecraft.host, port = cfg.minecraft.port, timeoutMs = 4000): Promise<McPing | null> {
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return demo.ping();
  return new Promise<McPing | null>((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error("Server list ping timed out")), timeoutMs);
    const done = (err?: Error, value?: McPing) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value ?? null);
    };

    sock.on("error", (e) => done(e));
    sock.on("connect", () => {
      const handshake = packet(varInt(0x00), varInt(-1), mcString(host), Buffer.from([(port >> 8) & 0xff, port & 0xff]), varInt(1));
      sock.write(Buffer.concat([handshake, packet(varInt(0x00))]));
    });
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarInt(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const id = readVarInt(buf, len.size);
        if (!id) return;
        const strLen = readVarInt(buf, len.size + id.size);
        if (!strLen) return;
        const start = len.size + id.size + strLen.size;
        if (buf.length < start + strLen.value) return;
        const json = JSON.parse(buf.subarray(start, start + strLen.value).toString("utf8")) as {
          players?: { online?: number; max?: number; sample?: { name: string }[] };
          version?: { name?: string };
          description?: ChatComponent | string;
        };
        done(undefined, {
          online: json.players?.online ?? 0,
          max: json.players?.max ?? 0,
          sample: (json.players?.sample ?? []).map((p) => p.name),
          version: json.version?.name ?? "unknown",
          motd: flattenText(json.description).replace(/§[0-9a-fk-or]/gi, "").trim(),
          latencyMs: Date.now() - started,
        });
      } catch (e) {
        done(e as Error);
      }
    });
  });
}
