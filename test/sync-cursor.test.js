const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, post, get } = require("./helpers.js");

const ID = "syncaccount000000001";
const SECRET = "secret-secret-secret";
const CODE = "test-enrollment-secret";

async function enroll(app) {
  const r = await post(app.baseUrl, "/api/enroll", { accountId: ID, accountSecret: SECRET, enrollmentCode: CODE });
  assert.equal(r.status, 200);
  return r.json.token;
}

const rec = (id, updatedAt) => ({ kind: "daily", id, updated_at: updatedAt, deleted: false, payload: "blob" });

// The root-cause regression: the sync cursor must be a server-assigned sequence,
// NOT the client's wall-clock `updated_at`. A record pushed with an EARLIER
// updated_at than the one already pulled (a device whose clock lags) must still
// be delivered on the next incremental pull. Under the old `updated_at > since`
// filter this record was dropped forever.
test("a later push with an earlier updated_at is still delivered incrementally", async () => {
  const app = await startApp();
  try {
    const token = await enroll(app);

    // Device A pushes a record; we pull and capture the cursor.
    await post(app.baseUrl, "/api/sync", { records: [rec("rec-A", "2026-07-10T12:00:05Z")] }, token);
    const first = await get(app.baseUrl, "/api/sync?since=", token);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.records.map((r) => r.id), ["rec-A"]);
    const cursor = first.json.serverTime;

    // Device B (clock lagging) pushes a record stamped EARLIER than rec-A.
    await post(app.baseUrl, "/api/sync", { records: [rec("rec-B", "2026-07-10T12:00:01Z")] }, token);

    // The incremental pull since the previous cursor MUST include rec-B.
    const second = await get(app.baseUrl, `/api/sync?since=${encodeURIComponent(cursor)}`, token);
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.records.map((r) => r.id), ["rec-B"],
      "record with an earlier updated_at was dropped from the incremental pull");
  } finally { await app.close(); }
});

// A non-integer `since` (an existing client's old ISO-timestamp watermark) is
// treated as a full snapshot so every device self-heals on its next sync and
// recovers records that were previously dropped.
test("a non-integer (legacy ISO) since returns a full snapshot", async () => {
  const app = await startApp();
  try {
    const token = await enroll(app);
    await post(app.baseUrl, "/api/sync",
      { records: [rec("r1", "2026-07-10T12:00:01Z"), rec("r2", "2026-07-10T12:00:02Z")] }, token);

    const pull = await get(app.baseUrl, "/api/sync?since=2026-07-10T16:00:00.000Z", token);
    assert.equal(pull.status, 200);
    assert.deepEqual(pull.json.records.map((r) => r.id).sort(), ["r1", "r2"]);
  } finally { await app.close(); }
});

// Incremental correctness: pulling since a cursor returns only what is new, and
// the cursor advances monotonically.
test("incremental pull returns only records newer than the cursor", async () => {
  const app = await startApp();
  try {
    const token = await enroll(app);

    await post(app.baseUrl, "/api/sync", { records: [rec("r1", "2026-07-10T12:00:01Z")] }, token);
    const p1 = await get(app.baseUrl, "/api/sync?since=", token);
    assert.deepEqual(p1.json.records.map((r) => r.id), ["r1"]);
    const c1 = p1.json.serverTime;

    await post(app.baseUrl, "/api/sync", { records: [rec("r2", "2026-07-10T12:00:02Z")] }, token);
    const p2 = await get(app.baseUrl, `/api/sync?since=${encodeURIComponent(c1)}`, token);
    assert.deepEqual(p2.json.records.map((r) => r.id), ["r2"], "should return only the new record");
    assert.ok(Number(p2.json.serverTime) > Number(c1), "cursor must advance");

    // Nothing new since the latest cursor.
    const p3 = await get(app.baseUrl, `/api/sync?since=${encodeURIComponent(p2.json.serverTime)}`, token);
    assert.deepEqual(p3.json.records, []);
  } finally { await app.close(); }
});

// An updated record (higher updated_at, LWW-applied) re-syncs to a device that
// already pulled the earlier version.
test("an updated record re-syncs on the next incremental pull", async () => {
  const app = await startApp();
  try {
    const token = await enroll(app);
    await post(app.baseUrl, "/api/sync", { records: [rec("r1", "2026-07-10T12:00:01Z")] }, token);
    const c1 = (await get(app.baseUrl, "/api/sync?since=", token)).json.serverTime;

    // Same id, later updated_at → LWW applies it and it gets a fresh cursor.
    await post(app.baseUrl, "/api/sync", { records: [rec("r1", "2026-07-10T12:00:09Z")] }, token);
    const p = await get(app.baseUrl, `/api/sync?since=${encodeURIComponent(c1)}`, token);
    assert.deepEqual(p.json.records.map((r) => r.id), ["r1"]);
    assert.equal(p.json.records[0].updated_at, "2026-07-10T12:00:09Z");
  } finally { await app.close(); }
});
