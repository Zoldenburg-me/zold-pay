/**
 * Loading .env so that a mistake in it stops the service instead of being
 * skipped. Node's own parser drops a line it cannot read, cuts an unquoted value
 * at a "#", and drops text after a closing quote; the old code also ignored a
 * file it could not open. Any of those meant the service started on settings
 * nobody chose. Errors name the file and line numbers, and at most a key that
 * passed the key pattern, never a value: a .env holds secrets.
 *
 * The rules follow what Node 22's util.parseEnv actually does (checked against
 * it, see test/env-file.test.ts), and are stricter where it would be surprising.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const QUOTES = new Set(['"', "'", "`"]);

/** After a closing quote only a comment may follow; anything else Node drops. */
const onlyCommentAfter = (rest: string) => {
  const r = rest.trim();
  return r === "" || r.startsWith("#");
};

interface EnvCheck {
  problems: string[];
  /** The keys Node should read from the text, in order. */
  keys: string[];
}

function analyzeEnv(text: string): EnvCheck {
  // Read differently from how they look: a byte-order mark becomes part of the
  // first key, a lone carriage return joins two lines. Every line after either
  // one would be misread too, so they are reported on their own.
  if (text.startsWith("﻿")) return { problems: ["line 1: starts with a byte-order mark"], keys: [] };
  const loneCr = text.search(/\r(?!\n)/);
  if (loneCr >= 0) {
    return { problems: [`line ${text.slice(0, loneCr).split("\n").length}: a carriage return without a newline`], keys: [] };
  }
  const problems: string[] = [];
  const firstLine = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    // Node knows `export ` with a space only; `export<tab>` would become part of the key.
    const key = eq < 0 ? "" : line.slice(0, eq).replace(/^export /, "").trim();
    if (!KEY.test(key) || key === "__proto__") {
      problems.push(`line ${lineNo}: not KEY=value`);
      continue;
    }
    // Line numbers only: text before an "=" can be a value that only looks like a key.
    const first = firstLine.get(key);
    if (first !== undefined) problems.push(`line ${lineNo}: set again, first on line ${first}`);
    else firstLine.set(key, lineNo);

    const value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (!QUOTES.has(quote)) {
      // Unquoted, Node ends the value at the first "#". Only " #" reads as meant.
      const hash = value.indexOf("#");
      if (hash > 0 && !/\s/.test(value[hash - 1])) {
        problems.push(`line ${lineNo}: ${key} has a # inside an unquoted value; quote the value`);
      }
      continue;
    }
    // Node has no escapes: the next same quote closes the value, on this line or a later one.
    const close = value.indexOf(quote, 1);
    if (close > 0) {
      if (!onlyCommentAfter(value.slice(close + 1))) problems.push(`line ${lineNo}: ${key} has text after its closing quote`);
      continue;
    }
    let closedOn = -1;
    for (let j = i + 1; j < lines.length && closedOn < 0; j++) if (lines[j].includes(quote)) closedOn = j;
    if (closedOn < 0) {
      problems.push(`line ${lineNo}: ${key} has an unclosed quote`);
      break; // what follows would all be read as part of this value
    }
    const closing = lines[closedOn];
    if (!onlyCommentAfter(closing.slice(closing.indexOf(quote) + 1))) {
      problems.push(`line ${lineNo}: ${key} has text after its closing quote`);
    }
    i = closedOn;
  }
  return { problems, keys: [...firstLine.keys()] };
}

/** Problems with a .env's text, as "line N: …". Empty when it is fine. */
export function checkEnvText(text: string): string[] {
  return analyzeEnv(text).problems;
}

/**
 * Load `file` into process.env. Returns false when there is no such file (the
 * defaults apply); throws, naming the file, when it cannot be read or is malformed.
 * The file is read once and the same text is checked and then parsed by Node's
 * own parser, so what was checked is what is loaded; as a backstop, Node must
 * read exactly the keys the check found. As with Node's loader, a variable
 * already set in the environment (even to "") wins over the file.
 */
export function loadEnvFileStrict(file: string, parse: (text: string) => NodeJS.Dict<string> = parseEnv): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String(e.code) : "unknown error";
    if (code === "ENOENT") return false;
    throw new Error(`could not read ${file} (${code})`, { cause: e });
  }
  const { problems, keys } = analyzeEnv(text);
  if (problems.length) throw new Error(`${file} has lines that would be ignored or misread: ${problems.join("; ")}`);
  const parsed = parse(text);
  const parsedKeys = Object.keys(parsed);
  const sameKeys = parsedKeys.length === keys.length && keys.every((k) => Object.hasOwn(parsed, k));
  // Key names are not echoed: if Node read a key the check did not, it may be a value.
  if (!sameKeys) throw new Error(`${file}: Node reads a different set of keys from it than the check found`);
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
