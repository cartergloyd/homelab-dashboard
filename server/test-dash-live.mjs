import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import { transform } from "esbuild";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "dash-live-test-"));
process.env.DATA_DIR = temp;
const { cfg } = await import("./dist/config.js");
const { RepositoryStore, RepositoryInput } = await import(
  "./dist/services/repositories.js"
);
const { executeHostCommand, sampleHost, hostStatus } = await import(
  "./dist/services/host.js"
);
const { directusRecordRoutes } = await import(
  "./dist/services/directusRecords.js"
);
const { protectedAction } = await import("./dist/security.js");
const originalFetch = globalThis.fetch;
let server;
try {
  const source = await fs.readFile(
    new URL("../web/src/importRecords.ts", import.meta.url),
    "utf8",
  );
  const compiled = await transform(source, { loader: "ts", format: "esm" });
  const { parseRecordImport } = await import(
    "data:text/javascript;base64," +
      Buffer.from(compiled.code).toString("base64")
  );
  assert.deepEqual(
    parseRecordImport(
      'id,note\r\n001,"a,b"\r\n002,"line\n""quoted"""\r\n',
      "records.csv",
    ),
    [
      { id: "001", note: "a,b" },
      { id: "002", note: 'line\n"quoted"' },
    ],
  );
  assert.deepEqual(
    parseRecordImport('[{"active":true,"count":2}]', "records.json"),
    [{ active: true, count: 2 }],
  );
  for (const csv of ["id,id\na,b", "id,note\na", 'id\n"bad', 'id\n"bad"tail'])
    assert.throws(() => parseRecordImport(csv, "bad.csv"));
  assert.throws(() => parseRecordImport("[1,2]", "bad.json"));
  assert.throws(() => parseRecordImport("[]", "bad.json"));
  assert.throws(() => parseRecordImport("a".repeat(750001), "big.csv"));
  let mode = "release",
    calls = [],
    unblock;
  const fake = async (url) => {
    calls.push(url);
    if (mode === "wait")
      await new Promise((r) => {
        unblock = r;
      });
    if (mode === "error") return new Response("", { status: 429 });
    if (mode === "tags" && url.includes("/releases/"))
      return new Response("", { status: 404 });
    return Response.json(
      url.includes("/tags?") ? [{ name: "v3" }] : { tag_name: "v2" },
    );
  };
  const file = path.join(temp, "repositories.json"),
    store = new RepositoryStore(file, fake);
  assert.deepEqual(store.list(), []);
  const repo = store.add(
    RepositoryInput.parse({
      name: "owner/project",
      installed: "v1",
      workspace: "personal",
    }),
  );
  assert.throws(
    () =>
      store.add(
        RepositoryInput.parse({
          name: "OWNER/project",
          installed: "v1",
          workspace: "personal",
        }),
      ),
    /already followed/,
  );
  store.add(
    RepositoryInput.parse({
      name: "owner/project",
      installed: "v1",
      workspace: "business",
    }),
  );
  assert.equal(new RepositoryStore(file, fake).list().length, 2);
  assert.equal((await store.check())[0].latest, "v2");
  mode = "tags";
  assert.equal((await store.check())[0].latest, "v3");
  mode = "error";
  assert.match((await store.check())[0].error, /429/);
  store.remove(store.list()[1].id);
  mode = "wait";
  const pending = store.check();
  await new Promise((r) => setImmediate(r));
  store.update(
    repo.id,
    RepositoryInput.parse({
      name: "owner/renamed",
      installed: "v4",
      workspace: "personal",
    }),
  );
  unblock();
  await pending;
  assert.equal(
    store.list()[0].latest,
    null,
    "old name check cannot overwrite an edited repository",
  );
  store.remove(repo.id);
  assert.deepEqual(store.list(), []);
  await fs.writeFile(file, "broken");
  assert.throws(() => store.list(), /Cannot read/);
  const metrics = sampleHost();
  assert.equal(metrics.cpu, null);
  assert.ok(metrics.memoryTotal > 0);
  assert.deepEqual(
    hostStatus().history,
    [],
    "new history contains no fabricated samples",
  );
  process.env.DASHBOARD_KEY = "test-canary-never-in-child";
  const shell = await executeHostCommand(
    'pwd; printf "%s" "${DASHBOARD_KEY-unset}"',
    temp,
  );
  assert.equal(shell.code, 0);
  assert.match(shell.stdout, /unset$/);
  assert.ok(shell.stdout.includes(temp));
  const failed = await executeHostCommand("printf problem >&2; exit 7", temp);
  assert.equal(failed.code, 7);
  assert.equal(failed.stderr, "problem");
  await assert.rejects(
    executeHostCommand("pwd", path.join(temp, "missing")),
    /Working directory/,
  );
  const large = await executeHostCommand(
    "node -e 'process.stdout.write(\"x\".repeat(300000))'",
    temp,
  );
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(large.stdout) <= 256 * 1024);
  assert.ok(protectedAction("POST", "/terminal/execute"));
  assert.ok(protectedAction("PATCH", "/DIRECTUS/personal/items/notes/1/"));
  assert.ok(
    protectedAction("POST", "/qbittorrent/control", { action: "remove" }),
  );
  assert.equal(protectedAction("POST", "/directus/personal/login"), null);
  let refreshes = 0,
    upstreamCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    upstreamCalls.push({ url, init });
    if (url.endsWith("/auth/login")) {
      assert.equal(JSON.parse(init.body).otp, "123456");
      return Response.json({
        data: {
          access_token: "private-access",
          refresh_token: "private-refresh",
          expires: 1,
        },
      });
    }
    if (url.endsWith("/auth/refresh")) {
      refreshes++;
      await new Promise((r) => setTimeout(r, 20));
      return Response.json({
        data: {
          access_token: "private-access",
          refresh_token: "private-refresh",
          expires: 900000,
        },
      });
    }
    if (url.endsWith("/auth/logout"))
      return new Response(null, { status: 204 });
    assert.equal(init.headers.Authorization, "Bearer private-access");
    if (url.endsWith("/collections") && !init.method)
      return Response.json({
        data: [
          { collection: "notes", meta: {} },
          { collection: "directus_users" },
          { collection: "hidden", meta: { hidden: true } },
        ],
      });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (init.method === "PATCH")
      return Response.json({ data: JSON.parse(init.body) });
    if (init.method === "POST")
      return Response.json({ data: { ...JSON.parse(init.body), id: 1 } });
    return Response.json({ data: [{ id: 1, title: "Saved note" }] });
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.user = {
      login: req.headers["x-owner"] || "owner",
      name: "Owner",
      via: "tailscale",
    };
    next();
  });
  app.use(
    "/api/directus",
    directusRecordRoutes(() => {}),
  );
  app.use((err, _req, res, _next) =>
    res
      .status(err.status || (err.name === "ZodError" ? 400 : 500))
      .json({ error: err.message }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`,
    endpoint = base + "/api/directus";
  let cookie = "";
  const request = (
    p,
    body,
    extra = {},
    method = body === undefined ? "GET" : "POST",
  ) =>
    originalFetch(endpoint + p, {
      method,
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let r = await request("/personal/collections");
  assert.equal(r.status, 401);
  r = await request(
    "/personal/login",
    { email: "owner@example.com", password: "not-real", otp: "123456" },
    { Origin: "https://wrong.example" },
  );
  assert.equal(r.status, 403);
  r = await request("/unknown/login", {
    email: "owner@example.com",
    password: "not-real",
    otp: "123456",
  });
  assert.equal(r.status, 404);
  r = await request("/personal/login", {
    email: "owner@example.com",
    password: "not-real",
    otp: "123456",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { connected: true });
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.headers.get("set-cookie"), /SameSite=Strict/);
  cookie = r.headers.get("set-cookie").split(";")[0];
  const results = await Promise.all([
    request("/personal/collections"),
    request("/personal/items/notes"),
  ]);
  assert.deepEqual(await results[0].json(), [
    { collection: "notes", meta: {} },
  ]);
  assert.equal(results[1].status, 200);
  assert.equal(refreshes, 1, "concurrent queries share one token refresh");
  r = await request("/personal/items/notes", undefined, {
    "x-owner": "someone-else",
  });
  assert.equal(r.status, 401, "sessions bound to dashboard owner");
  r = await request("/personal/items/directus_users");
  assert.equal(r.status, 400);
  r = await request("/personal/items/notes", { title: "New note" });
  assert.equal(r.status, 201);
  r = await request(
    "/personal/items/notes/1",
    { title: "Edited" },
    {},
    "PATCH",
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { title: "Edited" });
  r = await request("/personal/items/notes/1", undefined, {}, "DELETE");
  assert.equal(r.status, 200);
  r = await request("/personal/logout", {});
  assert.equal(r.status, 200);
  r = await request("/personal/items/notes");
  assert.equal(r.status, 401);
  console.log(
    "dash-live: CSV/JSON imports, persistence, release/tag checks, edit races, truthful metrics, actual shell output/limits/environment isolation, step-up coverage, Directus owner/origin/permissions/session/refresh/CRUD/logout passed",
  );
} finally {
  globalThis.fetch = originalFetch;
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await fs.rm(temp, { recursive: true, force: true });
}
