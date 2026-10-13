// DEMO=1 fixtures. Lets the whole UI run on a laptop with no Docker, systemd,
// Tailscale, Jellyfin or Minecraft present. Files and backups still operate on
// real (throwaway) directories under DATA_DIR/demo so those flows can be exercised.
//
// [INSTALLER] EVERYTHING IN THIS FILE IS DEMO ONLY. Nothing here runs on the
// server unless DEMO=1 is set — never set DEMO or AUTH_DISABLED on the server.
// The fake players, peers, filesystems, container names, the demo key
// ("demo-key-not-secret") and the three sample scripts (backup_world.py,
// restart_server.py, check_disk.py) are stand-ins. The real equivalents are:
// the owner's existing Python scripts (point SCRIPTS_DIR at them or wrap their
// cron lines with hl-run), the real DASHBOARD_KEY, and whatever `docker ps`,
// `systemctl` and `tailscale status` actually report.

import fs from "node:fs/promises";
import path from "node:path";
import { cfg } from "./config.js";
import type {
  ContainerInfo,
  DatabasePayload,
  Filesystem,
  FolderUsage,
  GeoInfo,
  JellyfinPayload,
  LogSource,
  McPing,
  TailscalePayload,
  UnitState,
  VpnPayload,
} from "./types.js";

const startedAt = Date.now();

