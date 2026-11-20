/**
 * Normal-browser verification of the documented AP journey.
 *
 * Launches a real Chromium (default: the verified macOS Playwright-cache
 * headless shell; override with VR_CHROME) on an ephemeral port against a
 * disposable DB + browser profile, and drives the review-and-decide
 * journey through actual page loads, form posts and keyboard input — not
 * the API. Writes a short redacted evidence record plus screenshots to
 * build-progress/vendor-refresh/evidence/browser/.
 *
 *   node scripts/browser-check.mjs
 *
 * Env:
 *   VR_CHROME   path to a Chromium-family executable (headless shell or
 *               full Chrome/Chromium/Edge). Default: newest
 *               chromium_headless_shell-* in the Playwright cache,
 *               else `chrome`/`chromium` on PATH.
 *   VR_KEEP=1   keep the disposable workdir for debugging.
 *
 * Provider/rail are the labeled fixture registry + local emulator; no
 * paid or external call is made. The credential file produced by seeding
 * stays inside the disposable dir and is removed unless VR_KEEP=1.
 */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const REPO = fileURLToPath(new URL("..", import.meta.url)); // decodes %20 etc. for paths with spaces
const EVIDENCE = join(REPO, "build-progress", "vendor-refresh", "evidence", "browser");
const KEEP = process.env.VR_KEEP === "1";

const work = mkdtempSync(join(REPO, ".browser-"));
const DB = join(work, "browser.db");
const PROFILE = join(work, "profile");
const FIXTURE = join(work, "fixture.json");

