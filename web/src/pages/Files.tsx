import { useEffect, useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Icons } from "../components/icons";
import { Card, ErrorNotice, PageHead, useDialog, useToast } from "../components/ui";
import { fmtBytes, fmtDateTime } from "../format";
import type { FileEntry, FileListing } from "../types";

export function Files() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm, prompt } = useDialog();
  const roots = useQuery({ queryKey: ["files", "roots"], queryFn: () => api.get<string[]>("/files/roots"), staleTime: Infinity });
  const [root, setRoot] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!root && roots.data?.length) setRoot(roots.data[0]);
  }, [roots.data, root]);

  const listing = useQuery({
    queryKey: ["files", root, path],
    queryFn: () => api.get<FileListing>(`/files/list?root=${encodeURIComponent(root!)}&path=${encodeURIComponent(path)}`),
    enabled: !!root,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["files", root] });
  const onError = (e: Error) => toast(e.message, "error");

  const mkdir = useMutation({ mutationFn: (name: string) => api.post("/files/mkdir", { root, path, name }), onSuccess: invalidate, onError });
  const rename = useMutation({ mutationFn: (v: { path: string; newName: string }) => api.post("/files/rename", { root, ...v }), onSuccess: invalidate, onError });
  const move = useMutation({ mutationFn: (v: { path: string; dest: string }) => api.post("/files/move", { root, ...v }), onSuccess: invalidate, onError });
  const remove = useMutation({ mutationFn: (p: string) => api.post("/files/delete", { root, path: p }), onSuccess: invalidate, onError });
  const upload = useMutation({
    mutationFn: (files: FileList | File[]) => api.upload<{ uploaded: string[] }>(`/files/upload?root=${encodeURIComponent(root!)}&path=${encodeURIComponent(path)}`, files),
    onSuccess: (r) => {
      toast(`Uploaded ${r.uploaded.length} file${r.uploaded.length === 1 ? "" : "s"}`);
      invalidate();
    },
    onError,
  });

  const join = (name: string) => (path ? `${path}/${name}` : name);
  const crumbs = path ? path.split("/") : [];
  const navigate = (p: string) => {
    setPath(p);
    setSelected(null);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) upload.mutate(e.dataTransfer.files);
  };

  const actions = (entry: FileEntry) => (
    <div className="row" style={{ gap: 4, justifyContent: "flex-end", flexWrap: "nowrap" }}>
      <button
        className="btn sm ghost"
        onClick={async (ev) => {
          ev.stopPropagation();
          const newName = await prompt({ title: "Rename", label: "New name", initial: entry.name, confirmLabel: "Rename" });
          if (newName && newName !== entry.name) rename.mutate({ path: join(entry.name), newName });
        }}
      >
        Rename
      </button>
      <button
        className="btn sm ghost"
        onClick={async (ev) => {
          ev.stopPropagation();
          const dest = await prompt({ title: `Move "${entry.name}"`, label: `Destination folder inside ${root} (blank = top level)`, initial: path, confirmLabel: "Move", placeholder: "e.g. Season 02" });
          if (dest !== null) move.mutate({ path: join(entry.name), dest });
        }}
      >
        Move
      </button>
      <button
        className="btn sm ghost danger"
        onClick={async (ev) => {
          ev.stopPropagation();
          if (
            await confirm({
              title: `Delete "${entry.name}"?`,
              body: entry.type === "dir" ? "The folder and everything inside it will be deleted permanently." : "The file will be deleted permanently.",
              confirmLabel: "Delete",
              danger: true,
            })
          )
            remove.mutate(join(entry.name));
        }}
      >
        <Icons.trash width={14} height={14} />
      </button>
    </div>
  );

  return (
    <>
      <PageHead
        title="Media files"
        sub="Browse and organise the folders Jellyfin indexes. Changes trigger a library scan automatically."
        actions={
          <>
            <button
              className="btn"
              disabled={!root}
              onClick={async () => {
                const name = await prompt({ title: "New folder", label: "Folder name", confirmLabel: "Create" });
                if (name) mkdir.mutate(name);
              }}
            >
              <Icons.folderPlus width={14} height={14} /> New folder
            </button>
            <button className="btn primary" disabled={!root || upload.isPending} onClick={() => fileInput.current?.click()}>
              <Icons.upload width={14} height={14} /> {upload.isPending ? "Uploading…" : "Upload"}
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files?.length && upload.mutate(e.target.files)} />
          </>
        }
      />
      <ErrorNotice error={roots.error ?? listing.error} />

      <div className="row" style={{ marginBottom: 12 }}>
        {(roots.data ?? []).map((r) => (
          <button
            key={r}
            className={`btn sm ${r === root ? "primary" : ""}`}
            onClick={() => {
              setRoot(r);
              navigate("");
            }}
          >
            <Icons.folder width={14} height={14} /> {r}
          </button>
        ))}
        {roots.data?.length === 0 && <span className="notice">No media roots configured. Set MEDIA_ROOTS in the dashboard environment.</span>}
      </div>

      <Card
        title={
          <div className="breadcrumb">
            <button onClick={() => navigate("")}>{root ?? "…"}</button>
            {crumbs.map((c, i) => (
              <span key={i} className="row" style={{ gap: 4 }}>
                <span className="sep">/</span>
                <button onClick={() => navigate(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
              </span>
            ))}
          </div>
        }
        actions={<span className="muted small">{listing.data ? `${listing.data.entries.length} items` : ""}</span>}
      >
        <div
          className={`dropzone ${dragOver ? "active" : ""}`}
          style={{ marginBottom: 12 }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          Drop files here to upload into {root ?? "…"}/{path}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Size</th>
              <th>Modified</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {path && (
              <tr className="clickable" onClick={() => navigate(crumbs.slice(0, -1).join("/"))}>
                <td colSpan={4} className="dim">
                  ↑ ..
                </td>
              </tr>
            )}
            {listing.isLoading && (
              <tr>
                <td colSpan={4} className="skeleton">
                  Loading…
                </td>
              </tr>
            )}
            {listing.data?.entries.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Empty folder
                </td>
              </tr>
            )}
            {listing.data?.entries.map((e) => (
              <tr
                key={e.name}
                className={`clickable ${selected === e.name ? "selected" : ""}`}
                onClick={() => (e.type === "dir" ? navigate(join(e.name)) : setSelected(selected === e.name ? null : e.name))}
              >
                <td>
                  <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                    {e.type === "dir" ? <Icons.folder width={16} height={16} style={{ color: "var(--accent)" }} /> : <Icons.file width={16} height={16} className="muted" />}
                    <span className="truncate">{e.name}</span>
                  </span>
                </td>
                <td className="num dim">{e.type === "dir" ? "–" : fmtBytes(e.size)}</td>
                <td className="dim nowrap">{fmtDateTime(e.mtime)}</td>
                <td>{actions(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
