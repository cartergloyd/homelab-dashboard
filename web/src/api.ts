export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON
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
  del: <T>(path: string) => request<T>(`/api${path}`, { method: "DELETE" }),
  upload: <T>(path: string, files: FileList | File[]) => {
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f, f.name);
    return request<T>(`/api${path}`, { method: "POST", body: form });
  },
};

export function logSocketUrl(source: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/logs?source=${encodeURIComponent(source)}`;
}
