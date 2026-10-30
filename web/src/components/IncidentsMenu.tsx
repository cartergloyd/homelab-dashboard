import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { fmtDateTime, fmtRelative } from "../format";
import type { Incident, IncidentReviewPayload, InstructionSuggestion } from "../types";
import { Modal, useToast } from "./ui";

function statusLabel(incident: Incident): string {
  if (incident.status === "investigating") return "Being reviewed";
  if (incident.status === "waiting-approval") return "Waiting for permission";
  if (incident.status === "failed") return "Review couldn't finish";
  if (incident.outcome === "needs-human") return "Needs your input";
  if (incident.status === "resolved") return incident.outcome === "fixed" ? "Fixed" : "Checked";
  if (incident.status === "dismissed") return "Previously set aside";
  return "Waiting for review";
}

export function IncidentsMenu({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<Incident | null>(null);
  const [revisiting, setRevisiting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const incidents = useQuery({ queryKey: ["sidecar", "incident-menu"], queryFn: () => api.get<Incident[]>("/sidecar/incidents?all=1&limit=200"), refetchInterval: 5000 });
  const review = useQuery({ queryKey: ["sidecar", "incident-review", selected?.id], queryFn: () => api.get<IncidentReviewPayload>(`/sidecar/incidents/${selected!.id}/review`), enabled: !!selected, refetchInterval: 3000 });
  const onError = (e: Error) => toast(e.message, "error");
  const revisit = useMutation({
    mutationFn: () => api.post(`/sidecar/incidents/${selected!.id}/revisit`, { text: feedback.trim() }),
    onSuccess: () => {
      setFeedback("");
      setRevisiting(false);
      toast("Feedback saved. The assistant will revisit this issue.");
      qc.invalidateQueries({ queryKey: ["sidecar"] });
    },
    onError,
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "decline" }) => api.post<InstructionSuggestion>(`/sidecar/suggestions/${v.id}`, { decision: v.decision }),
    onSuccess: (suggestion) => {
      toast(suggestion.status === "applied" ? "Lesson added to the assistant's instructions" : "Kept this feedback for this issue only");
      qc.invalidateQueries({ queryKey: ["sidecar"] });
    },
    onError,
  });
  const open = (incident: Incident, revisit: boolean) => {
    setSelected(incident);
    setRevisiting(revisit);
    setFeedback("");
  };
  const incident = review.data?.incident ?? selected;

  return (
    <Modal title={selected ? revisiting ? "Revisit an issue" : "Review an issue" : "Incidents"} onClose={onClose} wide>
      <div className="stack incident-menu">
        <div className="row spread">
          {selected ? <button className="btn sm ghost" onClick={() => { setSelected(null); setRevisiting(false); }}>Back to incidents</button> : <span className="muted small">The assistant handles the investigation. You can review its work or add context.</span>}
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        {!selected && (
          <>
            {incidents.isPending && <p className="muted">Loading incidents...</p>}
            {incidents.error && <div className="notice error">Couldn't load incidents. Please try again.</div>}
            {incidents.data?.length === 0 && <p className="muted">No incidents have been recorded.</p>}
            {incidents.data?.map((item) => (
              <article className="incident-menu-row" key={item.id}>
                <div>
                  <p className="incident-sentence">{item.summary ?? "A server problem was recorded for review."}</p>
                  <div className="muted small">{statusLabel(item)} · last seen {fmtRelative(item.lastSeen)}</div>
                </div>
                <div className="actions">
                  <button className="btn sm" onClick={() => open(item, false)}>Review</button>
                  <button className="btn sm" onClick={() => open(item, true)}>Revisit</button>
                </div>
              </article>
            ))}
          </>
        )}
        {incident && <p className="incident-sentence">{incident.summary ?? "A server problem was recorded for review."}</p>}
        {selected && revisiting && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (feedback.trim() && !revisit.isPending) revisit.mutate(); }}>
            <label className="field">
              What should the assistant consider or do differently?
              <textarea className="input" rows={5} autoFocus required maxLength={4000} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Explain what was missed, what has changed, or how the previous response could be improved." />
            </label>
            <p className="muted small">Your feedback applies to this issue. If the assistant suggests a lesson for future issues, you'll review it before anything is saved to its instructions.</p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setRevisiting(false)}>Cancel</button>
              <button className="btn primary" type="submit" disabled={!feedback.trim() || revisit.isPending}>{revisit.isPending ? "Sending..." : "Send for another review"}</button>
            </div>
          </form>
        )}
        {selected && !revisiting && (
          <>
            {review.isPending && <p className="muted">Loading the assistant's findings...</p>}
            {review.error && <div className="notice error">Couldn't load the review. Please try again.</div>}
            {review.data && (
              <>
                <div className="row spread">
                  <span className="small">{statusLabel(review.data.incident)}</span>
                  <button className="btn" onClick={() => setRevisiting(true)}>Revisit with feedback</button>
                </div>
                <h3>What the assistant found</h3>
                {review.data.reports.length === 0 && <p className="muted">{incident?.status === "failed" ? "The assistant couldn't complete this review. You can add context and ask it to revisit the issue." : "The assistant has not provided its findings yet."}</p>}
                {review.data.reports.slice(0, 1).map((report) => (
                  <article className="incident-report" key={report.id}>
                    <strong>{report.title}</strong>
                    <div className="muted small">{fmtDateTime(report.ts)}</div>
                    <p>{report.body.split(/\n\nSuggested context updates:/i)[0].replace(/^Summary:\s*/i, "")}</p>
                  </article>
                ))}
                {review.data.reports.length > 1 && (
                  <details>
                    <summary>Previous reviews ({review.data.reports.length - 1})</summary>
                    <div className="stack" style={{ marginTop: 10 }}>
                      {review.data.reports.slice(1).map((report) => <article className="incident-report" key={report.id}><strong>{report.title}</strong><div className="muted small">{fmtDateTime(report.ts)}</div><p>{report.body.split(/\n\nSuggested context updates:/i)[0].replace(/^Summary:\s*/i, "")}</p></article>)}
                    </div>
                  </details>
                )}
                {review.data.feedback.length > 0 && (
                  <section className="stack">
                    <h3>Your feedback</h3>
                    {review.data.feedback.map((entry) => <div className="incident-report" key={entry.id}><p>{entry.text}</p><span className="muted small">{entry.runId ? "Included in the assistant's review" : "Saved for the next review"}</span></div>)}
                  </section>
                )}
                {review.data.suggestions.length > 0 && (
                  <section className="stack">
                    <h3>Suggested lessons for future issues</h3>
                    <p className="muted small">These are only added to the assistant's instructions if you approve them.</p>
                    {review.data.suggestions.map((suggestion) => (
                      <article className="incident-report" key={suggestion.id}>
                        <p>{suggestion.text}</p>
                        {suggestion.status === "pending" ? <div className="row"><button className="btn primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: suggestion.id, decision: "approve" })}>Use for future issues</button><button className="btn" disabled={decide.isPending} onClick={() => decide.mutate({ id: suggestion.id, decision: "decline" })}>Keep this issue only</button></div> : <span className="muted small">{suggestion.status === "applied" ? "Added to the assistant's instructions" : "Not added to the assistant's instructions"}</span>}
                      </article>
                    ))}
                  </section>
                )}
                <details className="incident-technical">
                  <summary>Technical details</summary>
                  <p className="small muted">First seen {fmtDateTime(review.data.incident.firstSeen)} · {review.data.incident.count} occurrence(s)</p>
                  <pre>{review.data.incident.samples.join("\n")}</pre>
                  {review.data.incident.note && <p>{review.data.incident.note}</p>}
                  {review.data.conversation.map((turn) => <p key={turn.id}>{turn.text}</p>)}
                </details>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
