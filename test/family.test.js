const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, post, get } = require("./helpers.js");

const ID = "familyaccount0000001";
const SECRET = "secret-secret-secret";
const CODE = "test-enrollment-secret";

test("family enroll -> sync push -> login -> sync pull round-trip", async () => {
  const app = await startApp();
  try {
    const enroll = await post(app.baseUrl, "/api/enroll", { accountId: ID, accountSecret: SECRET, enrollmentCode: CODE });
    assert.equal(enroll.status, 200);
    assert.equal(enroll.json.created, true);

    const push = await post(app.baseUrl, "/api/sync",
      { records: [{ kind: "daily", id: "d1", updated_at: "2026-06-28T10:00:00Z", deleted: false, payload: "blob" }] },
      enroll.json.token);
    assert.equal(push.status, 200);
    assert.equal(push.json.applied, 1);

    const login = await post(app.baseUrl, "/api/login", { accountId: ID, accountSecret: SECRET });
    assert.equal(login.status, 200);

    const pull = await get(app.baseUrl, "/api/sync?since=", login.json.token);
    assert.equal(pull.status, 200);
    assert.equal(pull.json.records.length, 1);
    assert.equal(pull.json.records[0].id, "d1");
  } finally { await app.close(); }
});

test("wrong enrollment code => 403", async () => {
  const app = await startApp();
  try {
    const r = await post(app.baseUrl, "/api/enroll", { accountId: ID, accountSecret: SECRET, enrollmentCode: "wrong" });
    assert.equal(r.status, 403);
  } finally { await app.close(); }
});

test("sync without a token => 401", async () => {
  const app = await startApp();
  try {
    const r = await post(app.baseUrl, "/api/sync", { records: [] });
    assert.equal(r.status, 401);
  } finally { await app.close(); }
});
