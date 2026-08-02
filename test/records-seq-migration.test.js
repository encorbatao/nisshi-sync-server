const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { initDb } = require("../db.js");

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-seq-"));
  return path.join(dir, "vault.db");
}

test("fresh db has the seq column, seq index, and record_seq counter", () => {
  const { db } = initDb(tmp());
  const cols = db.prepare("PRAGMA table_info(records)").all().map((c) => c.name);
  assert.ok(cols.includes("seq"), "records.seq missing");
  const idx = db.prepare("PRAGMA index_list(records)").all().map((i) => i.name);
  assert.ok(idx.includes("idx_records_seq"), "idx_records_seq missing");
  const counter = db.prepare("SELECT v FROM counters WHERE name = 'record_seq'").get();
  assert.equal(counter.v, 0);
});

test("migrates an old records table in place, backfilling increasing seq by updated_at", () => {
  const p = tmp();
  const old = new Database(p);
  old.exec(`CREATE TABLE records (
    account_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, payload TEXT,
    PRIMARY KEY (account_id, kind, id));`);
  const ins = old.prepare("INSERT INTO records (account_id, kind, id, updated_at, deleted, payload) VALUES (?,?,?,?,0,?)");
  ins.run("acct", "daily", "b", "2026-07-10T12:00:02Z", "blob");   // inserted first, later time
  ins.run("acct", "daily", "a", "2026-07-10T12:00:01Z", "blob");   // earlier time
  old.close();

  const { db } = initDb(p);
  const rows = db.prepare("SELECT id, seq FROM records ORDER BY seq").all();
  // Backfill orders by updated_at, so 'a' (earlier) gets the lower seq.
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
  assert.ok(rows[0].seq >= 1 && rows[1].seq > rows[0].seq, "seq must be strictly increasing");
  const counter = db.prepare("SELECT v FROM counters WHERE name = 'record_seq'").get().v;
  assert.equal(counter, rows[1].seq, "counter must equal the max assigned seq");
});

test("migration is idempotent across reopen and does not renumber existing rows", () => {
  const p = tmp();
  const first = initDb(p);
  first.db.prepare(
    "INSERT INTO records (account_id, kind, id, updated_at, deleted, payload, seq) VALUES ('a','daily','x','2026-07-10T12:00:00Z',0,'b',7)"
  ).run();
  first.db.prepare("UPDATE counters SET v = 7 WHERE name = 'record_seq'").run();
  first.db.close();

  const { db } = initDb(p);   // reopen: must not re-add column or renumber
  const row = db.prepare("SELECT seq FROM records WHERE id = 'x'").get();
  assert.equal(row.seq, 7, "existing seq must be preserved");
  const counter = db.prepare("SELECT v FROM counters WHERE name = 'record_seq'").get().v;
  assert.equal(counter, 7);
});
