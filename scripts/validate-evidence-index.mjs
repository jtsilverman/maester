#!/usr/bin/env node
// Acceptance test for chunk 3: validates corpus/evidence-index.json.
//
// Asserts:
//   1. File exists, valid JSON, flat array.
//   2. Card count >= MIN_CARDS (default 300).
//   3. Each card has all six required fields with correct types and a valid claim_type.
//   4. No card references a slug missing from corpus/stripe-customers.json.
//   5. For SPOT_CHECK_N random cards (default 20): looking up the story by slug,
//      raw_text.slice(source_span[0], source_span[1]) matches exact_quote
//      (curly-quote-tolerant, same normalizer as chunk 2's extract-evidence).
//
// Run: node scripts/validate-evidence-index.mjs
// Exit codes: 0 = pass, 1 = fail (any assertion above).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, 'corpus/stripe-customers.json');
const INDEX = path.join(ROOT, 'corpus/evidence-index.json');

const MIN_CARDS = 300;
const SPOT_CHECK_N = 20;
const REQUIRED_FIELDS = ['slug', 'customer', 'metric', 'baseline', 'exact_quote', 'source_span', 'claim_type'];
const VALID_CLAIM_TYPES = new Set(['customer-claimed', 'verified-by-source', 'stripe-internal']);

// Same normalizer as skills/maester/scripts/extract-evidence.mjs — curly quotes
// and en/em dashes collapsed to ASCII so substring matches survive typography.
function normalizeQuotes(s) {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ');
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function pickRandom(arr, n) {
  const copy = arr.slice();
  const picked = [];
  while (picked.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    picked.push(copy[i]);
    copy.splice(i, 1);
  }
  return picked;
}

function main() {
  if (!existsSync(INDEX)) fail(`evidence-index.json does not exist at ${INDEX}`);

  let cards;
  try {
    cards = JSON.parse(readFileSync(INDEX, 'utf8'));
  } catch (e) {
    fail(`evidence-index.json is not valid JSON: ${e.message}`);
  }

  if (!Array.isArray(cards)) fail(`evidence-index.json is not a flat array (got ${typeof cards})`);
  if (cards.length < MIN_CARDS) fail(`expected >= ${MIN_CARDS} cards, got ${cards.length}`);

  // Card shape validation.
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    for (const f of REQUIRED_FIELDS) {
      if (!(f in c)) fail(`card[${i}] (slug=${c.slug}) missing required field "${f}"`);
    }
    if (typeof c.slug !== 'string' || !c.slug) fail(`card[${i}] has invalid slug`);
    if (typeof c.customer !== 'string' || !c.customer) fail(`card[${i}] (${c.slug}) has invalid customer`);
    if (typeof c.metric !== 'string' || !c.metric) fail(`card[${i}] (${c.slug}) has invalid metric`);
    if (c.baseline !== null && typeof c.baseline !== 'string') fail(`card[${i}] (${c.slug}) baseline must be string|null`);
    if (typeof c.exact_quote !== 'string' || !c.exact_quote) fail(`card[${i}] (${c.slug}) has invalid exact_quote`);
    if (!Array.isArray(c.source_span) || c.source_span.length !== 2
        || typeof c.source_span[0] !== 'number' || typeof c.source_span[1] !== 'number') {
      fail(`card[${i}] (${c.slug}) source_span must be [number, number]`);
    }
    if (!VALID_CLAIM_TYPES.has(c.claim_type)) {
      fail(`card[${i}] (${c.slug}) invalid claim_type "${c.claim_type}"`);
    }
  }

  // Corpus cross-reference.
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const corpusBySlug = new Map(corpus.map((e) => [e.slug, e]));
  const orphanSlugs = new Set();
  for (const c of cards) {
    if (!corpusBySlug.has(c.slug)) orphanSlugs.add(c.slug);
  }
  if (orphanSlugs.size) fail(`${orphanSlugs.size} card slug(s) not in corpus: ${[...orphanSlugs].slice(0, 5).join(', ')}`);

  // Spot-check substring contract on N random cards.
  const spotChecked = pickRandom(cards, Math.min(SPOT_CHECK_N, cards.length));
  const spotFailures = [];
  for (const c of spotChecked) {
    const story = corpusBySlug.get(c.slug);
    const raw = story.raw_text;
    const [start, end] = c.source_span;
    if (start < 0 || end > raw.length || start >= end) {
      spotFailures.push(`${c.slug}: source_span [${start}, ${end}] out of range (raw_text len ${raw.length})`);
      continue;
    }
    const sliced = raw.slice(start, end);
    const normSliced = normalizeQuotes(sliced);
    const normQuote = normalizeQuotes(c.exact_quote);
    if (normSliced !== normQuote) {
      spotFailures.push(
        `${c.slug}: raw_text.slice(${start},${end}) does not match exact_quote\n` +
        `  expected: ${normQuote.slice(0, 100)}\n` +
        `  got:      ${normSliced.slice(0, 100)}`,
      );
    }
  }
  if (spotFailures.length) {
    console.error(`Spot-check substring contract violations (${spotFailures.length}/${spotChecked.length}):`);
    for (const f of spotFailures) console.error(`  - ${f}`);
    fail(`spot-check failed`);
  }

  // Summary.
  const stories = new Set(cards.map((c) => c.slug)).size;
  const byClaim = cards.reduce((acc, c) => { acc[c.claim_type] = (acc[c.claim_type] || 0) + 1; return acc; }, {});
  const withBaseline = cards.filter((c) => c.baseline !== null).length;
  console.log(`PASS: ${cards.length} cards across ${stories} stories (${corpus.length} stories in corpus)`);
  console.log(`  claim_type: ${Object.entries(byClaim).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  with baseline: ${withBaseline} (${((withBaseline / cards.length) * 100).toFixed(1)}%)`);
  console.log(`  spot-checked: ${spotChecked.length} cards, substring contract holds`);
}

main();
