import { useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, setStepUpHandler, type StepUpChallenge } from "../api";
import { ErrorNotice, Modal, useToast } from "./ui";

export function StepUpProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [pending, setPending] = useState<StepUpChallenge | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const resolve = useRef<((permit: string | null) => void) | null>(null);

  useEffect(() => {
    setStepUpHandler((challenge) => {
      if (challenge.enrollmentRequired) {
        navigate("/security");
        toast("Set up your dashboard authenticator, then try the action again.");
        return Promise.resolve(null);
      }
      if (resolve.current) return Promise.reject(new Error("Finish the current confirmation first"));
      setCode("");
      setError(null);
      setPending(challenge);
      return new Promise((done) => { resolve.current = done; });
    });
    return () => { setStepUpHandler(null); resolve.current?.(null); resolve.current = null; };
  }, [navigate, toast]);

  const finish = (permit: string | null) => {
    const done = resolve.current;
    resolve.current = null;
    setPending(null);
    setCode("");
    setError(null);
    done?.(permit);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pending?.challengeId || !code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ permit: string }>("/security/verify", { challengeId: pending.challengeId, code: code.trim() });
      finish(result.permit);
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  };

  return <>{children}{pending && <Modal title="Confirm it’s you" onClose={() => { if (!busy) finish(null); }}>
    <form className="stack" onSubmit={submit}>
      <p style={{ margin: 0 }}>{pending.description ?? "Confirm this protected action"}</p>
      <p className="muted small" style={{ margin: 0 }}>Enter your dashboard authenticator code or one unused recovery code. This confirmation applies only to this action.</p>
      <ErrorNotice error={error} />
      <label className="field">Authenticator or recovery code
        <input className="input" autoFocus autoComplete="one-time-code" value={code} maxLength={64} onChange={(e) => setCode(e.target.value)} disabled={busy} required />
      </label>
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => finish(null)}>Cancel</button>
        <button className="btn primary" type="submit" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Confirm action"}</button>
      </div>
    </form>
  </Modal>}</>;
}
