// Assistant panel beside the alerts feed: which agent is connected (via MCP),
// what it last did, problem counts, and the two doors — instructions/context
// and the connect-an-agent snippet. It does not run a model itself.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useAppConfig } from "../App";
import { fmtRelative } from "../format";
import type { AgentPresence, AlertEvent, AlertSummary } from "../types";
import { ContextModal } from "./ContextModal";
import { Icons } from "./icons";
import { Modal, StatusPill, useToast } from "./ui";

const ONLINE_MS = 5 * 60_000;

function ConnectModal({ onClose }: { onClose: () => void }) {
  const config = useAppConfig();
  const toast = useToast();
  const [reveal, setReveal] = useState(false);
  const key = config.data?.dashboardKey;
  const mask = (k: string) => (reveal ? k : `${k.slice(0, 4)}…${k.slice(-4)}`);
  const shownKey = key ? mask(key) : "<DASHBOARD_KEY>";
  // real path reported by the server, so the snippet is right wherever the repo was installed
  const node = config.data?.mcpScript ?? "/opt/homelab-dashboard/server/dist/mcp.js";
  const snippets = [
    {
      title: "Claude Code — from this device over Tailscale",
      cmd: `claude mcp add homelab -e HOMELAB_URL=${location.origin} -e HOMELAB_KEY=${shownKey} -- node ${node}`,
      raw: `claude mcp add homelab -e HOMELAB_URL=${location.origin} -e HOMELAB_KEY=${key ?? "<DASHBOARD_KEY>"} -- node ${node}`,
    },
    {
      title: "Claude Code — in a shell on the server itself",
      cmd: `claude mcp add homelab -e HOMELAB_URL=http://127.0.0.1:3000 -e HOMELAB_KEY=${shownKey} -- node ${node}`,
      raw: `claude mcp add homelab -e HOMELAB_URL=http://127.0.0.1:3000 -e HOMELAB_KEY=${key ?? "<DASHBOARD_KEY>"} -- node ${node}`,
    },
    {
      title: "Codex CLI",
      cmd: `codex mcp add homelab --env HOMELAB_URL=${location.origin} --env HOMELAB_KEY=${shownKey} -- node ${node}`,
      raw: `codex mcp add homelab --env HOMELAB_URL=${location.origin} --env HOMELAB_KEY=${key ?? "<DASHBOARD_KEY>"} -- node ${node}`,
    },
  ];
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Could not copy", "error"));

  return (
    <Modal title="Connect an agent" onClose={onClose} wide>
      <div className="stack">
        <p className="dim small" style={{ margin: 0 }}>
          Agents run in <strong>your own terminal</strong> on the Claude or Codex subscription you already have — no API keys. Paste one line once; after that the agent has tools to read this feed, tail logs, send RCON commands, restart Minecraft, run your scripts and update its instructions. Everything it does appears in the feed.
        </p>
        {!key && <div className="notice">DASHBOARD_KEY is not set on the server, so the connector can't authenticate yet. Add it to /etc/homelab-dashboard.env (see SERVER_SETUP.md).</div>}
        <div className="row">
          <span className="small dim">Dashboard key:</span>
          <code className="mono small">{key ? mask(key) : "—"}</code>
          {key && (
            <>
              <button className="btn sm ghost" onClick={() => setReveal((r) => !r)}>
                {reveal ? "Hide" : "Reveal"}
              </button>
              <button className="btn sm ghost" onClick={() => copy(key)}>
                Copy key
              </button>
            </>
          )}
        </div>
        {snippets.map((s) => (
          <div key={s.title}>
            <div className="row spread" style={{ marginBottom: 4 }}>
              <span className="small" style={{ fontWeight: 500 }}>
                {s.title}
              </span>
              <button className="btn sm ghost" onClick={() => copy(s.raw)}>
                Copy
              </button>
            </div>
            <pre className="code">{s.cmd}</pre>
          </div>
        ))}
        <p className="muted small" style={{ margin: 0 }}>
          The node path is where this dashboard is installed on the server. Running the connector from another device needs the repo cloned there too, or wrap it as <code className="mono">ssh homeserver node {node}</code>.
        </p>
      </div>
    </Modal>
  );
}

export function AssistantWidget() {
  const [modal, setModal] = useState<"context" | "connect" | null>(null);
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<AgentPresence[]>("/agents"), refetchInterval: 5000 });
  const summary = useQuery({ queryKey: ["alerts", "summary"], queryFn: () => api.get<AlertSummary>("/alerts/summary"), refetchInterval: 10_000 });
  const actions = useQuery({ queryKey: ["alerts", "agent-actions"], queryFn: () => api.get<AlertEvent[]>("/alerts?sources=agent&limit=8"), refetchInterval: 5000 });

  const agent = agents.data?.[0];
  const connected = !!agent && Date.now() - Date.parse(agent.lastSeen) < ONLINE_MS;
  const s = summary.data;
  const problems = (s?.errorsLastHour ?? 0) + (s?.warnsLastHour ?? 0);

  return (
    <section className="card assistant">
      <div className="card-head">
        <h2 className="row" style={{ gap: 8 }}>
          <Icons.spark width={16} height={16} style={{ color: "var(--accent)" }} /> Assistant
        </h2>
        <StatusPill state={connected ? "ok" : agent ? "degraded" : "unavailable"} label={connected ? `Connected · ${agent.name}` : agent ? `Idle · ${agent.name}` : "No agent connected"} />
      </div>
      <div className="muted small" style={{ marginTop: -6, marginBottom: 12 }}>
        {agent ? `Last seen ${fmtRelative(agent.lastSeen)} · ${agent.actions} action${agent.actions === 1 ? "" : "s"}` : "Connect Claude Code or Codex from your terminal to let it watch and act."}
      </div>

      <div className="mini-stats">
        <div>
          <div className="mini-value" style={{ color: problems ? "var(--critical)" : undefined }}>
            {s ? problems : "–"}
          </div>
          <div className="mini-label">problems, last hour</div>
        </div>
        <div>
          <div className="mini-value">{s ? s.maintenanceLastHour : "–"}</div>
          <div className="mini-label">maintenance events</div>
        </div>
        <div>
          <div className="mini-value">{agents.data ? agents.data.length : "–"}</div>
          <div className="mini-label">agents seen</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 6, marginTop: 12 }}>
        <div className="small">
          <span className="muted">Last maintenance: </span>
          {s?.lastMaintenance ? (
            <span title={s.lastMaintenance.text}>
              {s.lastMaintenance.text.length > 70 ? `${s.lastMaintenance.text.slice(0, 70)}…` : s.lastMaintenance.text} <span className="muted">· {fmtRelative(s.lastMaintenance.ts)}</span>
            </span>
          ) : (
            <span className="muted">none yet</span>
          )}
        </div>
      </div>

      <h3 style={{ margin: "14px 0 6px" }}>Agent activity</h3>
      {!actions.data?.length ? (
        <div className="muted small">Nothing yet. Once an agent is connected, every tool it uses is listed here and in the feed.</div>
      ) : (
        <div className="stack" style={{ gap: 4 }}>
          {[...actions.data].reverse().map((e) => (
            <div key={e.id} className="small row" style={{ gap: 8, flexWrap: "nowrap" }}>
              <span className="muted nowrap">{fmtRelative(e.ts)}</span>
              <span className="truncate" title={e.text}>
                {e.text}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 16, gap: 8 }}>
        <button className="btn" onClick={() => setModal("context")}>
          <Icons.file width={14} height={14} /> Instructions &amp; context
        </button>
        <button className="btn primary" onClick={() => setModal("connect")}>
          <Icons.plug width={14} height={14} /> Connect an agent
        </button>
      </div>

      {modal === "context" && <ContextModal onClose={() => setModal(null)} />}
      {modal === "connect" && <ConnectModal onClose={() => setModal(null)} />}
    </section>
  );
}
