import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRead, useActions, type Workspace } from "./data";
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
import { fmtRelative } from "../format";
import type { StagedUpdatePayload } from "../types";
type Repo = {
  id: string;
  name: string;
  installed: string;
  workspace: Workspace;
  tags: string[];
  latest: string | null;
  checkedAt: string | null;
  error: string | null;
  releaseUrl: string | null;
};
export function RepositoryHub({
  workspace,
  tag,
  installedUpdates,
}: {
  workspace: Workspace;
  tag?: string;
  installedUpdates?: StagedUpdatePayload;
}) {
  const q = useRead<Repo[]>("repositories", "/repositories", 15000),
    action = useActions(),
    qc = useQueryClient(),
    [editor, setEditor] = useState<Repo | "new" | null>(null),
    [name, setName] = useState(""),
    [installed, setInstalled] = useState(""),
    [tags, setTags] = useState(""),
    [filter, setFilter] = useState("");
  const rows =
    q.data?.filter(
      (r) =>
        r.workspace === workspace &&
        (!tag || r.tags.includes(tag)) &&
        (!filter ||
          `${r.name} ${r.tags.join(" ")}`
            .toLowerCase()
            .includes(filter.toLowerCase())),
    ) ?? [];
  function edit(r: Repo | "new") {
    setEditor(r);
    setName(r === "new" ? "" : r.name);
    setInstalled(r === "new" ? "" : r.installed);
    setTags(r === "new" ? (tag ?? "") : r.tags.join(", "));
  }
  async function save() {
    const r = await action.perform(
      editor && editor !== "new"
        ? `/repositories/${editor.id}`
        : "/repositories",
      {
        name: name.trim(),
        installed: installed.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        workspace,
      },
      {
        method: editor && editor !== "new" ? "put" : undefined,
        refresh: ["repositories"],
        success: "Repository saved",
      },
    );
    if (r) setEditor(null);
  }
  return (
    <Panel
      title="Update hub"
      sub="Installed version → latest release"
      actions={
        <div className="head-actions">
          <Button icon="plus" onClick={() => edit("new")}>
            Follow repository
          </Button>
          <Button
            icon="refresh"
            disabled={action.pending}
            onClick={async () => {
              if (installedUpdates)
                await action.perform("/updates?refresh=1", undefined, {
                  method: "get",
                  refresh: ["updates"],
                });
              await action.perform("/repositories/check", undefined, {
                success: "Release check started; results refresh automatically",
                refresh: ["repositories"],
              });
            }}
          >
            Check releases
          </Button>
        </div>
      }
    >
      <Issue error={q.error} />
      {!tag && (
        <div className="panel-body">
          <input
            className="search-input"
            aria-label="Filter repository tags"
            placeholder="Filter repositories or tags"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}
      <Table
        headers={[
          "Repository",
          "Tags",
          "Installed",
          "Latest release",
          "Status",
          "Source",
        ]}
      >
        {installedUpdates?.items.map((item) => (
          <tr key={`installed-${item.name}`}>
            <td>{item.name}</td>
            <td>
              <span className="tag">minecraft</span>
            </td>
            <td>{item.installed?.version ?? "Unknown"}</td>
            <td>{item.latest?.version ?? "Not checked"}</td>
            <td>
              <Status
                label={
                  item.status === "up-to-date"
                    ? "Up to date"
                    : item.status === "staged"
                      ? "Staged"
                      : item.status === "update-available"
                        ? "Update available"
                        : "Unknown"
                }
                state={
                  item.status === "up-to-date"
                    ? "ok"
                    : item.status === "unknown"
                      ? "unknown"
                      : "warn"
                }
              />
            </td>
            <td>
              {item.latest?.url ? (
                <a
                  className="text-link"
                  href={item.latest.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Release <Icon name="external" />
                </a>
              ) : (
                (item.note ?? "Installed inventory")
              )}
            </td>
          </tr>
        ))}
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <button className="table-name" onClick={() => edit(r)}>
                {r.name}
              </button>
            </td>
            <td>
              <button className="text-link" onClick={() => edit(r)}>
                {r.tags.join(", ") || "Add tags"}
              </button>
            </td>
            <td>{r.installed}</td>
            <td>{r.latest ?? "Awaiting check"}</td>
            <td>
              <Status
                label={
                  r.error
                    ? "Check failed"
                    : !r.latest
                      ? "Not checked"
                      : r.latest === r.installed
                        ? "Same tag"
                        : "Different tag"
                }
                state={
                  r.error ? "warn" : r.latest === r.installed ? "ok" : "unknown"
                }
              />
              {r.error && <small>{r.error}</small>}
            </td>
            <td>
              <a
                className="text-link"
                href={`https://github.com/${r.name}/releases`}
                target="_blank"
                rel="noreferrer"
              >
                Releases <Icon name="external" />
              </a>
            </td>
          </tr>
        ))}
      </Table>
      {!rows.length && !installedUpdates?.items.length && (
        <Empty>
          No repositories configured{tag ? " with the minecraft tag" : ""}.
        </Empty>
      )}
      <div className="panel-body">
        <p className="inline-note">
          Automatic release checks run daily. Installed Minecraft versions come
          from the server; followed repository versions are entered by you.
          Updates are never installed automatically by this checker.
        </p>
        {installedUpdates?.nextApply && (
          <p className="inline-note">
            Next apply: {installedUpdates.nextApply.job} ·{" "}
            {fmtRelative(installedUpdates.nextApply.at)}
          </p>
        )}
      </div>
      {editor && (
        <Drawer
          title={editor === "new" ? "Follow repository" : "Edit repository"}
          onClose={() => setEditor(null)}
        >
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="field">
              GitHub owner/repository
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              Installed version
              <input
                required
                value={installed}
                onChange={(e) => setInstalled(e.target.value)}
              />
            </label>
            <label className="field">
              Tags (comma separated)
              <input value={tags} onChange={(e) => setTags(e.target.value)} />
            </label>
            <div className="file-grid">
              <Button primary type="submit" disabled={action.pending}>
                Save
              </Button>
              {editor !== "new" && (
                <Button
                  type="button"
                  className="danger"
                  disabled={action.pending}
                  onClick={async () => {
                    const r = await action.perform(
                      `/repositories/${editor.id}`,
                      undefined,
                      {
                        method: "delete",
                        title: `Unfollow ${editor.name}?`,
                        description: "Installed software is not removed.",
                        refresh: ["repositories"],
                        success: "Repository unfollowed",
                      },
                    );
                    if (r) setEditor(null);
                  }}
                >
                  Unfollow
                </Button>
              )}
            </div>
          </form>
        </Drawer>
      )}
    </Panel>
  );
}
