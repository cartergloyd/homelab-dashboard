// Pure helpers for the install audit / importer (issue #2). No I/O here so they
// can be unit-tested: `node server/test-discover.mjs` after a build.
import path from "node:path";
import { createTask } from "node-cron";

/** Timers / cron commands that look like Minecraft maintenance. */
export const RELEVANT_RE = /mine|\bmc\b|mc[-_]|paper|backup|update|restart|world|server|rcon|spigot|bukkit/i;
/** Noise units every distro ships. */
export const IRRELEVANT_UNIT_RE = /apt|snapd|logrotate|man-db|fstrim|motd|e2scrub|systemd-|dpkg|ua-|fwupd|certbot|unattended|anacron|plocate|mlocate|phpsessionclean|sysstat|docker-?prune/i;

export function isRelevant(text: string, unit = ""): boolean {
  return RELEVANT_RE.test(text) && !IRRELEVANT_UNIT_RE.test(unit || text);
}

// ---- systemd OnCalendar → cron ---------------------------------------------------

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const SHORTCUTS: Record<string, string> = {
  minutely: "* * * * *",
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  midnight: "0 0 * * *",
  weekly: "0 0 * * 1",
  monthly: "0 0 1 * *",
  quarterly: "0 0 1 1,4,7,10 *",
  semiannually: "0 0 1 1,7 *",
  yearly: "0 0 1 1 *",
  annually: "0 0 1 1 *",
};

const num = (s: string) => String(Number(s));

/** `04,16` → `4,16`; `*` → `*`; `*​/15` or `0/15` → `*​/15`; `5/10` → `5-MAX/10`. */
function field(spec: string, max: number): string | null {
  if (spec === "*") return "*";
  const step = spec.match(/^(\*|\d{1,2})\/(\d{1,2})$/);
  if (step) {
    const start = step[1] === "*" ? 0 : Number(step[1]);
    if (start === 0) return `*/${Number(step[2])}`;
    return `${start}-${max}/${Number(step[2])}`;
  }
  if (/^\d{1,2}(,\d{1,2})*$/.test(spec)) return spec.split(",").map(num).join(",");
  const range = spec.match(/^(\d{1,2})\.\.(\d{1,2})$/);
  if (range) return `${num(range[1])}-${num(range[2])}`;
  return null;
}

function dowField(spec: string): string | null {
  const out: string[] = [];
  for (const part of spec.split(",")) {
    const m = part.match(/^([A-Za-z]{3})(?:\.\.([A-Za-z]{3}))?$/);
    if (!m) return null;
    const a = DOW[m[1].toLowerCase()];
    const b = m[2] ? DOW[m[2].toLowerCase()] : undefined;
    if (a === undefined || (m[2] && b === undefined)) return null;
    out.push(b === undefined ? String(a) : `${a}-${b}`);
  }
  return out.join(",");
}

/**
 * Translate a systemd OnCalendar expression to a 5-field cron expression, or
 * null when cron cannot express it (years, seconds, day-of-month AND weekday).
 * Coverage: shortcuts, `[Dow[,Dow|Dow..Dow]] [*-M-D ]HH:MM[:SS]`, lists and
 * `start/step` in any field. The audit verifies the result against systemd's own
 * next-elapse time, so an imperfect translation is caught rather than trusted.
 */
export function calendarToCron(cal: string): string | null {
  const c = cal.trim().replace(/\s+/g, " ");
  if (!c) return null;
  const shortcut = SHORTCUTS[c.toLowerCase()];
  if (shortcut) return shortcut;
  const m = c.match(/^(?:([A-Za-z]{3}(?:\.\.[A-Za-z]{3})?(?:,[A-Za-z]{3}(?:\.\.[A-Za-z]{3})?)*) )?(?:(\*|\d{4})-(\*|[\d,./]+)-(\*|[\d,./]+) )?(\*|[\d,./]+):(\*|[\d,./]+)(?::(\*|[\d,./]+))?$/);
  if (!m) return null;
  const [, days, year, month, dom, hour, minute, second] = m;
  if (year && year !== "*") return null; // cron has no year field
  if (second !== undefined && (second === "*" || /\//.test(second))) return null; // sub-minute repetition; other seconds are dropped
  const min = field(minute, 59);
  const hr = field(hour, 23);
  const dm = dom ? field(dom, 31) : "*";
  const mo = month ? field(month, 12) : "*";
  const dw = days ? dowField(days) : "*";
  if (min === null || hr === null || dm === null || mo === null || dw === null) return null;
  if (dm !== "*" && dw !== "*") return null; // systemd ANDs these; cron ORs them
  return `${min} ${hr} ${dm} ${mo} ${dw}`;
}

// ---- crontab parsing ----------------------------------------------------------------

export interface CronEntry {
  /** where the line lives, e.g. "crontab (gold)" or "/etc/cron.d/minecraft" */
  source: string;
  user: string | null;
  /** 5-field cron, or null for @reboot */
  cron: string | null;
  command: string;
  /** *.py / *.sh path found in the command, if any */
  script: string | null;
  /** already prefixed with hl-run */
  wrapped: boolean;
  line: string;
}

const AT: Record<string, string | null> = {
  "@reboot": null,
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export function scriptPathFromCommand(cmd: string): string | null {
  const m = cmd.match(/(?:"([^"&;|]+\.(?:py|sh))"|'([^'&;|]+\.(?:py|sh))'|(\S+\.(?:py|sh)))(?=[\s'";&|)]|$)/);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** Strip an hl-run prefix and systemd exec prefixes, collapse whitespace. */
