const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// Open (creating if needed) the vault DB, apply schema + idempotent migrations, and
// return prepared statements. Pulling this out of server.js lets tests build a
// throwaway DB with the exact same schema.
function initDb(dbPath) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id  TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      account_id TEXT NOT NULL,
      kind       TEXT NOT NULL,
      id         TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0,
      payload    TEXT,
      PRIMARY KEY (account_id, kind, id)
    );
    CREATE INDEX IF NOT EXISTS idx_records_sync ON records(account_id, updated_at);
  `);

  migrateRecordsSeq(db);

  const stmts = {
    getAccount:    db.prepare("SELECT * FROM accounts WHERE account_id = ?"),
    createAccount: db.prepare(`INSERT INTO accounts (account_id, secret_hash, created_at)
      VALUES (@account_id, @secret_hash, @created_at)`),
    // The sync cursor is the server-assigned `seq`, NOT the client's wall-clock
    // `updated_at` — comparing a client clock against a server-clock watermark
    // silently dropped records from devices whose clock lagged.
    pull:      db.prepare("SELECT kind, id, updated_at, deleted, payload FROM records WHERE account_id = ? AND seq > ? ORDER BY seq"),
    getRecord: db.prepare("SELECT updated_at FROM records WHERE account_id = ? AND kind = ? AND id = ?"),
    upsert:    db.prepare(`INSERT INTO records (account_id, kind, id, updated_at, deleted, payload, seq)
      VALUES (@account_id, @kind, @id, @updated_at, @deleted, @payload, @seq)
      ON CONFLICT(account_id, kind, id) DO UPDATE SET
        updated_at=@updated_at, deleted=@deleted, payload=@payload, seq=@seq`),
    purge:     db.prepare("DELETE FROM records WHERE account_id = ? AND kind = ? AND id = ?"),
    purgeAccountRecords: db.prepare("DELETE FROM records WHERE account_id = ?"),
    deleteAccount:       db.prepare("DELETE FROM accounts WHERE account_id = ?"),
    // Monotonic global sequence generator. Bump then read, inside the push
    // transaction, so a rolled-back push also rolls back the counter.
    bumpSeq:   db.prepare("UPDATE counters SET v = v + 1 WHERE name = 'record_seq'"),
    getSeq:    db.prepare("SELECT v FROM counters WHERE name = 'record_seq'"),
  };

  return { db, stmts };
}

// Give records a server-assigned monotonic `seq` used as the sync cursor, plus a
// `counters` row that generates it. Idempotent: adds the column only when absent
// and backfills existing rows in `updated_at` order so they get a stable
// increasing cursor. The counter is re-derived from MAX(seq) on every boot so it
// can never hand out a seq at or below one already stored.
function migrateRecordsSeq(db) {
  const cols = new Set(db.prepare("PRAGMA table_info(records)").all().map((c) => c.name));
  if (!cols.has("seq")) {
    db.exec("ALTER TABLE records ADD COLUMN seq INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      WITH ordered AS (
        SELECT rowid AS rid, ROW_NUMBER() OVER (ORDER BY updated_at, rowid) AS rn FROM records
      )
      UPDATE records SET seq = (SELECT rn FROM ordered WHERE ordered.rid = records.rowid)
    `);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_records_seq ON records(account_id, seq)");
  db.exec("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM records").get().m;
  db.prepare("INSERT INTO counters (name, v) VALUES ('record_seq', @m) ON CONFLICT(name) DO UPDATE SET v = @m")
    .run({ m: maxSeq });
}

module.exports = { initDb };
