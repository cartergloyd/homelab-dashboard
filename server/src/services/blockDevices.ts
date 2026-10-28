import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DriveInventory, StorageDevice } from "../types.js";

const execFileP = promisify(execFile);
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

export function parseBlockDevices(input: unknown): StorageDevice[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as { blockdevices?: unknown }).blockdevices)) throw new Error("Invalid lsblk response");
  function device(input: unknown): StorageDevice | null {
    if (!input || typeof input !== "object") return null;
    const raw = input as Record<string, unknown>;
    const path = text(raw.name);
    const type = text(raw.type);
    if (!path?.startsWith("/dev/") || !type || type === "loop") return null;
    const mounts = Array.isArray(raw.mountpoints) ? raw.mountpoints.map(text).filter((p): p is string => p !== null) : [];
    const size = Number(raw.size);
    return {
      path, type, model: text(raw.model), label: text(raw.label), filesystem: text(raw.fstype), uuid: text(raw.uuid),
      sizeBytes: Number.isFinite(size) && size >= 0 ? size : 0,
      mounts: [...new Set(mounts)], readOnly: raw.ro === true || raw.ro === 1 || raw.ro === "1",
      children: Array.isArray(raw.children) ? raw.children.map(device).filter((d): d is StorageDevice => d !== null) : [],
    };
  }
  return (input as { blockdevices: unknown[] }).blockdevices.map(device).filter((d): d is StorageDevice => d?.type === "disk");
}

let cache: { at: number; value: DriveInventory } | null = null;
let pending: Promise<DriveInventory> | null = null;

export async function driveInventory(): Promise<DriveInventory> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  if (pending) return pending;
  pending = (async () => {
    let value: DriveInventory;
    try {
      const { stdout } = await execFileP("lsblk", ["--json", "--bytes", "--paths", "--exclude", "7", "--output", "NAME,TYPE,SIZE,MODEL,FSTYPE,LABEL,UUID,MOUNTPOINTS,RO"], { timeout: 5000, maxBuffer: 2 << 20 });
      value = { devices: parseBlockDevices(JSON.parse(stdout)), error: null };
    } catch {
      value = { devices: [], error: "Connected drives could not be listed. Mounted filesystems and existing scans are still available." };
    }
    cache = { at: Date.now(), value };
    return value;
  })().finally(() => { pending = null; });
  return pending;
}
