const test = require("node:test");
const assert = require("node:assert");
const { startApp } = require("./helpers.js");

const raw = (baseUrl, p, body, headers = {}) =>
  fetch(baseUrl + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

test("security headers are set and x-powered-by is hidden", async () => {
  const app = await startApp();
  try {
    const res = await fetch(app.baseUrl + "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.match(res.headers.get("strict-transport-security"), /max-age=31536000/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  } finally { await app.close(); }
});

test("malformed JSON => 400, not 500", async () => {
  const app = await startApp();
  try {
    assert.equal((await raw(app.baseUrl, "/api/login", "{bad")).status, 400);
    assert.equal((await raw(app.baseUrl, "/api/enroll", "{bad")).status, 400);
  } finally { await app.close(); }
});

test("unauthenticated sync is rejected before its body is parsed", async () => {
  const app = await startApp();
  try {
    assert.equal((await raw(app.baseUrl, "/api/sync", "{bad")).status, 401);
    assert.equal((await raw(app.baseUrl, "/api/sync/purge", "{bad")).status, 401);
    const big = JSON.stringify({ records: [{ payload: "a".repeat(2 * 1024 * 1024) }] });
    assert.equal((await raw(app.baseUrl, "/api/sync", big)).status, 401);
  } finally { await app.close(); }
});

test("oversized login/enroll bodies => 413", async () => {
  const app = await startApp();
  try {
    const big = JSON.stringify({ accountId: "x".repeat(64 * 1024) });
    assert.equal((await raw(app.baseUrl, "/api/login", big)).status, 413);
    assert.equal((await raw(app.baseUrl, "/api/enroll", big)).status, 413);
  } finally { await app.close(); }
});

test("unknown routes => JSON 404", async () => {
  const app = await startApp();
  try {
    const res = await fetch(app.baseUrl + "/nope");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found" });
  } finally { await app.close(); }
});
