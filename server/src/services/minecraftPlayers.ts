import type { McPlayers } from "../types.js";

export interface PlayerState {
  players: McPlayers | null;
  rcon: { ok: boolean; error?: string };
}

export function isPlayerChange(text: string): boolean {
  return /\b\S+ (?:joined|left) the game\s*$|\bDone \([\d.]+s\)!.*For help/i.test(text);
}

/** Shared state: log events refresh it; a one-minute check catches missed events. */
export class MinecraftPlayers {
  private state: PlayerState | null = null;
  private checkedAt = 0;
  private revision = 0;
  private dirty = true;
  private pending: Promise<PlayerState> | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly load: () => Promise<McPlayers>, private readonly now = Date.now) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.timer) return;
    void this.read();
    this.timer = setInterval(() => void this.read(), 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = null;
  }

  invalidate(): void {
    this.revision++;
    this.dirty = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.read();
    }, 200);
    this.debounce.unref();
  }

  disconnected(error: Error): void {
    // An in-flight read will publish its own failure. Do not invalidate it into a retry loop.
    if (this.pending) return;
    this.revision++;
    this.dirty = false;
    this.commit({ players: null, rcon: { ok: false, error: error.message } });
  }

  read(): Promise<PlayerState> {
    if (this.pending) return this.pending;
    const ttl = this.state?.rcon.ok ? 60_000 : 15_000;
    if (!this.dirty && this.state && this.now() - this.checkedAt < ttl) return Promise.resolve(this.state);
    this.pending = this.refresh().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async refresh(): Promise<PlayerState> {
    for (;;) {
      const revision = this.revision;
      let next: PlayerState;
      try {
        next = { players: await this.load(), rcon: { ok: true } };
      } catch (error) {
        next = { players: null, rcon: { ok: false, error: (error as Error).message } };
      }
      // A join/leave arriving during a read requires another read, not stale cached names.
      if (revision !== this.revision) continue;
      this.dirty = false;
      this.commit(next);
      return next;
    }
  }

  private commit(next: PlayerState): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    this.checkedAt = this.now();
    if (changed) for (const fn of this.listeners) {
      try { fn(); } catch { /* A disconnected subscriber must not stop monitoring. */ }
    }
  }
}
