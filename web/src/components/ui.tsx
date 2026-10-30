import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ServiceState } from "../types";
import { fmtBytes } from "../format";

// ---- Card / tiles --------------------------------------------------------

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === "string" ? <h2>{title}</h2> : title}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatTile({ label, value, sub, hero = false }: { label: string; value: ReactNode; sub?: ReactNode; hero?: boolean }) {
  return (
    <div className="card tile">
      <div className="tile-label">{label}</div>
      <div className={`tile-value${hero ? " hero" : ""}`}>{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

/** Fill colour carries severity; the track is a lighter step of the same ramp. */
export function Meter({ label, used, total, sub }: { label: ReactNode; used: number; total: number; sub?: ReactNode }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const severity = pct >= 90 ? "danger" : pct >= 80 ? "warn" : "";
  return (
    <div className={`meter ${severity}`}>
      <div className="meter-head">
        <span className="truncate">{label}</span>
        <span className="nowrap dim">{pct.toFixed(0)}%</span>
      </div>
      <div className="meter-track" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="meter-foot">
        <span>{sub ?? `${fmtBytes(used)} used`}</span>
        <span>{fmtBytes(total - used)} free</span>
      </div>
    </div>
  );
}

const STATE_LABEL: Record<ServiceState, string> = { ok: "OK", degraded: "Degraded", down: "Down", unavailable: "Unavailable" };

export function StatusPill({ state, label }: { state: ServiceState | string; label?: string }) {
  const known = (state in STATE_LABEL ? state : "unavailable") as ServiceState;
  return (
    <span className={`pill ${known}`} title={STATE_LABEL[known]}>
      <span className="dot" aria-hidden />
      {label ?? STATE_LABEL[known]}
    </span>
  );
}

export function unitToState(active: string | null | undefined): ServiceState {
  if (active === "active") return "ok";
  if (active === "activating" || active === "deactivating" || active === "reloading") return "degraded";
  if (active === "inactive" || active === "failed") return "down";
  return "unavailable";
}

// ---- Toasts --------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---- Confirm / prompt dialogs -------------------------------------------

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}
interface PromptOpts {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  placeholder?: string;
}
interface DialogApi {
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  prompt: (o: PromptOpts) => Promise<string | null>;
}
const DialogCtx = createContext<DialogApi>({ confirm: async () => false, prompt: async () => null });

type Pending = { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void } | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (opts) => new Promise((resolve) => setPending({ kind: "confirm", opts, resolve })),
      prompt: (opts) =>
        new Promise((resolve) => {
          setValue(opts.initial ?? "");
          setPending({ kind: "prompt", opts, resolve });
        }),
    }),
    [],
  );

  useEffect(() => {
    if (pending?.kind === "prompt") setTimeout(() => inputRef.current?.select(), 0);
  }, [pending]);

  const close = (result: boolean | string | null) => {
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(Boolean(result));
    else pending.resolve(typeof result === "string" ? result : null);
    setPending(null);
  };

  return (
    <DialogCtx.Provider value={api}>
      {children}
      {pending && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(pending.kind === "confirm" ? false : null)}>
          <div className="modal" role="dialog" aria-modal>
            <h2>{pending.opts.title}</h2>
            {pending.kind === "confirm" ? (
              <>
                {pending.opts.body && <div className="dim">{pending.opts.body}</div>}
                <div className="modal-actions">
                  <button className="btn" onClick={() => close(false)}>
                    Cancel
                  </button>
                  <button className={`btn ${pending.opts.danger ? "danger" : "primary"}`} autoFocus onClick={() => close(true)}>
                    {pending.opts.confirmLabel ?? "Confirm"}
                  </button>
                </div>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (value.trim()) close(value.trim());
                }}
              >
                <label className="field">
                  {pending.opts.label}
                  <input ref={inputRef} className="input" value={value} placeholder={pending.opts.placeholder} onChange={(e) => setValue(e.target.value)} />
                </label>
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => close(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn primary" disabled={!value.trim()}>
                    {pending.opts.confirmLabel ?? "OK"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </DialogCtx.Provider>
  );
}

export const useDialog = () => useContext(DialogCtx);

// ---- Modal shell for custom forms ---------------------------------------

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal>
        <div className="row spread" style={{ marginBottom: 16 }}><h2>{title}</h2><button type="button" className="btn ghost sm" aria-label="Close" onClick={onClose}>×</button></div>
        {children}
      </div>
    </div>
  );
}

// ---- Page head -----------------------------------------------------------

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="notice error">{(error as Error).message ?? String(error)}</div>;
}
