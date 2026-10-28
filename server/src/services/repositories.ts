import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";

export const RepositoryInput = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(160),
  installed: z.string().trim().min(1).max(100),
  workspace: z.enum(["personal", "business"]),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});
type Entry = z.infer<typeof RepositoryInput> & {
  id: string;
  latest: string | null;
  checkedAt: string | null;
  error: string | null;
  releaseUrl: string | null;
};
export class RepositoryStore {
  private pending: Promise<Entry[]> | null = null;
  constructor(
    private file: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  list(): Entry[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(data)) throw new Error("Invalid repository data");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new HttpError(500, "Cannot read saved repository tracking data");
    }
  }
  private save(items: Entry[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(items, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(this.file + ".tmp", this.file);
  }
  add(input: z.infer<typeof RepositoryInput>) {
    const items = this.list();
    if (items.length >= 100)
      throw new HttpError(400, "Follow up to 100 repositories");
    if (
      items.some(
        (item) =>
          item.name.toLowerCase() === input.name.toLowerCase() &&
          item.workspace === input.workspace,
      )
    )
      throw new HttpError(
        409,
        "This repository is already followed in this workspace",
      );
    const item: Entry = {
      ...input,
      id: crypto.randomUUID(),
      latest: null,
      checkedAt: null,
      error: null,
      releaseUrl: null,
    };
    this.save([...items, item]);
    return item;
  }
  update(id: string, input: z.infer<typeof RepositoryInput>) {
    const items = this.list(),
      index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new HttpError(404, "Repository not found");
    if (
      items.some(
        (item) =>
          item.id !== id &&
          item.name.toLowerCase() === input.name.toLowerCase() &&
          item.workspace === input.workspace,
      )
    )
      throw new HttpError(
        409,
        "This repository is already followed in this workspace",
      );
    const changed = items[index]!.name !== input.name;
    items[index] = {
      ...items[index]!,
      ...input,
      ...(changed
        ? { latest: null, checkedAt: null, error: null, releaseUrl: null }
        : {}),
    };
    this.save(items);
    return items[index];
  }
  remove(id: string) {
    const items = this.list();
    if (!items.some((item) => item.id === id))
      throw new HttpError(404, "Repository not found");
    this.save(items.filter((item) => item.id !== id));
  }
  check(): Promise<Entry[]> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const originals = this.list();
      const updates = new Map<string, Partial<Entry>>();
      for (const item of originals) {
        const checkedAt = new Date().toISOString();
        try {
          const headers = {
            Accept: "application/vnd.github+json",
            "User-Agent": "Gold-Dash",
          };
          let response = await this.fetcher(
            `https://api.github.com/repos/${item.name}/releases/latest`,
            { headers, redirect: "error", signal: AbortSignal.timeout(12_000) },
          );
          let tag: string;
          if (response.status === 404) {
            response = await this.fetcher(
              `https://api.github.com/repos/${item.name}/tags?per_page=1`,
              {
                headers,
                redirect: "error",
                signal: AbortSignal.timeout(12_000),
              },
            );
            if (!response.ok)
              throw new Error(`GitHub returned ${response.status}`);
            const data = await response.json();
            tag = data[0]?.name;
          } else {
            if (!response.ok)
              throw new Error(`GitHub returned ${response.status}`);
            const data = await response.json();
            tag = data.tag_name;
          }
          if (!tag || typeof tag !== "string")
            throw new Error("No releases or tags published");
          updates.set(item.id, {
            latest: tag.slice(0, 100),
            checkedAt,
            error: null,
            releaseUrl: `https://github.com/${item.name}/releases`,
          });
        } catch (error) {
          updates.set(item.id, { checkedAt, error: (error as Error).message });
        }
      }
      // Preserve edits/removals made while the network checks were in flight.
      const items = this.list().map((item) => ({
        ...item,
        ...(originals.find((original) => original.id === item.id)?.name ===
        item.name
          ? updates.get(item.id)
          : {}),
      }));
      this.save(items);
      return items;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
}
export const repositories = new RepositoryStore(
  path.join(cfg.dataDir, "repositories.json"),
);
export function initRepositoryChecks() {
  const check = () => {
    try {
      const items = repositories.list();
      if (
        items.some(
          (item) =>
            !item.checkedAt ||
            Date.parse(item.checkedAt) < Date.now() - 86400_000,
        )
      )
        void repositories.check().catch(console.error);
    } catch (error) {
      console.error("Repository checks unavailable:", (error as Error).message);
    }
  };
  check();
  const timer = setInterval(check, 3600_000);
  timer.unref();
}
