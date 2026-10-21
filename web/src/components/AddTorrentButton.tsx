import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAppConfig } from "../App";
import { api } from "../api";
import { ErrorNotice, Modal, useToast } from "./ui";

export function AddTorrentButton() {
  const config = useAppConfig();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [urls, setUrls] = useState("");
  const [paused, setPaused] = useState(false);
  const status = useQuery({
    queryKey: ["qbittorrent", "status"],
    queryFn: () => api.get<{ reachable: boolean; error?: string }>("/qbittorrent/status"),
    enabled: open,
    staleTime: 0,
    retry: false,
  });
  const add = useMutation({
    mutationFn: () => api.post<{ submitted: number; failed?: number; demo?: boolean }>("/qbittorrent/torrents", { urls, paused }),
    retry: false,
    onSuccess: (result) => {
      toast(result.failed
        ? `qBittorrent accepted ${result.submitted} link(s); ${result.failed} failed. Check qBittorrent before retrying.`
        : `${result.demo ? "Demo: " : ""}Sent ${result.submitted} link${result.submitted === 1 ? "" : "s"} to qBittorrent${paused ? " (paused)" : ""}`, result.failed ? "error" : "info");
      setUrls("");
      setPaused(false);
      setOpen(false);
    },
  });
  if (!config.data?.torrentAdd) return null;
  const close = () => { if (!add.isPending) setOpen(false); };
  const submit = (event: FormEvent) => { event.preventDefault(); if (urls.trim() && !add.isPending) add.mutate(); };

  return <>
    <button className="btn" onClick={() => { add.reset(); setOpen(true); }}>Add Torrent Link</button>
    {open && <Modal title="Add torrent links" onClose={close}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>Paste magnet links or torrent download URLs, one per line (up to 20). Downloads use qBittorrent’s usual folder.</p>
        <ErrorNotice error={status.error ?? (status.data?.error ? new Error(status.data.error) : null)} />
        <ErrorNotice error={add.error} />
        <label className="field">
          Torrent links
          <textarea className="input" rows={6} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="magnet:?xt=urn:btih:…" autoFocus required maxLength={40000} disabled={add.isPending} spellCheck={false} />
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} disabled={add.isPending} /> Add paused
        </label>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" onClick={close} disabled={add.isPending}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!urls.trim() || add.isPending || status.isFetching || !status.data?.reachable}>{add.isPending ? "Sending…" : "Add to qBittorrent"}</button>
        </div>
      </form>
    </Modal>}
  </>;
}
