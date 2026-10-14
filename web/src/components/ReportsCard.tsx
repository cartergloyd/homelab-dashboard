// Maintenance reports filed by agents (via the MCP submit_report tool) for the
// owner to read and mark as reviewed.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { fmtDateTime, fmtRelative } from "../format";
import type { AgentReport } from "../types";
import { Card, useToast } from "./ui";

export function ReportsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [showReviewed, setShowReviewed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["reports"], queryFn: () => api.get<AgentReport[]>("/reports?limit=50"), refetchInterval: 10_000 });
  const review = useMutation({
    mutationFn: (v: { id: string; reviewed: boolean }) => api.post(`/reports/${v.id}/review`, { reviewed: v.reviewed }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reports"] }),
    onError: (e: Error) => toast(e.message, "error"),
  });

  const all = q.data ?? [];
  const unreviewed = all.filter((r) => !r.reviewed).length;
  const shown = showReviewed ? all : all.filter((r) => !r.reviewed);

  return (
    <Card
      title={
        <h2 className="row" style={{ gap: 8 }}>
          Maintenance reports
          {unreviewed > 0 && <span className="badge accent">{unreviewed} to review</span>}
        </h2>
      }
      actions={
        <label className="check small">
          <input type="checkbox" checked={showReviewed} onChange={(e) => setShowReviewed(e.target.checked)} /> Show reviewed
        </label>
      }
    >
      <p className="muted small" style={{ margin: "0 0 10px" }}>
        Agents file a short write-up after they investigate or fix something. Read it, then mark it reviewed.
      </p>
      {shown.length === 0 && <div className="muted small">{all.length ? "Everything has been reviewed." : "No reports yet. A connected agent files one with the submit_report tool."}</div>}
      <div className="stack" style={{ gap: 8 }}>
        {shown.map((r) => {
          const expanded = open === r.id;
          const long = r.body.length > 240;
          return (
            <div key={r.id} className={`report${r.reviewed ? " reviewed" : ""}`}>
              <div className="row spread" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
                <div className="truncate">
                  <div style={{ fontWeight: 600 }} className="truncate" title={r.title}>
                    {r.title}
                  </div>
                  <div className="muted small">
                    <span className="badge">{r.agent}</span> <span title={fmtDateTime(r.ts)}>{fmtRelative(r.ts)}</span>
                    {r.incidentId && (
                      <>
                        {" · "}
                        <Link to={`/minecraft#assistant`} title="Open the Assistant panel" className="mono">
                          incident #{r.incidentId}
                        </Link>
                      </>
                    )}
                    {r.reviewed && r.reviewedBy && ` · reviewed by ${r.reviewedBy} ${fmtRelative(r.reviewedAt)}`}
                  </div>
                </div>
                <button className={`btn sm ${r.reviewed ? "ghost" : ""}`} disabled={review.isPending} onClick={() => review.mutate({ id: r.id, reviewed: !r.reviewed })}>
                  {r.reviewed ? "Unreview" : "Mark reviewed"}
                </button>
              </div>
              <div className="report-body" style={expanded || !long ? undefined : { maxHeight: 96, overflow: "hidden", maskImage: "linear-gradient(#000 60%, transparent)" }}>
                {r.body}
              </div>
              {long && (
                <button className="btn sm ghost" onClick={() => setOpen(expanded ? null : r.id)}>
                  {expanded ? "Show less" : "Read more"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