export function normalizeCommand(cmd: string | undefined | null): string {
  return (cmd ?? "")
    .trim()
    .replace(/^[-@+!:]+/, "")
    .replace(/^(?:\S*\/)?hl-run(?:\.sh)?\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse crontab text. `systemTable` = /etc/crontab or /etc/cron.d/* layout, which
 * has a user column after the five time fields.
 */
export function parseCrontab(text: string, source: string, opts: { systemTable?: boolean; user?: string | null } = {}): CronEntry[] {
  const out: CronEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue; // SHELL=, PATH=, MAILTO=
    let cron: string | null;
    let rest: string;
    if (line.startsWith("@")) {
      const [at, ...tail] = line.split(/\s+/);
      if (!(at in AT)) continue;
      cron = AT[at];
      rest = tail.join(" ");
    } else {
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;
      cron = parts.slice(0, 5).join(" ");
      rest = parts.slice(5).join(" ");
    }
    let user: string | null = opts.user ?? null;
    if (opts.systemTable) {
      const [u, ...tail] = rest.split(/\s+/);
      user = u;
      rest = tail.join(" ");
    }
    if (!rest) continue;
    const script = scriptPathFromCommand(rest);
    out.push({ source, user, cron, command: rest, script, wrapped: /(^|\s|\/)hl-run(\.sh)?(\s|$)/.test(rest), line });
  }
  return out;
}

export interface JobLike {
  type: string;
  cron: string;
  options: { timer?: string; script?: string; command?: string; cronSource?: string; managedBy?: string };
}

/** Is this external job the mirror of that crontab entry? */
export function jobMatchesCronEntry(job: JobLike, e: CronEntry): boolean {
  if (job.type !== "external" || job.options.timer) return false;
  const jc = normalizeCommand(job.options.command);
  const ec = normalizeCommand(e.command);
  if (jc && jc === ec) return true;
  if (e.script && job.options.script && path.basename(e.script) === job.options.script && (!e.cron || job.cron === e.cron)) return true;
  return false;
}

/** Suggested replacement line with the command wrapped by hl-run. */
export function wrappedCronLine(e: CronEntry, hlRun = "/usr/local/bin/hl-run"): string {
  const time = e.cron ?? "@reboot";
  const userCol = e.source.startsWith("/etc/") && e.user ? ` ${e.user}` : "";
  return `${time}${userCol} ${hlRun} ${normalizeCommand(e.command)}`;
}

// ---- schedules ---------------------------------------------------------------------

/** Next run of a cron expression in a timezone (null if invalid). */
export function nextRunOf(cron: string, timezone?: string, count = 1): Date[] {
  try {
    const t = createTask(cron, () => {}, { timezone });
    const next = t.getNextRuns(count);
    void t.destroy();
    return next;
  } catch {
    return [];
  }
}

/** systemd `next`/`last` from `list-timers --output=json` (µs) or a show= string. */
export function parseSystemdTimestamp(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "" || v === "n/a") return null;
  if (typeof v === "number") return v > 1e14 ? Math.round(v / 1000) : v > 1e11 ? v : v * 1000;
  if (/^\d+$/.test(v)) return parseSystemdTimestamp(Number(v));
  // "Thu 2026-10-16 04:00:00 CDT" → "2026-10-16 04:00:00 CDT" (V8 knows US zone names; others → NaN)
  const t = Date.parse(v.replace(/^[A-Za-z]{3}\s+/, "").replace(/\s+UTC$/, "Z"));
  return Number.isFinite(t) ? t : null;
}

export function fmtDelta(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}
