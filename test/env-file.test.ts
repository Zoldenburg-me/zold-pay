import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { checkEnvText, loadEnvFileStrict } from "../server/src/env-file.js";

/**
 * A .env that cannot be read, or has a line the loader skips, used to be ignored
 * without a word: the service started on defaults the operator never chose. Now
 * it stops, naming the file, the line and the key, and never the value.
 */
describe("checkEnvText", () => {
  it("accepts what Node's loader reads", () => {
    const ok = [
      "# a comment", "", "PLAIN=1", "export EXPORTED=yes", "SPACED = value with spaces", "EMPTY=",
      'QUOTED="has # and = inside"', "SINGLE='x'", 'MULTI="first', "second", 'third"', "TRAILING=1 # comment",
    ].join("\n");
    assert.deepEqual(checkEnvText(ok), []);
  });

  it("reports the line number and key of each bad line, never its value", () => {
    // An unclosed quote takes the lines after it (Node would join them into its value), so it comes last.
    const text = ["GOOD=1", "this line has no equals sign", "=no-key-secret", "1BAD=secret-value", "GOOD=2", 'OPEN="never closed secret', "LOST=1"].join("\n");
    const problems = checkEnvText(text);
    assert.deepEqual(problems, [
      "line 2: not KEY=value",
      "line 3: not KEY=value",
      "line 4: not KEY=value",
      "line 5: set again, first on line 1",
      "line 6: OPEN has an unclosed quote",
    ]);
    assert.equal(problems.join(" ").includes("secret"), false);
  });

  it("refuses what Node would read differently: a byte-order mark, a lone carriage return", () => {
    assert.deepEqual(checkEnvText("\uFEFFFIRST=1\nSECOND=2"), ["line 1: starts with a byte-order mark"]);
    assert.deepEqual(checkEnvText("A=1\rB=2\n"), ["line 1: a carriage return without a newline"]);
    assert.deepEqual(checkEnvText("A=1\r\nB=2\r\n"), [], "Windows line endings are fine");
  });

  it("refuses lines Node would read differently from how they look", () => {
    assert.deepEqual(checkEnvText("export\tTABBED=1"), ["line 1: not KEY=value"], "Node only knows `export ` with a space");
    assert.deepEqual(checkEnvText("__proto__=1"), ["line 1: not KEY=value"]);
    assert.deepEqual(checkEnvText("HASHED=a#b"), ["line 1: HASHED has a # inside an unquoted value; quote the value"]);
    assert.deepEqual(checkEnvText('TAILED="a"b'), ["line 1: TAILED has text after its closing quote"]);
    assert.deepEqual(checkEnvText("SINGLE='x' y"), ["line 1: SINGLE has text after its closing quote"]);
  });

  it("accepts a comment after a value, unquoted or quoted", () => {
    assert.deepEqual(checkEnvText(["SPACED=x #a comment", 'QUOTED="a" # a comment', "INSIDE='a#b'"].join("\n")), []);
  });

  it("knows Node has no escaped quotes: a backslash before a quote still closes it", () => {
    // Node reads ESCAPED="x\"y" as x\ and drops y": refused, not silently cut.
    assert.deepEqual(checkEnvText('ESCAPED="x\\"y"'), ["line 1: ESCAPED has text after its closing quote"]);
  });

  it("refuses a quote closed on a later line with text after it", () => {
    // Node joins J's lines up to the next quote and drops what follows it.
    assert.deepEqual(checkEnvText('J="abc\nK=1\nL="x"'), ["line 1: J has text after its closing quote"]);
  });

  it("names only line numbers for a repeated key, so a value can never pose as a key name", () => {
    const [problem] = checkEnvText("c2VjcmV0=1\nc2VjcmV0=2");
    assert.equal(problem.includes("c2VjcmV0"), false);
  });
});

describe("loadEnvFileStrict", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pay-env-"));
  const setHere = ["ENV_FILE_TEST_A", "ENV_FILE_TEST_GOOD", "ENV_FILE_TEST_SET", "ENV_FILE_TEST_Q", "ENV_FILE_TEST_UNDEF"];
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of setHere) delete process.env[k];
  });

  it("is quiet when there is no .env at all", () => {
    assert.equal(loadEnvFileStrict(path.join(dir, "missing.env")), false);
  });

  it("stops on a .env it cannot read, naming the file and the reason", () => {
    const notAFile = path.join(dir, "dir.env");
    mkdirSync(notAFile);
    assert.throws(() => loadEnvFileStrict(notAFile), (e: Error) => e.message.includes(notAFile) && /EISDIR/.test(e.message));
  });

  it("stops on a malformed .env without loading any of it or echoing a value", () => {
    const file = path.join(dir, "bad.env");
    writeFileSync(file, "ENV_FILE_TEST_A=1\nENV_FILE_TEST_SECRET hunter2\n");
    assert.throws(
      () => loadEnvFileStrict(file),
      (e: Error) => e.message.includes(file) && e.message.includes("line 2") && !e.message.includes("hunter2"),
    );
    assert.equal(process.env.ENV_FILE_TEST_A, undefined);
  });

  it("loads a good .env, and like Node never overrides a variable already set", () => {
    const file = path.join(dir, "good.env");
    process.env.ENV_FILE_TEST_SET = "from-the-environment";
    writeFileSync(file, 'ENV_FILE_TEST_GOOD=yes\nENV_FILE_TEST_SET=from-the-file\nexport ENV_FILE_TEST_Q="a # b"\n');
    assert.equal(loadEnvFileStrict(file), true);
    assert.equal(process.env.ENV_FILE_TEST_GOOD, "yes");
    assert.equal(process.env.ENV_FILE_TEST_SET, "from-the-environment");
    assert.equal(process.env.ENV_FILE_TEST_Q, "a # b");
  });
});

describe("loadEnvFileStrict, against Node's own reading", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pay-env-parse-"));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ENV_FILE_TEST_UNDEF;
  });
  const file = path.join(dir, "x.env");
  writeFileSync(file, "ENV_FILE_TEST_UNDEF=1\n");

  it("stops when Node reads a different set of keys than the check found", () => {
    const parse = () => ({ ENV_FILE_TEST_UNDEF: "1", SURPRISE: "x" });
    assert.throws(() => loadEnvFileStrict(file, parse), (e: Error) => /different set of keys/.test(e.message) && !e.message.includes("SURPRISE"));
  });

  it("never stores a missing value as the string \"undefined\"", () => {
    loadEnvFileStrict(file, () => ({ ENV_FILE_TEST_UNDEF: undefined }));
    assert.equal(process.env.ENV_FILE_TEST_UNDEF, undefined);
  });
});
