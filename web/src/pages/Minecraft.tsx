import React, { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAppConfig } from "../App";
import { AlertsFeed } from "../components/AlertsFeed";
import { AssistantWidget } from "../components/AssistantWidget";
import { Icons } from "../components/icons";
import { Card, ErrorNotice, PageHead, StatusPill, unitToState, useDialog, useToast } from "../components/ui";
import { fmtBytes, fmtRelative, fmtUptime } from "../format";
import type { MinecraftPayload, ScriptRun, ScriptsPayload } from "../types";

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
  const config = useAppConfig();
  const q = useQuery({ queryKey: ["minecraft"], queryFn: () => api.get<MinecraftPayload>("/minecraft"), refetchInterval: 5000 });
  const scripts = useQuery({ queryKey: ["scripts"], queryFn: () => api.get<ScriptsPayload>("/scripts"), refetchInterval: 4000 });
  const missingDirs = scripts.data?.dirs.filter((d) => !d.exists) ?? [];
  const runScript = useMutation({
    mutationFn: (name: string) => api.post<ScriptRun>(`/scripts/${encodeURIComponent(name)}/run`),
    onSuccess: (_r, name) => {
      toast(`${name} started — output is in the feed below`);
      qc.invalidateQueries({ queryKey: ["scripts"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
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
          <div className="stack" style={{ alignItems: "flex-end", gap: 8 }}>
            <div className="status-strip" title={d?.players?.names.length ? `Online: ${d.players.names.join(", ")}` : undefined}>
              <StatusPill state={state} label={d ? (d.ping ? "Online" : active === "active" ? "Starting" : active ?? "Unknown") : "Checking"} />
              <span>
                <span className="muted">Players</span> {d?.players ? `${d.players.online}/${d.players.max}` : d?.ping ? `${d.ping.online}/${d.ping.max}` : "–"}
              </span>
              <span>
                <span className="muted">Memory</span> {d?.unit?.memoryBytes ? fmtBytes(d.unit.memoryBytes) : "–"}
              </span>
              <span>
                <span className="muted">Up</span> {d?.unit ? fmtUptime(d.unit.since) : "–"}
              </span>
              {d?.ping && <span className="muted">{d.ping.latencyMs} ms</span>}
            </div>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
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
            </div>
          </div>
        }
      />
      <ErrorNotice error={q.error} />
      {d && !d.rcon.ok && running && <div className="notice" style={{ marginBottom: 14 }}>RCON unavailable: {d.rcon.error}. Player list and console need RCON enabled in server.properties.</div>}

      <div className="alerts-layout">
        <div>
          <h3 style={{ marginBottom: 8 }}>Live server alerts</h3>
          <AlertsFeed height={520} />
        </div>
        <div id="assistant">
          <h3 style={{ marginBottom: 8 }}>Assistant</h3>
          <AssistantWidget />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title="Console">
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
          {missingDirs.length > 0 && (
            <div className="notice error" style={{ marginTop: 10 }}>
              Scripts folder not found: {missingDirs.map((d) => <span key={d.path} className="mono">{d.path}</span>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}. Set{" "}
              <span className="mono">SCRIPTS_DIR</span> in /etc/homelab-dashboard.env to the real folder(s), then restart the dashboard.
            </div>
          )}
          <div className="row" style={{ marginTop: 10, gap: 6 }}>
            <span className="small dim">Scripts:</span>
            {scripts.data && scripts.data.scripts.length === 0 && missingDirs.length === 0 && (
              <span className="muted small">
                no *.py / *.sh files in <span className="mono">{config.data?.scriptsDirs.join(", ")}</span>
              </span>
            )}
            {scripts.data?.scripts.map((s) => (
              <button
                key={s.name}
                className="btn sm mono"
                disabled={s.running || runScript.isPending}
                title={`${s.dir}/${s.name}${s.lastRun ? ` · last run ${fmtRelative(s.lastRun.startedAt)} · exit ${s.lastRun.exitCode ?? "?"} · ${s.lastRun.trigger}` : " · never run"}`}
                onClick={() => runScript.mutate(s.name)}
              >
                {s.running ? <span className="spin">◌</span> : <Icons.play width={12} height={12} />}
                {s.name}
                {!s.running && s.lastRun && s.lastRun.exitCode !== null && s.lastRun.exitCode !== 0 && <span className="dot-err" title="Last run failed" />}
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
    </>
  );
}
