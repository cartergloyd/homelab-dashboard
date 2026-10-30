import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAppConfig } from "../App";
import { Icons } from "../components/icons";
import { AddTorrentButton } from "../components/AddTorrentButton";
import { Card, ErrorNotice, PageHead, StatTile, StatusPill, useDialog, useToast } from "../components/ui";
import { fmtRelative, fmtUptime } from "../format";
import type { JellyfinPayload } from "../types";

export function Jellyfin() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialog();
  const config = useAppConfig();
  const q = useQuery({ queryKey: ["jellyfin"], queryFn: () => api.get<JellyfinPayload>("/jellyfin"), refetchInterval: 10_000 });
  const refresh = useMutation({
    mutationFn: () => api.post("/jellyfin/refresh"),
    onSuccess: () => toast("Library scan started"),
    onError: (e: Error) => toast(e.message, "error"),
  });
  const restart = useMutation({
    mutationFn: () => api.post("/jellyfin/restart"),
    onSuccess: () => {
      toast("Jellyfin container restarting");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["jellyfin"] }), 3000);
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  const d = q.data;
  const state = !d ? "unavailable" : d.reachable ? "ok" : d.container?.state === "running" ? "degraded" : "down";

  return (
    <>
      <PageHead
        title="Jellyfin"
        sub={d?.info ? `${d.info.serverName} · v${d.info.version} · ${d.info.os}` : d?.error ?? "Media server"}
        actions={
          <>
            <a className="btn primary" href={d?.url} target="_blank" rel="noreferrer">
              <Icons.external width={14} height={14} /> Open Jellyfin
            </a>
            {config.data?.links.qbittorrent && (
              <a className="btn" href={config.data.links.qbittorrent} target="_blank" rel="noreferrer">
                <Icons.external width={14} height={14} /> Open qBittorrent
              </a>
            )}
            <AddTorrentButton />
            <Link className="btn" to="/files">
              <Icons.folder width={14} height={14} /> Media files
            </Link>
            <button className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              <Icons.refresh width={14} height={14} /> Scan library
            </button>
            <button
              className="btn"
              disabled={restart.isPending}
              onClick={async () => {
                if (await confirm({ title: "Restart the Jellyfin container?", body: "Active streams will drop for a few seconds.", confirmLabel: "Restart", danger: true })) restart.mutate();
              }}
            >
              Restart container
            </button>
          </>
        }
      />
      <ErrorNotice error={q.error} />
      {d?.error && d.reachable && <div className="notice" style={{ marginBottom: 14 }}>{d.error}</div>}

      <div className="grid" style={{ marginBottom: 14 }}>
        <div className="card tile">
          <div className="tile-label">Server</div>
          <div className="row" style={{ marginTop: 4 }}>
            <StatusPill state={state} label={d ? (d.reachable ? "Reachable" : "Unreachable") : "Checking"} />
            {d?.container && <span className="badge">{d.container.status}</span>}
          </div>
          <div className="tile-sub">{d?.container ? `${d.container.image} · up ${fmtUptime(d.container.startedAt)}` : "Container not visible to the dashboard"}</div>
        </div>
        {Object.entries(d?.counts ?? {}).map(([k, v]) => (
          <StatTile key={k} label={k} value={v?.toLocaleString() ?? "–"} />
        ))}
      </div>

      <Card title="Active sessions">
        {!d?.sessions.length ? (
          <span className="muted">No one is connected right now.</span>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Now playing</th>
                <th>Device</th>
                <th>Progress</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {d.sessions.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 500 }}>{s.user}</td>
                  <td>
                    {s.nowPlaying ? (
                      <>
                        <div>{s.nowPlaying.name}</div>
                        <div className="muted small">
                          {s.nowPlaying.series ? `${s.nowPlaying.series} · ` : ""}
                          {s.nowPlaying.type}
                          {s.nowPlaying.paused ? " · paused" : ""}
                        </div>
                      </>
                    ) : (
                      <span className="muted">Idle</span>
                    )}
                  </td>
                  <td>
                    <div>{s.device}</div>
                    <div className="muted small">{s.client}</div>
                  </td>
                  <td>
                    {s.nowPlaying && (
                      <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                        <div className="progress-mini">
                          <div style={{ width: `${Math.round(s.nowPlaying.progress * 100)}%` }} />
                        </div>
                        <span className="small dim">{Math.round(s.nowPlaying.progress * 100)}%</span>
                      </div>
                    )}
                  </td>
                  <td className="dim nowrap">{fmtRelative(s.lastActivity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
