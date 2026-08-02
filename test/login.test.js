const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, post } = require("./helpers.js");

const SECRET = "secret-secret-secret";
const CODE = "test-enrollment-secret";
const enroll = (app, id, secret = SECRET) =>
  post(app.baseUrl, "/api/enroll", { accountId: id, accountSecret: secret, enrollmentCode: CODE });

test("login with the right secret issues a token", async () => {
  const app = await startApp();
  try {
    await enroll(app, "loginokaccount00001");
    const r = await post(app.baseUrl, "/api/login", { accountId: "loginokaccount00001", accountSecret: SECRET });
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
  } finally { await app.close(); }
});

test("login with the wrong secret => 401", async () => {
  const app = await startApp();
  try {
    await enroll(app, "loginwrongsecret001");
    const r = await post(app.baseUrl, "/api/login", { accountId: "loginwrongsecret001", accountSecret: "different-secret-xx" });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "Unknown account or wrong secret");
  } finally { await app.close(); }
});

test("login for an unknown account => 401", async () => {
  const app = await startApp();
  try {
    const r = await post(app.baseUrl, "/api/login", { accountId: "nosuchaccount000001", accountSecret: SECRET });
    assert.equal(r.status, 401);
  } finally { await app.close(); }
});

test("malformed credentials => 400", async () => {
  const app = await startApp();
  try {
    const r = await post(app.baseUrl, "/api/login", { accountId: "short", accountSecret: SECRET });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "Invalid account credentials");
  } finally { await app.close(); }
});