function luhn(base8) {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let d = base8.charCodeAt(i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}
const siren = "55212040" + luhn("55212040");
writeFileSync(FIXTURE, JSON.stringify([{
  siren,
  legal_name: "BROWSER DEMO SAS",
  omit_status: true, // registry omits the optional status field -> unknown
  address: { line1: "12 rue de la Verrerie", line2: null, postal_code: "75004", city: "Paris", country: "FR" },
  effective_at: "2026-11-15T00:00:00.000Z",
}]));

const evidence = { browser: null, steps: [], assertions: 0 };
const fail = (msg) => { throw new Error(msg); };
function step(name, data = {}) {
  evidence.steps.push({ name, ...data });
  console.log(`ok - ${name}${Object.keys(data).length ? " " + JSON.stringify(data) : ""}`);
}
function check(cond, label) {
  evidence.assertions++;
  if (!cond) fail(`assertion failed: ${label}`);
}

// --- browser binary resolution ------------------------------------------------
function chromePath() {
  if (process.env.VR_CHROME) return process.env.VR_CHROME;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  try {
    const dirs = readdirSync(cache)
      .filter((d) => /^chromium_headless_shell-\d+$/.test(d))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const candidate of [
        join(cache, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
        join(cache, d, "chrome-headless-shell-mac-x64/chrome-headless-shell"),
        join(cache, d, "chrome-headless-shell-linux/chrome-headless-shell"),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {}
  for (const name of ["chrome-headless-shell", "google-chrome", "chromium", "chrome"]) {
    try { return execSync(`command -v ${name}`).toString().trim(); } catch {}
  }
  fail("no Chromium executable found; set VR_CHROME=/path/to/chrome");
}
const CHROME = chromePath();
evidence.browser = CHROME;
console.log("browser:", CHROME);

// --- ephemeral app port --------------------------------------------------------
const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});
const BASE = `http://localhost:${port}`;

// --- app server (real entry point, disposable data) -----------------------------
const app = spawn("node", ["src/main.ts"], {
  cwd: REPO,
  env: { ...process.env, VR_DB: DB, VR_PORT: String(port), VR_WORKER_MS: "50", VR_FIXTURE_DATA: FIXTURE },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stderr.on("data", (d) => process.stderr.write(d));
async function waitApp() {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(BASE + "/login")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  fail("app did not start");
}

// --- minimal CDP client over the built-in WebSocket -----------------------------
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    const c = new CDP(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      // Responses resolve with the unwrapped `result`; protocol errors reject.
      if (!m.id) return; // event — ignored
      const p = c.pending.get(m.id);
      if (!p) return;
      c.pending.delete(m.id);
      if (m.error) p.rej(new Error(`CDP ${m.error.code}: ${m.error.message}`));
      else p.res(m.result);
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

// launch the shell; DevToolsActivePort tells us the debugging port
const chrome = spawn(CHROME, [
  `--remote-debugging-port=0`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run",
  "--disable-gpu",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.on("data", () => {}); // shell logs are noisy; keep for VR_KEEP debugging via file
async function waitChrome() {
  const f = join(PROFILE, "DevToolsActivePort");
  for (let i = 0; i < 200; i++) {
    try {
      const [p, ws] = readFileSync(f, "utf8").split("\n");
      if (p && ws) return { port: Number(p), wsPath: ws.trim() };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  fail("chrome did not expose DevToolsActivePort");
}

const { port: cdpPort } = await waitChrome().catch((e) => {
  evidence.launch_error = String(e.message ?? e);
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, "evidence.json"), JSON.stringify({ generated_at: new Date().toISOString(), ...evidence }, null, 2));
  chrome.kill("SIGKILL");
  app.kill("SIGTERM");
  throw e;
});
const ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
const b = await CDP.connect(ver.webSocketDebuggerUrl);
const { targetId } = await b.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
const page = {
  send: (m, p = {}) => b.send(m, p, sessionId),
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) fail("page eval error: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r?.result?.value;
  },
  // Readiness polls must tolerate transient errors — during a navigation the
  // old execution context is destroyed and Runtime.evaluate can protocol-error
  // for a moment. evalSafe swallows that; assertive checks use eval.
  async evalSafe(expr) { try { return await this.eval(expr); } catch { return undefined; } },
  async goto(url, { until = null, tries = 80 } = {}) {
    await this.send("Page.navigate", { url });
    for (let i = 0; i < tries; i++) {
      const ready = await this.evalSafe("document.readyState");
      if (ready === "complete" && (!until || (await this.evalSafe(until)))) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    fail(`navigation to ${url} did not settle (${until ?? "load"})`);
  },
  async reload(until) { await this.send("Page.reload", {}); if (until) { for (let i = 0; i < 60; i++) { if (await this.evalSafe(until)) return; await new Promise((r) => setTimeout(r, 150)); } fail("reload did not settle"); } },
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(EVIDENCE, file), Buffer.from(r.data, "base64"));
    return file;
  },
  async key(type, opts = {}) {
    await this.send("Input.dispatchKeyEvent", { type, windowsVirtualKeyCode: opts.code ?? 0, key: opts.key ?? "", ...opts });
  },
  async tab() {
    await this.key("rawKeyDown", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await this.key("keyUp", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await new Promise((r) => setTimeout(r, 60));
  },
  async enter() {
    await this.key("rawKeyDown", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await this.key("char", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await this.key("keyUp", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  },
  async type(text) { await this.send("Input.insertText", { text }); },
  async active() {
    const s = await this.evalSafe("JSON.stringify({tag:document.activeElement.tagName,id:document.activeElement.id,type:document.activeElement.type||'',text:(document.activeElement.innerText||document.activeElement.value||'').slice(0,60)})");
    return s ? JSON.parse(s) : { tag: "", id: "", type: "", text: "" };
  },
};

try {
  await waitApp();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  mkdirSync(EVIDENCE, { recursive: true });

  const waitPath = async (re, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      const p = await page.evalSafe(`location.pathname`);
      if (typeof p === "string" && re.test(p)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    fail(`path did not match ${re}`);
  };

  // 1 — Real credential login through the sign-in page (analyst).
  await page.goto(`${BASE}/login`, { until: `!!document.getElementById("cred")` });
  check(await page.eval(`!!document.querySelector('input[type=password]')`), "login page has a credential field");
  check(!(await page.eval(`document.body.innerHTML.includes("dev_login")`)), "no dev-login picklist without VR_DEV_LOGIN=1");
  const creds = JSON.parse(readFileSync(join(work, "credentials.seed.json"), "utf8"));
  await page.eval(`document.getElementById("uid").value = "u_ana"; document.getElementById("cred").focus()`);
  await page.type(creds.u_ana);
  await page.enter(); // implicit form submission with Enter
  await waitPath(/^\/inbox/);
  check(await page.eval(`document.body.innerText.includes("Ana Analyst")`), "signed in as the analyst");
  step("authenticated sign-in (credential form)");

  // 2 — Import the vendor master via the UI (preview -> commit).
  await page.goto(`${BASE}/imports/new`, { until: `!!document.querySelector("textarea")` });
  await page.eval(`document.querySelector("form[action='/imports/preview'] textarea").value = ${JSON.stringify(`siren,legal_name,vendor_ref,address_line1,postal_code,city,country,status\n${siren},BROWSER DEMO SAS,V700,"3 rue Pastourelle",75003,Paris,FR,active`)}`);
  await page.eval(`document.querySelector("form[action='/imports/preview']").requestSubmit()`);
  await page.eval(`new Promise(r=>setTimeout(r,400))`);
  check(await page.eval(`!!document.querySelector("form[action='/imports/commit']")`), "import preview rendered with mapping");
  await page.eval(`document.querySelector("form[action='/imports/commit']").requestSubmit()`);
  await page.eval(`new Promise(r=>setTimeout(r,400))`);
  check(await page.eval(`document.body.innerText.includes("Import complete")`), "import committed");
  step("vendor master imported through the UI");

  // 3 — Age evidence + run the freshness scan from the inbox.
  const dbw = new DatabaseSync(DB);
  dbw.prepare("UPDATE suppliers SET accepted_at='2026-01-01T00:00:00.000Z'").run();
  dbw.close();
  await page.goto(`${BASE}/inbox`, { until: `!!document.querySelector("form[action='/scan']")` });
  await page.eval(`document.querySelector("form[action='/scan']").requestSubmit()`);
  await new Promise((r) => setTimeout(r, 400));
  await page.goto(`${BASE}/inbox`, { until: `document.body.innerText.includes("BROWSER DEMO")` });
  check(await page.eval(`document.body.innerText.includes("stale")`), "inbox shows the stale case");
  step("inbox lists the coalesced stale case");

  // 4 — Open supplier, request a refresh, watch it reach review_ready.
  const supHref = await page.eval(`document.querySelector("a[href^='/suppliers/']").getAttribute("href")`);
  await page.goto(`${BASE}${supHref}`, { until: `!!document.querySelector("form[action$='/refreshes']")` });
  await page.eval(`document.querySelector("input[name='reason']").value="stale registry evidence"; document.querySelector("form[action$='/refreshes']").requestSubmit()`);
  await waitPath(/^\/refreshes\//);
  const refreshUrl = await page.eval(`location.pathname`);
  for (let i = 0; i < 80; i++) {
    await page.goto(`${BASE}${refreshUrl}`);
    if (await page.eval(`document.body.innerText.includes("review_ready")`)) break;
    await new Promise((r) => setTimeout(r, 200));
    if (i === 79) fail("refresh never reached review_ready");
  }
  step("refresh reached review_ready");

  // 5 — Switch actors: sign out, sign in as the approver through the UI.
  await page.eval(`document.querySelector("form[action='/logout']").requestSubmit()`);
  await waitPath(/^\/login/);
  await page.goto(`${BASE}/login`, { until: `!!document.getElementById("cred")` });
  await page.eval(`document.getElementById("uid").value = "u_carol"; document.getElementById("cred").focus()`);
  await page.type(creds.u_carol);
  await page.enter();
  await waitPath(/^\/inbox/);
  await page.goto(`${BASE}${refreshUrl}`, { until: `document.body.innerText.includes("Field differences")` });
  check(await page.eval(`document.body.innerText.includes("Carol Approver")`), "second authorized session as approver");
  step("approver session via credential login");

  // 6 — Verify the proposed difference in the real UI.
  const diffText = await page.eval(`document.body.innerText`);
  check(diffText.includes("12 rue de la Verrerie"), "observed address rendered");
  check(diffText.includes("3 rue Pastourelle"), "accepted address rendered");
  check(/status[\s\S]{0,400}unknown/.test(diffText) || diffText.includes("not present at source"), "unknown field rendered");
  check(diffText.includes("Field differences"), "diff table present");
  await page.shot("01-desktop-review.png");
  step("review page renders changed address + unknown field", { viewport: "1280x900" });

  // a11y spot checks
  check(await page.eval(`document.documentElement.lang === "en"`), "html lang set");
  check(await page.eval(`!!document.querySelector('label[for="dreason"]')`), "reason input labelled");
  check(await page.eval(`document.querySelectorAll("button").length > 0`), "native buttons used");

  // 7 — Keyboard-only decision: Tab into the form, type reason, Enter to accept.
  await page.eval(`document.body.focus()`);
  let focused = null;
  for (let i = 0; i < 25; i++) {
    await page.tab();
    focused = await page.active();
    if (focused.id === "dreason") break;
    if (i === 24) fail("could not reach the reason field by Tab");
  }
  check((await page.eval(`getComputedStyle(document.activeElement).outlineStyle`)) !== "none", "visible focus indicator");
  await page.type("registry address verified in browser check");
  for (let i = 0; i < 4; i++) {
    await page.tab();
    focused = await page.active();
    if (focused.tag === "BUTTON" && /Accept/.test(focused.text)) break;
    if (i === 3) fail("could not reach Accept button by Tab");
  }
  step("keyboard traversal reaches reason + Accept with visible focus", { focused: focused.text });
  await page.enter(); // Enter on the focused Accept button submits the form
  await waitPath(/^\/refreshes\//);

  // 8 — Reload and verify the recorded decision persisted (server-rendered).
  await page.reload(`document.body.innerText.includes("Recorded decision")`);
  const after = await page.eval(`document.body.innerText`);
  check(after.includes("Recorded decision"), "recorded decision rendered after reload");
  check(/accepted/.test(after), "accepted state rendered");
  check(after.includes("Carol Approver"), "deciding actor recorded");
  const sup = await page.goto(`${BASE}${supHref}`, { until: `document.body.innerText.includes("version")` }).then(() => page.eval(`document.body.innerText`));
  check(sup.includes("version 2"), "supplier version incremented exactly once");
  await page.shot("02-desktop-accepted.png");
  step("decision persisted through reload + version bumped");

  // 8b — Stale/invalid operation: approver posts a conflicting decision on
  // the already-decided revision -> 409 renders the HTML error page.
  // (An identical replay of the same decision is intentionally idempotent.)
  const conflict = await page.eval(`fetch("${BASE}${refreshUrl}/decision", {method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"expected_version=1&decision=dismiss&reason=changed+mind"}).then(async r=>({s:r.status,t:await r.text()}))`);
  check(conflict.s === 409, `stale decision returns 409 (got ${conflict.s})`);
  check(/Cannot complete this action/.test(conflict.t), "conflict renders operator error page");
  step("stale decision rejected with visible conflict page", { status: conflict.s });

  // 9 — 320px viewport: same task usable, no horizontal overflow.
  await page.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
  await page.goto(`${BASE}${refreshUrl}`, { until: `document.body.innerText.includes("Recorded decision")` });
  const sw = await page.eval(`document.documentElement.scrollWidth`);
  check(sw <= 321, `no horizontal overflow at 320px (scrollWidth=${sw})`);
  check(await page.eval(`document.body.innerText.includes("Recorded decision")`), "decision record reachable at 320px");
  await page.shot("03-mobile-320.png");
  step("320 CSS px: readable, no overflow", { scrollWidth: sw });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // 10 — Permission + error visibility.
  await page.eval(`document.querySelector("form[action='/logout']").requestSubmit()`);
  await waitPath(/^\/login/);
  await page.goto(`${BASE}/login`, { until: `!!document.getElementById("cred")` });
  await page.eval(`document.getElementById("uid").value = "u_ana"; document.getElementById("cred").focus()`);
  await page.type(creds.u_ana);
  await page.enter();
  await waitPath(/^\/inbox/);
  await page.goto(`${BASE}${refreshUrl}`, { until: `document.body.innerText.includes("Recorded decision")` });
  check(await page.eval(`document.body.innerText.includes("Recorded decision")`), "analyst can read the decided case");
  check(!(await page.eval(`!!document.querySelector("form[action$='/decision']")`)), "no decision form for analyst");
  const denied = await page.eval(`fetch("${BASE}${refreshUrl}/decision", {method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"expected_version=1&decision=dismiss&reason=x"}).then(async r=>({s:r.status,t:await r.text()}))`);
  check(denied.s === 403, `denied decision returns 403 (got ${denied.s})`);
  check(/Cannot complete this action/.test(denied.t), "HTML error page renders the denial");
  step("permission + error surfaces verified", { deniedStatus: denied.s });

  console.log(`\nBROWSER CHECK PASSED — ${evidence.assertions} assertions, ${evidence.steps.length} steps`);
} finally {
  chrome.kill("SIGKILL");
  app.kill("SIGTERM");
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, "evidence.json"), JSON.stringify({ generated_at: new Date().toISOString(), ...evidence }, null, 2));
  if (KEEP) console.log(`workdir kept: ${work}`); else rmSync(work, { recursive: true, force: true });
}
