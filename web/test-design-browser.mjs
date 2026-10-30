/** Visual/layout contract from the approved version-8 design. API writes below are intercepted in browser memory. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const base = process.env.DASH_QA_URL || "http://127.0.0.1:8090";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const layouts = {
  "/minecraft": [
    "Server console",
    "Quick commands",
    "Mods & plugins",
    "Update hub",
    "World backups",
    "Server settings",
  ],
  "/jellyfin": ["Downloads", "Media files", "Media settings"],
  "/files": [
    "Directus",
    "Workspace files",
    "Uploads & database records",
    "APIs & website connections",
  ],
  "/network": [
    "Hostnames",
    "Homelab tunnel",
    "VPN connection",
    "Tailscale",
    "Router",
  ],
  "/automation": [
    "Scheduled jobs",
    "Update hub",
    "Maintenance scripts",
    "Activity",
  ],
  "/access": ["Users", "Connections"],
  "/terminal": ["Sessions"],
  "/": ["CPU & memory", "Drive storage", "Recent activity", "Scheduled jobs"],
  "/business": ["Business storage", "Workspace actions"],
  "/business/crm": ["Twenty CRM"],
  "/business/ai": ["AI workspace"],
  "/business/files": [
    "Directus",
    "Workspace files",
    "Uploads & database records",
    "APIs & website connections",
  ],
  "/business/network": [
    "Hostnames",
    "Homelab tunnel",
    "VPN connection",
    "Tailscale",
    "Router",
  ],
  "/business/automation": [
    "Scheduled jobs",
    "Update hub",
    "Maintenance scripts",
    "Activity",
  ],
  "/business/access": ["Users", "Connections"],
  "/business/terminal": ["Sessions"],
};
async function go(path) {
  await page.goto(base + path);
  await page.locator("main h1").waitFor();
}
try {
  for (const [path, panels] of Object.entries(layouts)) {
    await go(path);
    assert.deepEqual(
      await page.locator("main .panel-title").allTextContents(),
      panels,
      path,
    );
    assert.equal(
      await page.locator("main .card").count(),
      0,
      `Old page cards must not return to ${path}`,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `${path} desktop overflow`,
    );
  }
  await go("/");
  await page
    .getByRole("button", { name: "Choose workspace", exact: true })
    .click();
  await page
    .locator(".workspace-option")
    .filter({ hasText: "xGold AI" })
    .click();
  await page.waitForURL("**/business");
  await page
    .getByRole("button", { name: "Search pages and services", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search pages", exact: true })
    .fill("Minecraft");
  await page
    .locator(".search-results a")
    .filter({ hasText: "Minecraft" })
    .click();
  await page.waitForURL("**/minecraft");
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.getByText("Player activity", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await go("/files");
  await page
    .getByRole("button", { name: "Connection settings", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Email", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Upload database", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await go("/business/files");
  await page
    .getByRole("combobox", { name: "Upload database", exact: true })
    .locator('option[value="ai"]')
    .waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByRole("combobox", { name: "Upload database", exact: true })
      .inputValue(),
    "ai",
    "Business uploads must default to the actual AI database",
  );
  await go("/automation");
  await page
    .getByRole("button", { name: "New automation", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Name", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Follow repository", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "GitHub owner/repository", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  for (const width of [850, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of Object.keys(layouts)) {
      await go(path);
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${path} overflow at ${width}`,
      );
    }
    if (width <= 680)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await page
      .locator("nav")
      .getByRole("link", { name: "Access", exact: true })
      .click();
    await page.waitForURL("**/business/access");
  }
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Switch color theme", exact: true })
    .click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.equal(
    await page
      .locator(".dash-design")
      .evaluate((e) => getComputedStyle(e).getPropertyValue("--bg").trim()),
    "#17201c",
  );
  // A separate desktop context exercises real UI request payloads against in-memory responses only.
  const fixture = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    writes = [];
  await fixture.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET") {
      const body = request.postDataJSON();
      writes.push({ path: url.pathname, method: request.method(), body });
      await route.fulfill({
        json: url.pathname.endsWith("/minecraft/command")
          ? { output: "Command completed in isolated browser test" }
          : {
              ok: true,
              stdout: "isolated-output",
              stderr: "",
              code: 0,
              timedOut: false,
              truncated: false,
            },
      });
      return;
    }
    if (url.pathname === "/api/minecraft") {
      await route.fulfill({
        json: {
          unit: { active: "active", sub: "running" },
          ping: { version: "isolated test", online: 0, max: 20, sample: [] },
          players: { online: 0, max: 20, names: [] },
          rcon: { ok: true },
          address: "isolated",
        },
      });
      return;
    }
    await route.continue();
  });
  await fixture.goto(base + "/minecraft");
  await fixture
    .getByRole("textbox", { name: "Minecraft command", exact: true })
    .fill("list");
  await fixture.getByRole("button", { name: "Send", exact: true }).click();
  await fixture.getByRole("button", { name: "Confirm", exact: true }).click();
  await fixture
    .getByText("Command completed in isolated browser test", { exact: true })
    .waitFor();
  assert.deepEqual(writes[0], {
    path: "/api/minecraft/command",
    method: "POST",
    body: { command: "list" },
  });
  await fixture
    .getByRole("button", { name: "Set time to day", exact: true })
    .click();
  await fixture.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(writes.length, 1, "Cancelled commands never reach the API");
  await fixture.goto(base + "/terminal");
  await fixture
    .getByRole("textbox", { name: "Terminal command", exact: true })
    .fill("pwd");
  await fixture.getByRole("button", { name: "Run ↵", exact: true }).click();
  await fixture.getByRole("button", { name: "Confirm", exact: true }).click();
  await fixture.getByText("isolated-output", { exact: true }).waitFor();
  assert.equal(writes.at(-1).path, "/api/terminal/execute");
  assert.equal(writes.at(-1).body.command, "pwd");
  await fixture.close();
  // Upload files opens a chooser directly; Files opens the library without one.
  const uploadPage = await browser.newPage();
  let uploadRequest = null;
  await uploadPage.route("**/api/database/files/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/targets")) {
      await route.fulfill({ json: [
        { id: "personal", label: "Personal database", enabled: true },
        { id: "ai", label: "ai", enabled: true },
      ] });
    } else if (request.method() === "POST") {
      uploadRequest = { pathname, type: request.headers()["content-type"], body: request.postData() };
      await route.fulfill({ status: 201, json: { id: "isolated-upload" } });
    } else {
      await route.fulfill({ json: [] });
    }
  });
  await uploadPage.goto(base + "/business/files");
  const directusPanel = uploadPage.locator(".panel").filter({
    has: uploadPage.locator(".panel-title", { hasText: /^Directus$/ }),
  });
  const chooserReady = uploadPage.waitForEvent("filechooser");
  await directusPanel.getByRole("button", { name: "Upload files", exact: true }).click();
  const chooser = await chooserReady;
  await chooser.setFiles({ name: "isolated-upload.txt", mimeType: "text/plain", buffer: Buffer.from("upload-check") });
  await uploadPage.getByText("Uploaded 1 files", { exact: true }).waitFor();
  assert.equal(uploadRequest.pathname, "/api/database/files/ai");
  assert.match(uploadRequest.type, /^multipart\/form-data;/);
  assert.match(uploadRequest.body, /isolated-upload.txt/);
  assert.match(uploadRequest.body, /upload-check/);
  await uploadPage.getByRole("button", { name: "Close", exact: true }).click();
  let unexpectedPicker = false;
  uploadPage.on("filechooser", () => { unexpectedPicker = true; });
  await directusPanel.getByRole("button", { name: "Files", exact: true }).click();
  await uploadPage.getByRole("dialog").waitFor();
  await uploadPage.waitForTimeout(100);
  assert.equal(unexpectedPicker, false, "Browsing files must not open an upload chooser");
  await uploadPage.close();
  assert.deepEqual(errors, []);
  console.log(
    "Design browser QA: all 16 layouts match the approved panel order; no old page cards; desktop, 850px and 390px layouts, workspace switching, search, reports, connection/file/job/repository dialogs, business database default, dark theme, exact command payloads and cancellation passed. No production API writes performed.",
  );
} finally {
  await browser.close();
}
