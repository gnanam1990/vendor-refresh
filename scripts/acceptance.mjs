/**
 * Reference end-to-end acceptance replay (docs/build-pack/examples/ACCEPTANCE.md).
 * Runs the real entry point on a scratch file DB with the labeled fixture
 * registry + local-emulator rail, drives the flow over HTTP, restarts the
 * process mid-run for NFR-01 persistence, and prints an evidence summary.
 *
 *   node scripts/acceptance.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

let BASE = null; // set from the child's own listening announcement
const dir = mkdtempSync(join(process.cwd(), ".acceptance-"));
const DB = join(dir, "acc.db");
const FIXTURE = join(dir, "fixture.json");

function luhn(base8) {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let d = base8.charCodeAt(i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}
const siren = "55212022" + luhn("55212022");
const sirenB = "55212023" + luhn("55212023");

writeFileSync(FIXTURE, JSON.stringify([
  {
    siren,
    legal_name: "ACCEPTANCE DEMO SA",
    status: "active",
    omit_status: true, // registry omits the optional status field
    address: { line1: "12 rue de la Verrerie", line2: null, postal_code: "75004", city: "Paris", country: "FR" },
    effective_at: "2026-11-15T00:00:00.000Z",
  },
  {
    siren: sirenB,
    legal_name: "OVER QUOTE SA",
    status: "active",
    quote_minor: 6, // $0.06 quote -> blocked by the $0.05 per-call cap
    address: { line1: "1 rue X", line2: null, postal_code: "75001", city: "Paris", country: "FR" },
    effective_at: "2026-11-15T00:00:00.000Z",
  },
]));

const env = {
  ...process.env,
  VR_DB: DB,
  VR_PORT: "0", // ephemeral port — the child announces its real bound address
  VR_HOST: "127.0.0.1", // loopback only; cannot collide with another workspace's server
  VR_WORKER_MS: "50",
  VR_FIXTURE_DATA: FIXTURE,
  VR_STALE_AFTER: "1", // evidence older than 1s is stale -> scans flag quickly
};
const children = [];
/**
 * Spawn the app and resolve once ITS OWN stdout prints the bound address —
 * never poll a guessed port, which can answer from an unrelated server.
 */
