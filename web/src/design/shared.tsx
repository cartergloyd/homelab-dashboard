import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../components/ui";
import { ReportsCard } from "../components/ReportsCard";
import { AssistantWidget } from "../components/AssistantWidget";
import { AlertsFeed } from "../components/AlertsFeed";
import { StorageExplorer } from "../components/StorageExplorer";
import { LogViewer } from "../components/LogViewer";
import { useAppConfig } from "../App";
import { useRead, type Host } from "./data";
import {
  Button,
  Details,
  Empty,
  Icon,
  Issue,
  Panel,
  Status,
  Table,
} from "./ui";
import { fmtBytes, fmtDateTime, fmtRelative } from "../format";
import type {
  AlertEvent,
  StoragePayload,
  StorageDevice,
  JellyfinPayload,
  MinecraftPayload,
} from "../types";
export function Drawer({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="drawer-content">{children}</div>
    </Modal>
  );
}
export function AssistantDialog({ onClose }: { onClose: () => void }) {
  return (
    <Drawer title="Server assistant" onClose={onClose}>
      <AssistantWidget />
    </Drawer>
  );
}
export function ReportsDialog({
  kind,
  onClose,
}: {
  kind: "minecraft" | "jellyfin" | "all";
  onClose: () => void;
}) {
  const [period, setPeriod] = useState("7"),
    host = useRead<Host>("host", "/host?range=7d"),
    mc = useRead<MinecraftPayload>("minecraft", "/minecraft"),
    jf = useRead<JellyfinPayload>("jellyfin", "/jellyfin");
  return (
    <Drawer
      title={
        kind === "all"
          ? "Maintenance reports"
          : kind === "minecraft"
            ? "Minecraft reports"
            : "Jellyfin reports"
      }
      onClose={onClose}
    >
      {kind !== "all" && (
        <>
          <label className="field">
            Period
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </label>
          {kind === "minecraft" ? (
            <>
              <h3>Player activity</h3>
              {mc.data?.players?.names.length ? (
                <Table headers={["Player", "Status"]}>
                  {mc.data.players.names.map((name) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>Online now</td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <Empty>
                  {mc.data?.players
                    ? "No players online."
                    : "Player names are unavailable while RCON is disconnected."}
                </Empty>
              )}
              <p className="inline-note">
                Historical player sessions and TPS are not collected by this
                installation.
              </p>
              <h3>Host performance</h3>
              <Details
                items={[
                  [
                    "Actual samples available",
                    host.data?.history.length ?? "Checking",
                  ],
                  [
                    "First recorded sample",
                    host.data?.history[0]
                      ? fmtDateTime(host.data.history[0].at)
                      : "No history yet",
                  ],
                  [
                    "Current CPU",
                    host.data?.cpu == null
                      ? "Unavailable"
                      : host.data.cpu.toFixed(1) + "%",
                  ],
                  [
                    "Current memory",
                    host.data ? fmtBytes(host.data.memoryUsed) : "Checking",
                  ],
                ]}
              />
            </>
          ) : (
            <>
              <h3>Viewing activity</h3>
              {jf.data?.sessions.some((s) => s.nowPlaying) ? (
                <Table headers={["Viewer", "Title", "Client"]}>
                  {jf.data.sessions
                    .filter((s) => s.nowPlaying)
                    .map((s) => (
                      <tr key={s.id}>
                        <td>{s.user}</td>
                        <td>{s.nowPlaying?.name}</td>
                        <td>{s.client}</td>
                      </tr>
                    ))}
                </Table>
              ) : (
                <Empty>
                  {jf.data?.error ?? "No streams currently playing."}
                </Empty>
              )}
              <p className="inline-note">
                Historical watch time, title play counts, and least-streamed
                rankings are not collected by this installation.
              </p>
            </>
          )}
          <hr />
        </>
      )}
      <ReportsCard />
    </Drawer>
  );
}
export function Activity({
  limit = 30,
  compact = false,
}: {
  limit?: number;
  compact?: boolean;
}) {
  const events = useRead<AlertEvent[]>("alerts", "/alerts?limit=200", 5000),
    [category, setCategory] = useState("All activity"),
    [selected, setSelected] = useState<AlertEvent | null>(null),
    [assistant, setAssistant] = useState(false),
    [raw, setRaw] = useState(false);
  const rows =
    events.data
      ?.filter(
        (e) =>
          category === "All activity" ||
          (category === "Problems" && e.level !== "info") ||
          (category === "Automation" &&
            ["jobs", "scripts"].includes(e.source)) ||
          (category === "Agents" && e.source === "agent"),
      )
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, limit) ?? [];
  return (
    <>
      <div className="panel-head">
        <div>
          {!compact && (
            <p className="panel-sub">
              Server events, scheduled work, and agent actions
            </p>
          )}
        </div>
        {!compact && (
          <div className="head-actions">
            <select
              className="activity-filter"
              aria-label="Filter activity"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {["All activity", "Problems", "Automation", "Agents"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <Button icon="terminal" onClick={() => setRaw(true)}>
              Live feed
            </Button>
            <Button icon="spark" onClick={() => setAssistant(true)}>
              Assistant
            </Button>
          </div>
        )}
      </div>
      <Issue error={events.error} />
      <div className="activity-list">
        {rows.map((e) => (
          <button
            key={e.id}
            className="activity-row"
            style={{ width: "100%", textAlign: "left" }}
            onClick={() => setSelected(e)}
          >
            <span
              className={`activity-icon ${e.level === "info" ? "" : "amber"}`}
            >
              <Icon
                name={
                  e.source === "agent"
                    ? "spark"
                    : e.kind === "job"
                      ? "clock"
                      : e.kind === "script"
                        ? "terminal"
                        : "pulse"
                }
              />
            </span>
            <span className="activity-main">
              <strong>
                {e.text.length > 150 ? e.text.slice(0, 150) + "…" : e.text}
              </strong>
              <small>
                {e.source} · {e.level}
              </small>
            </span>
            <time title={fmtDateTime(e.ts)}>{fmtRelative(e.ts)}</time>
          </button>
        ))}
        {!rows.length && (
          <Empty>
            {events.isPending
              ? "Loading activity…"
              : "No recorded activity in this view."}
          </Empty>
        )}
      </div>
      {selected && (
        <Drawer title="Activity details" onClose={() => setSelected(null)}>
          <Details
            items={[
              ["Source", selected.source],
              ["Time", fmtDateTime(selected.ts)],
              ["Level", selected.level],
            ]}
          />
          <pre style={{ whiteSpace: "pre-wrap" }}>{selected.text}</pre>
          <Button
            icon="spark"
            onClick={() => {
              setSelected(null);
              setAssistant(true);
            }}
          >
            Open assistant
          </Button>
        </Drawer>
      )}
      {assistant && <AssistantDialog onClose={() => setAssistant(false)} />}{" "}
      {raw && (
        <Drawer title="Live server alerts" onClose={() => setRaw(false)}>
          <AlertsFeed height="60vh" />
        </Drawer>
      )}
    </>
  );
}
function mountedFor(device: StorageDevice): string[] {
  return [...device.mounts, ...device.children.flatMap(mountedFor)];
}
export function DriveCards({ compact = false }: { compact?: boolean }) {
  const q = useRead<StoragePayload>("storage", "/storage"),
    [explorer, setExplorer] = useState(false),
    filesystems = q.data?.filesystems ?? [],
    devices = q.data?.driveInventory?.devices ?? [];
  const rows = devices.length
    ? devices.map((d) => {
        const mounts = mountedFor(d),
          fs = filesystems.filter((f) => mounts.includes(f.mount));
        const unique = [...new Map(fs.map((f) => [f.filesystem, f])).values()];
        return {
          id: d.path,
          name: d.label || d.model || d.path,
          type: d.type,
          path: mounts.join(", ") || d.path,
          total: d.sizeBytes,
          used: unique.length
            ? unique.reduce((a, f) => a + f.usedBytes, 0)
            : null,
          free: unique.length
            ? unique.reduce((a, f) => a + f.availBytes, 0)
            : null,
        };
      })
    : filesystems.map((f) => ({
        id: f.mount,
        name: f.mount === "/" ? "System" : f.mount.split("/").pop() || f.mount,
        type: f.filesystem,
        path: f.mount,
        total: f.totalBytes,
        used: f.usedBytes,
        free: f.availBytes,
      }));
  return (
    <>
      <Issue error={q.error} />
      <div className={compact ? "" : "storage-drives"}>
        {rows.map((d) => (
          <section
            key={d.id}
            className={
              compact
                ? "storage-row drive-entry-compact"
                : "panel inventory-card"
            }
          >
            <div className="storage-row-head">
              <div className="storage-drive">
                <Icon name="drive" />
                <span className="drive-label">
                  <strong>{d.name}</strong>
                  <small>
                    {d.type} · {d.path}
                  </small>
                </span>
              </div>
              <span>
                {d.used == null
                  ? fmtBytes(d.total)
                  : `${fmtBytes(d.used)} / ${fmtBytes(d.total)}`}
              </span>
            </div>
            <div
              className="capacity-bar"
              role="img"
              aria-label={
                d.used == null
                  ? `${d.name}: usage unavailable`
                  : `${d.name}: ${fmtBytes(d.used)} used`
              }
            >
              <span
                className="used-segment"
                style={{
                  width:
                    d.used != null && d.total > 0
                      ? `${Math.min(100, (d.used / d.total) * 100)}%`
                      : "0%",
                }}
              />
            </div>
            <div className="storage-legend">
              {d.used == null ? (
                <span>Usage unavailable · no mounted filesystem reported</span>
              ) : (
                <>
                  <span>
                    <i style={{ background: "#7ea889" }} />
                    Used · {fmtBytes(d.used)}
                  </span>
                  <span>
                    <i style={{ background: "var(--line)" }} />
                    Free · {fmtBytes(d.free)}
                  </span>
                </>
              )}
            </div>
            {!compact && (
              <button
                className="text-link"
                style={{ marginTop: 16 }}
                onClick={() => setExplorer(true)}
              >
                Explore storage <Icon name="external" />
              </button>
            )}
          </section>
        ))}
      </div>
      {!rows.length && (
        <Empty>
          {q.isPending
            ? "Reading drive inventory…"
            : "No drive inventory available."}
        </Empty>
      )}
      {q.data?.driveInventory.error && (
        <p className="inline-note">{q.data.driveInventory.error}</p>
      )}
      {explorer && (
        <Drawer title="Storage explorer" onClose={() => setExplorer(false)}>
          <StorageExplorer />
        </Drawer>
      )}
    </>
  );
}
export function LogsDialog({ onClose }: { onClose: () => void }) {
  const cfg = useAppConfig(),
    [source, setSource] = useState("minecraft");
  return (
    <Drawer title="Service logs" onClose={onClose}>
      <label className="field">
        Source
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {cfg.data?.logSources.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <LogViewer source={source as "minecraft"} height="55vh" />
    </Drawer>
  );
}
export function MetricCards({
  items,
}: {
  items: [string, ReactNode, ReactNode][];
}) {
  return (
    <div className="three-cols">
      {items.map(([label, value, note]) => (
        <div key={label} className="panel metric-card">
          <span>{label}</span>
          <div className="number">{value}</div>
          <small>{note}</small>
        </div>
      ))}
    </div>
  );
}
