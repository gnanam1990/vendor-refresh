import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, listen, api, loginAs, type TestEnv } from "./helpers.ts";
import { openDb } from "../src/db.ts";
import { seed, seedCredential } from "../src/seed.ts";
import { verifyCredential, login } from "../src/auth.ts";

let env: TestEnv;
before(async () => {
  env = await listen(makeEnv());
});
after(() => env.cleanup());

test("T-015a: session is minted only after the provisioned credential verifies", async () => {
  const bad = await api(env, null, "POST", "/v1/session/login", { user_id: "u_ana", credential: "wrong" });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, "unauthorized");

  const missing = await api(env, null, "POST", "/v1/session/login", { user_id: "u_ana" });
  assert.equal(missing.status, 401);

  const token = await loginAs(env, "u_ana");
  const me = await api(env, token, "GET", "/v1/me");
  assert.equal(me.json.actor.id, "u_ana");
  assert.equal(me.json.actor.role, "ap_analyst");
});

test("T-015b: actor role comes from stored enrollment, not client claims", async () => {
  const r = await api(env, null, "POST", "/v1/session/login", {
    user_id: "u_ana",
    credential: seedCredential("u_ana"),
    role: "ap_approver", // ignored — authority is enrolled server-side
    tenant_id: "t_other",
  });
  assert.equal(r.status, 200);
  const me = await api(env, r.json.token, "GET", "/v1/me");
  assert.equal(me.json.actor.role, "ap_analyst");
  assert.equal(me.json.actor.tenantId, "t_acme");

  // The enrolled analyst still cannot spend-decide — authorization regresses only via enrollment.
  const dec = await api(env, r.json.token, "POST", "/v1/refreshes/r_x/decision", {
    expected_version: 1, decision: "accept",
  });
  assert.equal(dec.status, 403);
});

test("T-015c: dev-login shortcut is gated behind VR_DEV_LOGIN=1", async () => {
  const off = await api(env, null, "POST", "/v1/session/dev-login", { user_id: "u_ana" });
  assert.equal(off.status, 400);
  assert.equal(off.json.error.code, "dev_login_disabled");

  // Opted-in fixture run: same request succeeds when the flag is explicitly set.
  process.env.VR_DEV_LOGIN = "1";
  try {
    const on = await api(env, null, "POST", "/v1/session/dev-login", { user_id: "u_ana" });
    assert.equal(on.status, 200);
    assert.ok(on.json.token);
  } finally {
    delete process.env.VR_DEV_LOGIN;
  }
});

test("T-015d: credentials are stored as salted scrypt hashes, never plaintext", () => {
  const db = openDb(":memory:");
  seed(db);
  const row = db.prepare("SELECT credential_hash, credential_salt FROM users WHERE id='u_ana'").get() as any;
  assert.ok(row.credential_hash && row.credential_salt);
  assert.ok(!String(row.credential_hash).includes("localdev"));
  assert.notEqual(row.credential_hash, seedCredential("u_ana"));
  assert.equal(verifyCredential(db, "u_ana", seedCredential("u_ana")), true);
  assert.equal(verifyCredential(db, "u_ana", "localdev-u_ben"), false);
  assert.throws(() => login(db, "u_ana", ""), /invalid user or credential/);
  db.close();
});

test("T-015e: login page enforces credentials; dev picklist only renders when opted in", async () => {
  const pageRes = await fetch(env.base + "/login");
  const html = await pageRes.text();
  assert.match(html, /type="password"/);
  assert.ok(!html.includes("dev_login"), "dev picklist must not render by default");

  const bad = await fetch(env.base + "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_id: "u_ana", credential: "nope" }).toString(),
    redirect: "manual",
  });
  const badHtml = await bad.text();
  assert.equal(bad.status, 401);
  assert.match(badHtml, /role="alert"/);

  // Real credential form post -> 302 to inbox with a session cookie.
  const good = await fetch(env.base + "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_id: "u_carol", credential: seedCredential("u_carol") }).toString(),
    redirect: "manual",
  });
  assert.equal(good.status, 303);
  assert.match(good.headers.get("set-cookie") ?? "", /vr_session=/);
});
