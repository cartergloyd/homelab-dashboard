// Owner-authorized maintenance runs beyond the HTTP/MCP request lifetime.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import { sleep } from "../util.js";
import { publish } from "./alerts.js";
import { runBackup } from "./backups.js";
import { minecraftAction, minecraftCommand, minecraftStatus } from "./minecraft.js";

export type MaintenanceAction = "restart" | "backup" | "stage_updates" | "apply_updates" | "rollback_updates";
export interface MaintenanceTask {
  id: string; action: MaintenanceAction; reason: string; status: "running" | "completed" | "failed";
  phase: string; startedAt: string; finishedAt: string | null; error: string | null;
}
export interface MaintenanceDependencies {
  online: () => Promise<boolean>;
  announce: (text: string) => Promise<void>;
  service: (action: "start" | "stop") => Promise<void>;
  backup: (offline: boolean) => Promise<unknown>;
  stage: () => Promise<unknown>;
  preflight: () => Promise<void>;
  apply: () => Promise<unknown>;
  rollback: () => Promise<unknown>;
  verify: () => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
  changed: (task: MaintenanceTask) => void;
}
export class MinecraftMaintenance {
  private tasks: MaintenanceTask[] = [];
  constructor(private deps: MaintenanceDependencies) {}
  list(): MaintenanceTask[] { return this.tasks.map(t => ({...t})); }
  active(): MaintenanceTask | undefined { return this.tasks.find(t => t.status === "running"); }
  start(action: MaintenanceAction, reason: string): MaintenanceTask {
    const active = this.active();
    if (active) { if (active.action === action) return {...active}; throw new HttpError(409, `Minecraft maintenance is already running (${active.id}). Check maintenance status before starting another operation.`); }
    const task: MaintenanceTask = { id: crypto.randomUUID(), action, reason, status: "running", phase: "queued", startedAt: new Date().toISOString(), finishedAt: null, error: null };
    this.tasks.unshift(task); this.tasks = this.tasks.slice(0, 100);
    this.deps.changed(task);
    void this.execute(task);
    return {...task};
  }
  private phase(task: MaintenanceTask, phase: string) { task.phase = phase; this.deps.changed(task); }
  private async notice(task: MaintenanceTask) {
    this.phase(task, "Giving players three minutes' notice");
    // Each wait starts after its announcement succeeds; there is always a full 180s notice.
    await this.deps.announce(`Minecraft maintenance: restarting in 3 minutes. ${task.reason.slice(0, 160)}`);
    await this.deps.wait(120_000);
    await this.deps.announce("Minecraft maintenance: restarting in 1 minute.");
    await this.deps.wait(50_000);
    await this.deps.announce("Minecraft maintenance: restarting in 10 seconds.");
    await this.deps.wait(10_000);
  }
  private async execute(task: MaintenanceTask) {
    let stopped = false;
    let updateAttempted = false;
    try {
      if (task.action === "stage_updates") { this.phase(task, "Staging official Paper and plugin updates"); await this.deps.stage(); }
      else if (task.action === "backup") { this.phase(task, "Creating a new backup; existing backups are preserved"); await this.deps.backup(!await this.deps.online()); }
      else {
        if (task.action === "apply_updates") await this.deps.preflight();
        const online = await this.deps.online();
        if (online) await this.notice(task);
        this.phase(task, "Stopping Minecraft for maintenance");
        await this.deps.service("stop"); stopped = true;
        if (task.action === "apply_updates" || task.action === "rollback_updates") {
          this.phase(task, "Backing up worlds without pruning existing backups"); await this.deps.backup(true);
          if (task.action === "apply_updates") { this.phase(task, "Applying verified staged updates with rollback copies"); updateAttempted = true; await this.deps.apply(); }
          else { this.phase(task, "Restoring previous server/plugin versions"); await this.deps.rollback(); }
        }
        this.phase(task, "Starting Minecraft and verifying recovery");
        await this.deps.service("start"); stopped = false;
        await this.deps.verify();
      }
      task.status = "completed"; task.phase = "Completed";
    } catch (error) {
      task.status = "failed"; task.error = (error as Error).message;
      if (updateAttempted) {
        try {
          await this.deps.service("stop"); stopped = true;
          await this.deps.rollback();
          await this.deps.service("start"); stopped = false;
          await this.deps.verify();
          task.error += "; previous versions restored and Minecraft verified online";
        } catch (rollbackError) { task.error += `; rollback needs attention: ${(rollbackError as Error).message}`; }
      }
      if (stopped) {
        try { await this.deps.service("start"); }
        catch (startError) { task.error += `; Minecraft could not start: ${(startError as Error).message}`; }
      }
      task.phase = "Failed";
    } finally { task.finishedAt = new Date().toISOString(); this.deps.changed(task); }
  }
}

