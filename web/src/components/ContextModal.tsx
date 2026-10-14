// "Instructions & context": view/edit the Minecraft server context agents read,
// with a change log.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { fmtDateTime, fmtRelative } from "../format";
import type { ContextHistoryEntry, ContextPayload, ContextVersion } from "../types";
import { Modal, useDialog, useToast } from "./ui";

export function ContextModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialog();
  const [tab, setTab] = useState<"editor" | "history">("editor");
  const ctx = useQuery({ queryKey: ["context"], queryFn: () => api.get<ContextPayload>("/context") });
  const history = useQuery({ queryKey: ["context", "history"], queryFn: () => api.get<ContextHistoryEntry[]>("/context/history"), enabled: tab === "history" });
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const version = useQuery({ queryKey: ["context", "version", versionId], queryFn: () => api.get<ContextVersion>(`/context/history/${versionId}`), enabled: !!versionId });

  // load the draft once per fetched hash (don't clobber typing on refetch)
  useEffect(() => {
    if (ctx.data && ctx.data.hash !== baseHash) {
      setDraft(ctx.data.content);
      setBaseHash(ctx.data.hash);
    }
  }, [ctx.data, baseHash]);

  const dirty = ctx.data ? draft !== ctx.data.content : false;

  const save = useMutation({
    mutationFn: () => api.put<ContextPayload>("/context", { content: draft, baseHash, note }),
    onSuccess: () => {
      toast("Instructions saved");
      setNote("");
      qc.invalidateQueries({ queryKey: ["context"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.post<ContextPayload>(`/context/history/${id}/restore`),
    onSuccess: () => {
      toast("Version restored");
      setVersionId(null);
      setTab("editor");
      qc.invalidateQueries({ queryKey: ["context"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  return (
    <Modal title="Minecraft instructions & context" onClose={onClose} wide>
      <div className="row spread" style={{ marginBottom: 10 }}>
        <div className="tabs">
          <button className={`btn sm ${tab === "editor" ? "primary" : "ghost"}`} onClick={() => setTab("editor")}>
            Editor
          </button>
          <button className={`btn sm ${tab === "history" ? "primary" : "ghost"}`} onClick={() => setTab("history")}>
            Change log
          </button>
        </div>
        <span className="muted small mono truncate" style={{ maxWidth: 420 }} title={ctx.data?.path}>
          {ctx.data?.path}
        </span>
      </div>

      {tab === "editor" && (
        <div className="stack">
          <p className="dim small" style={{ margin: 0 }}>
            This is the Minecraft server context connected agents read before they act. Keep operational rules, known harmless alerts, repair patterns, and follow-up instructions here. Every save is kept in the change log.
          </p>
          <textarea className="input mono" rows={22} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} style={{ resize: "vertical", lineHeight: 1.5 }} />
          <div className="row">
            <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="What changed? (optional note for the log)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn" disabled={!dirty} onClick={() => ctx.data && setDraft(ctx.data.content)}>
              Discard
            </button>
            <button className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              Save
            </button>
          </div>
          <div className="muted small">
            {ctx.data?.updatedAt ? `Last modified ${fmtRelative(ctx.data.updatedAt)} · ` : ""}
            {dirty ? "Unsaved changes" : "No unsaved changes"}
          </div>
        </div>
      )}

      {tab === "history" && !versionId && (
        <div className="stack">
          {history.data?.length === 0 && <span className="muted">No changes recorded yet.</span>}
          {!!history.data?.length && (
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Note</th>
                  <th className="num">Lines</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((h) => (
                  <tr key={h.id} className="clickable" onClick={() => setVersionId(h.id)}>
                    <td className="nowrap" title={fmtDateTime(h.ts)}>
                      {fmtRelative(h.ts)}
                    </td>
                    <td>
                      <span className="badge">{h.author}</span>
                    </td>
                    <td className="dim">{h.note || <span className="muted">—</span>}</td>
                    <td className="num">
                      <span style={{ color: "var(--good-text)" }}>+{h.added}</span> <span style={{ color: "var(--critical)" }}>−{h.removed}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "history" && versionId && (
        <div className="stack">
          <div className="row spread">
            <button className="btn sm ghost" onClick={() => setVersionId(null)}>
              ← All changes
            </button>
            {version.data && (
              <span className="dim small">
                {fmtDateTime(version.data.ts)} · <span className="badge">{version.data.author}</span> {version.data.note}
              </span>
            )}
            <button
              className="btn sm"
              disabled={!version.data || restore.isPending}
              onClick={async () => {
                if (await confirm({ title: "Restore this version?", body: "The current file is kept in the change log, so this can be undone.", confirmLabel: "Restore" })) restore.mutate(versionId);
              }}
            >
              Restore this version
            </button>
          </div>
          <div className="diff">
            {version.data?.diff.map((l, i) => (
              <div key={i} className={`diff-line diff-${l.type}`}>
                <span className="diff-sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                {l.text || " "}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
