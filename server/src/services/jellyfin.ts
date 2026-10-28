import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { containerInfo, restartContainer } from "./docker.js";
import type { JellyfinPayload, JellyfinSession } from "../types.js";

// Jellyfin 12 dropped the legacy X-Emby-Token header; this is the current scheme.
function headers(): Record<string, string> {
  const key = cfg.jellyfin.apiKey ?? "";
  return {
    Accept: "application/json",
    Authorization: `MediaBrowser Token="${key}", Client="homelab-dashboard", Device="server", DeviceId="homelab-dashboard", Version="0.1"`,
  };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${cfg.jellyfin.url}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Jellyfin ${path} → ${res.status}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Unauthenticated liveness probe. Returns latency in ms, or throws. */
export async function health(): Promise<number> {
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return 4;
  const t = Date.now();
  const res = await fetch(`${cfg.jellyfin.url}/health`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`/health → ${res.status}`);
  return Date.now() - t;
}

interface RawSession {
  Id: string;
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  LastActivityDate?: string;
  NowPlayingItem?: { Name: string; Type: string; SeriesName?: string; RunTimeTicks?: number };
  PlayState?: { PositionTicks?: number; IsPaused?: boolean };
}

function mapSession(s: RawSession): JellyfinSession {
  const item = s.NowPlayingItem;
  const runtime = item?.RunTimeTicks ?? 0;
  return {
    id: s.Id,
    user: s.UserName ?? "(unknown)",
    client: s.Client ?? "",
    device: s.DeviceName ?? "",
    lastActivity: s.LastActivityDate ?? "",
    nowPlaying: item
      ? {
          name: item.Name,
          type: item.Type,
          series: item.SeriesName,
          progress: runtime ? (s.PlayState?.PositionTicks ?? 0) / runtime : 0,
          paused: s.PlayState?.IsPaused ?? false,
        }
      : null,
  };
}

export async function overview(): Promise<JellyfinPayload> {
  if (cfg.demo) return demo.jellyfin();
  const container = await containerInfo(cfg.jellyfin.container);
  const base: JellyfinPayload = { reachable: false, info: null, counts: null, sessions: [], container, url: cfg.jellyfin.publicUrl };
  try {
    await health();
  } catch (e) {
    return { ...base, error: `Jellyfin not reachable at ${cfg.jellyfin.url}: ${(e as Error).message}` };
  }
  if (!cfg.jellyfin.apiKey) return { ...base, reachable: true, error: "JELLYFIN_API_KEY not set — sessions and counts unavailable" };
  try {
    const [info, counts, sessions] = await Promise.all([
      api<{ Version: string; ServerName: string; OperatingSystem: string }>("/System/Info"),
      api<Record<string, number>>("/Items/Counts"),
      api<RawSession[]>("/Sessions?activeWithinSeconds=900"),
    ]);
    return {
      ...base,
      reachable: true,
      info: { version: info.Version, serverName: info.ServerName, os: info.OperatingSystem },
      counts: {
        Movies: counts.MovieCount,
        Series: counts.SeriesCount,
        Episodes: counts.EpisodeCount,
        Songs: counts.SongCount,
        Albums: counts.AlbumCount,
      },
      sessions: sessions.filter((s) => s.UserName).map(mapSession),
    };
  } catch (e) {
    return { ...base, reachable: true, error: (e as Error).message };
  }
}

export async function refreshLibrary(): Promise<void> {
  if (cfg.demo) return;
  await api<void>("/Library/Refresh", { method: "POST" });
}

export async function restart(): Promise<void> {
  await restartContainer(cfg.jellyfin.container);
}

// File changes trigger one library scan, 30 s after the last change.
let refreshTimer: NodeJS.Timeout | null = null;
export function scheduleLibraryRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshLibrary().catch((e: Error) => console.warn(`[jellyfin] library refresh failed: ${e.message}`));
  }, 30_000);
}

export async function libraryItems(kind: "Movie" | "Series" | "Audio", search: string, start: number) {
  if (!cfg.jellyfin.apiKey) throw new Error("JELLYFIN_API_KEY is not configured");
  const query = new URLSearchParams({ IncludeItemTypes: kind, Recursive: "true", Limit: "30", StartIndex: String(start), SortBy: "SortName", SortOrder: "Ascending", Fields: "Path,ProductionYear", ...(search ? { SearchTerm: search } : {}) });
  const result = await api<{ Items: { Id: string; Name: string; Type: string; ProductionYear?: number; Path?: string; RunTimeTicks?: number }[]; TotalRecordCount: number }>(`/Items?${query}`);
  return { items: result.Items.map(item => ({ id: item.Id, name: item.Name, type: item.Type, year: item.ProductionYear, path: item.Path, minutes: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600_000_000) : null })), total: result.TotalRecordCount };
}
