import { z } from "zod";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";

function validLink(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "magnet:") {
      return url.searchParams.getAll("xt").some((xt) => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt) || /^urn:btmh:1220[a-f0-9]{64}$/i.test(xt));
    }
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const TorrentInput = z.object({
  urls: z.string().trim().min(1, "Paste at least one torrent link").max(40_000)
    .transform((text) => [...new Set(text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(8000).refine(validLink, "Use a valid magnet link or HTTP/HTTPS torrent download URL")).min(1).max(20, "Submit up to 20 links at a time")),
  paused: z.boolean().default(false),
});

interface Connection { url: string | null; username?: string; password?: string }

export class QbittorrentClient {
  private cookie: string | null = null;
  private login: Promise<void> | null = null;
  constructor(private connection: Connection) {}

  private async request(endpoint: string, body?: URLSearchParams): Promise<Response> {
    const base = this.connection.url;
    if (!base) throw new HttpError(503, "qBittorrent is not configured");
    try {
      return await fetch(`${base}/api/v2/${endpoint}`, {
        method: body ? "POST" : "GET",
        headers: { Referer: `${base}/`, ...(this.cookie ? { Cookie: this.cookie } : {}) },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(502, body && endpoint === "torrents/add"
        ? "Could not confirm submission. Check qBittorrent before retrying; it may have received the links."
        : "Could not connect to qBittorrent. Try again when it is available.");
    }
  }

  private async authenticate(): Promise<void> {
    if (!this.connection.username || this.cookie) return;
    if (!this.login) {
      this.login = (async () => {
        const res = await this.request("auth/login", new URLSearchParams({ username: this.connection.username!, password: this.connection.password ?? "" }));
        if (!res.ok || (await res.text()).trim() !== "Ok.") throw new HttpError(502, "qBittorrent login failed. Check the server's configured credentials.");
        this.cookie = res.headers.get("set-cookie")?.match(/(?:^|,\s*)SID=([^;]+)/)?.[0].replace(/^,\s*/, "") ?? null;
        if (!this.cookie) throw new HttpError(502, "qBittorrent did not return a login session");
      })().finally(() => { this.login = null; });
    }
    await this.login;
  }

  private check(res: Response): void {
    if (res.status === 403 || res.status === 401) {
      this.cookie = null;
      throw new HttpError(502, "qBittorrent requires authentication. Check its server connection settings, then try again.");
    }
    if (!res.ok) throw new HttpError(502, `qBittorrent returned HTTP ${res.status}`);
  }

  async status(): Promise<{ reachable: boolean; version?: string; error?: string }> {
    try {
      await this.authenticate();
      const res = await this.request("app/version");
      this.check(res);
      const version = (await res.text()).trim();
      if (!/^v?\d+\.\d+/.test(version)) throw new HttpError(502, "Unexpected response from qBittorrent");
      return { reachable: true, version };
    } catch (e) {
      return { reachable: false, error: (e as Error).message };
    }
  }

  async add(input: z.output<typeof TorrentInput>): Promise<{ submitted: number; failed?: number }> {
    await this.authenticate();
    const res = await this.request("torrents/add", new URLSearchParams({ urls: input.urls.join("\n"), stopped: String(input.paused), paused: String(input.paused) }));
    this.check(res);
    const reply = (await res.text()).trim();
    if (reply === "Ok.") return { submitted: input.urls.length };
    // qBittorrent 5.2 returns per-submission counts instead of the older plain Ok.
    let result: { success_count?: number; pending_count?: number; failure_count?: number } | null = null;
    try { result = JSON.parse(reply); } catch { /* older API error or unexpected response */ }
    if (result && [result.success_count, result.pending_count, result.failure_count].every((n) => Number.isInteger(n) && n! >= 0)) {
      const submitted = result.success_count! + result.pending_count!;
      if (submitted) return { submitted, ...(result.failure_count ? { failed: result.failure_count } : {}) };
      if (result.failure_count) throw new HttpError(502, "qBittorrent rejected the links. Check that each URL points to a torrent file or is a valid magnet link.");
    }
    if (reply === "Fails.") throw new HttpError(502, "qBittorrent rejected the submission. Check that each URL points to a torrent file or is a valid magnet link.");
    throw new HttpError(502, "Could not confirm qBittorrent's response. Check qBittorrent before retrying; it may have received the links.");
  }
}

const client = new QbittorrentClient(cfg.qbittorrent);

export async function torrentStatus() {
  // [DEMO] simulated connection; demo never talks to a real torrent client.
  if (cfg.demo) return { reachable: true, version: "demo" };
  return client.status();
}

export async function addTorrents(input: z.output<typeof TorrentInput>) {
  // [DEMO] acknowledge links without adding or downloading anything.
  if (cfg.demo) return { submitted: input.urls.length, demo: true };
  return client.add(input);
}
