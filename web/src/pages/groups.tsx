// Grouped pages: each nav tab shows all of its sections stacked vertically,
// with jump chips at the top. The section components are the original pages.
import type { ReactNode } from "react";
import { Jellyfin } from "./Jellyfin";
import { Files } from "./Files";
import { Minecraft } from "./Minecraft";
import { Maintenance } from "./Maintenance";
import { Logs } from "./Logs";
import { Status } from "./Status";
import { Storage } from "./Storage";

interface SectionDef {
  id: string;
  label: string;
  element: ReactNode;
}

function GroupPage({ title, sub, sections }: { title: string; sub: string; sections: SectionDef[] }) {
  return (
    <>
      <div className="group-head">
        <h1>{title}</h1>
        <p className="dim">{sub}</p>
        <div className="section-nav">
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="btn sm">
              {s.label}
            </a>
          ))}
        </div>
      </div>
      {sections.map((s) => (
        <section key={s.id} id={s.id} className="stack-section">
          {s.element}
        </section>
      ))}
    </>
  );
}

export function MediaPage() {
  return (
    <GroupPage
      title="Media"
      sub="Jellyfin server and the media folders it indexes."
      sections={[
        { id: "jellyfin", label: "Jellyfin", element: <Jellyfin /> },
        { id: "files", label: "Media files", element: <Files /> },
      ]}
    />
  );
}

export function MinecraftPage() {
  return (
    <GroupPage
      title="Minecraft"
      sub="Paper server controls, console and live log, plus automated maintenance."
      sections={[
        { id: "server", label: "Server", element: <Minecraft /> },
        { id: "maintenance", label: "Maintenance", element: <Maintenance /> },
      ]}
    />
  );
}

export function SystemPage() {
  return (
    <GroupPage
      title="System"
      sub="Logs, service health and storage for the whole server."
      sections={[
        { id: "status", label: "Service status", element: <Status /> },
        { id: "storage", label: "Storage", element: <Storage /> },
        { id: "logs", label: "Logs", element: <Logs /> },
      ]}
    />
  );
}
