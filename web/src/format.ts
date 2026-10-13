export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = (t - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(t);
}

export function fmtUptime(sinceIso: string | null | undefined): string {
  if (!sinceIso) return "–";
  const t = Date.parse(sinceIso);
  if (Number.isNaN(t)) return sinceIso;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const time = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` : null;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (time && dom === "*" && mon === "*" && dow === "*") return `Daily at ${time}`;
  if (time && dom === "*" && mon === "*" && /^\d$/.test(dow)) return `Every ${days[Number(dow)]} at ${time}`;
  if (time && dom === "*" && mon === "*" && dow === "1-5") return `Weekdays at ${time}`;
  if (time && dom === "*" && mon === "*" && dow === "0,6") return `Weekends at ${time}`;
  if (time && dom === "*" && mon === "*" && /^\d(,\d)+$/.test(dow)) return `${dow.split(",").map((d) => days[Number(d) % 7]).join(", ")} at ${time}`;
  if (time && dom === "*" && mon === "*" && /^\d-\d$/.test(dow)) return `${days[Number(dow[0])]}–${days[Number(dow[2])]} at ${time}`;
  if (time && /^\d+$/.test(dom) && mon === "*" && dow === "*") return `Monthly on day ${dom} at ${time}`;
  if (/^\*\/\d+$/.test(min) && hour === "*") return `Every ${min.slice(2)} min`;
  if (min === "0" && /^\*\/\d+$/.test(hour)) return `Every ${hour.slice(2)} hours`;
  return expr;
}
