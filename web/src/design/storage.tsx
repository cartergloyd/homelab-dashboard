import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAppConfig } from "../App";
import { useToast } from "../components/ui";
import { DirectusDesign } from "./directus";
import { DriveCards, Drawer } from "./shared";
import { MediaBrowser } from "./media";
import { useRead, type Workspace, workspaceName } from "./data";
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
import { fmtBytes, fmtDateTime } from "../format";
import type { AppsPayload, DatabasePayload, JellyfinPayload } from "../types";
type FileTarget = { id: string; label: string; enabled: boolean };
type StoredFile = {
  id: string;
  title: string;
  filename_download: string;
  type: string;
  filesize: string | number;
  uploaded_on: string;
};
export function FileStore({
  initialTarget,
  compact = false,
}: {
  initialTarget?: string;
  compact?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const targets = useRead<FileTarget[]>(
      "database-file-targets",
      "/database/files/targets",
    ),
    [selected, setSelected] = useState(initialTarget ?? ""),
    [pending, setPending] = useState(false),
    [progress, setProgress] = useState(""),
    [view, setView] = useState<StoredFile | null>(null),
    input = useRef<HTMLInputElement>(null),
    toast = useToast(),
    qc = useQueryClient();
  const target = selected || targets.data?.find((t) => t.enabled)?.id || "",
    enabled = targets.data?.some((t) => t.id === target && t.enabled),
    q = useQuery({
      queryKey: ["database-files", target],
      queryFn: () =>
        api.get<StoredFile[]>(`/database/files/${encodeURIComponent(target)}`),
      enabled: !!enabled,
    });
  async function upload(files: File[]) {
    if (files.some((f) => f.size > 25 * 1024 * 1024)) {
      toast("Each file must be 25 MB or smaller.", "error");
      return;
    }
    setPending(true);
    let completed = 0;
    try {
      for (const file of files) {
        setProgress(`Uploading ${completed + 1} of ${files.length}…`);
        await api.upload(`/database/files/${encodeURIComponent(target)}`, [
          file,
        ]);
        completed++;
      }
      toast(`Uploaded ${completed} files`);
    } catch (e) {
      toast(
        `${completed} of ${files.length} uploaded. ${(e as Error).message}`,
        "error",
      );
    } finally {
      setPending(false);
      setProgress("");
      void qc.invalidateQueries({ queryKey: ["database-files", target] });
    }
  }
  return (
    <>
      <div className="panel-body row-controls">
        <label>
          Database{" "}
          <select
            className="activity-filter"
            aria-label="Upload database"
            value={target}
            disabled={pending}
            onChange={(e) => setSelected(e.target.value)}
          >
            {targets.data?.map((t) => (
              <option key={t.id} value={t.id} disabled={!t.enabled}>
                {t.label}
                {t.enabled ? "" : " · unavailable"}
              </option>
            ))}
          </select>
        </label>
        <Button
          icon="upload"
          primary
          disabled={!enabled || pending}
          onClick={() => input.current?.click()}
        >
          {pending ? progress : "Upload files"}
        </Button>
        <span className="inline-note">
          Images, documents and other files · 25 MB per file
        </span>
      </div>
      <input
        hidden
        ref={input}
        type="file"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void upload(files);
        }}
      />
      <Issue error={targets.error || q.error} />
      <Table headers={["File", "Type", "Size", "Uploaded", ""]}>
        {(compact && !showAll ? q.data?.slice(0, 5) : q.data)?.map((f) => (
          <tr key={f.id}>
            <td>
              <button className="table-name" onClick={() => setView(f)}>
                <Icon name="file" />
                {f.filename_download}
              </button>
            </td>
            <td>
              {f.type.startsWith("image/")
                ? f.type.split("/")[1].toUpperCase() + " image"
                : /\.xlsx?$/i.test(f.filename_download)
                  ? "Spreadsheet"
                  : f.type === "application/json"
                    ? "JSON"
                    : f.type === "application/pdf"
                      ? "PDF"
                      : f.type}
            </td>
            <td>{fmtBytes(Number(f.filesize))}</td>
            <td>{fmtDateTime(f.uploaded_on)}</td>
            <td>
              <a
                className="text-link"
                href={`/api/database/files/${encodeURIComponent(target)}/${encodeURIComponent(f.id)}`}
                download={f.filename_download}
              >
                Download <Icon name="external" />
              </a>
            </td>
          </tr>
        ))}
      </Table>
      {q.data?.length === 0 && (
        <Empty>No files uploaded in this database.</Empty>
      )}
      {q.isPending && enabled && <Empty>Loading private files…</Empty>}
      {!enabled && (
        <Empty>File uploads are not configured for this database.</Empty>
      )}
      {compact && (q.data?.length ?? 0) > 5 && (
        <div className="panel-bottom">
          <span>Latest private files</span>
          <button className="text-link" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `View ${q.data?.length} files`}
          </button>
        </div>
      )}
      {view && (
        <Drawer title={view.filename_download} onClose={() => setView(null)}>
          {/^image\/(png|jpeg|gif|webp|avif)$/.test(view.type) && (
            <img
              src={`/api/database/files/${encodeURIComponent(target)}/${encodeURIComponent(view.id)}?preview=1`}
              alt={view.title || view.filename_download}
              style={{ width: "100%", maxHeight: 360, objectFit: "contain" }}
            />
          )}
          <Details
            items={[
              ["Type", view.type],
              ["Size", fmtBytes(Number(view.filesize))],
              ["Uploaded", fmtDateTime(view.uploaded_on)],
            ]}
          />
          <a
            className="button"
            href={`/api/database/files/${encodeURIComponent(target)}/${encodeURIComponent(view.id)}`}
            download={view.filename_download}
          >
            Download
          </a>
        </Drawer>
      )}
    </>
  );
}
export function Connections({ workspace }: { workspace: Workspace }) {
  const apps = useRead<AppsPayload>("apps", "/apps"),
    host = useRead<{ hostname: string }>("host", "/host"),
    jf = useRead<JellyfinPayload>("jellyfin", "/jellyfin"),
    [details, setDetails] = useState(false),
    db = useRead<DatabasePayload>("database", "/database"),
    config = useAppConfig();
  const clients =
    apps.data?.apps.filter((a) =>
      workspace === "business" ? a.name !== "fam" : a.name === "fam",
    ) ?? [];
  return (
    <Panel title="APIs & website connections">
      <Table
        headers={[
          "Website / client",
          "API",
          "Database",
          "Status",
          "Authentication",
        ]}
      >
        {workspace === "personal" && (
          <>
            <tr>
              <td>Jellyfin clients</td>
              <td>Jellyfin HTTP API</td>
              <td>Jellyfin library database</td>
              <td>
                <Status
                  label={
                    jf.data?.reachable && !jf.data.error
                      ? "Connected"
                      : "Unavailable"
                  }
                  state={
                    jf.data?.reachable && !jf.data.error ? "ok" : "unknown"
                  }
                />
              </td>
              <td>Server-side API key</td>
            </tr>
            <tr>
              <td>Dashboard</td>
              <td>Host inventory API</td>
              <td>Host metadata</td>
              <td>
                <Status
                  label={host.data ? "Connected" : "Checking"}
                  state={host.data ? "ok" : "unknown"}
                />
              </td>
              <td>Authenticated server session</td>
            </tr>
          </>
        )}
        {clients.map((a) => (
          <tr key={a.name}>
            <td>
              {a.siteUrl ? (
                <a
                  className="plain-link"
                  href={a.siteUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {new URL(a.siteUrl).hostname}
                </a>
              ) : (
                a.name
              )}
            </td>
            <td>
              {a.kind === "twenty"
                ? "Twenty GraphQL"
                : a.kind === "directus"
                  ? "Directus REST"
                  : "Umami API"}
              <small>{a.publicUrl ?? "Private instance"}</small>
            </td>
            <td>{a.db}</td>
            <td>
              <Status
                label={a.state === "ok" ? "Connected" : a.state}
                state={a.state}
              />
            </td>
            <td>
              {a.kind === "directus"
                ? "Directus account / service token"
                : a.kind === "twenty"
                  ? "Twenty sign-in / API key"
                  : "Application sign-in"}
            </td>
          </tr>
        ))}
      </Table>
      <div className="panel-body">
        <p className="inline-note">
          Website backend → authenticated API → database. Browser requests go
          through the dashboard; database credentials stay on the server.
        </p>
        <Button icon="pulse" onClick={() => setDetails(true)}>
          Connection details
        </Button>
      </div>
      {details && (
        <Drawer title="Database connections" onClose={() => setDetails(false)}>
          <Issue error={db.error || apps.error} />
          <Details
            items={[
              ["Personal Directus", db.data?.directus.state ?? "Checking"],
              [
                "PostgreSQL",
                db.data?.postgres.connected ? "Connected" : "Unavailable",
              ],
              ["Version", db.data?.postgres.version ?? "Unavailable"],
              ["Database size", fmtBytes(db.data?.postgres.sizeBytes)],
              ["Table count", db.data?.postgres.tables ?? "Unavailable"],
              ["Backups directory", apps.data?.backupDir ?? "Checking"],
            ]}
          />
          <h3 className="section-gap">Application databases</h3>
          <Table headers={["App", "Database", "Size", "Latest backup"]}>
            {apps.data?.apps.map((a) => (
              <tr key={a.name}>
                <td>{a.name}</td>
                <td>{a.db}</td>
                <td>{fmtBytes(a.database.sizeBytes)}</td>
                <td>
                  {a.backup.latest
                    ? fmtDateTime(a.backup.latest)
                    : "No backup reported"}
                </td>
              </tr>
            ))}
          </Table>
          <h3 className="section-gap">Personal database tables</h3>
          <Table headers={["Table", "Rows", "Size"]}>
            {db.data?.postgres.topTables.map((t) => (
              <tr key={t.name}>
                <td>{t.name}</td>
                <td>{t.rows}</td>
                <td>{fmtBytes(t.bytes)}</td>
              </tr>
            ))}
          </Table>
        </Drawer>
      )}
    </Panel>
  );
}
export function StorageDesign({ workspace }: { workspace: Workspace }) {
  const config = useAppConfig(),
    [browser, setBrowser] = useState<string | null>(null),
    [library, setLibrary] = useState(false);
  return (
    <>
      <Head
        title={workspace === "business" ? "Business files" : "Files & storage"}
      />
      <DirectusDesign workspace={workspace} />
      <div className="scope-banner">
        <strong>{workspaceName(workspace)}</strong>
        <span>
          {workspace === "personal"
            ? "Personal files · media · worlds"
            : "Business files · CRM · client projects"}
        </span>
        <span className="tag">Shared physical host</span>
      </div>
      <DriveCards />
      <div className="section-stack section-gap">
        <Panel
          title="Workspace files"
          sub={
            workspace === "personal"
              ? "Personal files"
              : "Files accessible to this workspace"
          }
        >
          <div className="panel-body file-grid">
            {workspace === "personal" &&
              config.data?.mediaRoots.map((root) => (
                <Button
                  key={root}
                  icon="folder"
                  onClick={() => setBrowser(root)}
                >
                  {root} <Icon name="external" />
                </Button>
              ))}
            {workspace === "business" && (
              <Button icon="folder" onClick={() => setLibrary(true)}>
                Business files <Icon name="external" />
              </Button>
            )}
            {workspace === "personal" && (
              <a className="button" href="/minecraft#backups">
                <Icon name="cube" />
                Minecraft worlds & backups <Icon name="external" />
              </a>
            )}
            {config.data?.mediaRoots.length === 0 && (
              <p className="inline-note">No host file roots configured.</p>
            )}
          </div>
        </Panel>
        <Panel title="Uploads & database records">
          <FileStore
            key={workspace}
            initialTarget={workspace === "business" ? "ai" : "personal"}
            compact
          />
        </Panel>
        <Connections workspace={workspace} />
      </div>
      {library && (
        <Drawer title="Business files" onClose={() => setLibrary(false)}>
          <FileStore initialTarget="ai" />
        </Drawer>
      )}
      {browser && (
        <Drawer title={browser} onClose={() => setBrowser(null)}>
          <MediaBrowser initialRoot={browser} />
        </Drawer>
      )}
    </>
  );
}
