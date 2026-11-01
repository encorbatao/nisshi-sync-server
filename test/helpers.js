const os = require("os");
const path = require("path");
const fs = require("fs");
const { initDb } = require("../db.js");
const { createApp } = require("../app.js");
const { loadRecordKinds } = require("../record-kinds.js");

const VALID_KINDS = loadRecordKinds(path.join(__dirname, "..", "record-kinds.txt"));

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-test-"));
  return path.join(dir, "vault.db");
}

async function startApp() {
  const { db, stmts } = initDb(tempDbPath());
  const app = createApp({
    db, stmts,
    config: {
      tokenSecret: "test-token-secret",
      enrollmentSecret: "test-enrollment-secret",
      tokenTtlMs: 30 * 24 * 60 * 60 * 1000,
      disableRateLimit: true,
      quiet: true,
      validKinds: VALID_KINDS,
    },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stmts, db,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function post(baseUrl, p, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + p, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function get(baseUrl, p, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + p, { headers });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function del(baseUrl, p, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + p, { method: "DELETE", headers });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

module.exports = { startApp, post, get, del };
