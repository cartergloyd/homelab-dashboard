import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icons, type IconName } from "../components/icons";
import paths from "./reference-icons.json";
export function Icon({
  name,
  ...props
}: {
  name: string;
  width?: number;
  height?: number;
}) {
  const alias: Record<string, string> = {
    spark: "sparkles",
    pulse: "activity",
    user: "users",
    folderPlus: "folder",
  };
  const path = (paths as Record<string, string>)[alias[name] ?? name];
  if (path)
    return (
      <svg viewBox="0 0 22 22" aria-hidden="true" {...props}>
        <path d={path} />
      </svg>
    );
  const Element = Icons[name as IconName] ?? Icons.drive;
  return <Element {...props} />;
}
export function Button({
  icon,
  children,
  primary = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  primary?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button ${primary ? "primary" : ""} ${props.className ?? ""}`}
    >
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </button>
  );
}
export function Head({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
      </div>
      <div className="head-actions">{actions}</div>
    </div>
  );
}
export function PanelHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="panel-head">
      <div>
        <h2 className="panel-title">{title}</h2>
        {sub && <p className="panel-sub">{sub}</p>}
      </div>
      {actions}
    </div>
  );
}
export function Panel({
  title,
  sub,
  actions,
  children,
  className = "",
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <PanelHead title={title} sub={sub} actions={actions} />
      {children}
    </section>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Issue({ error }: { error: unknown }) {
  return error ? (
    <p className="connection-error" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  ) : null;
}
export function Status({
  label,
  state = "unknown",
}: {
  label: string;
  state?: "ok" | "warn" | "unknown" | "down" | string;
}) {
  return (
    <span
      className={`status ${state === "ok" ? "" : state === "warn" || state === "down" ? "amber" : "neutral"}`}
    >
      <span
        className={`dot ${state === "ok" ? "" : state === "warn" || state === "down" ? "amber" : "gray"}`}
      />
      {label}
    </span>
  );
}
export function Details({ items }: { items: [string, ReactNode][] }) {
  return (
    <ul className="detail-list">
      {items.map(([label, value]) => (
        <li key={label}>
          <span>{label}</span>
          <strong>{value ?? "Unavailable"}</strong>
        </li>
      ))}
    </ul>
  );
}
export function Table({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
