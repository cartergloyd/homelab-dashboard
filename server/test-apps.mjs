// Unit checks for the Directus-per-app configuration parser. Run after `npm run build`:
//   node server/test-apps.mjs
import assert from "node:assert/strict";
import { appsFromEnv, envKey } from "./dist/apps-config.js";

let n = 0;
const eq = (a, b, what) => (assert.deepEqual(a, b, what), n++);

eq(envKey("fam"), "FAM", "upper");
eq(envKey("my-shop"), "MY_SHOP", "dash → underscore");

const apps = appsFromEnv(["fam", " ai ", ""], {}, "xgold.tech");
eq(apps.length, 2, "blank skipped, names trimmed");
eq(
  apps[0],
  { name: "fam", kind: "directus", url: "http://127.0.0.1:8056", publicUrl: "https://fam-api.xgold.tech", siteUrl: "https://fam.xgold.tech", container: "homelab-directus-fam", db: "fam", healthPath: "/server/health" },
  "defaults for the first app: Directus at <name>-api.<domain>, the site at <name>.<domain>",
);
eq(apps[1].url, "http://127.0.0.1:8057", "ports count up in APPS order");
eq(apps[1].publicUrl, "https://ai-api.xgold.tech", "public URL from the domain");
eq(apps[1].siteUrl, "https://ai.xgold.tech", "site URL from the domain");

const custom = appsFromEnv(
  ["shop"],
  { APP_SHOP_URL: "http://127.0.0.1:9000/", APP_SHOP_PUBLIC_URL: "https://store.example.com/", APP_SHOP_SITE_URL: "https://shop.example.com/", APP_SHOP_CONTAINER: "shop-directus", APP_SHOP_DB: "shopdb" },
  "xgold.tech",
);
eq(
  custom[0],
  { name: "shop", kind: "directus", url: "http://127.0.0.1:9000", publicUrl: "https://store.example.com", siteUrl: "https://shop.example.com", container: "shop-directus", db: "shopdb", healthPath: "/server/health" },
  "every field overridable; trailing slashes dropped",
);

eq(appsFromEnv(["fam"], {}, null)[0].publicUrl, null, "no domain → no public URL");
eq(appsFromEnv(["fam"], {}, null)[0].siteUrl, null, "no domain → no site URL");
assert.throws(() => appsFromEnv(["Bad Name"], {}, null), /not a valid app name/, "invalid names are rejected at boot");
n++;

console.log(`apps-config: ${n} checks passed`);

// second app kind: Twenty CRM
const mixed = appsFromEnv(["fam", "crm", "ai"], { APP_CRM_KIND: "twenty" }, "xgold.tech");
eq(mixed.map((a) => [a.name, a.kind, a.url, a.publicUrl, a.siteUrl, a.container, a.healthPath]), [
  ["fam", "directus", "http://127.0.0.1:8056", "https://fam-api.xgold.tech", "https://fam.xgold.tech", "homelab-directus-fam", "/server/health"],
  ["crm", "twenty", "http://127.0.0.1:3020", "https://crm.xgold.tech", null, "homelab-twenty", "/healthz"],
  ["ai", "directus", "http://127.0.0.1:8057", "https://ai-api.xgold.tech", "https://ai.xgold.tech", "homelab-directus-ai", "/server/health"],
], "twenty apps do not consume a directus port; crm is the site itself");
assert.throws(() => appsFromEnv(["x"], { APP_X_KIND: "wordpress" }, null), /APP_X_KIND/, "unknown kinds are rejected at boot");
n++;
console.log(`apps-config (kinds): ${n} checks total`);
