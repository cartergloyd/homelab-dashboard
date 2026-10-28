import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, ErrorNotice, PageHead, useDialog, useToast } from "../components/ui";

interface SecurityStatus { enrolled: boolean; enforced: boolean; tailnetExempt: boolean; recoveryCodesRemaining: number; activeAccounts: number; canManage: boolean }
interface Enrollment { enrollmentId: string; qr: string; secret: string }

export function Security() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialog();
  const status = useQuery({ queryKey: ["security"], queryFn: () => api.get<SecurityStatus>("/security/status"), refetchOnWindowFocus: false, retry: false });
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["security"] });
  const begin = useMutation({ mutationFn: () => api.post<Enrollment>("/security/enroll"), onSuccess: (result) => { setEnrollment(result); setCode(""); begin.reset(); } });
  const enroll = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>("/security/confirm", { enrollmentId: enrollment?.enrollmentId, code }),
    onSuccess: (result) => { setRecovery(result.recoveryCodes); setSaved(false); setEnrollment(null); setCode(""); enroll.reset(); refresh(); toast("Dashboard authenticator protection is enabled"); },
  });
  const settings = useMutation({ mutationFn: (tailnetExempt: boolean) => api.put("/security/settings", { tailnetExempt }), onSuccess: refresh });
  const rotate = useMutation({ mutationFn: () => api.post<{ recoveryCodes: string[] }>("/security/recovery"), onSuccess: (result) => { setRecovery(result.recoveryCodes); setSaved(false); rotate.reset(); refresh(); } });
  const disable = useMutation({ mutationFn: () => api.post("/security/disable"), onSuccess: () => { setRecovery([]); refresh(); toast("Dashboard authenticator protection disabled for your account"); } });
  useEffect(() => {
    if (!recovery.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recovery.length]);

  const download = () => {
    const data = "Home Server Dashboard recovery codes\nEach code works once. Store these in your password manager.\n\n" + recovery.join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([data], { type: "text/plain" }));
    const link = document.createElement("a"); link.href = url; link.download = "homelab-dashboard-recovery-codes.txt"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const d = status.data;
  return <>
    <PageHead title="Access" sub="Confirm sensitive dashboard actions with your authenticator" />
    <ErrorNotice error={status.error ?? begin.error ?? enroll.error ?? settings.error ?? rotate.error ?? disable.error} />
    {d && !d.canManage && <div className="notice">Open the dashboard using your GitHub login to manage your authenticator.</div>}
    {d?.canManage && <div className="stack">
      {recovery.length > 0 && <Card title="Save your recovery codes">
        <div className="stack">
          <p style={{ margin: 0 }}>These codes are shown only now. Each works once if you lose access to your authenticator. Save them in your password manager and keep them private.</p>
          <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{recovery.join("\n")}</pre>
          <button className="btn" onClick={download}>Download recovery codes</button>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved my recovery codes somewhere safe</label>
          <button className="btn primary" disabled={!saved} onClick={() => setRecovery([])}>Done</button>
        </div>
      </Card>}
      {!recovery.length && !d.enrolled && <Card title="Set up dashboard authenticator">
        <div className="stack">
          <p style={{ margin: 0 }}>Use a separate authenticator entry for Home Server Dashboard. Once enrolled, sensitive actions require a code, including server restarts, deleting backups, changing assistant settings and approving risky actions.</p>
          {!enrollment ? <button className="btn primary" disabled={begin.isPending} onClick={() => begin.mutate()}>{begin.isPending ? "Preparing…" : "Set up authenticator"}</button> : <>
            <img src={enrollment.qr} alt="Scan this QR code with your authenticator app" width={256} height={256} style={{ maxWidth: "100%", alignSelf: "flex-start" }} />
            <details><summary>Enter the setup key manually</summary><p className="mono" style={{ overflowWrap: "anywhere" }}>{enrollment.secret}</p></details>
            <form className="stack" onSubmit={(e) => { e.preventDefault(); enroll.mutate(); }}>
              <label className="field">Six-digit code from your authenticator
                <input className="input" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={enroll.isPending} />
              </label>
              <div className="row" style={{ gap: 8 }}><button type="submit" className="btn primary" disabled={enroll.isPending || code.length !== 6}>{enroll.isPending ? "Checking…" : "Enable protection"}</button><button type="button" className="btn" disabled={enroll.isPending} onClick={() => { setEnrollment(null); setCode(""); }}>Cancel</button></div>
            </form>
          </>}
        </div>
      </Card>}
      {!recovery.length && d.enrolled && <Card title="Authenticator protection is enabled">
        <div className="stack">
          <p style={{ margin: 0 }}>Protected actions ask for a fresh authenticator code. A code cannot be reused; wait for the next code if you just confirmed another action.</p>
          <p className="muted small" style={{ margin: 0 }}>{d.recoveryCodesRemaining} recovery codes remain.</p>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={d.tailnetExempt} disabled={settings.isPending} onChange={(e) => settings.mutate(e.target.checked)} /> Skip action confirmations when connected through Tailscale</label>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn" disabled={rotate.isPending} onClick={() => rotate.mutate()}>Replace recovery codes</button>
            <button className="btn danger" disabled={disable.isPending} onClick={async () => { if (await confirm({ title: "Disable your dashboard authenticator?", body: "You will need to enroll again to restore protection. An authenticator or recovery code is required to confirm.", confirmLabel: "Disable", danger: true })) disable.mutate(); }}>Disable authenticator</button>
          </div>
        </div>
      </Card>}
    </div>}
  </>;
}
