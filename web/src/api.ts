export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface StepUpChallenge { challengeId?: string; description?: string; enrollmentRequired: boolean }
let stepUpHandler: ((challenge: StepUpChallenge) => Promise<string | null>) | null = null;
export function setStepUpHandler(handler: typeof stepUpHandler) { stepUpHandler = handler; }

async function request<T>(url: string, init?: RequestInit, confirmed = false): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let body: { error?: string; code?: string; challengeId?: string; description?: string } = {};
    try {
      body = await res.json();
    } catch {
      // Non-JSON errors retain their HTTP status below.
    }
    if (body.error) message = body.error;
    if (!confirmed && res.status === 428 && stepUpHandler && (body.code === "STEP_UP_REQUIRED" || body.code === "STEP_UP_ENROLLMENT_REQUIRED")) {
      const permit = await stepUpHandler({ challengeId: body.challengeId, description: body.description, enrollmentRequired: body.code === "STEP_UP_ENROLLMENT_REQUIRED" });
      if (!permit) throw new ApiError(428, "Action cancelled. No changes were made.");
      const headers = new Headers(init?.headers);
      headers.set("X-Homelab-Step-Up", permit);
      // Only a server-issued 428 may be retried, once; it ran before the action.
      return request<T>(url, { ...init, headers }, true);
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(`/api${path}`),
  post: <T>(path: string, body?: unknown) =>
    request<T>(`/api${path}`, { method: "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(`/api${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(`/api${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(`/api${path}`, { method: "DELETE" }),
  upload: <T>(path: string, files: FileList | File[]) => {
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f, f.name);
    return request<T>(`/api${path}`, { method: "POST", body: form });
  },
};

function wsBase(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
}

export function logSocketUrl(source: string): string {
  return `${wsBase()}/ws/logs?source=${encodeURIComponent(source)}`;
}

export function alertsSocketUrl(): string {
  return `${wsBase()}/ws/alerts`;
}

export function minecraftSocketUrl(): string {
  return `${wsBase()}/ws/minecraft`;
}
