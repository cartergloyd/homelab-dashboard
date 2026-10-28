import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { minecraftSocketUrl } from "../api";
import { useEventSocket } from "./useEventSocket";

function extract(message: unknown): object[] | null {
  return (message as { type?: string }).type === "minecraft-update" ? [{}] : null;
}

export function useMinecraftUpdates(): void {
  const qc = useQueryClient();
  const { items } = useEventSocket(minecraftSocketUrl(), extract, 1);
  useEffect(() => {
    if (!items.length) return;
    void qc.invalidateQueries({ queryKey: ["minecraft"] });
    void qc.invalidateQueries({ queryKey: ["overview"] });
  }, [items, qc]);
}
