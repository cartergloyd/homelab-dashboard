import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, ErrorNotice, useToast } from "./ui";
import { Icons } from "./icons";
import { fmtBytes } from "../format";

type Target = { id: string; label: string; enabled: boolean };
type FileItem = { id: string; title: string; filename_download: string; type: string; filesize: number | string; uploaded_on: string };
const raster = (type: string) => /^image\/(png|jpeg|gif|webp|avif)$/.test(type);

export function DatabaseFiles() {
  const [selected, setSelected] = useState("");
  const [progress, setProgress] = useState("");
  const input = useRef<HTMLInputElement>(null), toast = useToast(), qc = useQueryClient();
  const targets = useQuery({ queryKey: ["database-file-targets"], queryFn: () => api.get<Target[]>("/database/files/targets") });
  const target = selected || targets.data?.find(t => t.enabled)?.id || "";
  const enabled = targets.data?.some(t => t.id === target && t.enabled);
  const files = useQuery({ queryKey: ["database-files", target], queryFn: () => api.get<FileItem[]>(`/database/files/${encodeURIComponent(target)}`), enabled: !!enabled });
  const upload = useMutation({
    mutationFn: async (chosen: File[]) => {
      if (chosen.some(f => f.size > 25 * 1024 * 1024)) throw new Error("Each file must be 25 MB or smaller.");
      let completed = 0;
      for (const file of chosen) {
        setProgress(`Uploading ${completed + 1} of ${chosen.length}…`);
        try { await api.upload<FileItem>(`/database/files/${encodeURIComponent(target)}`, [file]); }
        catch (e) { throw new Error(`${completed} of ${chosen.length} uploaded. ${(e as Error).message}`); }
        completed++;
      }
      return completed;
    },
    onSuccess: count => toast(`Uploaded ${count} file${count === 1 ? "" : "s"}`),
    onError: (e: Error) => toast(e.message, "error"),
    onSettled: () => { setProgress(""); void qc.invalidateQueries({ queryKey: ["database-files", target] }); },
  });
  return <Card title="Files & images" actions={<button className="btn" disabled={!enabled || upload.isPending} onClick={() => input.current?.click()}><Icons.upload width={14} height={14} /> {upload.isPending ? progress || "Uploading…" : "Upload files / images"}</button>}>
    <div className="row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
      <label htmlFor="upload-database">Database</label>
      <select id="upload-database" value={target} disabled={upload.isPending || !targets.data} onChange={e => setSelected(e.target.value)}>
        {!target && <option value="">Choose a database</option>}
        {targets.data?.map(t => <option key={t.id} value={t.id} disabled={!t.enabled}>{t.label}{t.enabled ? "" : " — uploads unavailable"}</option>)}
      </select>
      <span className="muted small">Images, documents, and other files · up to 25 MB each</span>
    </div>
    <input ref={input} type="file" multiple hidden aria-label="Upload files and images" onChange={e => { const chosen = Array.from(e.target.files ?? []); e.target.value = ""; if (chosen.length) upload.mutate(chosen); }} />
    <p className="muted small">Files stay private. Choose a database to see its latest 30 files.</p>
    {targets.isError && <ErrorNotice error={targets.error} />}
    {files.isError && <ErrorNotice error={files.error} />}
    {files.isFetching && !files.data && <p className="muted">Loading files…</p>}
    {files.data?.length === 0 && <p className="muted">No files uploaded here yet.</p>}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 170px), 1fr))", gap: 12 }}>
      {files.data?.map(file => {
        const url = `/api/database/files/${encodeURIComponent(target)}/${encodeURIComponent(file.id)}`;
        return <div key={file.id} style={{ border: "1px solid var(--hairline)", borderRadius: 8, padding: 12, minWidth: 0 }}>
          {raster(file.type) && <img src={`${url}?preview=1`} loading="lazy" alt={file.title || file.filename_download} style={{ width: "100%", height: 110, objectFit: "contain", marginBottom: 8 }} />}
          <div className="truncate" title={file.filename_download}>{file.filename_download}</div>
          <div className="muted small" style={{ margin: "4px 0 8px" }}>{fmtBytes(Number(file.filesize))}</div>
          <a className="btn sm" href={url} download={file.filename_download}>Download</a>
        </div>;
      })}
    </div>
  </Card>;
}
