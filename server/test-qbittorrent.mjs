import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { QbittorrentClient, TorrentInput } from "./dist/services/qbittorrent.js";

const magnet = `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=Example`;
assert.deepEqual(TorrentInput.parse({ urls: ` ${magnet}\r\n${magnet}\nhttps://example.com/file.torrent?key=a%26b ` }), { urls: [magnet, "https://example.com/file.torrent?key=a%26b"], paused: false });
for (const urls of ["", "file:///etc/passwd", "javascript:alert(1)", "magnet:?dn=no-hash", "https://user:pass@example.com/torrent", "not a link", Array.from({ length: 21 }, (_, i) => `https://example.com/${i}.torrent`).join("\n")]) {
  assert.equal(TorrentInput.safeParse({ urls }).success, false, urls);
}

let mode = "ok";
let requireLogin = false;
let logins = 0;
let controls = [];
const adds = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = new URLSearchParams(Buffer.concat(chunks).toString());
  assert.equal(req.headers.referer, `http://127.0.0.1:${server.address().port}/`);
  if (req.url === "/api/v2/auth/login") {
    logins++;
    assert.equal(body.get("username"), "admin");
    assert.equal(body.get("password"), "secret & value");
    res.setHeader("Set-Cookie", "SID=test-session; HttpOnly; path=/");
    res.end("Ok.");
    return;
  }
  if (requireLogin && req.headers.cookie !== "SID=test-session") { res.writeHead(403).end(); return; }
  if (req.url === "/api/v2/app/version") { res.end("v5.2.4"); return; }
  if (req.url === "/api/v2/torrents/info") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify([{hash:"a".repeat(40), name:"Actual title", progress:0.5, tracker:"private-passkey", magnet_uri:"secret"}])); return; }
  if (["stop", "start", "pause", "resume", "delete"].some(action => req.url === `/api/v2/torrents/${action}`)) {
    controls.push({path:req.url,body});
    if (mode === "old-api" && /\/(stop|start)$/.test(req.url)) { res.writeHead(404).end(); return; }
    res.end(); return;
  }
  assert.equal(req.url, "/api/v2/torrents/add");
  assert.equal(req.method, "POST");
  adds.push(body);
  if (mode === "disconnect") { req.socket.destroy(); return; }
  if (mode === "unauthorized") { res.writeHead(403).end(); return; }
  if (mode === "redirect") { res.writeHead(302, { Location: "/unexpected" }).end(); return; }
  if (mode === "json") { res.end(JSON.stringify({ success_count: 1, pending_count: 1, failure_count: 0 })); return; }
  if (mode === "partial") { res.end(JSON.stringify({ success_count: 1, pending_count: 0, failure_count: 1 })); return; }
  if (mode === "unknown") { res.end("{}"); return; }
  res.end(mode === "reject" ? "Fails." : "Ok.");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new QbittorrentClient({ url });
  assert.deepEqual(await client.status(), { reachable: true, version: "v5.2.4" });
  const input = TorrentInput.parse({ urls: `${magnet}\nhttps://example.com/a.torrent?key=a%26b`, paused: true });
  assert.deepEqual(await client.add(input), { submitted: 2 });
  assert.equal(adds[0].get("urls"), input.urls.join("\n"), "URL query strings survive form encoding");
  assert.equal(adds[0].get("stopped"), "true", "qBittorrent 5 paused-add setting");
  assert.equal(adds[0].get("paused"), "true", "older qBittorrent paused-add setting");
  assert.equal(adds[0].has("savepath"), false, "existing destination settings preserved");
  mode = "json";
  assert.deepEqual(await client.add(input), { submitted: 2 }, "qBittorrent 5.2 JSON reply includes pending URL downloads");
  mode = "partial";
  assert.deepEqual(await client.add(input), { submitted: 1, failed: 1 }, "partial failures are not reported as a complete success");
  mode = "ok";

  requireLogin = true;
  const auth = new QbittorrentClient({ url, username: "admin", password: "secret & value" });
  const statuses = await Promise.all([auth.status(), auth.status()]);
  assert.ok(statuses.every((s) => s.reachable));
  assert.equal(logins, 1, "concurrent requests share one login");
  await auth.add(input);
  assert.equal(logins, 1, "session reused");
  for (const [failure, message] of [["reject", /rejected/], ["unauthorized", /authentication/], ["disconnect", /before retrying/], ["redirect", /before retrying/], ["unknown", /before retrying/]]) {
    mode = failure;
    const before = adds.length;
    await assert.rejects(auth.add(input), message);
    assert.equal(adds.length, before + 1, "uncertain submissions are never replayed");
  }
  mode="ok";
  const queue = await auth.queue(); assert.equal(queue[0].name,"Actual title"); assert.equal(queue[0].progress,0.5);
  assert.equal("tracker" in queue[0],false);assert.equal("magnet_uri" in queue[0],false);
  await auth.control("a".repeat(40),"pause");assert.ok(controls.at(-1).path.endsWith("/stop"));
  mode="old-api";await auth.control("a".repeat(40),"resume");assert.ok(controls.at(-1).path.endsWith("/resume"));
  await auth.control("a".repeat(40),"remove");assert.equal(controls.at(-1).body.get("deleteFiles"),"false");
  requireLogin = false;
  const disabled = new QbittorrentClient({ url: null });
  assert.equal((await disabled.status()).reachable, false);
  await assert.rejects(disabled.add(input), /not configured/);
  console.log("qbittorrent: link validation, encoding, paused submissions, session auth, rejected/uncertain replies and no replay passed");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
