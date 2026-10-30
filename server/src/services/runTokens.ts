// Per-run credentials for the agents the dashboard launches. Each run gets its own random bearer
// token, bound to that run and its lane; it stops working when the run ends or its time is up.
// Runs never receive DASHBOARD_KEY — that key stays with the owner's own interactive clients
// and scripts. Tokens live in memory only: a dashboard restart also ends every run.
import crypto from "node:crypto";

/** What a run may act on: Minecraft only, or the whole server (the ops agent). */
export type RunLane = "minecraft" | "ops";
/** What started the run: a Discord player's message, or the dashboard itself (incident, owner, button). */
export type RunOrigin = "discord" | "dashboard";

export interface RunClaims {
  runId: string;
  lane: RunLane;
  origin: RunOrigin;
  /** the Discord member whose message started the run (per-member limits) */
  requester?: string;
  expiresAt: number;
}

const PREFIX = "hlr_";
const tokens = new Map<string, RunClaims>();
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export function isRunToken(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function issueRunToken(claims: Omit<RunClaims, "expiresAt">, ttlMs: number): string {
  revokeRunToken(claims.runId);
  const token = PREFIX + crypto.randomBytes(32).toString("base64url");
  tokens.set(hash(token), { ...claims, expiresAt: Date.now() + ttlMs });
  return token;
}

export function verifyRunToken(token: string): RunClaims | null {
  if (!isRunToken(token)) return null;
  const key = hash(token);
  const claims = tokens.get(key);
  if (!claims) return null;
  if (Date.now() >= claims.expiresAt) {
    tokens.delete(key);
    return null;
  }
  return claims;
}

export function revokeRunToken(runId: string): void {
  for (const [key, claims] of tokens) if (claims.runId === runId) tokens.delete(key);
}
