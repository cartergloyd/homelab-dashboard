export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const FS_STATUS: Record<string, number> = {
  ENOENT: 404,
  EEXIST: 409,
  ENOTEMPTY: 409,
  EACCES: 403,
  EPERM: 403,
  EISDIR: 400,
  ENOTDIR: 400,
  EXDEV: 400,
};

/** Maps Node fs errors to HTTP statuses so the UI gets a sensible message. */
export function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const code = (err as { code?: string })?.code;
  if (code === "LIMIT_FILE_SIZE") return 413;
  if (code && FS_STATUS[code]) return FS_STATUS[code];
  return 500;
}
