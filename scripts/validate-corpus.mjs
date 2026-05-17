#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "corpus", "stripe-customers.json");
const MIN_ENTRIES = 80;
const REQUIRED_FIELDS = [
  "slug",
  "customer",
  "url",
  "html",
  "raw_text",
  "products",
  "industry",
  "published_date",
];

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (!existsSync(CORPUS_PATH)) {
  fail(`corpus file does not exist at ${CORPUS_PATH}`);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
} catch (err) {
  fail(`corpus file is not valid JSON: ${err.message}`);
}

if (!Array.isArray(parsed)) {
  fail(`corpus root must be an array; got ${typeof parsed}`);
}

if (parsed.length < MIN_ENTRIES) {
  fail(`expected >= ${MIN_ENTRIES} entries, got ${parsed.length}`);
}

const issues = [];
const seenSlugs = new Set();
const urlPattern = /^https:\/\/stripe\.com\/customers\/[a-z0-9][a-z0-9-]*$/;

for (const [i, entry] of parsed.entries()) {
  for (const f of REQUIRED_FIELDS) {
    if (!(f in entry)) {
      issues.push(`entry ${i} (${entry.slug ?? "?"}): missing field "${f}"`);
    }
  }
  if (typeof entry.slug !== "string" || entry.slug.length === 0) {
    issues.push(`entry ${i}: slug must be non-empty string`);
  } else if (seenSlugs.has(entry.slug)) {
    issues.push(`entry ${i}: duplicate slug "${entry.slug}"`);
  } else {
    seenSlugs.add(entry.slug);
  }
  if (typeof entry.url !== "string" || !urlPattern.test(entry.url)) {
    issues.push(
      `entry ${i} (${entry.slug}): url does not match expected pattern (got "${entry.url}")`,
    );
  }
  if (typeof entry.raw_text !== "string" || entry.raw_text.length < 200) {
    issues.push(
      `entry ${i} (${entry.slug}): raw_text must be string >=200 chars (got ${entry.raw_text?.length ?? 0})`,
    );
  }
  if (typeof entry.customer !== "string" || entry.customer.length === 0) {
    issues.push(`entry ${i} (${entry.slug}): customer must be non-empty string`);
  }
  if (!Array.isArray(entry.products)) {
    issues.push(`entry ${i} (${entry.slug}): products must be array`);
  }
}

if (issues.length > 0) {
  for (const issue of issues.slice(0, 25)) console.error(`FAIL: ${issue}`);
  if (issues.length > 25) console.error(`... and ${issues.length - 25} more`);
  process.exit(1);
}

console.log(
  `OK: ${parsed.length} entries, all required fields present, raw_text >=200 chars, urls match pattern.`,
);
