const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, post, get } = require("./helpers.js");

const ID = "syncaccount000000001";
const SECRET = "secret-secret-secret";
const CODE = "test-enrollment-secret";

// Every kind in the shipped record-kinds.txt allowlist.
const KINDS = [
  "daily", "monthly", "future", "collection", "audit",
  "scorecard_question", "scorecard_answer", "collection_template", "collection_entry",
];

async function enroll(app) {
  const r = await post(app.baseUrl, "/api/enroll", { accountId: ID, accountSecret: SECRET, enrollmentCode: CODE });
  assert.equal(r.status, 200);
  return r.json.token;
}

test("sync accepts every allowlisted record kind and pulls them back", async () => {
  const app = await startApp();
  try {
    const token = await enroll(app);
    const records = KINDS.map((kind, i) => ({
      kind, id: `${kind}-1`, updated_at: `2026-07-07T10:00:0${i}Z`, deleted: false, payload: "blob",
    }));

    const push = await post(app.baseUrl, "/api/sync", { records }, token);
    assert.equal(push.status, 200);
    assert.equal(push.json.applied, KINDS.length);
    assert.equal(push.json.rejected, 0);

    const pull = await get(app.baseUrl, "/api/sync?since=", token);
    assert.equal(pull.status, 200);
    assert.deepEqual(pull.json.records.map((r) => r.kind).sort(), [...KINDS].sort());
  } finally { await app.close(); }
});

test("an unknown kind is still rejected (allowlist, not a wildcard)", async () => {
  const app = await startApp();
  try {
    const token = await enroll(app);
    const push = await post(app.baseUrl, "/api/sync",
      { records: [{ kind: "not_a_kind", id: "x1", updated_at: "2026-07-07T10:00:00Z", deleted: false, payload: "blob" }] },
      token);
    assert.equal(push.status, 200);
    assert.equal(push.json.applied, 0);
    assert.equal(push.json.rejected, 1);
  } finally { await app.close(); }
});