const hash = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
// These scripts were reviewed: fixed official upstreams, published checksums where available.
const FETCH_SCRIPT_HASH = "1d40f4cbc561daaba9f30d27b37ddc7d5d0e73881c1d549d8d04823d58b5ab88";
interface StagedJar { relative: string; sha256: string; }
interface RollbackFile { destination: string; original: string | null; }
const pluginDestinations: Record<string, string> = {
  "Geyser-Spigot.jar": "plugins/Geyser-Spigot.jar", "floodgate-spigot.jar": "plugins/floodgate-spigot.jar",
  "ViaVersion.jar": "plugins/ViaVersion.jar", "MCXboxBroadcastExtension.jar": "plugins/Geyser-Spigot/extensions/MCXboxBroadcastExtension.jar",
};

export class TrustedMinecraftUpdates {
  constructor(private directory: string, private stateDirectory: string, private fetchUpdates = async () => {
    const file = path.join(directory, "scripts/fetch_updates.sh");
    if (hash(await fs.readFile(file)) !== FETCH_SCRIPT_HASH) throw new Error("Update fetcher changed since review; refusing to run unreviewed software");
    await promisify(execFile)("bash", [file], { cwd: directory, timeout: 15 * 60_000, maxBuffer: 2 << 20 });
  }) {}
  private get manifestFile() { return path.join(this.stateDirectory, "trusted-minecraft-updates.json"); }
  private get rollbackFile() { return path.join(this.stateDirectory, "minecraft-update-rollback.json"); }
  private async load<T>(file: string, fallback: T): Promise<T> { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
  private async staged(): Promise<StagedJar[]> {
    const entries: StagedJar[] = [];
    for (const kind of ["paper", "plugins"]) {
      const folder = path.join(this.directory, "scripts/updates", kind);
      for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
        if (!name.endsWith(".jar")) continue;
        if (!(kind === "paper" ? /^paper-[\w.+-]+\.jar$/.test(name) : !!pluginDestinations[name])) throw new Error(`Unrecognized staged software: ${name}`);
        const file = path.join(folder, name);
        if (!(await fs.lstat(file)).isFile()) throw new Error("Staged updates must be regular files");
        entries.push({ relative: `${kind}/${name}`, sha256: hash(await fs.readFile(file)) });
      }
    }
    return entries;
  }
  async stage(): Promise<void> {
    const before = await this.staged();
    const trusted = await this.load<StagedJar[]>(this.manifestFile, []);
    await this.fetchUpdates();
    const after = await this.staged();
    const verified = after.filter(item => !before.some(old => old.relative === item.relative && old.sha256 === item.sha256)
      || trusted.some(old => old.relative === item.relative && old.sha256 === item.sha256));
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await fs.writeFile(this.manifestFile, JSON.stringify(verified), { mode: 0o600 });
    if (after.length !== verified.length) throw new Error("Some pre-existing staged jars lack trusted download provenance; they were preserved but will not be installed");
  }
  async preflight(): Promise<void> {
    const staged = await this.staged();
    const trusted = await this.load<StagedJar[]>(this.manifestFile, []);
    if (!staged.length) throw new Error("No staged updates. Use stage_updates first");
    if (staged.filter(i => i.relative.startsWith("paper/")).length > 1) throw new Error("Multiple Paper jars are staged; choose one verified version first");
    for (const item of staged) if (!trusted.some(t => t.relative === item.relative && t.sha256 === item.sha256)) throw new Error("Staged update provenance/checksum changed; refusing installation");
  }
  private destination(relative: string): string {
    const [kind, name] = relative.split("/");
    if (kind === "paper" && /^paper-[\w.+-]+\.jar$/.test(name ?? "")) return "paper-server.jar";
    if (kind === "plugins" && pluginDestinations[name!]) return pluginDestinations[name!];
    throw new Error("Unrecognized update destination");
  }
  private validDestination(relative: string): boolean { return relative === "paper-server.jar" || Object.values(pluginDestinations).includes(relative) || /^plugins\/ViaVersion-[\w.+-]+\.jar$/.test(relative); }
  async apply(): Promise<void> {
    await this.preflight();
    const staged = await this.staged();
    const folder = path.join(this.directory, "scripts/updates/applied_archive", `maintenance-${crypto.randomUUID()}`);
    await fs.mkdir(folder, { recursive: true });
    const copies: RollbackFile[] = [];
    const archive = async (destination: string): Promise<void> => {
      const file = path.join(this.directory, destination);
      const stat = await fs.lstat(file).catch(() => null);
      if (stat && !stat.isFile()) throw new Error("Refusing to replace a symlink or non-file update target");
      const original = stat ? path.join(folder, `${copies.length}-${path.basename(destination)}.previous`) : null;
      if (original) await fs.copyFile(file, original);
      copies.push({ destination, original });
    };
    for (const item of staged) await archive(this.destination(item.relative));
    if (staged.some(i => i.relative === "plugins/ViaVersion.jar")) {
      for (const name of await fs.readdir(path.join(this.directory, "plugins"))) if (/^ViaVersion-[\w.+-]+\.jar$/.test(name)) await archive(`plugins/${name}`);
    }
    await fs.writeFile(this.rollbackFile, JSON.stringify(copies), { mode: 0o600 });
    for (const copy of copies) if (/^plugins\/ViaVersion-/.test(copy.destination)) await fs.rename(path.join(this.directory, copy.destination), path.join(folder, path.basename(copy.destination)));
    for (const item of staged) {
      const target = path.join(this.directory, this.destination(item.relative));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(this.directory, "scripts/updates", item.relative), target + ".maintenance-new");
      await fs.rename(target + ".maintenance-new", target);
      await fs.copyFile(path.join(this.directory, "scripts/updates", item.relative), path.join(folder, path.basename(item.relative)));
    }
    // Keep staging and rollback copies intact; future stage/apply checks remain idempotent.
  }
  async rollback(): Promise<void> {
    const copies = await this.load<RollbackFile[]>(this.rollbackFile, []);
    if (!copies.length) throw new Error("No maintenance rollback copy is available");
    const archiveRoot = path.join(this.directory, "scripts/updates/applied_archive") + path.sep;
    for (const item of copies) {
      if (!this.validDestination(item.destination) || (item.original && !path.resolve(item.original).startsWith(archiveRoot))) throw new Error("Invalid rollback manifest");
      const target = path.join(this.directory, item.destination);
      if (item.original) await fs.copyFile(item.original, target);
      else await fs.unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

let discordAnnounce: ((text: string) => Promise<void>) | null = null;
export function registerMaintenanceAnnouncer(announce: typeof discordAnnounce): void { discordAnnounce = announce; }
const updates = new TrustedMinecraftUpdates(cfg.minecraft.dir, cfg.dataDir);
const stateFile = path.join(cfg.dataDir, "minecraft-maintenance.json");
let writes = Promise.resolve();
export const minecraftMaintenance = new MinecraftMaintenance({
  online: async () => { const status = await minecraftStatus(); if (!status.unit && !status.ping) throw new Error("Minecraft state is unknown; refusing a disruptive operation"); return !!status.ping || status.unit?.active === "active"; },
  announce: async text => {
    const sent = await Promise.allSettled([minecraftCommand(`say ${text}`), ...(discordAnnounce ? [discordAnnounce(text)] : [])]);
    if (!sent.some(s => s.status === "fulfilled")) throw new Error("Cannot notify players; restart was cancelled before stopping Minecraft");
  },
  service: action => minecraftAction(action),
  backup: offline => runBackup(cfg.backups.keep, { preserveExisting: true, offline }),
  stage: () => updates.stage(), preflight: () => updates.preflight(), apply: () => updates.apply(), rollback: () => updates.rollback(),
  verify: async () => { for (let i = 0; i < 60; i++) { const s = await minecraftStatus(); if (s.ping && s.unit?.active === "active") return; await sleep(5000); } throw new Error("Minecraft did not pass its post-maintenance health check"); },
  wait: sleep,
  changed: task => {
    publish({ source: "agent", kind: "agent", level: task.status === "failed" ? "error" : "info", tags: ["maintenance"], text: `Minecraft maintenance ${task.id}: ${task.phase}${task.error ? ` — ${task.error}` : ""}` });
    const data = JSON.stringify(minecraftMaintenance.list());
    writes = writes.catch(() => {}).then(() => fs.writeFile(stateFile, data, { mode: 0o600 }));
  },
});
