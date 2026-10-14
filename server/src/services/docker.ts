import fs from "node:fs";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import Dockerode from "dockerode";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import type { ContainerInfo } from "../types.js";

let client: Dockerode | null = null;

function docker(): Dockerode {
  return (client ??= new Dockerode({ socketPath: cfg.dockerSocket }));
}

export interface DockerDiskUsage {
  imagesTotal: number;
  imagesUnused: number;
  imagesUnusedCount: number;
  buildCache: number;
  volumesUnused: number;
  volumesUnusedCount: number;
}

/** `docker system df` through the socket: what `docker system prune` would reclaim. */
export async function dockerDiskUsage(): Promise<DockerDiskUsage | null> {
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return { imagesTotal: 6.1 * 1024 ** 3, imagesUnused: 2.3 * 1024 ** 3, imagesUnusedCount: 4, buildCache: 1.1 * 1024 ** 3, volumesUnused: 420 * 1024 ** 2, volumesUnusedCount: 2 };
  if (!dockerAvailable()) return null;
  try {
    const df = (await docker().df()) as {
      Images?: { Size: number; SharedSize: number; Containers: number }[];
      BuildCache?: { Size: number; InUse: boolean }[];
      Volumes?: { UsageData?: { Size: number; RefCount: number } }[];
    };
    const images = df.Images ?? [];
    const unused = images.filter((i) => i.Containers === 0);
    const volumes = (df.Volumes ?? []).filter((v) => v.UsageData && v.UsageData.RefCount === 0);
    return {
      imagesTotal: images.reduce((s, i) => s + i.Size, 0),
      imagesUnused: unused.reduce((s, i) => s + Math.max(0, i.Size - i.SharedSize), 0),
      imagesUnusedCount: unused.length,
      buildCache: (df.BuildCache ?? []).filter((b) => !b.InUse).reduce((s, b) => s + b.Size, 0),
      volumesUnused: volumes.reduce((s, v) => s + (v.UsageData?.Size ?? 0), 0),
      volumesUnusedCount: volumes.length,
    };
  } catch {
    return null;
  }
}

export function dockerAvailable(): boolean {
  if (cfg.demo) return true;
  try {
    fs.accessSync(cfg.dockerSocket, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function containerInfo(name: string): Promise<ContainerInfo | null> {
  if (cfg.demo) return demo.containerInfo(name);
  if (!dockerAvailable()) return null;
  try {
    const info = await docker().getContainer(name).inspect();
    const state = info.State as typeof info.State & { Health?: { Status: string } };
    return {
      name,
      state: state.Status,
      status: state.Health?.Status ?? state.Status,
      image: info.Config.Image,
      startedAt: state.Running ? state.StartedAt : null,
      health: state.Health?.Status ?? null,
    };
  } catch {
    return null;
  }
}

export async function restartContainer(name: string): Promise<void> {
  if (cfg.demo) return;
  await docker().getContainer(name).restart({ t: 20 });
}

/** Follows a container's stdout+stderr; resolves to a stop function. `onEnd` fires if the stream dies. */
export async function followContainerLogs(name: string, onLine: (line: string) => void, onEnd?: () => void): Promise<() => void> {
  if (!dockerAvailable()) {
    onLine(`[docker socket not available at ${cfg.dockerSocket}]`);
    setTimeout(() => onEnd?.(), 0);
    return () => {};
  }
  const container = docker().getContainer(name);
  const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 200 });
  const out = new PassThrough();
  const err = new PassThrough();
  container.modem.demuxStream(stream, out, err);
  const rlOut = readline.createInterface({ input: out });
  const rlErr = readline.createInterface({ input: err });
  rlOut.on("line", onLine);
  rlErr.on("line", onLine);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd?.();
  };
  stream.on("error", (e: Error) => {
    onLine(`[docker logs error] ${e.message}`);
    end();
  });
  stream.on("end", end);
  stream.on("close", end);
  return () => {
    ended = true;
    rlOut.close();
    rlErr.close();
    (stream as unknown as { destroy?: () => void }).destroy?.();
  };
}
