const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { loadRecordKinds } = require("../record-kinds.js");

function writeTemp(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kinds-test-"));
  const p = path.join(dir, "record-kinds.txt");
  fs.writeFileSync(p, contents);
  return p;
}

test("parses kinds, ignoring comments and blank lines", () => {
  const p = writeTemp("# header comment\n\ndaily\nmonthly\n  # indented comment\nfuture\n\n");
  const kinds = loadRecordKinds(p);
  assert.deepEqual([...kinds].sort(), ["daily", "future", "monthly"]);
});

test("trims surrounding whitespace on a kind line", () => {
  const p = writeTemp("  daily  \n");
  const kinds = loadRecordKinds(p);
  assert.ok(kinds.has("daily"));
  assert.equal(kinds.size, 1);
});

test("throws when the file is missing", () => {
  assert.throws(() => loadRecordKinds("/no/such/file/record-kinds.txt"), /record kinds file/i);
});

test("throws when the file has no kinds (comments only)", () => {
  const p = writeTemp("# just a comment\n\n   \n");
  assert.throws(() => loadRecordKinds(p), /no record kinds/i);
});

test("throws on a malformed kind line", () => {
  const p = writeTemp("daily\nBad Kind!\n");
  assert.throws(() => loadRecordKinds(p), /invalid record kind/i);
});
