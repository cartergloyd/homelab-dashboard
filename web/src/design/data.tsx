import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useDialog, useToast } from "../components/ui";
export function useRead<T>(
  key: string,
  path: string,
  interval: number | false = 30000,
) {
  return useQuery({
    queryKey: [key, path],
    queryFn: () => api.get<T>(path),
    refetchInterval: interval,
  });
}
export function useActions() {
  const [pending, setPending] = useState(false),
    qc = useQueryClient(),
    toast = useToast(),
    dialog = useDialog();
  async function perform<T = unknown>(
    path: string,
    body?: unknown,
    options: {
      title?: string;
      description?: string;
      danger?: boolean;
      method?: "get" | "put" | "delete" | "patch";
      success?: string;
      refresh?: string[];
    } = {},
  ) {
    if (
      options.title &&
      !(await dialog.confirm({
        title: options.title,
        body: options.description,
        danger: options.danger,
        confirmLabel: "Confirm",
      }))
    )
      return;
    setPending(true);
    try {
      const result =
        options.method === "get"
          ? await api.get<T>(path)
          : options.method === "delete"
            ? await api.del<T>(path)
            : options.method === "put"
              ? await api.put<T>(path, body)
              : options.method === "patch"
                ? await api.patch<T>(path, body)
                : await api.post<T>(path, body);
      for (const key of options.refresh ?? [])
        void qc.invalidateQueries({ queryKey: [key] });
      if (options.success) toast(options.success);
      return result;
    } catch (error) {
      toast((error as Error).message, "error");
      return;
    } finally {
      setPending(false);
    }
  }
  return { pending, perform, ...dialog };
}
export interface Host {
  hostname: string;
  platform: string;
  cpuCount: number;
  uptime: number;
  username: string;
  cwd: string;
  cpu: number | null;
  memoryUsed: number;
  memoryTotal: number;
  checkedAt: string;
  history: {
    at: string;
    cpu: number | null;
    memoryUsed: number;
    memoryTotal: number;
  }[];
}
export type Workspace = "personal" | "business";
export const workspaceName = (workspace: Workspace) =>
  workspace === "business" ? "xGold AI" : "Gold Server";
export const basePath = (workspace: Workspace) =>
  workspace === "business" ? "/business" : "";
