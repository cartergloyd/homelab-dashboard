import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useDialog, useToast } from "../components/ui";
import { Button, Empty, Issue } from "./ui";

type Result = { slug?: string; section?: string; url?: string; status: string; errors?: string[]; media?: number };
type Item = { id: string; section: string; slug: string; title: string; date: string };

// Publish card for the website's Research and Solutions feeds. Format reference: docs/feed-uploads.md
export function FeedPublish() {
  const zip = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<Result[]>([]);
  const toast = useToast(), qc = useQueryClient(), { confirm } = useDialog();
  const items = useQuery({ queryKey: ["feed-items"], queryFn: () => api.get<Item[]>("/feed") });
  const publish = useMutation({
    mutationFn: (files: File[]) => api.upload<{ results: Result[] }>("/feed/publish", files),
    onSuccess: r => { setResults(r.results); void qc.invalidateQueries({ queryKey: ["feed-items"] }); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) { setResults([]); publish.mutate(files); } };
  async function remove(item: Item) {
    if (!(await confirm({ title: `Remove “${item.title}”?`, body: "It leaves the website straight away. Its images and videos stay in the file library.", confirmLabel: "Remove" }))) return;
    try { await api.del(`/feed/${item.id}`); toast("Removed"); void qc.invalidateQueries({ queryKey: ["feed-items"] }); } catch (e) { toast((e as Error).message, "error"); }
  }
  return <div className="feed-publish">
    <p>One folder per item, with an <code>article.json</code> and its images and videos. Zip it, or pick the folder. New items appear on the Research and Solutions pages right away.</p>
    <details>
      <summary>Format</summary>
      <p><code>article.json</code> needs <code>section</code> (research or solutions), <code>slug</code>, <code>title</code>, <code>summary</code>, <code>date</code> (YYYY-MM-DD). Add <code>body</code> blocks: <code>{`{"h2":""}`}</code>, <code>{`{"p":""}`}</code>, <code>{`{"image":"img/a.png","alt":""}`}</code>, <code>{`{"video":"clip.mp4"}`}</code> and more. Files are referenced by their path inside the folder. A zip can hold several item folders. <code>"draft": true</code> skips an item. Full guide: <code>docs/feed-uploads.md</code>.</p>
    </details>
    <div className="file-grid">
      <Button icon="upload" primary disabled={publish.isPending} onClick={() => zip.current?.click()}>{publish.isPending ? "Publishing…" : "Choose zip"}</Button>
      <Button icon="folder" disabled={publish.isPending} onClick={() => folder.current?.click()}>Choose folder</Button>
    </div>
    <input ref={zip} type="file" accept=".zip,application/zip" hidden aria-label="Choose a zip to publish" onChange={pick} />
    {/* @ts-expect-error webkitdirectory is not in React's input types */}
    <input ref={folder} type="file" webkitdirectory="" multiple hidden aria-label="Choose a folder to publish" onChange={pick} />
    {results.map((r, i) => <div key={i} className={r.errors ? "connection-error" : "feed-result"} role={r.errors ? "alert" : "status"}>
      <strong>{r.status}</strong> {r.section && r.slug ? `${r.section}/${r.slug}` : r.slug ?? ""}{r.media ? ` · ${r.media} file${r.media === 1 ? "" : "s"}` : ""}
      {r.url && <> · <a href={r.url} target="_blank" rel="noreferrer">View</a></>}
      {r.errors?.map((m, j) => <div key={j}>{m}</div>)}
    </div>)}
    <h3>On the website</h3>
    <Issue error={items.error} />
    {items.data?.length === 0 && <Empty>Nothing published yet.</Empty>}
    {items.data?.map(item => <div key={item.id} className="row" style={{ gap: 12, justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
      <span><strong>{item.title}</strong> <span className="muted small">{item.section} · {item.date}</span></span>
      <Button onClick={() => remove(item)}>Remove</Button>
    </div>)}
  </div>;
}
