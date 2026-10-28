import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAppConfig } from "../App";
import { useToast } from "../components/ui";
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
import { Drawer } from "./shared";
import { useRead, useActions } from "./data";
import { fmtBytes, fmtDateTime } from "../format";
import type { FileEntry, FileListing } from "../types";
type Torrent = {
  hash: string;
  name: string;
  size: number;
  progress: number;
  state: string;
  downloadSpeed: number;
  uploadSpeed: number;
  eta: number;
  savePath: string;
};
export function TorrentQueue() {
  const [showAll, setShowAll] = useState(false),
    toast = useToast();
  const q = useRead<Torrent[]>("torrent-queue", "/qbittorrent/queue", 5000),
    config = useAppConfig(),
    action = useActions(),
    [adding, setAdding] = useState(false),
    [urls, setUrls] = useState(""),
    [paused, setPaused] = useState(false),
    [selected, setSelected] = useState<Torrent | null>(null);
  async function add() {
    const r = await action.perform<{ submitted: number; failed?: number }>(
      "/qbittorrent/torrents",
      { urls, paused },
      { refresh: ["torrent-queue"] },
    );
    if (r) {
      toast(
        r.failed
          ? `qBittorrent accepted ${r.submitted} links; ${r.failed} failed. Check the queue before retrying.`
          : `Sent ${r.submitted} links to qBittorrent`,
        r.failed ? "error" : "info",
      );
      setAdding(false);
      setUrls("");
    }
  }
  return (
    <Panel
      title="Downloads"
      sub="qBittorrent"
      actions={
        <Button primary icon="drive" onClick={() => setAdding(true)}>
          Add torrent links
        </Button>
      }
    >
      <Issue error={q.error} />
      <Table headers={["Source", "Destination", "Status", ""]}>
        {q.data
          ?.filter((t) => showAll || t.progress < 1)
          .map((t) => (
            <tr key={t.hash}>
              <td>
                <button className="table-name" onClick={() => setSelected(t)}>
                  <Icon name="file" />
                  <span>
                    {t.name}
                    <small>{fmtBytes(t.size)}</small>
                  </span>
                </button>
              </td>
              <td className="muted">{t.savePath}</td>
              <td>
                <Status
                  label={`${(t.progress * 100).toFixed(1)}% · ${t.state}`}
                  state={
                    t.state.toLowerCase().includes("error")
                      ? "warn"
                      : t.progress === 1
                        ? "ok"
                        : "unknown"
                  }
                />
                <small>
                  {fmtBytes(t.downloadSpeed)}/s ↓ · {fmtBytes(t.uploadSpeed)}/s
                  ↑
                </small>
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`Manage ${t.name}`}
                  onClick={() => setSelected(t)}
                >
                  <Icon name="external" />
                </button>
              </td>
            </tr>
          ))}
      </Table>
      {q.data?.filter((t) => t.progress < 1).length === 0 && !showAll && (
        <Empty>No unfinished downloads.</Empty>
      )}
      {q.data && (
        <div className="panel-bottom">
          <span>
            {q.data.filter((t) => t.progress < 1).length} unfinished ·{" "}
            {q.data.filter((t) => t.progress >= 1).length} completed
          </span>
          <button className="text-link" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show unfinished" : `View all ${q.data.length} torrents`}
          </button>
        </div>
      )}
      {q.isPending && <Empty>Reading download queue…</Empty>}
      {adding && (
        <Drawer
          title="Add torrent links"
          onClose={() => {
            if (!action.pending) setAdding(false);
          }}
        >
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <p className="inline-note">
              Paste one magnet link or torrent URL per line. qBittorrent keeps
              its configured download location.
            </p>
            <label className="field">
              Torrent links
              <textarea
                rows={6}
                maxLength={40000}
                required
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
              />{" "}
              Add paused
            </label>
            <Button primary disabled={action.pending || !urls.trim()}>
              Add to qBittorrent
            </Button>
          </form>
        </Drawer>
      )}
      {selected && (
        <Drawer title={selected.name} onClose={() => setSelected(null)}>
          <Details
            items={[
              ["State", selected.state],
              ["Progress", `${(selected.progress * 100).toFixed(1)}%`],
              ["Download location", selected.savePath],
              ["Size", fmtBytes(selected.size)],
            ]}
          />
          <div className="file-grid section-gap">
            {(["pause", "resume", "remove"] as const).map((a) => (
              <Button
                key={a}
                icon={
                  a === "remove" ? "trash" : a === "pause" ? "stop" : "play"
                }
                disabled={action.pending}
                className={a === "remove" ? "danger" : ""}
                onClick={async () => {
                  const r = await action.perform(
                    "/qbittorrent/control",
                    { hash: selected.hash, action: a },
                    {
                      title: `${a[0].toUpperCase() + a.slice(1)} this torrent?`,
                      description:
                        a === "remove"
                          ? "Downloaded files are kept."
                          : selected.name,
                      danger: a === "remove",
                      refresh: ["torrent-queue"],
                      success: "Torrent queue updated",
                    },
                  );
                  if (r) setSelected(null);
                }}
              >
                {a[0].toUpperCase() + a.slice(1)}
              </Button>
            ))}
            {config.data?.links.qbittorrent && (
              <a
                className="button"
                href={config.data.links.qbittorrent}
                target="_blank"
                rel="noreferrer"
              >
                Open qBittorrent <Icon name="external" />
              </a>
            )}
          </div>
        </Drawer>
      )}
    </Panel>
  );
}
export function MediaBrowser({ initialRoot }: { initialRoot?: string }) {
  const config = useAppConfig(),
    qc = useQueryClient(),
    toast = useToast(),
    action = useActions(),
    upload = useRef<HTMLInputElement>(null);
  const [selectedRoot, setSelectedRoot] = useState(initialRoot ?? ""),
    [path, setPath] = useState(""),
    [file, setFile] = useState<FileEntry | null>(null),
    [moving, setMoving] = useState<FileEntry | null>(null),
    [destination, setDestination] = useState(""),
    [managing, setManaging] = useState(false),
    [uploading, setUploading] = useState(false);
  const root = selectedRoot || config.data?.mediaRoots[0] || "",
    q = useQuery({
      queryKey: ["files", root, path],
      queryFn: () =>
        api.get<FileListing>(
          `/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
        ),
      enabled: !!root,
    });
  const target = useQuery({
    queryKey: ["files", root, "destination", destination],
    queryFn: () =>
      api.get<FileListing>(
        `/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(destination)}`,
      ),
    enabled: !!root && !!moving,
  });
  const join = (name: string) => (path ? path + "/" + name : name),
    crumbs = path.split("/").filter(Boolean);
  async function uploadFiles(files: File[]) {
    setUploading(true);
    try {
      const r = await api.upload<{ uploaded: string[] }>(
        `/files/upload?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
        files,
      );
      toast(`Uploaded ${r.uploaded.length} files`);
      void qc.invalidateQueries({ queryKey: ["files"] });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setUploading(false);
    }
  }
  return (
    <>
      <div className="media-path">
        <button onClick={() => setPath("")}>{root || "Media"}</button>
        {crumbs.map((name, i) => (
          <span key={i} className="row-controls">
            <span>/</span>
            <button onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>
              {name}
            </button>
          </span>
        ))}
        {(config.data?.mediaRoots.length ?? 0) > 1 && (
          <select
            aria-label="Media root"
            value={root}
            onChange={(e) => {
              setSelectedRoot(e.target.value);
              setPath("");
            }}
          >
            {config.data?.mediaRoots.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        )}
        <button
          className="text-link"
          style={{ marginLeft: "auto" }}
          onClick={() => setManaging(true)}
        >
          Manage files <Icon name="folder" />
        </button>
      </div>
      <Issue error={q.error} />
      <Table headers={["Name", "Type", ""]}>
        {q.data?.entries.map((entry) => (
          <tr key={entry.name}>
            <td>
              {entry.type === "dir" ? (
                <button
                  className="table-name folder-link"
                  onClick={() => setPath(join(entry.name))}
                >
                  <Icon name="folder" />
                  {entry.name}
                </button>
              ) : (
                <button className="table-name" onClick={() => setFile(entry)}>
                  <Icon name="file" />
                  {entry.name}
                </button>
              )}
            </td>
            <td className="muted">
              {entry.type === "dir" ? "Folder" : fmtBytes(entry.size)}
            </td>
            <td>
              {entry.type === "dir" ? (
                <button
                  className="icon-button"
                  aria-label={`Open ${entry.name}`}
                  onClick={() => setPath(join(entry.name))}
                >
                  <Icon name="external" />
                </button>
              ) : (
                <div className="table-actions">
                  {!!path && (
                    <Button
                      icon="folder"
                      onClick={() => {
                        setMoving(entry);
                        setDestination("");
                      }}
                    >
                      Move
                    </Button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={`Details for ${entry.name}`}
                    onClick={() => setFile(entry)}
                  >
                    <Icon name="chevron" />
                  </button>
                </div>
              )}
            </td>
          </tr>
        ))}
      </Table>
      {q.data?.entries.length === 0 && <Empty>This folder is empty.</Empty>}
      {q.isPending && (
        <Empty>
          {root ? "Reading media folders…" : "No media root configured."}
        </Empty>
      )}
      <input
        ref={upload}
        hidden
        type="file"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void uploadFiles(files);
        }}
      />
      {managing && (
        <Drawer title="Manage media files" onClose={() => setManaging(false)}>
          <p className="inline-note">
            {root}
            {path ? "/" + path : ""} · File changes trigger a Jellyfin library
            scan.
          </p>
          <div className="file-grid">
            <Button
              icon="upload"
              disabled={uploading}
              onClick={() => upload.current?.click()}
            >
              {uploading ? "Uploading…" : "Upload files"}
            </Button>
            <Button
              icon="folderPlus"
              disabled={action.pending}
              onClick={async () => {
                const name = await action.prompt({
                  title: "New folder",
                  label: "Folder name",
                  confirmLabel: "Create",
                });
                if (name)
                  await action.perform(
                    "/files/mkdir",
                    { root, path, name },
                    { refresh: ["files"], success: "Folder created" },
                  );
              }}
            >
              New folder
            </Button>
            {!!path && (
              <>
                <Button
                  icon="file"
                  disabled={action.pending}
                  onClick={async () => {
                    const current = path.split("/").pop()!;
                    const name = await action.prompt({
                      title: "Rename current folder",
                      label: "New name",
                      initial: current,
                      confirmLabel: "Next",
                    });
                    if (!name || name === current) return;
                    const r = await action.perform(
                      "/files/rename",
                      { root, path, newName: name },
                      {
                        title: `Rename ${path}?`,
                        description: name,
                        refresh: ["files"],
                        success: "Folder renamed",
                      },
                    );
                    if (r) {
                      const parent = path.split("/").slice(0, -1).join("/");
                      setPath(parent ? parent + "/" + name : name);
                    }
                  }}
                >
                  Rename current folder
                </Button>
                <Button
                  icon="folder"
                  disabled={action.pending}
                  onClick={async () => {
                    const dest = await action.prompt({
                      title: "Move current folder",
                      label: `Destination directory inside ${root} (blank = top level)`,
                      initial: "",
                      confirmLabel: "Next",
                    });
                    if (dest === null) return;
                    const r = await action.perform(
                      "/files/move",
                      { root, path, dest },
                      {
                        title: `Move ${path}?`,
                        description: `Destination: ${root}/${dest}`,
                        refresh: ["files"],
                        success: "Folder moved",
                      },
                    );
                    if (r) {
                      const name = path.split("/").pop()!;
                      setPath(dest ? dest + "/" + name : name);
                    }
                  }}
                >
                  Move current folder
                </Button>
                <Button
                  icon="trash"
                  className="danger"
                  disabled={action.pending}
                  onClick={async () => {
                    const r = await action.perform(
                      "/files/delete",
                      { root, path },
                      {
                        title: `Delete ${path}?`,
                        description:
                          "The folder and all of its contents will be permanently deleted.",
                        danger: true,
                        refresh: ["files"],
                        success: "Folder deleted",
                      },
                    );
                    if (r) {
                      setPath(path.split("/").slice(0, -1).join("/"));
                      setManaging(false);
                    }
                  }}
                >
                  Delete current folder
                </Button>
              </>
            )}
          </div>
        </Drawer>
      )}
      {file && (
        <Drawer title={file.name} onClose={() => setFile(null)}>
          <Details
            items={[
              ["Location", `${root}/${join(file.name)}`],
              ["Size", fmtBytes(file.size)],
              ["Modified", fmtDateTime(file.mtime)],
            ]}
          />
          <div className="file-grid section-gap">
            <Button
              icon="file"
              disabled={action.pending}
              onClick={async () => {
                const newName = await action.prompt({
                  title: "Rename file",
                  label: "New name",
                  initial: file.name,
                  confirmLabel: "Next",
                });
                if (newName && newName !== file.name) {
                  const r = await action.perform(
                    "/files/rename",
                    { root, path: join(file.name), newName },
                    {
                      title: `Rename ${file.name}?`,
                      description: newName,
                      refresh: ["files"],
                      success: "File renamed",
                    },
                  );
                  if (r) setFile(null);
                }
              }}
            >
              Rename
            </Button>
            {!!path && (
              <Button
                icon="folder"
                onClick={() => {
                  setMoving(file);
                  setDestination("");
                  setFile(null);
                }}
              >
                Move
              </Button>
            )}
            <Button
              icon="trash"
              className="danger"
              disabled={action.pending}
              onClick={async () => {
                const r = await action.perform(
                  "/files/delete",
                  { root, path: join(file.name) },
                  {
                    title: `Delete ${file.name}?`,
                    description: "This permanently deletes the file.",
                    danger: true,
                    refresh: ["files"],
                    success: "File deleted",
                  },
                );
                if (r) setFile(null);
              }}
            >
              Delete
            </Button>
          </div>
        </Drawer>
      )}
      {moving && (
        <Drawer title={`Move ${moving.name}`} onClose={() => setMoving(null)}>
          <p className="inline-note">
            Choose a destination inside {root}. An existing file will not be
            overwritten.
          </p>
          <div className="media-path">
            <button onClick={() => setDestination("")}>{root}</button>
            {destination
              .split("/")
              .filter(Boolean)
              .map((c, i, arr) => (
                <span className="row-controls" key={i}>
                  /
                  <button
                    onClick={() =>
                      setDestination(arr.slice(0, i + 1).join("/"))
                    }
                  >
                    {c}
                  </button>
                </span>
              ))}
          </div>
          <Issue error={target.error} />
          <div className="link-stack">
            {target.data?.entries
              .filter((e) => e.type === "dir")
              .map((e) => (
                <Button
                  key={e.name}
                  icon="folder"
                  onClick={() =>
                    setDestination(
                      destination ? destination + "/" + e.name : e.name,
                    )
                  }
                >
                  {e.name}
                </Button>
              ))}
          </div>
          <Button
            primary
            style={{ marginTop: 20 }}
            disabled={action.pending || target.isPending}
            onClick={async () => {
              const r = await action.perform(
                "/files/move",
                { root, path: join(moving.name), dest: destination },
                {
                  title: `Move ${moving.name}?`,
                  description: `Destination: ${root}/${destination || ""}`,
                  refresh: ["files"],
                  success: "File moved; Jellyfin scan scheduled",
                },
              );
              if (r) setMoving(null);
            }}
          >
            Move here
          </Button>
        </Drawer>
      )}
    </>
  );
}
