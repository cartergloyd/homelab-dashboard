// A tiny shared store: the alert row the owner clicked in Live server alerts, so
// the Assistant sidecar can offer "ask about this". No provider needed.
import { useSyncExternalStore } from "react";
import type { AlertEvent } from "./types";

let selected: AlertEvent | null = null;
const listeners = new Set<() => void>();

export function selectAlert(e: AlertEvent | null): void {
  selected = selected?.id === e?.id ? null : e;
  for (const fn of listeners) fn();
}

export function useSelectedAlert(): AlertEvent | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => selected,
  );
}
