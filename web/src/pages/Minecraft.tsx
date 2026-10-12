import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Icons } from "../components/icons";
import { LogViewer } from "../components/LogViewer";
import { Card, ErrorNotice, PageHead, StatTile, StatusPill, unitToState, useDialog, useToast } from "../components/ui";
import { fmtBytes, fmtUptime } from "../format";
import type { MinecraftPayload } from "../types";

interface ConsoleEntry {
  cmd: string;
  out: string;
  at: number;
  error?: boolean;
}

export function Minecraft() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialog();
  const q = useQuery({ queryKey: ["minecraft"], queryFn: () => api.get<MinecraftPayload>("/minecraft"), refetchInterval: 5000 });
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState<ConsoleEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const action = useMutation({
    mutationFn: (a: "start" | "stop" | "restart") => api.post("/minecraft/action", { action: a }),
    onSuccess: (_r, a) => {
      toast(`Minecraft ${a} requested`);
      qc.invalidateQueries({ queryKey: ["minecraft"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const send = useMutation({
    mutationFn: (command: string) => api.post<{ output: string }>("/minecraft/command", { command }),
    onSuccess: (r, command) => setHistory((h) => [{ cmd: command, out: r.output || "(no output)", at: Date.now() }, ...h].slice(0, 30)),
    onError: (e: Error, command) => setHistory((h) => [{ cmd: command, out: e.message, at: Date.now(), error: true }, ...h].slice(0, 30)),
  });

  const d = q.data;
  const active = d?.unit?.active ?? (d?.ping ? "active" : null);
  const state = d?.ping ? "ok" : unitToState(active);
  const running = active === "active";

  const guarded = async (a: "stop" | "restart") => {
    const n = d?.players?.online ?? 0;
    const ok = await confirm({
      title: `${a === "stop" ? "Stop" : "Restart"} the Minecraft server?`,
      body: n > 0 ? `${n} player${n === 1 ? " is" : "s are"} online and will be disconnected.` : "No players are online.",
      confirmLabel: a === "stop" ? "Stop" : "Restart",
      danger: true,
    });
    if (ok) action.mutate(a);
  };

  return (
    <>
      <PageHead
        title="Minecraft"
        sub={
          d ? (
            <>
              {d.ping ? `${d.ping.version} · “${d.ping.motd}”` : d.unit ? `systemd: ${d.unit.active} (${d.unit.sub})` : "Server status unknown"}
              {" · "}
              <span className="mono">{d.address}</span>
            </>
          ) : (
            "Loading…"
          )
        }
        actions={
          <>
            <button className="btn primary" disabled={running || action.isPending} onClick={() => action.mutate("start")}>
              <Icons.play width={14} height={14} /> Start
            </button>
            <button className="btn" disabled={!running || action.isPending} onClick={() => guarded("restart")}>
              <Icons.refresh width={14} height={14} /> Restart
            </button>
            <button className="btn danger" disabled={!running || action.isPending} onClick={() => guarded("stop")}>
              <Icons.stop width={14} height={14} /> Stop
            </button>
            <Link className="btn" to="/minecraft#maintenance">
              <Icons.clock width={14} height={14} /> Maintenance
            </Link>
          </>
        }
      />
      <ErrorNotice error={q.error} />
      {d && !d.rcon.ok && running && <div className="notice" style={{ marginBottom: 14 }}>RCON unavailable: {d.rcon.error}. Player list and console need RCON enabled in server.properties.</div>}

      <div className="grid" style={{ marginBottom: 14 }}>
        <div className="card tile">
          <div className="tile-label">Server</div>
          <div className="row" style={{ marginTop: 4 }}>
            <StatusPill state={state} label={d ? (d.ping ? "Online" : active === "active" ? "Starting" : active ?? "Unknown") : "Checking"} />
            {d?.ping && <span className="muted small">{d.ping.latencyMs} ms</span>}
          </div>
          <div className="tile-sub">{d?.unit ? `Up ${fmtUptime(d.unit.since)}${d.unit.pid ? ` · PID ${d.unit.pid}` : ""}` : "No systemd unit visible"}</div>
        </div>
        <StatTile
          label="Players online"
          value={d?.players ? `${d.players.online} / ${d.players.max}` : d?.ping ? `${d.ping.online} / ${d.ping.max}` : "–"}
          sub={d?.players?.names.length ? d.players.names.join(", ") : running ? "Nobody online" : "Server offline"}
        />
        <StatTile label="Memory" value={d?.unit?.memoryBytes ? fmtBytes(d.unit.memoryBytes) : "–"} sub="Java process (systemd)" />
      </div>

      <div className="grid wide">
        <Card title="Console" className="span-2">
          <form
            className="console"
            onSubmit={(e) => {
              e.preventDefault();
              const c = cmd.trim();
              if (!c) return;
              send.mutate(c);
              setCmd("");
              inputRef.current?.focus();
            }}
          >
            <input ref={inputRef} className="input" placeholder={running ? "RCON command, e.g. list, say hello, whitelist add Alex" : "Server is offline"} value={cmd} disabled={!running} onChange={(e) => setCmd(e.target.value)} />
            <button className="btn primary" type="submit" disabled={!running || send.isPending || !cmd.trim()}>
              Send
            </button>
          </form>
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            {["list", "tps", "save-all", "whitelist list", "say Server maintenance soon"].map((c) => (
              <button key={c} className="btn sm ghost mono" disabled={!running} onClick={() => send.mutate(c)}>
                {c}
              </button>
            ))}
          </div>
          {history.length > 0 && (
            <div className="console-out">
              {history.map((h) => (
                <div key={h.at} style={{ marginBottom: 8 }}>
                  <div className="dim">&gt; {h.cmd}</div>
                  <div style={{ color: h.error ? "var(--critical)" : undefined }}>{h.out}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <h3 style={{ marginBottom: 8 }}>Live server log</h3>
        <LogViewer source="minecraft" height={380} />
      </div>
    </>
  );
}
