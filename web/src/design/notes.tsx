import { useState } from "react";
import { useAppConfig } from "../App";
import { Empty, Head, Icon, Panel } from "./ui";

/** AppFlowy (deploy/appflowy) framed inside the dash. The dash serves it at /appflowy (notesProxy.ts). */
export function NotesDesign() {
  const config = useAppConfig(),
    url = config.data?.links.notes ?? null,
    [loaded, setLoaded] = useState(false);
  return (
    <>
      <Head
        title="Notes"
        actions={
          url && (
            <a className="button" href={url} target="_blank" rel="noreferrer">
              Open Notes <Icon name="external" />
            </a>
          )
        }
      />
      {url ? (
        <>
          <div className="notes-frame">
            {!loaded && (
              <p className="notes-loading" role="status">
                Loading Notes…
              </p>
            )}
            <iframe
              title="AppFlowy Notes"
              src={url}
              onLoad={() => setLoaded(true)}
              allow="clipboard-read; clipboard-write; fullscreen"
              referrerPolicy="strict-origin"
            />
          </div>
        </>
      ) : (
        config.data && (
          <Panel title="Notes" sub="Not connected">
            <Empty>
              Notes isn&apos;t connected yet. Set <code>NOTES_UPSTREAM</code> to
              your AppFlowy address in the dashboard environment, then restart
              the dashboard.
            </Empty>
          </Panel>
        )
      )}
    </>
  );
}
