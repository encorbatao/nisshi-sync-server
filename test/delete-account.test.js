const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, post, get, del } = require("./helpers.js");

const ID = "deleteaccount0000001";
const OTHER = "deleteaccount0000002";
const SECRET = "secret-secret-secret";
const CODE = "test-enrollment-secret";

async function enroll(app, id = ID) {
  const r = await post(app.baseUrl, "/api/enroll", { accountId: id, accountSecret: SECRET, enrollmentCode: CODE });
  assert.equal(r.status, 200);
  return r.json;
}

const rec = (id) => ({ kind: "daily", id, updated_at: "2026-11-01T12:00:00Z", deleted: false, payload: "blob" });
const countRecords = (app, id) =>
  app.db.prepare("SELECT COUNT(*) AS n FROM records WHERE account_id = ?").get(id).n;

test("delete removes the account and all its records", async () => {
  const app = await startApp();
  try {
    const { token } = await enroll(app);
    await post(app.baseUrl, "/api/sync", { records: [rec("a"), rec("b")] }, token);

    const r = await del(app.baseUrl, "/api/account", token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { deleted: true, records: 2 });
    assert.equal(countRecords(app, ID), 0);
    assert.equal(app.stmts.getAccount.get(ID), undefined);
  } finally { await app.close(); }
});

test("delete leaves other accounts untouched", async () => {
  const app = await startApp();
  try {
    const { token } = await enroll(app);
    const other = await enroll(app, OTHER);
    await post(app.baseUrl, "/api/sync", { records: [rec("mine")] }, other.token);

    await del(app.baseUrl, "/api/account", token);
    assert.equal(countRecords(app, OTHER), 1);
    assert.ok(app.stmts.getAccount.get(OTHER));
  } finally { await app.close(); }
});

// Tokens are stateless HMACs valid for 30 days, and records carry no foreign key
// to accounts — so another device still holding a token would otherwise keep
// pushing and silently recreate the deleted data.
test("a token issued before deletion is rejected everywhere", async () => {
  const app = await startApp();
  try {
    const { token } = await enroll(app);
    await del(app.baseUrl, "/api/account", token);

    assert.equal((await get(app.baseUrl, "/api/sync", token)).status, 401);
    assert.equal((await post(app.baseUrl, "/api/sync", { records: [rec("late")] }, token)).status, 401);
    assert.equal((await post(app.baseUrl, "/api/sync/purge", { records: [] }, token)).status, 401);
    assert.equal((await del(app.baseUrl, "/api/account", token)).status, 401);
    assert.equal(countRecords(app, ID), 0);
  } finally { await app.close(); }
});

test("re-enrolling after deletion creates a fresh account", async () => {
  const app = await startApp();
  try {
    const { token } = await enroll(app);
    await del(app.baseUrl, "/api/account", token);

    const again = await enroll(app);
    assert.equal(again.created, true);
  } finally { await app.close(); }
});

test("delete without a token => 401", async () => {
  const app = await startApp();
  try {
    await enroll(app);
    assert.equal((await del(app.baseUrl, "/api/account")).status, 401);
    assert.ok(app.stmts.getAccount.get(ID));
  } finally { await app.close(); }
});
