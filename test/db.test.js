const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { initDb } = require("../db.js");

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-db-"));
  return path.join(dir, "vault.db");
}
const row = (over) => ({
  account_id: "a1", secret_hash: "h", created_at: "2026-01-01T00:00:00Z", ...over,
});

test("fresh db has the accounts table with its three columns", () => {
  const { db } = initDb(tmp());
  const cols = db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ["account_id", "created_at", "secret_hash"]);
});

test("createAccount inserts and getAccount reads it back", () => {
  const { stmts } = initDb(tmp());
  stmts.createAccount.run(row({ account_id: "acct-1" }));
  assert.equal(stmts.getAccount.get("acct-1").secret_hash, "h");
  assert.equal(stmts.getAccount.get("nope"), undefined);
});

test("account_id is unique", () => {
  const { stmts } = initDb(tmp());
  stmts.createAccount.run(row({ account_id: "dupe" }));
  assert.throws(() => stmts.createAccount.run(row({ account_id: "dupe" })));
});

// A vault written by a build that carried the licensing columns still opens:
// the extra columns are nullable or defaulted, so the narrower INSERT succeeds.
test("opens a database that still has legacy subscription columns", () => {
  const p = tmp();
  const old = new Database(p);
  old.exec(`CREATE TABLE accounts (
    account_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'family', license_key TEXT,
    license_status TEXT, license_checked_at TEXT);`);
  old.close();

  const { stmts } = initDb(p);
  stmts.createAccount.run(row({ account_id: "legacy-acct" }));
  assert.equal(stmts.getAccount.get("legacy-acct").account_id, "legacy-acct");
});
