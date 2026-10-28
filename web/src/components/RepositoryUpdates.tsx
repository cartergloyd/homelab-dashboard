import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, ErrorNotice, Modal, useDialog, useToast } from "./ui";
import { fmtRelative } from "../format";
type Repo = {
  id: string;
  name: string;
  installed: string;
  workspace: "personal" | "business";
  tags: string[];
  latest: string | null;
  checkedAt: string | null;
  error: string | null;
  releaseUrl: string | null;
};
export function RepositoryUpdates({
  workspace,
}: {
  workspace: "personal" | "business";
}) {
  const qc = useQueryClient(),
    toast = useToast(),
    { confirm } = useDialog();
  const q = useQuery({
    queryKey: ["repositories"],
    queryFn: () => api.get<Repo[]>("/repositories"),
    refetchInterval: 30000,
  });
  const [editing, setEditing] = useState<Repo | "new" | null>(null),
    [name, setName] = useState(""),
    [installed, setInstalled] = useState(""),
    [tags, setTags] = useState(""),
    [filter, setFilter] = useState("");
  const done = () => {
      void qc.invalidateQueries({ queryKey: ["repositories"] });
    },
    error = (e: Error) => toast(e.message, "error");
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        installed: installed.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        workspace,
      };
      return editing && editing !== "new"
        ? api.put(`/repositories/${editing.id}`, body)
        : api.post("/repositories", body);
    },
    onSuccess: () => {
      done();
      setEditing(null);
    },
    onError: error,
  });
  const check = useMutation({
    mutationFn: () => api.post("/repositories/check"),
    onSuccess: () => {
      done();
      toast("Release check started. Results refresh automatically.");
    },
    onError: error,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/repositories/${id}`),
    onSuccess: done,
    onError: error,
  });
  const open = (repo: Repo | "new") => {
    setEditing(repo);
    setName(repo === "new" ? "" : repo.name);
    setInstalled(repo === "new" ? "" : repo.installed);
    setTags(repo === "new" ? "" : repo.tags.join(", "));
  };
  const repos =
    q.data?.filter(
      (r) =>
        r.workspace === workspace &&
        (!filter ||
          `${r.name} ${r.tags.join(" ")}`
            .toLowerCase()
            .includes(filter.toLowerCase())),
    ) ?? [];
  return (
    <Card
      title="Repository updates"
      actions={
        <>
          <button
            className="btn"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? "Checking…" : "Check GitHub"}
          </button>
          <button className="btn primary" onClick={() => open("new")}>
            Follow repository
          </button>
        </>
      }
    >
      <p className="muted small">
        Follow real GitHub releases. Installed versions are entered by you; a
        different tag is flagged for review. These checks never install
        software. Automatic checks run daily.
      </p>
      <input
        aria-label="Filter repositories by name or tag"
        placeholder="Filter repositories or tags"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ErrorNotice error={q.error} />
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Installed</th>
              <th>Latest</th>
              <th>Checked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {repos.map((r) => (
              <tr key={r.id}>
                <td>
                  <a
                    href={`https://github.com/${r.name}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.name}
                  </a>
                  <small className="dim">{r.tags.join(" · ")}</small>
                </td>
                <td>{r.installed}</td>
                <td>
                  {r.latest ?? "Not checked"}
                  {r.latest && r.latest !== r.installed && (
                    <span className="badge">Different tag</span>
                  )}
                  {r.error && <div className="notice error">{r.error}</div>}
                </td>
                <td>{r.checkedAt ? fmtRelative(r.checkedAt) : "Never"}</td>
                <td>
                  <div className="row">
                    <button className="btn sm" onClick={() => open(r)}>
                      Edit
                    </button>
                    <button
                      className="btn sm danger"
                      disabled={remove.isPending}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Unfollow ${r.name}?`,
                            body: "Stops version checks. Installed software is untouched.",
                            confirmLabel: "Unfollow",
                          })
                        )
                          remove.mutate(r.id);
                      }}
                    >
                      Unfollow
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.data && repos.length === 0 && (
        <p className="muted">
          {filter
            ? "No matching repositories."
            : "No repositories followed in this workspace."}
        </p>
      )}
      {editing && (
        <Modal
          title={editing === "new" ? "Follow repository" : "Edit repository"}
          onClose={() => setEditing(null)}
        >
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <label>
              GitHub owner/repository
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Installed version
              <input
                required
                value={installed}
                onChange={(e) => setInstalled(e.target.value)}
              />
            </label>
            <label>
              Tags (comma separated)
              <input value={tags} onChange={(e) => setTags(e.target.value)} />
            </label>
            <button className="btn primary" disabled={save.isPending}>
              Save
            </button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
