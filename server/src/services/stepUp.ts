import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { HttpError } from "../errors.js";

interface Account { secret: string; recovery: string[]; counter: number; enforced: boolean; tailnetExempt: boolean }
interface RecordFile { version: 1; accounts: Record<string, Account> }
interface Pending { login: string; session: string; secret: string; expires: number }
interface Challenge { login: string; session: string; target: string; expires: number }
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const token = () => crypto.randomBytes(32).toString("hex");
const equal = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** One server process owns writes. Only encrypted TOTP secrets and recovery hashes reach disk. */
export class StepUpStore {
  private key!: Buffer;
  private records: RecordFile = { version: 1, accounts: {} };
  private pending = new Map<string, Pending>();
  private challenges = new Map<string, Challenge>();
  private permits = new Map<string, Challenge>();
  private attempts = new Map<string, { count: number; reset: number }>();
  private writes: Promise<unknown> = Promise.resolve();
  private broken = false;
  constructor(private dir: string, private now = Date.now) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const filename = path.join(this.dir, "step-up.json");
    try { this.records = JSON.parse(await fs.readFile(filename, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (this.records.version !== 1 || !this.records.accounts || typeof this.records.accounts !== "object") throw new Error("Invalid step-up security state; refusing to disable protection");
    const keyfile = path.join(this.dir, "step-up.key");
    try { this.key = await fs.readFile(keyfile); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (Object.keys(this.records.accounts).length) throw new Error("Step-up encryption key is missing; restore it with step-up.json");
      this.key = crypto.randomBytes(32);
      await fs.writeFile(keyfile, this.key, { mode: 0o600, flag: "wx" });
    }
    if (this.key.length !== 32) throw new Error("Invalid step-up encryption key");
    await fs.chmod(keyfile, 0o600);
    for (const account of Object.values(this.records.accounts)) {
      this.decrypt(account.secret); // Fail closed on corrupted state or the wrong key.
      if (!Array.isArray(account.recovery) || !account.recovery.every((s) => /^[a-f0-9]{64}$/.test(s)) || !Number.isSafeInteger(account.counter) || typeof account.enforced !== "boolean" || typeof account.tailnetExempt !== "boolean") throw new Error("Invalid step-up account");
    }
    if (Object.keys(this.records.accounts).length) await fs.chmod(filename, 0o600);
  }

  private loginKey(login: string) { return hash(login.toLowerCase()); }
  private account(login: string) { return this.records.accounts[this.loginKey(login)]; }
  private encrypt(secret: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((p) => p.toString("base64")).join(".");
  }
  private decrypt(value: string): string {
    const [iv, tag, ciphertext] = value.split(".").map((v) => Buffer.from(v, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
  private totp(login: string, secret: string) {
    return new OTPAuth.TOTP({ issuer: "Home Server Dashboard", label: login, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
  }
  private async save() {
    const file = path.join(this.dir, "step-up.json");
    const tmp = `${file}.${token()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(this.records), { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (e) { this.broken = true; throw e; }
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writes.then(fn);
    this.writes = next.catch(() => {});
    return next;
  }
  private sweep() {
    for (const map of [this.pending, this.challenges, this.permits]) for (const [id, value] of map) if (value.expires <= this.now()) map.delete(id);
    for (const [id, value] of this.attempts) if (value.reset <= this.now()) this.attempts.delete(id);
  }
  private limit(login: string, kind = "code", max = 5) {
    this.sweep();
    const key = `${kind}:${this.loginKey(login)}`;
    const attempt = this.attempts.get(key) ?? { count: 0, reset: this.now() + 5 * 60_000 };
    if (attempt.count >= max) throw new HttpError(429, "Too many attempts. Wait five minutes before trying again.");
    attempt.count++;
    this.attempts.set(key, attempt);
  }
  activeAccounts() {
    if (this.broken) throw new HttpError(503, "Security state could not be saved. Protected actions are unavailable until it is repaired.");
    return Object.values(this.records.accounts).filter((a) => a.enforced).length;
  }
  status(login: string, via: string) {
    const a = this.account(login);
    return { enrolled: !!a, enforced: a?.enforced ?? false, tailnetExempt: a?.tailnetExempt ?? false,
      recoveryCodesRemaining: a?.recovery.length ?? 0, activeAccounts: this.activeAccounts(),
      required: this.activeAccounts() > 0 && !(via === "tailscale" && a?.tailnetExempt) };
  }
  async begin(login: string, session: string) {
    this.limit(login, "enroll", 3);
    if (this.account(login)) throw new HttpError(409, "An authenticator is already enrolled. Disable it with a code before replacing it.");
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const id = token();
    for (const [key, value] of this.pending) if (value.login === login && value.session === session) this.pending.delete(key);
    this.pending.set(id, { login, session, secret, expires: this.now() + 10 * 60_000 });
    const uri = this.totp(login, secret).toString();
    return { enrollmentId: id, secret, qr: await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2, width: 256 }) };
  }
  private recoveryCodes(login: string) {
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(16).toString("hex").match(/.{1,8}/g)!.join("-"));
    return { codes, hashes: codes.map((code) => this.recoveryHash(login, code)) };
  }
  private recoveryHash(login: string, code: string) { return hash(`recovery:${this.loginKey(login)}:${code.toLowerCase().replace(/-/g, "")}`); }
  async confirm(login: string, session: string, id: string, code: string) {
    return this.exclusive(async () => {
      this.limit(login);
      const pending = this.pending.get(id);
      if (!pending || pending.login !== login || pending.session !== session || pending.expires <= this.now()) throw new HttpError(400, "Enrollment expired. Start again.");
      if (this.account(login)) throw new HttpError(409, "An authenticator is already enrolled");
      const delta = this.totp(login, pending.secret).validate({ token: code, timestamp: this.now(), window: 1 });
      if (delta === null) throw new HttpError(400, "The authenticator code is incorrect. Check your phone's clock and try again.");
      const recovery = this.recoveryCodes(login);
      this.records.accounts[this.loginKey(login)] = { secret: this.encrypt(pending.secret), recovery: recovery.hashes,
        counter: Math.floor(this.now() / 30_000) + delta, enforced: true, tailnetExempt: false };
      await this.save();
      this.attempts.delete(`code:${this.loginKey(login)}`);
      this.pending.delete(id);
      return { recoveryCodes: recovery.codes };
    });
  }
  challenge(login: string, session: string, target: string) {
    this.sweep();
    if (this.challenges.size >= 2000) throw new HttpError(429, "Too many pending confirmations. Try again shortly.");
    const id = token();
    this.challenges.set(id, { login, session, target, expires: this.now() + 2 * 60_000 });
    return id;
  }
  async verify(login: string, session: string, id: string, code: string) {
    return this.exclusive(async () => {
      this.limit(login);
      const challenge = this.challenges.get(id);
      if (!challenge || challenge.login !== login || challenge.session !== session || challenge.expires <= this.now()) throw new HttpError(400, "Confirmation expired. Cancel and try the action again.");
      const a = this.account(login);
      if (!a) throw new HttpError(403, "Enroll an authenticator first");
      let method = "authenticator";
      if (/^\d{6}$/.test(code)) {
        const delta = this.totp(login, this.decrypt(a.secret)).validate({ token: code, timestamp: this.now(), window: 1 });
        if (delta === null) throw new HttpError(400, "Incorrect authenticator code");
        const counter = Math.floor(this.now() / 30_000) + delta;
        if (counter <= a.counter) throw new HttpError(400, "This code was already used. Wait for the next code on your authenticator.");
        a.counter = counter;
      } else {
        const digest = this.recoveryHash(login, code);
        const index = a.recovery.findIndex((stored) => equal(stored, digest));
        if (index < 0) throw new HttpError(400, "Incorrect or already used recovery code");
        a.recovery.splice(index, 1);
        method = "recovery code";
      }
      await this.save();
      this.attempts.delete(`code:${this.loginKey(login)}`);
      this.challenges.delete(id);
      const permit = token();
      this.permits.set(hash(permit), { ...challenge, expires: this.now() + 60_000 });
      return { permit, method };
    });
  }
  consume(login: string, session: string, target: string, permit: string): boolean {
    this.sweep();
    const key = hash(permit);
    const p = this.permits.get(key);
    if (!p || p.login !== login || p.session !== session || p.target !== target || p.expires <= this.now()) return false;
    this.permits.delete(key);
    return true;
  }
  async settings(login: string, tailnetExempt: boolean) {
    await this.exclusive(async () => {
      const a = this.account(login);
      if (!a) throw new HttpError(400, "No authenticator is enrolled");
      a.tailnetExempt = tailnetExempt;
      await this.save();
    });
  }
  async rotateRecovery(login: string) {
    return this.exclusive(async () => {
      const a = this.account(login);
      if (!a) throw new HttpError(400, "No authenticator is enrolled");
      const recovery = this.recoveryCodes(login);
      a.recovery = recovery.hashes;
      await this.save();
      return { recoveryCodes: recovery.codes };
    });
  }
  async disable(login: string) {
    await this.exclusive(async () => {
      delete this.records.accounts[this.loginKey(login)];
      await this.save();
      for (const map of [this.challenges, this.permits]) for (const [key, p] of map) if (p.login === login) map.delete(key);
    });
  }
}
