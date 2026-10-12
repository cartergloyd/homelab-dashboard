import { useState } from "react";
import { useAppConfig } from "../App";
import { LogViewer } from "../components/LogViewer";
import { PageHead } from "../components/ui";
import type { LogSource } from "../types";

const LABELS: Record<LogSource, string> = {
  minecraft: "Minecraft",
  jellyfin: "Jellyfin",
  directus: "Directus",
  postgres: "PostgreSQL",
  dashboard: "Dashboard",
  system: "System (warnings+)",
};

export function Logs() {
  const config = useAppConfig();
  const sources = config.data?.logSources ?? (Object.keys(LABELS) as LogSource[]);
  const [source, setSource] = useState<LogSource>("minecraft");

  return (
    <>
      <PageHead title="Logs" sub="Live tail of each service. Minecraft, the dashboard and system logs come from journald; the rest from Docker." />
      <div className="row" style={{ marginBottom: 12 }}>
        {sources.map((s) => (
          <button key={s} className={`btn sm ${s === source ? "primary" : ""}`} onClick={() => setSource(s)}>
            {LABELS[s]}
          </button>
        ))}
      </div>
      <LogViewer source={source} height={520} />
    </>
  );
}
