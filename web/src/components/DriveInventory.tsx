import type { DriveInventory as Inventory, StorageDevice } from "../types";
import { fmtBytes } from "../format";
import { Card, StatusPill } from "./ui";

function volumes(device: StorageDevice): StorageDevice[] {
  return device.children.length ? device.children.flatMap(volumes) : [device];
}

export function DriveInventory({ inventory }: { inventory: Inventory | undefined }) {
  const devices = inventory?.devices ?? [];
  return (
    <Card title="Connected drives">
      <p className="muted small" style={{ marginTop: 0 }}>All detected disks, including drives Linux has not mounted. Mounting makes a drive's existing files accessible; it does not move data onto it.</p>
      {inventory?.error && <div className="notice">{inventory.error}</div>}
      {!inventory && <div className="skeleton">Checking connected drives...</div>}
      {inventory && !inventory.error && !devices.length && <p className="muted">No physical disks were reported. Mounted filesystems are shown below.</p>}
      <div className="drive-inventory">
        {devices.map((device) => {
          const parts = volumes(device);
          const mounted = parts.some((part) => part.mounts.length > 0);
          return (
            <article className="drive-entry" key={device.path}>
              <div className="row spread" style={{ gap: 10, alignItems: "flex-start" }}>
                <div><strong>{device.model ?? device.label ?? device.path}</strong><div className="small muted">{fmtBytes(device.sizeBytes)} <span className="mono">{device.path}</span>{device.readOnly ? " · read-only" : ""}</div></div>
                <StatusPill state={mounted ? "ok" : "unavailable"} label={mounted ? "Mounted" : "Not mounted"} />
              </div>
              {parts.map((part) => (
                <div className="drive-volume small" key={part.path}>
                  <strong>{part.label ?? part.path}</strong>{" · "}{part.filesystem?.toUpperCase() ?? "Filesystem unknown"}
                  <div className="mono muted">{part.path}{part.mounts.length ? ` → ${part.mounts.join(", ")}` : " · not mounted"}</div>
                </div>
              ))}
              {!mounted && <p className="small muted" style={{ marginBottom: 0 }}>Not available to the file explorer yet. Used/free space is unknown, not zero. Existing files must be checked before choosing how to use this drive.</p>}
            </article>
          );
        })}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>The explorer scans mounted filesystems separately so it doesn't miss other drives or count them twice. This page never mounts, formats, or moves anything.</p>
    </Card>
  );
}
