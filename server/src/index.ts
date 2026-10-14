import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { identityMiddleware } from "./auth.js";
import { cfg } from "./config.js";
import { bootstrapDemo } from "./demo.js";
import { statusOf } from "./errors.js";
import { api } from "./routes.js";
import { startHub } from "./services/alerts.js";
import { initContext } from "./services/context.js";
import { initReports } from "./services/reports.js";
import { initScheduler } from "./services/scheduler.js";
import { initScripts } from "./services/scripts.js";
import { initSidecar } from "./services/sidecar.js";
import { refreshFolders } from "./services/storage.js";
import { attachLogSocket } from "./ws.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return;
  }
  const status = statusOf(err);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: (err as Error).message ?? "Internal error" });
};

async function main(): Promise<void> {
  if (cfg.demo) await bootstrapDemo();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  await startHub();
  await initScripts();
  await initContext();
  await initReports();
  await initScheduler();
  await initSidecar();
  void refreshFolders();

  const app = express();
  app.set("trust proxy", false);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(identityMiddleware);
  app.use("/api", api);

  const webDist = path.resolve(here, "../../web/dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/|\/ws\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  } else {
    app.get("/", (_req, res) => res.type("text").send("homelab-dashboard API is running. Build the web app (npm run build) to serve the UI."));
  }
  app.use(errorHandler);

  const server = http.createServer(app);
  attachLogSocket(server);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`homelab-dashboard listening on http://${cfg.host}:${cfg.port}${cfg.demo ? " (DEMO mode)" : ""}${cfg.authDisabled ? " (auth disabled)" : ""}`);
    if (!cfg.dashboardKey) console.warn("DASHBOARD_KEY is not set: scripts and the MCP connector cannot authenticate.");
    else if (cfg.demo) console.log(`Dashboard key (demo): ${cfg.dashboardKey}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