async function writeIfMissing(file: string, content: string | Buffer) {
  try {
    await fs.access(file);
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

export async function bootstrapDemo(): Promise<void> {
  const base = path.join(cfg.dataDir, "demo");
  const media = path.join(base, "media");
  const mc = path.join(base, "minecraft");
  const backups = path.join(base, "backups");

  const sample: Record<string, string[]> = {
    Movies: ["Arrival (2016)/Arrival (2016).mkv", "Dune Part Two (2024)/Dune Part Two (2024).mkv", "Heat (1995)/Heat (1995).mp4"],
    Shows: ["Severance/Season 01/Severance S01E01.mkv", "Severance/Season 01/Severance S01E02.mkv", "The Expanse/Season 03/The Expanse S03E01.mkv"],
    Music: ["Daft Punk/Discovery/01 One More Time.flac", "Daft Punk/Discovery/02 Aerodynamic.flac"],
  };
  for (const [root, files] of Object.entries(sample)) {
    for (const f of files) {
      await writeIfMissing(path.join(media, root, f), Buffer.alloc(2048 + Math.floor(Math.random() * 4096)));
    }
  }
  for (const world of ["world", "world_nether", "world_the_end"]) {
    await writeIfMissing(path.join(mc, world, "level.dat"), Buffer.alloc(4096));
    await writeIfMissing(path.join(mc, world, "region", "r.0.0.mca"), Buffer.alloc(16384));
  }
  await writeIfMissing(path.join(mc, "server.properties"), "enable-rcon=true\nrcon.port=25575\nmotd=Demo Paper server\n");
  await fs.mkdir(backups, { recursive: true });

  // Stand-ins for the owner's Python maintenance scripts
  const scripts = path.join(base, "scripts");
  await writeIfMissing(
    path.join(scripts, "backup_world.py"),
    `import time
steps = [
    "Checking server status",
    "Disabling world autosave (save-off)",
    "Flushing world to disk (save-all flush)",
    "Compressing world (12,480 files)",
    "Compressing world_nether",
    "Compressing world_the_end",
    "Copying archive to backup drive",
    "Re-enabling autosave (save-on)",
    "Pruning backups older than 7 days",
]
print("== backup_world.py starting", flush=True)
for i, step in enumerate(steps, 1):
    print(f"[{i}/{len(steps)}] {step}...", flush=True)
    time.sleep(0.6)
    if i == 4:
        for pct in range(0, 101, 25):
            print(f"    {pct}% ({pct * 13} MB)", flush=True)
            time.sleep(0.3)
print("Backup complete: mc-20261013-040001.tar.gz (1.3 GB)", flush=True)
`,
  );
  await writeIfMissing(
    path.join(scripts, "restart_server.py"),
    `import time
print("Warning players: restarting in 10 seconds", flush=True); time.sleep(0.8)
print("say Server restarting in 10 seconds", flush=True); time.sleep(0.8)
print("Stopping server...", flush=True); time.sleep(1.2)
print("[Server thread/INFO]: Saving players", flush=True)
print("[Server thread/INFO]: Saving worlds", flush=True); time.sleep(0.8)
print("Starting minecraft server version 1.21.8", flush=True); time.sleep(1.5)
print("Preparing spawn area: 92%", flush=True); time.sleep(0.6)
print("Done (8.2s)! For help, type \\"help\\"", flush=True)
`,
  );
  await writeIfMissing(
    path.join(scripts, "check_disk.py"),
    `import sys, time
print("Checking /srv/media ... 81% used", flush=True); time.sleep(0.5)
print("WARNING: /srv/media is above 80%", flush=True); time.sleep(0.5)
print("Checking /var/backups ...", flush=True); time.sleep(0.5)
print("ERROR: backup drive /var/backups is not mounted", flush=True)
sys.exit(1)
`,
  );

  if (!cfg.explicit.mediaRoots) {
    cfg.mediaRoots = Object.keys(sample).map((name) => ({ name, path: path.join(media, name) }));
  }
  if (!cfg.explicit.mcDir) cfg.minecraft.dir = mc;
  if (!cfg.explicit.backupDir) cfg.backups.dir = backups;
  if (!cfg.explicit.scriptsDir) cfg.scriptsDir = scripts;
  // Demo edits go to a copy, never the repo's real CLAUDE.md
  if (!cfg.explicit.contextFile) {
    const copy = path.join(base, "CLAUDE.md");
    try {
      await fs.access(copy);
    } catch {
      await fs.copyFile(cfg.contextFile, copy).catch(() => fs.writeFile(copy, "# Instructions (demo copy)\n"));
    }
    cfg.contextFile = copy;
  }
  cfg.dashboardKey ??= "demo-key-not-secret";
}

// ---- systemd -------------------------------------------------------------

const units: Record<string, { active: string; sub: string; since: number }> = {
  minecraft: { active: "active", sub: "running", since: startedAt - 3 * 3600_000 },
  "homelab-dashboard": { active: "active", sub: "running", since: startedAt },
};

export function unitState(unit: string): UnitState | null {
  const u = units[unit.replace(/\.service$/, "")];
  if (!u) return null;
  return {
    unit,
    active: u.active,
    sub: u.sub,
    since: new Date(u.since).toISOString(),
    pid: u.active === "active" ? 4242 : null,
    memoryBytes: u.active === "active" ? 3.1 * 1024 ** 3 : null,
  };
}

export async function unitAction(unit: string, action: "start" | "stop" | "restart"): Promise<void> {
  const u = units[unit.replace(/\.service$/, "")];
  if (!u) throw new Error(`Unit ${unit} not found`);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (action === "stop" || action === "restart") {
    u.active = "deactivating";
    u.sub = "stop-sigterm";
    await wait(1500);
    u.active = "inactive";
    u.sub = "dead";
  }
  if (action === "start" || action === "restart") {
    u.active = "activating";
    u.sub = "start";
    await wait(1500);
    u.active = "active";
    u.sub = "running";
    u.since = Date.now();
  }
}

export function minecraftRunning(): boolean {
  return units.minecraft.active === "active";
}

// ---- docker --------------------------------------------------------------

export function containerInfo(name: string): ContainerInfo {
  return {
    name,
    state: "running",
    status: "healthy",
    image: name.includes("directus") ? "directus/directus:11.9.3" : name.includes("postgres") ? "postgres:16" : "jellyfin/jellyfin:latest",
    startedAt: new Date(startedAt - 26 * 3600_000).toISOString(),
    health: "healthy",
  };
}

// ---- minecraft -----------------------------------------------------------

const players = ["Alex", "Steve", "Jeb_"];

export function rcon(command: string): string {
  if (!minecraftRunning()) throw new Error("Connection refused (server is stopped)");
  const [verb] = command.trim().split(/\s+/);
  switch (verb) {
    case "list":
      return `There are ${players.length} of a max of 20 players online: ${players.join(", ")}`;
    case "say":
    case "save-off":
    case "save-on":
      return "";
    case "save-all":
      return "Saved the game";
    case "tps":
      return "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0";
    case "version":
      return "This server is running Paper version 1.21.8-60-main@abc123 (MC: 1.21.8)";
    default:
      return `Unknown or incomplete command, see below for error\n${command}<--[HERE]`;
  }
}

export function ping(): McPing | null {
  if (!minecraftRunning()) return null;
  return { online: players.length, max: 20, sample: players, version: "Paper 1.21.8", motd: "Demo Paper server", latencyMs: 3 };
}

// ---- jellyfin ------------------------------------------------------------

export function jellyfin(): JellyfinPayload {
  return {
    reachable: true,
    url: cfg.jellyfin.publicUrl,
    info: { version: "10.10.7", serverName: "homeserver", os: "Linux" },
    counts: { Movies: 212, Series: 38, Episodes: 1864, Songs: 2410, Albums: 190 },
    sessions: [
      {
        id: "s1",
        user: "carter",
        client: "Jellyfin Media Player",
        device: "Living room TV",
        lastActivity: new Date().toISOString(),
        nowPlaying: { name: "The Expanse S03E01", type: "Episode", series: "The Expanse", progress: 0.42, paused: false },
      },
      {
        id: "s2",
        user: "guest",
        client: "Jellyfin Web",
        device: "iPhone",
        lastActivity: new Date(Date.now() - 20 * 60_000).toISOString(),
        nowPlaying: null,
      },
    ],
    container: containerInfo("jellyfin"),
  };
}

// ---- database ------------------------------------------------------------

export function pgStats(): DatabasePayload["postgres"] {
  return {
    connected: true,
    version: "PostgreSQL 16.4 on x86_64-pc-linux-gnu",
    sizeBytes: 184 * 1024 ** 2,
    tables: 27,
    topTables: [
      { name: "directus_revisions", rows: 18240, bytes: 61 * 1024 ** 2 },
      { name: "directus_activity", rows: 20110, bytes: 33 * 1024 ** 2 },
      { name: "receipts", rows: 1420, bytes: 9 * 1024 ** 2 },
      { name: "notes", rows: 612, bytes: 3 * 1024 ** 2 },
    ],
  };
}

// ---- storage -------------------------------------------------------------

export function filesystems(): Filesystem[] {
  const mk = (filesystem: string, mount: string, totalGb: number, usedGb: number): Filesystem => {
    const totalBytes = totalGb * 1024 ** 3;
    const usedBytes = usedGb * 1024 ** 3;
    return { filesystem, mount, totalBytes, usedBytes, availBytes: totalBytes - usedBytes, usedPct: Math.round((usedBytes / totalBytes) * 1000) / 10 };
  };
  return [mk("/dev/nvme0n1p2", "/", 465, 121), mk("/dev/sda1", "/srv/media", 3726, 3012), mk("/dev/sdb1", "/var/backups", 931, 212)];
}

export function folders(): FolderUsage[] {
  return [
    { label: "Movies", path: "/srv/media/movies", bytes: 1810 * 1024 ** 3 },
    { label: "Shows", path: "/srv/media/shows", bytes: 1120 * 1024 ** 3 },
    { label: "Music", path: "/srv/media/music", bytes: 82 * 1024 ** 3 },
    { label: "Minecraft server", path: "/opt/minecraft", bytes: 14.2 * 1024 ** 3 },
    { label: "Minecraft backups", path: "/var/backups/minecraft", bytes: 61 * 1024 ** 3 },
  ];
}

// ---- tailscale -----------------------------------------------------------

export function tailscale(): TailscalePayload {
  const peer = (hostName: string, os: string, ip: string, online: boolean, self = false, minsAgo = 0) => ({
    hostName,
    dnsName: `${hostName}.tail1234.ts.net.`,
    os,
    ips: [ip],
    online,
    lastSeen: online ? null : new Date(Date.now() - minsAgo * 60_000).toISOString(),
    self,
  });
  return {
    available: true,
    magicDnsSuffix: "tail1234.ts.net",
    self: peer("homeserver", "linux", "100.101.1.1", true, true),
    peers: [
      peer("carters-macbook", "macOS", "100.101.1.2", true),
      peer("carters-iphone", "iOS", "100.101.1.3", true),
      peer("living-room-tv", "android", "100.101.1.4", false, false, 95),
      peer("work-laptop", "windows", "100.101.1.5", false, false, 1440),
    ],
  };
}

// ---- vpn -----------------------------------------------------------------

export function vpn(): VpnPayload {
  const zurich: GeoInfo = { ip: "185.213.155.72", city: "Zürich", region: "Zürich", country: "CH", org: "AS39351 31173 Services AB", timezone: "Europe/Zurich", hostname: "ch-zrh-wg-203.relays.mullvad.net" };
  const home: GeoInfo = { ip: "73.164.22.9", city: "St. Louis", region: "Missouri", country: "US", org: "AS7922 Comcast Cable Communications, LLC", timezone: "America/Chicago", hostname: null };
  const advice = (name: string) => {
    switch (name) {
      case "Minecraft":
        return "Players connect to your home IP (port forward). Replies must leave via the ISP, not the VPN, or connections hang — this port needs a bypass rule.";
      case "Jellyfin":
        return "Only needed if people reach Jellyfin from the open internet. Over Tailscale it works without any VPN exception.";
      case "Tailscale":
        return "Must stay outside the VPN. Tailscale carries this dashboard, Directus and SSH; if the VPN's kill switch/firewall blocks tailscale0, UDP 41641 or 100.64.0.0/10 you lose remote access.";
      case "Directus":
        return "Reached only over Tailscale, so it rides on the Tailscale exception. No separate rule.";
      case "PostgreSQL":
        return "Bound to 127.0.0.1 — never leaves the machine. Nothing to except.";
      case "Dashboard":
        return "Loopback + tailscale serve — rides on the Tailscale exception.";
      default:
        return "Over Tailscale nothing is needed. If you also SSH in from the internet, it needs a bypass like Minecraft.";
    }
  };
  const row = (name: string, port: string, path: VpnPayload["services"][number]["path"], evidence: string, needed: VpnPayload["services"][number]["needed"]) => ({ name, port, path, evidence, advice: advice(name), needed });
  return {
    checkedAt: new Date().toISOString(),
    state: "connected",
    provider: "Mullvad",
    protocol: "WireGuard",
    iface: "wg0-mullvad",
    endpoint: { host: "185.213.155.66", port: 51820, geo: { ...zurich, ip: "185.213.155.66" } },
    exit: zurich,
    home,
    handshakeAgoSec: 37,
    transfer: { rxBytes: 48.2 * 1024 ** 3, txBytes: 6.1 * 1024 ** 3 },
    connectedSince: new Date(Date.now() - 3 * 86400_000 - 4 * 3600_000).toISOString(),
    killSwitch: true,
    dns: ["10.64.0.1"],
    dnsNote: "DNS goes to a private address (VPN-provided or your router) — not leaking to the ISP's public resolvers.",
    defaultRouteDev: "wg0-mullvad",
    services: [
      row("Minecraft", "25565/tcp", "bypass", 'Found "25565" in routing/firewall rules (fwmark 0xca6c → table main).', "required"),
      row("Jellyfin", "8096/tcp", "bypass", 'Found "8096" in routing/firewall rules (fwmark 0xca6c → table main).', "optional"),
      row("Tailscale", "41641/udp · 100.64.0.0/10", "bypass", "Tailscale policy routing (table 52 / fwmark 0x80000) is present.", "required"),
      row("Directus", "8055/tcp", "bypass", "Carried inside Tailscale, whose policy routing (table 52) is active.", "none"),
      row("PostgreSQL", "5432/tcp (127.0.0.1)", "local", "Bound to loopback.", "none"),
      row("Dashboard", "3000/tcp (127.0.0.1)", "bypass", "Carried inside Tailscale, whose policy routing (table 52) is active.", "none"),
      row("SSH", "22/tcp", "vpn", "Default route is wg0-mullvad; no rule mentions this port.", "recommended"),
    ],
    diagnostics: {
      "ip rule": "0:\tfrom all lookup local\n5210:\tfrom all fwmark 0x80000/0xff0000 lookup main\n5230:\tfrom all fwmark 0x80000/0xff0000 lookup default\n5250:\tfrom all fwmark 0x80000/0xff0000 unreachable\n5270:\tfrom all lookup 52\n32764:\tfrom all lookup main suppress_prefixlength 0\n32765:\tnot from all fwmark 0xca6c lookup 51820\n32766:\tfrom all lookup main\n32767:\tfrom all lookup default",
      "ip route default": "default via wg0-mullvad",
      interfaces: "lo UNKNOWN\neth0 UP\ndocker0 UP bridge\ntailscale0 UNKNOWN tun\nwg0-mullvad UNKNOWN wireguard",
      "wg show all dump": "wg0-mullvad\t<key>\t<key>\t51820\t51820\nwg0-mullvad\t<key>\t(none)\t185.213.155.66:51820\t0.0.0.0/0,::/0\t1760388000\t51754931200\t6549000000\t25",
      "firewall (mangle/nft)": "-A OUTPUT -p tcp -m tcp --sport 25565 -j MARK --set-xmark 0xca6c/0xffffffff\n-A OUTPUT -p tcp -m tcp --sport 8096 -j MARK --set-xmark 0xca6c/0xffffffff",
      "Mullvad CLI": "Connected to ch-zrh-wg-203 in Zürich, Switzerland\nLockdown mode: on",
    },
    notes: [],
  };
}

// ---- logs ----------------------------------------------------------------

const logLines: Record<LogSource, string[]> = {
  minecraft: [
    "[Server thread/INFO]: Alex joined the game",
    "[Server thread/INFO]: <Alex> anyone want to go to the nether?",
    "[Server thread/INFO]: Steve joined the game",
    "[Server thread/INFO]: <Steve> sure, meet at spawn",
    "[Server thread/INFO]: Saved the game",
    "[Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2043ms or 40 ticks behind",
    "[Server thread/INFO]: Jeb_ fell from a high place",
    "[Server thread/INFO]: [Paper] Chunk system: 412 loaded, 18 ticking",
  ],
  jellyfin: [
    "[INF] Playback stopped reported by app Jellyfin Media Player playing The Expanse S03E01",
    "[INF] User carter started playing Arrival (2016)",
    "[INF] Scheduled task Scan Media Library completed in 00:00:41",
    "[WRN] Transcoding: hardware decoder fell back to software for hevc",
    "[INF] Http Response 200 to 100.101.1.2 /Sessions time: 4ms",
  ],
  directus: [
    "[12:00:01] GET /server/health 200 3ms",
    "[12:00:14] POST /items/notes 200 18ms",
    "[12:00:29] GET /items/receipts?limit=25 200 11ms",
    "[12:00:30] WebSocket client connected",
  ],
  postgres: [
    "LOG:  checkpoint starting: time",
    "LOG:  checkpoint complete: wrote 12 buffers (0.1%); 0 WAL file(s) added",
    "LOG:  automatic vacuum of table \"personal.public.directus_activity\": index scans: 1",
  ],
  dashboard: ["GET /api/status 200 41ms", "GET /api/overview 200 88ms", "scheduler: nightly backup next run 04:00", "ws: logs/minecraft client connected"],
  system: [
    "kernel: usb 1-3: new high-speed USB device number 7",
    "systemd[1]: Started Daily apt download activities.",
    "sshd[1203]: Accepted publickey for carter from 100.101.1.2 port 51234",
    "tailscaled[812]: Switching ifconfig to using stable DERP home",
  ],
};

export function logStream(source: LogSource, onLine: (line: string) => void): () => void {
  const pool = logLines[source];
  const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
  const emit = () => onLine(`[${stamp()}] ${pool[Math.floor(Math.random() * pool.length)]}`);
  for (let i = 0; i < 30; i++) emit();
  const timer = setInterval(emit, 700 + Math.random() * 900);
  return () => clearInterval(timer);
}