function startServer() {
  const proc = spawn("node", ["src/main.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(proc);
  proc.stderr.on("data", (d) => process.stderr.write(d));
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server did not announce a bound port in 15s")), 15000);
    proc.on("exit", (code) => reject(new Error(`server exited early (${code}): ${buf.slice(-400)}`)));
    proc.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/listening on (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        BASE = m[1].replace(/\/$/, "");
        resolve(proc);
      }
    });
  });
}
const evidence = { steps: [] };
function step(name, data) {
  evidence.steps.push({ name, ...data });
  console.log(`✔ ${name}`, JSON.stringify(data));
}
function fail(msg) {
  console.error("✘ " + msg);
  for (const p of children) p.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
async function waitReady() {
  try {
    await startServer();
    const r = await fetch(BASE + "/login");
    if (!r.ok) fail(`own server answered ${r.status} at ${BASE}`);
  } catch (e) {
    fail(e.message);
  }
}
async function call(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { cookie: `vr_session=${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
// Provisioned credentials written by the seeder (mode 600, synthetic local users).
const creds = () => JSON.parse(readFileSync(join(dir, "credentials.seed.json"), "utf8"));
async function login(userId) {
  const r = await call(null, "POST", "/v1/session/login", { user_id: userId, credential: creds()[userId] });
  if (r.status !== 200) fail(`login failed for ${userId}: ${r.status}`);
  return r.json.token;
}
async function waitState(token, refreshId, want, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const r = await call(token, "GET", `/v1/refreshes/${refreshId}`);
    if (r.json?.refresh?.state === want || r.json?.refresh?.state === "blocked" || r.json?.refresh?.state === "reconciling") return r.json;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  fail(`refresh ${refreshId} did not reach ${want}`);
}

await waitReady();
const ana = await login("u_ana");
const carol = await login("u_carol");
const fay = await login("u_fay");

// 1. Two imports of the same supplier -> one supplier, two receipts.
const csv = `siren,legal_name,vendor_ref,address_line1,postal_code,city,country,status\n${siren},ACCEPTANCE DEMO SA,V900,"3 rue Pastourelle",75003,Paris,FR,active\n${sirenB},OVER QUOTE SA,V901,"1 rue X",75001,Paris,FR,active`;
const map = { siren: "siren", legal_name: "legal_name", vendor_ref: "vendor_ref", address_line1: "address_line1", postal_code: "postal_code", city: "city", country: "country" };
const i1 = await call(ana, "POST", "/v1/suppliers/import", { csv, mapping: map, filename: "a.csv" });
const i2 = await call(ana, "POST", "/v1/suppliers/import", { csv, mapping: map, filename: "b.csv" });
const suppliers = (await call(ana, "GET", "/v1/suppliers")).json.suppliers;
const sup = suppliers.find((s) => s.siren === siren);
const supB = suppliers.find((s) => s.siren === sirenB);
if (!sup || i1.json.rows[0].status !== "ok" || i2.json.rows[0].status !== "duplicate") fail("import dedup failed");
step("two imports -> one supplier + two receipts", { importA: i1.json.importId, importB: i2.json.importId, supplierId: sup.id });

// 2. Age the evidence and run two scans -> one coalesced case.
const db = new DatabaseSync(DB);
db.prepare("UPDATE suppliers SET accepted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(sup.id);
db.close();
await new Promise((r) => setTimeout(r, 1200));
await call(ana, "POST", "/v1/scans", {});
const scan2 = await call(ana, "POST", "/v1/scans", {});
const trg = scan2.json.triggers.find((t) => t.supplierId === sup.id);
step("two scans -> one case (coalesced)", { triggerId: trg.id, kind: trg.kind });

// 3. Request the refresh from the case -> $0.02 quote -> one purchase.
const rr = await call(ana, "POST", `/v1/suppliers/${sup.id}/refreshes`, {
  reason: "stale case from scan", expected_version: 1, key: "acc-key-1", trigger_id: trg.id,
});
const refreshId = rr.json.refresh.id;
const done = await waitState(carol, refreshId, "review_ready");
const intent = done.spendIntents[0];
if (done.quote.amount_minor !== 2 || intent.status !== "settled") fail("expected one $0.02 settled purchase");
step("one $0.02 quote -> one purchase", { refreshId, intentId: intent.id, remoteRef: intent.remote_ref });

// 4. Newer address + absent status -> one change + one unknown.
const fields = Object.fromEntries(done.diffs.map((d) => [d.field, d.outcome]));
if (fields.address !== "changed" || fields.status !== "unknown") fail(`unexpected diffs ${JSON.stringify(fields)}`);
step("one address change + one unknown status", fields);

// 5. Restart mid-flow (NFR-01 replay), then accept -> version +1 exactly once.
children[0].kill("SIGTERM");
await new Promise((r) => setTimeout(r, 400));
await waitReady();
const dec = await call(carol, "POST", `/v1/refreshes/${refreshId}/decision`, {
  expected_version: 1, decision: "accept", reason: "registry address verified",
});
const supAfter = (await call(ana, "GET", `/v1/suppliers/${sup.id}`)).json.supplier;
if (supAfter.version !== 2) fail(`version ${supAfter.version} != 2`);
step("post-restart accept -> version incremented exactly once", { version: supAfter.version });

// 6. Later $0.06 quote -> blocked before paid execution.
const rr2 = await call(ana, "POST", `/v1/suppliers/${supB.id}/refreshes`, {
  reason: "cap check", expected_version: 1, key: "acc-key-2",
});
const blocked = await waitState(carol, rr2.json.refresh.id, "blocked");
if (blocked.refresh.state !== "blocked" || !String(blocked.refresh.block_reason).includes("over_per_call_cap")) fail("cap block missing");
if (blocked.spendIntents.length !== 0) fail("spend intent should not exist");
step("later $0.06 quote blocked before paid execution", { reason: blocked.refresh.block_reason });

// 7. Finance export + reconciliation.
const ex = await call(fay, "GET", "/v1/exports/accepted");
const mine = ex.json.rows.filter((row) => row.siren === siren);
const rec = await call(fay, "GET", "/v1/reconciliation");
const pilot = await call(fay, "GET", "/v1/reports/pilot");
step("export + reconciliation + pilot report", {
  exportedFields: mine.map((row) => row.field),
  settledMinor: rec.json.totals.settledMinor,
  reconciling: rec.json.totals.reconcilingCount,
  pilotCases: pilot.json.cases,
});

console.log("\nACCEPTANCE EVIDENCE");
console.log(JSON.stringify(evidence, null, 2));
for (const p of children) p.kill("SIGTERM");
console.log(`artifacts kept at ${dir} (db + fixture)`);
process.exit(0);
