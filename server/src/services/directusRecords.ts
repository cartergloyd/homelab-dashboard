import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { Identity } from "../auth.js";
import type { PeoplePayload, PersonRole } from "../types.js";

const cookieName = "dash-directus-session";
const identifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .max(100)
  .refine(
    (value) => !value.startsWith("directus_"),
    "Use an application collection, not a system collection",
  );
type Session = {
  owner: string;
  target: string;
  access: string;
  refresh: string;
  accessExpires: number;
  expires: number;
  refreshing?: Promise<void>;
};
export function directusRecordRoutes(
  logAction: (res: Response, action: string) => void,
) {
  const router = express.Router();
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, { count: number; expires: number }>();
  const targets = () => [
    { id: "personal", label: "Personal Directus", url: cfg.directus.url },
    ...cfg.apps
      .filter((a) => a.kind === "directus")
      .map((a) => ({ id: a.name, label: a.name, url: a.url })),
  ];
  const owner = (res: Response) => (res.locals.user as Identity).login;
  const token = (req: Request) =>
    req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
  function session(req: Request, res: Response) {
    const id = token(req),
      value = id ? sessions.get(id) : null;
    if (
      !value ||
      value.owner !== owner(res) ||
      value.target !== req.params.target ||
      value.expires <= Date.now()
    )
      throw new HttpError(
        401,
        "Sign in to this Directus instance to manage records",
      );
    return value;
  }
  function checkOrigin(req: Request, res: Response) {
    if (["GET", "HEAD"].includes(req.method)) return;
    if ((res.locals.user as Identity).viaKey) return;
    const expected =
      (res.locals.user as Identity).via === "cloudflare"
        ? cfg.cfAccess?.publicUrl
        : `${req.protocol}://${req.get("host")}`;
    if (!expected || req.get("origin") !== new URL(expected).origin)
      throw new HttpError(403, "Use the dashboard page for Directus changes");
  }
  async function upstream(
    targetId: string,
    endpoint: string,
    init: RequestInit = {},
    access?: string,
  ) {
    const target = targets().find((t) => t.id === targetId);
    if (!target) throw new HttpError(404, "Unknown Directus instance");
    let response: globalThis.Response;
    try {
      response = await fetch(target.url + endpoint, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "Content-Type": "application/json",
          ...(access ? { Authorization: `Bearer ${access}` } : {}),
        },
      });
    } catch {
      throw new HttpError(502, "Cannot reach this Directus instance");
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const code = data?.errors?.[0]?.extensions?.code;
      throw new HttpError(
        [400, 401, 403, 404, 409].includes(response.status)
          ? response.status
          : 502,
        code
          ? `Directus: ${String(code).replace(/_/g, " ").toLowerCase()}`
          : `Directus returned ${response.status}`,
      );
    }
    return response.status === 204 ? { data: null } : response.json();
  }
  async function request(
    req: Request,
    res: Response,
    endpoint: string,
    init: RequestInit = {},
  ) {
    const s = session(req, res);
    if (s.accessExpires < Date.now() + 15_000) {
      s.refreshing ??= (async () => {
        const refreshed = await upstream(s.target, "/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refresh_token: s.refresh, mode: "json" }),
        });
        s.access = refreshed.data.access_token;
        s.refresh = refreshed.data.refresh_token;
        s.accessExpires = Date.now() + refreshed.data.expires;
      })().finally(() => {
        s.refreshing = undefined;
      });
      await s.refreshing;
    }
    return upstream(s.target, endpoint, init, s.access);
  }
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    checkOrigin(req, res);
    next();
  });
  router.get("/targets", (_req, res) => res.json(targets()));
  router.get("/:target/session", (req, res) => {
    try {
      session(req, res);
      res.json({ connected: true });
    } catch {
      res.json({ connected: false });
    }
  });
  router.post("/:target/login", async (req, res) => {
    for (const [id, attempt] of attempts)
      if (attempt.expires <= Date.now()) attempts.delete(id);
    const attempt = attempts.get(owner(res)) ?? {
      count: 0,
      expires: Date.now() + 600_000,
    };
    if (++attempt.count > 10 || attempts.size > 2000)
      throw new HttpError(
        429,
        "Too many Directus sign-in attempts. Try again in ten minutes.",
      );
    attempts.set(owner(res), attempt);
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1).max(1024),
        otp: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      })
      .parse(req.body);
    for (const [id, s] of sessions)
      if (s.expires <= Date.now()) sessions.delete(id);
    if (sessions.size >= 200)
      throw new HttpError(429, "Too many Directus sessions");
    const data = await upstream(String(req.params.target), "/auth/login", {
      method: "POST",
      body: JSON.stringify({ ...body, mode: "json" }),
    });
    if (!data.data?.access_token || !data.data?.refresh_token)
      throw new HttpError(502, "Directus did not return a login session");
    const old = token(req);
    if (old) sessions.delete(old);
    const id = crypto.randomBytes(32).toString("hex");
    sessions.set(id, {
      owner: owner(res),
      target: String(req.params.target),
      access: data.data.access_token,
      refresh: data.data.refresh_token,
      accessExpires: Date.now() + data.data.expires,
      expires: Date.now() + 8 * 3600_000,
    });
    res.cookie(cookieName, id, {
      httpOnly: true,
      secure: (res.locals.user as Identity).via === "cloudflare" || req.secure,
      sameSite: "strict",
      path: "/api/directus",
      maxAge: 8 * 3600_000,
    });
    logAction(res, `signed in to Directus ${req.params.target}`);
    res.json({ connected: true });
  });
  router.post("/:target/logout", async (req, res) => {
    const id = token(req),
      s = id ? sessions.get(id) : null;
    if (s?.owner === owner(res)) {
      await upstream(s.target, "/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refresh_token: s.refresh }),
      }).catch(() => {});
      sessions.delete(id!);
    }
    res.clearCookie(cookieName, { path: "/api/directus" });
    res.json({ connected: false });
  });
  router.get("/:target/collections", async (req, res) => {
    const data = await request(req, res, "/collections");
    res.json(
      data.data.filter(
        (c: { collection: string; meta?: { hidden?: boolean } }) =>
          !c.collection.startsWith("directus_") && !c.meta?.hidden,
      ),
    );
  });
  router.post("/:target/collections", async (req, res) => {
    const body = z
      .object({
        collection: identifier,
        fields: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
      })
      .parse(req.body);
    const result = await request(req, res, "/collections", {
      method: "POST",
      body: JSON.stringify({
        collection: body.collection,
        meta: {},
        schema: {},
        fields: body.fields ?? [
          {
            field: "id",
            type: "integer",
            schema: { is_primary_key: true, has_auto_increment: true },
            meta: { hidden: true, interface: "input" },
          },
        ],
      }),
    });
    logAction(
      res,
      `created Directus collection ${body.collection} in ${req.params.target}`,
    );
    res.status(201).json(result.data);
  });
  router.get("/:target/fields/:collection", async (req, res) => {
    const name = identifier.parse(req.params.collection);
    const result = await request(req, res, `/fields/${name}`);
    res.json(result.data);
  });
  router.post("/:target/fields/:collection", async (req, res) => {
    const name = identifier.parse(req.params.collection);
    const field = z
      .object({
        field: identifier,
        type: z.enum([
          "string",
          "text",
          "integer",
          "bigInteger",
          "float",
          "decimal",
          "boolean",
          "date",
          "dateTime",
          "timestamp",
          "json",
          "uuid",
        ]),
        schema: z.record(z.string(), z.unknown()).optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    const result = await request(req, res, `/fields/${name}`, {
      method: "POST",
      body: JSON.stringify(field),
    });
    logAction(
      res,
      `added field ${name}.${field.field} in ${req.params.target}`,
    );
    res.status(201).json(result.data);
  });
  router.get("/:target/items/:collection", async (req, res) => {
    const name = identifier.parse(req.params.collection),
      page = z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .parse(req.query.page ?? 1);
    const result = await request(
      req,
      res,
      `/items/${name}?limit=50&page=${page}`,
    );
    res.json(result.data);
  });
  router.post("/:target/items/:collection", async (req, res) => {
    const name = identifier.parse(req.params.collection),
      body = z
        .union([
          z.record(z.string(), z.unknown()),
          z.array(z.record(z.string(), z.unknown())).min(1).max(500),
        ])
        .parse(req.body);
    const result = await request(req, res, `/items/${name}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    logAction(res, `created records in Directus ${req.params.target}/${name}`);
    res.status(201).json(result.data);
  });
  router.patch("/:target/items/:collection/:id", async (req, res) => {
    const name = identifier.parse(req.params.collection),
      id = z.string().min(1).max(300).parse(req.params.id),
      body = z.record(z.string(), z.unknown()).parse(req.body);
    const result = await request(
      req,
      res,
      `/items/${name}/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
    logAction(res, `updated Directus ${req.params.target}/${name} record`);
    res.json(result.data);
  });
  router.delete("/:target/items/:collection/:id", async (req, res) => {
    const name = identifier.parse(req.params.collection),
      id = z.string().min(1).max(300).parse(req.params.id);
    await request(req, res, `/items/${name}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    logAction(res, `deleted Directus ${req.params.target}/${name} record`);
    res.json({ ok: true });
  });

  // People: website sign-ups and who is approved (deploy/ai-members.sql, docs/SSO.md). Directus admins and
  // service accounts are listed as "system" and never changed from here, so this cannot grant or take
  // Directus admin rights. Writes ride on the same owner session, origin check and step-up code as the items.
  const PEOPLE_ROLES = { pending: "Pending", customer: "Customer", admin: "Network admin" } as const;
  const roleKey = (name?: string | null): PersonRole =>
    (Object.entries(PEOPLE_ROLES).find(([, n]) => n === name)?.[0] as PersonRole | undefined) ?? "system";
  async function roleNames(req: Request, res: Response) {
    const roles = await request(req, res, "/roles?fields=id,name&limit=100");
    return new Map<string, string>((roles.data as { id: string; name: string }[]).map((r) => [r.id, r.name]));
  }
  router.get("/:target/people", async (req, res) => {
    const roles = await roleNames(req, res);
    const users = await request(
      req,
      res,
      "/users?fields=id,email,first_name,last_name,status,provider,last_access,role&sort=email&limit=500",
    );
    const payload: PeoplePayload = {
      ready: [...roles.values()].includes(PEOPLE_ROLES.pending),
      dashAllowList: cfg.allowedLogins.length ? cfg.allowedLogins : null,
      people: (users.data as Record<string, string | null>[])
        .filter((u) => u.role) // service accounts have no role
        .map((u) => ({
          id: u.id as string,
          email: u.email ?? "",
          name: [u.first_name, u.last_name].filter(Boolean).join(" "),
          role: roleKey(roles.get(u.role as string)),
          roleName: roles.get(u.role as string) ?? null,
          provider: u.provider ?? "default",
          status: u.status ?? "active",
          lastAccess: u.last_access ?? null,
        })),
    };
    res.json(payload);
  });
  router.patch("/:target/people/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      body = z
        .object({
          role: z.enum(["pending", "customer", "admin"]).optional(),
          status: z.enum(["active", "suspended"]).optional(),
        })
        .refine((b) => b.role || b.status, "Nothing to change")
        .parse(req.body);
    const roles = await roleNames(req, res);
    const user = (await request(req, res, `/users/${id}?fields=email,role`)).data as { email: string; role: string | null };
    if (roleKey(user.role ? roles.get(user.role) : null) === "system")
      throw new HttpError(403, "System accounts are managed in Directus, not here");
    const patch: Record<string, string> = {};
    if (body.role) {
      const wanted = [...roles].find(([, n]) => n === PEOPLE_ROLES[body.role!]);
      if (!wanted) throw new HttpError(409, "The customer roles are not installed yet (deploy/ai-members.sql)");
      patch.role = wanted[0];
    }
    if (body.status) patch.status = body.status;
    await request(req, res, `/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    logAction(res, `set ${user.email} to ${body.role ?? body.status} in Directus ${req.params.target}`);
    res.json({ ok: true });
  });
  return router;
}
