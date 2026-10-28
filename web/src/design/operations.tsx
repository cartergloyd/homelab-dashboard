import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAppConfig } from "../App";
import {
  Button,
  Details,
  Empty,
  Head,
  Icon,
  Issue,
  Panel,
  Status,
  Table,
} from "./ui";
import { useActions, useRead, type Workspace } from "./data";
import { AssistantDialog, Drawer, LogsDialog, ReportsDialog } from "./shared";
import { RepositoryHub } from "./repositories";
import { MediaBrowser, TorrentQueue } from "./media";
import {
  fmtBytes,
  fmtDateTime,
  fmtRelative,
  fmtUptime,
  describeCron,
} from "../format";
import type {
  AlertEvent,
  BackupsPayload,
  JobView,
  JellyfinPayload,
  MinecraftPayload,
  StagedUpdatePayload,
} from "../types";

export function Backups() {
  const [showAll, setShowAll] = useState(false);
  const q = useRead<BackupsPayload>("backups", "/backups", 15000),
    jobs = useRead<JobView[]>("jobs", "/jobs"),
    action = useActions();
  const schedule = jobs.data
    ?.filter(
      (j) =>
        j.type === "backup" ||
        (/minecraft/i.test(j.name) && /backup/i.test(j.name)),
    )
    .map((j) => `${j.name} · ${describeCron(j.cron)}`)
    .join(" · ");
  return (
    <Panel
      title="World backups"
      sub={schedule || "Existing restore points"}
      actions={
        <Button
          icon="drive"
          disabled={action.pending}
          onClick={() =>
            action.perform("/backups", undefined, {
              title: "Create a world backup?",
              description: q.data?.method.startsWith("script:")
                ? `Runs ${q.data.method.slice(7)}.`
                : "Creates a backup in the configured backup directory.",
              success: "World backup completed",
              refresh: ["backups"],
            })
          }
        >
          Back up now
        </Button>
      }
    >
      <Issue error={q.error} />
      <Table headers={["Restore point", "Size", "Created", "Result", ""]}>
        {(showAll ? q.data?.backups : q.data?.backups.slice(0, 3))?.map((b) => (
          <tr key={b.path}>
            <td>
              <span className="table-name">
                <Icon name="drive" />
                {b.name}
              </span>
              <small>{b.root}</small>
            </td>
            <td>{fmtBytes(b.bytes)}</td>
            <td>{fmtDateTime(b.mtime)}</td>
            <td>
              <Status state="ok" label="Available" />
            </td>
            <td>
              {b.deletable && (
                <Button
                  className="danger"
                  disabled={action.pending}
                  onClick={() =>
                    action.perform(
                      `/backups?path=${encodeURIComponent(b.path)}`,
                      undefined,
                      {
                        method: "delete",
                        title: `Delete ${b.name}?`,
                        description: "Permanently removes this backup.",
                        danger: true,
                        refresh: ["backups"],
                        success: "Backup deleted",
                      },
                    )
                  }
                >
                  Delete
                </Button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      {q.data?.backups.length === 0 && (
        <Empty>No restore points found in the configured backup folders.</Empty>
      )}
      {q.isPending && <Empty>Reading backups…</Empty>}
      {q.data?.roots.some((r) => !r.exists) && (
        <Issue
          error={
            new Error(
              "A configured backup folder is unavailable. See backup settings.",
            )
          }
        />
      )}
      <div className="panel-bottom">
        <span>{q.data?.writeDir ?? "Checking backup location"}</span>
        <span>
          {(q.data?.backups.length ?? 0) > 3 && (
            <button className="text-link" onClick={() => setShowAll((v) => !v)}>
              {showAll
                ? "Show fewer"
                : `View all ${q.data?.backups.length} restore points`}
            </button>
          )}
        </span>
      </div>
    </Panel>
  );
}
export function MinecraftDesign({
  workspace = "personal",
}: {
  workspace?: Workspace;
}) {
  const q = useRead<MinecraftPayload>("minecraft", "/minecraft", 15000),
    updates = useRead<StagedUpdatePayload>("updates", "/updates", 300000),
    events = useRead<AlertEvent[]>(
      "minecraft-alerts",
      "/alerts?sources=minecraft&limit=40",
      5000,
    ),
    settings = useRead<Record<string, string>>(
      "minecraft-settings",
      "/minecraft/settings",
    ),
    action = useActions();
  const [command, setCommand] = useState(""),
    [history, setHistory] = useState<{ command: string; output: string }[]>([]),
    [reports, setReports] = useState(false),
    [controls, setControls] = useState(false),
    [assistant, setAssistant] = useState(false),
    [logs, setLogs] = useState(false),
    [plugin, setPlugin] = useState<StagedUpdatePayload["items"][number] | null>(
      null,
    );
  const d = q.data,
    ready = d?.rcon.ok === true,
    plugins = updates.data?.items.filter((p) => p.kind === "plugin") ?? [];
  async function send(text: string, confirm = true) {
    const r = await action.perform<{ output: string }>(
      "/minecraft/command",
      { command: text },
      {
        ...(confirm
          ? { title: "Send Minecraft command?", description: text }
          : {}),
        refresh: ["minecraft"],
      },
    );
    if (r) {
      setHistory((h) =>
        [...h, { command: text, output: r.output || "(no output)" }].slice(-30),
      );
      setCommand("");
    }
  }
  async function quick(prefix: string, player = false) {
    if (!ready) {
      setControls(true);
      return;
    }
    let text = prefix;
    if (player) {
      const name = await action.prompt({
        title:
          prefix === "whitelist add"
            ? "Whitelist player"
            : "Remove from whitelist",
        label: "Minecraft username",
        confirmLabel: "Next",
      });
      if (!name) return;
      text += " " + name;
    }
    await send(text);
  }
  return (
    <>
      <Head
        title="Minecraft"
        actions={
          <>
            <Button icon="spark" onClick={() => setAssistant(true)}>
              Assistant
            </Button>
            <Button icon="pulse" onClick={() => setReports(true)}>
              Reports
            </Button>
          </>
        }
      />
      <Issue error={q.error} />
      <div className="section-stack">
        <Panel
          title="Server console"
          sub="Minecraft commands and server output"
          actions={
            <Status
              label={
                ready
                  ? "Connected"
                  : d?.ping
                    ? "Server online · controls unavailable"
                    : d
                      ? "Unavailable"
                      : "Connecting"
              }
              state={ready ? "ok" : d?.ping ? "warn" : "unknown"}
            />
          }
        >
          <div className="game-console">
            <div className="console-lines" role="log">
              <p>
                {d?.ping
                  ? `${d.ping.version} · ${d.players?.online ?? d.ping.online} / ${d.players?.max ?? d.ping.max} players online`
                  : q.isPending
                    ? "Connecting to Minecraft…"
                    : "Game server is not responding."}
              </p>
              {events.data?.slice(-4).map((e) => (
                <p key={e.id}>{e.text}</p>
              ))}
              {history.map((h, i) => (
                <div key={i}>
                  <p className="command-echo">&gt; {h.command}</p>
                  <pre>{h.output}</pre>
                </div>
              ))}
              {d && !ready && (
                <p>
                  Console unavailable:{" "}
                  {d.rcon.error ?? "The RCON connection is not ready."}
                </p>
              )}
            </div>
            <form
              id="mc-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (command.trim()) void send(command.trim());
              }}
            >
              <label htmlFor="mc-command">&gt;</label>
              <input
                id="mc-command"
                aria-label="Minecraft command"
                placeholder={
                  ready
                    ? "Enter a Minecraft command"
                    : "RCON connection unavailable"
                }
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                disabled={!ready || action.pending}
                autoComplete="off"
              />
              <Button
                type="submit"
                disabled={!ready || !command.trim() || action.pending}
              >
                Send
              </Button>
            </form>
          </div>
        </Panel>
        <Panel title="Quick commands">
          <div className="panel-body file-grid">
            {[
              ["Whitelist player", "whitelist add", true],
              ["Remove from whitelist", "whitelist remove", true],
              ["Set time to day", "time set day", false],
              ["Clear weather", "weather clear", false],
              ["Save worlds", "save-all", false],
            ].map(([label, cmd, player]) => (
              <Button
                key={String(cmd)}
                icon={player ? "user" : cmd === "save-all" ? "drive" : "sun"}
                disabled={!ready || action.pending}
                onClick={() => void quick(String(cmd), Boolean(player))}
              >
                {label}
              </Button>
            ))}
          </div>
        </Panel>
        <div className="mods-updates">
          <Panel
            title="Mods & plugins"
            sub={
              updates.data?.mcVersion
                ? `Paper ${updates.data.mcVersion} · installed plugin inventory`
                : "Installed plugin inventory"
            }
          >
            <Issue error={updates.error} />
            {plugins.length ? (
              <Table headers={["Plugin", "Installed", ""]}>
                {plugins.map((p) => (
                  <tr key={p.name}>
                    <td>
                      <span className="table-name">
                        <Icon name="plug" />
                        {p.name}
                      </span>
                    </td>
                    <td>{p.installed?.version ?? "Unknown"}</td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`View ${p.name}`}
                        onClick={() => setPlugin(p)}
                      >
                        <Icon name="external" />
                      </button>
                    </td>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>
                {updates.isPending
                  ? "Reading installed plugins…"
                  : "No installed plugins reported."}
              </Empty>
            )}
          </Panel>
          <RepositoryHub
            workspace={workspace}
            tag="minecraft"
            installedUpdates={updates.data}
          />
        </div>
        <div id="backups">
          <Backups />
        </div>
        <Panel
          title="Server settings"
          sub={d?.ping?.version ?? "Minecraft configuration"}
          actions={
            <Button icon="drive" onClick={() => setControls(true)}>
              Server controls
            </Button>
          }
        >
          <div className="panel-body">
            <Issue error={settings.error} />
            <Details
              items={[
                ["Game mode", settings.data?.gamemode ?? "Unavailable"],
                ["Difficulty", settings.data?.difficulty ?? "Unavailable"],
                [
                  "Maximum players",
                  settings.data?.["max-players"] ??
                    d?.players?.max ??
                    d?.ping?.max ??
                    "Unavailable",
                ],
                ["Memory in use", fmtBytes(d?.unit?.memoryBytes)],
                [
                  "Whitelist",
                  settings.data?.["white-list"] === "true"
                    ? "Enabled"
                    : settings.data?.["white-list"] === "false"
                      ? "Disabled"
                      : "Unavailable",
                ],
                ["Address", d?.address ?? "Checking"],
              ]}
            />
          </div>
        </Panel>
      </div>
      {reports && (
        <ReportsDialog kind="minecraft" onClose={() => setReports(false)} />
      )}{" "}
      {assistant && <AssistantDialog onClose={() => setAssistant(false)} />}{" "}
      {logs && <LogsDialog onClose={() => setLogs(false)} />}
      {controls && (
        <Drawer
          title="Minecraft server controls"
          onClose={() => setControls(false)}
        >
          <Details
            items={[
              ["Service", d?.unit?.active ?? "Unavailable"],
              ["Uptime", fmtUptime(d?.unit?.since)],
              [
                "Control connection",
                ready ? "Connected" : (d?.rcon.error ?? "Unavailable"),
              ],
            ]}
          />
          <div className="file-grid">
            {(["start", "stop", "restart"] as const).map((a) => (
              <Button
                key={a}
                icon={
                  a === "stop" ? "stop" : a === "start" ? "play" : "refresh"
                }
                disabled={action.pending}
                onClick={() =>
                  action.perform(
                    "/minecraft/action",
                    { action: a },
                    {
                      title: `${a[0].toUpperCase() + a.slice(1)} Minecraft?`,
                      description:
                        a === "start"
                          ? undefined
                          : "Connected players will be disconnected.",
                      danger: a !== "start",
                      success: `Minecraft ${a} requested`,
                      refresh: ["minecraft", "overview"],
                    },
                  )
                }
              >
                {a[0].toUpperCase() + a.slice(1)}
              </Button>
            ))}
            <Button icon="terminal" onClick={() => setLogs(true)}>
              Service logs
            </Button>
          </div>
        </Drawer>
      )}
      {plugin && (
        <Drawer title={plugin.name} onClose={() => setPlugin(null)}>
          <Details
            items={[
              ["Installed", plugin.installed?.version ?? "Unknown"],
              ["Latest upstream", plugin.latest?.version ?? "Not available"],
              ["Staged for restart", plugin.staged?.version ?? "None"],
              ["Status", plugin.status],
              ["Source", plugin.installed?.file ?? "Not reported"],
            ]}
          />
          {plugin.note && <p className="inline-note">{plugin.note}</p>}
        </Drawer>
      )}
    </>
  );
}
export function JellyfinDesign() {
  const q = useRead<JellyfinPayload>("jellyfin", "/jellyfin", 15000),
    config = useAppConfig(),
    jobs = useRead<JobView[]>("jobs", "/jobs"),
    action = useActions(),
    [reports, setReports] = useState(false),
    [controls, setControls] = useState(false);
  const d = q.data;
  return (
    <>
      <Head
        title="Jellyfin"
        actions={
          <Button icon="pulse" onClick={() => setReports(true)}>
            Reports
          </Button>
        }
      />
      <div className="section-stack">
        <TorrentQueue />
        <Panel
          title="Media files"
          sub="Move files between library folders"
          actions={
            <Button
              icon="refresh"
              disabled={action.pending}
              onClick={() =>
                action.perform("/jellyfin/refresh", undefined, {
                  success: "Jellyfin library scan started",
                  refresh: ["jellyfin"],
                })
              }
            >
              Scan library
            </Button>
          }
        >
          <MediaBrowser />
        </Panel>
        <Panel
          title="Media settings"
          sub="Jellyfin and its supporting download client"
          actions={
            <Status
              label={
                d?.reachable
                  ? "Connected"
                  : q.isPending
                    ? "Checking"
                    : "Unavailable"
              }
              state={d?.reachable ? "ok" : "unknown"}
            />
          }
        >
          <Issue error={q.error || d?.error} />
          <div className="panel-body">
            <Details
              items={[
                ["Server", d?.info?.serverName ?? "Unavailable"],
                ["Version", d?.info?.version ?? "Unavailable"],
                [
                  "Media folders",
                  config.data?.mediaRoots.join(", ") ?? "Checking",
                ],
                [
                  "Scheduled scans",
                  jobs.data
                    ?.filter((j) => /jellyfin|library.scan/i.test(j.name))
                    .map((j) => describeCron(j.cron))
                    .join(", ") || "No dashboard scan job configured",
                ],
              ]}
            />
            <div className="file-grid section-gap">
              <Button icon="film" onClick={() => setControls(true)}>
                Jellyfin controls
              </Button>
              <a className="text-link" href="/files">
                Drive usage <Icon name="external" />
              </a>
            </div>
          </div>
        </Panel>
      </div>
      {reports && (
        <ReportsDialog kind="jellyfin" onClose={() => setReports(false)} />
      )}{" "}
      {controls && (
        <Drawer title="Jellyfin controls" onClose={() => setControls(false)}>
          <Details
            items={[
              ["Server", d?.info?.serverName],
              ["Version", d?.info?.version],
              ["Container", d?.container?.state ?? "Unknown"],
              ["Movies", d?.counts?.Movies ?? "Unavailable"],
              ["Series", d?.counts?.Series ?? "Unavailable"],
              ["Episodes", d?.counts?.Episodes ?? "Unavailable"],
              ["Current sessions", d?.sessions.length ?? "Unavailable"],
            ]}
          />
          <div className="file-grid section-gap">
            {config.data?.links.jellyfin && (
              <a
                className="button primary"
                href={config.data.links.jellyfin}
                target="_blank"
                rel="noreferrer"
              >
                Open Jellyfin <Icon name="external" />
              </a>
            )}
            <Button
              icon="refresh"
              disabled={action.pending}
              onClick={() =>
                action.perform("/jellyfin/restart", undefined, {
                  title: "Restart Jellyfin?",
                  description: "Active playback will be interrupted.",
                  danger: true,
                  success: "Jellyfin restart requested",
                  refresh: ["jellyfin"],
                })
              }
            >
              Restart Jellyfin
            </Button>
          </div>
          <h3 className="section-gap">Current streams</h3>
          {d?.sessions.length ? (
            <Table headers={["Viewer", "Title", "Client"]}>
              {d.sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.user}</td>
                  <td>{s.nowPlaying?.name ?? "Idle"}</td>
                  <td>{s.client}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty>No active sessions.</Empty>
          )}
        </Drawer>
      )}
    </>
  );
}
