import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAppConfig } from "../App";
import { Icons } from "../components/icons";
import { ReportsCard } from "../components/ReportsCard";
import { Card, ErrorNotice, Meter, PageHead, StatTile, StatusPill, useDialog, useToast } from "../components/ui";
import { fmtRelative } from "../format";
import type { OverviewPayload } from "../types";

export function Dashboard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialog();
  const config = useAppConfig();
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api.get<OverviewPayload>("/overview"), refetchInterval: 10_000 });

  const restartMc = useMutation({
    mutationFn: () => api.post("/minecraft/action", { action: "restart" }),
    onSuccess: () => {
      toast("Minecraft restart requested");
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const scanLibrary = useMutation({
    mutationFn: () => api.post("/jellyfin/refresh"),
    onSuccess: () => toast("Jellyfin library scan started"),
    onError: (e: Error) => toast(e.message, "error"),
  });

  const d = q.data;
  const services = d?.status.services ?? [];
  const problems = services.filter((s) => s.state !== "ok").length;

  return (
    <>
      <PageHead
        title="Dashboard"
        sub={d ? (problems === 0 ? "All services healthy" : `${problems} service${problems === 1 ? "" : "s"} need attention`) : "Loading…"}
        actions={
          <>
            <a className="btn" href={config.data?.links.jellyfin} target="_blank" rel="noreferrer">
              <Icons.external width={14} height={14} /> Jellyfin
            </a>
            <a className="btn" href={config.data?.links.directus} target="_blank" rel="noreferrer">
              <Icons.external width={14} height={14} /> Directus
            </a>
            <button className="btn" disabled={scanLibrary.isPending} onClick={() => scanLibrary.mutate()}>
              <Icons.refresh width={14} height={14} /> Scan library
            </button>
            <button
              className="btn"
              disabled={restartMc.isPending}
              onClick={async () => {
                if (await confirm({ title: "Restart Minecraft?", body: "Players online will be disconnected without warning. Use a scheduled restart for a countdown.", confirmLabel: "Restart", danger: true }))
                  restartMc.mutate();
              }}
            >
              <Icons.refresh width={14} height={14} /> Restart Minecraft
            </button>
          </>
        }
      />
      <ErrorNotice error={q.error} />

      <div className="grid" style={{ marginBottom: 14 }}>
        <StatTile
          label="Players online"
          value={d?.minecraft.players ? `${d.minecraft.players.online} / ${d.minecraft.players.max}` : d?.minecraft.active === "active" ? "–" : "Offline"}
          sub={d?.minecraft.players?.names.length ? d.minecraft.players.names.join(", ") : d?.minecraft.active ? `Service ${d.minecraft.active}` : "Minecraft"}
        />
        <StatTile label="Jellyfin streams" value={d ? d.jellyfin.playing : "–"} sub={d ? `${d.jellyfin.sessions} active session${d.jellyfin.sessions === 1 ? "" : "s"}` : ""} />
        <StatTile label="Tailnet devices online" value={d ? `${d.tailscale.online} / ${d.tailscale.total}` : "–"} sub="Peers on your Tailscale network" />
        <StatTile
          label="Next scheduled job"
          value={d?.nextJob ? fmtRelative(d.nextJob.at) : "None"}
          sub={d?.nextJob ? d.nextJob.name : <Link to="/minecraft#maintenance">Set up maintenance</Link>}
        />
      </div>

      <div style={{ marginBottom: 14 }}>
        <ReportsCard />
      </div>

      <div className="grid wide">
        <Card title="Services" actions={<Link to="/system#status" className="small">Details</Link>}>
          <div className="stack">
            {services.length === 0 && <span className="skeleton">Checking…</span>}
            {services.map((s) => (
              <div key={s.id} className="row spread" style={{ flexWrap: "nowrap" }}>
                <div className="truncate">
                  <div style={{ fontWeight: 500 }}>{s.href ? <a href={s.href} target="_blank" rel="noreferrer">{s.name}</a> : s.name}</div>
                  <div className="muted small truncate">{s.detail}</div>
                </div>
                <StatusPill state={s.state} />
              </div>
            ))}
          </div>
        </Card>

        <Card title="Storage" actions={<Link to="/system#storage" className="small">Details</Link>}>
          <div className="stack" style={{ gap: 16 }}>
            {d?.storage.length === 0 && <span className="skeleton">No filesystems reported</span>}
            {(d?.storage ?? []).map((f) => (
              <Meter key={f.mount} label={f.mount} used={f.usedBytes} total={f.totalBytes} />
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
