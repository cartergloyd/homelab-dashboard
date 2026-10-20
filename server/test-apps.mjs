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
  { name: "fam", url: "http://127.0.0.1:8056", publicUrl: "https://fam-api.xgold.tech", siteUrl: "https://fam.xgold.tech", container: "homelab-directus-fam", db: "fam" },
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
  { name: "shop", url: "http://127.0.0.1:9000", publicUrl: "https://store.example.com", siteUrl: "https://shop.example.com", container: "shop-directus", db: "shopdb" },
  "every field overridable; trailing slashes dropped",
);

eq(appsFromEnv(["fam"], {}, null)[0].publicUrl, null, "no domain → no public URL");
eq(appsFromEnv(["fam"], {}, null)[0].siteUrl, null, "no domain → no site URL");
assert.throws(() => appsFromEnv(["Bad Name"], {}, null), /not a valid app name/, "invalid names are rejected at boot");
n++;

console.log(`apps-config: ${n} checks passed`);
