const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, post } = require("./helpers.js");

const SECRET = "secret-secret-secret";
const CODE = "test-enrollment-secret";
const enroll = (app, body) => post(app.baseUrl, "/api/enroll", body);

test("enroll with the shared code creates an account", async () => {
  const app = await startApp();
  try {
    const r = await enroll(app, { accountId: "newaccount000000001", accountSecret: SECRET, enrollmentCode: CODE });
    assert.equal(r.status, 200);
    assert.equal(r.json.created, true);
    assert.ok(r.json.token);
    assert.equal(app.stmts.getAccount.get("newaccount000000001").account_id, "newaccount000000001");
  } finally { await app.close(); }
});

test("re-enrolling the same account is idempotent (created:false)", async () => {
  const app = await startApp();
  try {
    const body = { accountId: "reenrollaccount0001", accountSecret: SECRET, enrollmentCode: CODE };
    await enroll(app, body);
    const r = await enroll(app, body);
    assert.equal(r.status, 200);
    assert.equal(r.json.created, false);
    assert.ok(r.json.token);
  } finally { await app.close(); }
});

test("re-enrolling with a different secret => 409", async () => {
  const app = await startApp();
  try {
    await enroll(app, { accountId: "secretclashacct0001", accountSecret: SECRET, enrollmentCode: CODE });
    const r = await enroll(app, { accountId: "secretclashacct0001", accountSecret: "different-secret-xx", enrollmentCode: CODE });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "Account exists with a different secret");
  } finally { await app.close(); }
});

test("missing enrollment code => 403, no account created", async () => {
  const app = await startApp();
  try {
    const r = await enroll(app, { accountId: "nocodeaccount000001", accountSecret: SECRET });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "Invalid enrollment code");
    assert.equal(app.stmts.getAccount.get("nocodeaccount000001"), undefined);
  } finally { await app.close(); }
});

// The subscription build accepted a license key here; this one must not treat any
// other credential-shaped field as a way in.
test("a licenseKey field is not an alternative way to enroll => 403", async () => {
  const app = await startApp();
  try {
    const r = await enroll(app, { accountId: "licensekeyacct00001", accountSecret: SECRET, licenseKey: "LK-1" });
    assert.equal(r.status, 403);
    assert.equal(app.stmts.getAccount.get("licensekeyacct00001"), undefined);
  } finally { await app.close(); }
});

test("malformed account id => 400", async () => {
  const app = await startApp();
  try {
    const r = await enroll(app, { accountId: "short", accountSecret: SECRET, enrollmentCode: CODE });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "Invalid account credentials");
  } finally { await app.close(); }
});
