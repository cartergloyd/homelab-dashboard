import { useState } from "react";
import { useAppConfig } from "../App";
import { Empty, Head, Icon, Panel } from "./ui";

/** AppFlowy (deploy/appflowy) framed inside the dash. NOTES_URL on the server decides where. */
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
          {/* A frame cannot report that it was refused, so the way out is always on screen. */}
          <p className="notes-hint">
            AppFlowy has its own sign-in. If the frame is blank or asks you to
            sign in, open Notes in a new tab once, then come back.
          </p>
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
              Notes isn&apos;t connected yet. Set <code>NOTES_URL</code> to your
              AppFlowy address in the dashboard environment, then restart the
              dashboard.
            </Empty>
          </Panel>
        )
      )}
    </>
  );
}
