#!/usr/bin/env node
// Acceptance test for chunk 4: POST /api/find-evidence
//
// Runs 5 representative claims against a locally-running Next.js dev server,
// asserts response shape, card shape, source URL pattern, and the substring
// verbatim-quote contract against corpus/stripe-customers.json.
//
// Prereq: in another terminal, `npm run dev` (or set BASE_URL).
// Run:    node scripts/test-find-evidence.mjs
//
// Live integration: each claim hits the real Anthropic API via the route. 5 calls.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const ENDPOINT = `${BASE_URL}/api/find-evidence`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, 'corpus/stripe-customers.json');
const INDEX = path.join(ROOT, 'corpus/evidence-index.json');

const CLAIMS = [
  { kind: 'stripe-on-stripe', claim: 'Stripe Billing helps subscription companies grow internationally.', min_cards: 3 },
  { kind: 'known-customer',   claim: 'Atlassian saw significant subscription revenue growth after migrating to Stripe Billing.', min_cards: 3 },
  { kind: 'vague-generic',    claim: 'Modern payment platforms drive higher conversion for SaaS.', min_cards: 3 },
  { kind: 'competitor-shape', claim: 'Switching from a legacy payment provider to a modern one boosts revenue.', min_cards: 3 },
  { kind: 'no-match',         claim: 'How to bake chocolate chip cookies at high altitude.', min_cards: 0 },
];

const VALID_CLAIM_TYPES = new Set(['customer-claimed', 'verified-by-source', 'stripe-internal']);
const REQUIRED_CARD_FIELDS = [
  'slug', 'customer', 'metric', 'baseline', 'exact_quote', 'source_span', 'claim_type',
  'source_url', 'has_baseline', 'fit_score',
];

// Same normalizer as chunks 2-3: curly quotes + en/em dashes + NBSP collapsed
// so the substring contract survives LLM-introduced typographic improvements.
function normalizeQuotes(s) {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ');
}

async function postClaim(claim) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim }),
    });
  } catch (e) {
    throw new Error(`POST failed (is the dev server running at ${BASE_URL}?): ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${ENDPOINT} returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  const elapsed = Date.now() - t0;
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new Error(`response body was not JSON-parseable: ${text.slice(0, 200)}`);
  }
  return { body, elapsed };
}

function assertCardShape(card) {
  for (const f of REQUIRED_CARD_FIELDS) {
    if (!(f in card)) throw new Error(`card missing field "${f}": ${JSON.stringify(card).slice(0, 200)}`);
  }
  if (typeof card.slug !== 'string' || !card.slug) throw new Error(`bad slug`);
  if (typeof card.customer !== 'string' || !card.customer) throw new Error(`bad customer`);
  if (typeof card.exact_quote !== 'string' || !card.exact_quote) throw new Error(`bad exact_quote`);
  if (typeof card.source_url !== 'string' || !/^https:\/\/stripe\.com\/customers\//.test(card.source_url)) {
    throw new Error(`source_url must match https://stripe.com/customers/<slug>: ${card.source_url}`);
  }
  if (typeof card.has_baseline !== 'boolean') throw new Error(`has_baseline must be boolean`);
  if (typeof card.fit_score !== 'number' || card.fit_score < 0 || card.fit_score > 100) {
    throw new Error(`fit_score must be number 0-100: ${card.fit_score}`);
  }
  if (!VALID_CLAIM_TYPES.has(card.claim_type)) throw new Error(`bad claim_type: ${card.claim_type}`);
  if (!Array.isArray(card.source_span) || card.source_span.length !== 2) throw new Error(`bad source_span shape`);
}

function assertVerbatimQuote(card, corpusBySlug) {
  const story = corpusBySlug.get(card.slug);
  if (!story) throw new Error(`card slug "${card.slug}" not in corpus`);
  const [start, end] = card.source_span;
  if (start < 0 || end > story.raw_text.length || start >= end) {
    throw new Error(`source_span [${start},${end}] out of range for ${card.slug} (raw_text len ${story.raw_text.length})`);
  }
  const sliced = story.raw_text.slice(start, end);
  if (normalizeQuotes(sliced) !== normalizeQuotes(card.exact_quote)) {
    throw new Error(
      `verbatim-quote contract violated for ${card.slug}:\n` +
      `  exact_quote:        ${JSON.stringify(card.exact_quote.slice(0, 100))}\n` +
      `  raw_text[${start}:${end}]: ${JSON.stringify(sliced.slice(0, 100))}`,
    );
  }
}

async function main() {
  if (!existsSync(CORPUS)) { console.error(`corpus not found at ${CORPUS}`); process.exit(1); }
  if (!existsSync(INDEX))  { console.error(`evidence-index not found at ${INDEX}`); process.exit(1); }
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const corpusBySlug = new Map(corpus.map((e) => [e.slug, e]));
  console.log(`loaded corpus (${corpus.length} stories) — endpoint: ${ENDPOINT}\n`);

  let pass = 0, fail = 0;
  for (const { kind, claim, min_cards } of CLAIMS) {
    console.log(`--- ${kind} ---`);
    console.log(`  claim: ${claim}`);
    try {
      const { body, elapsed } = await postClaim(claim);
      const cards = Array.isArray(body) ? body : body.cards;
      if (!Array.isArray(cards)) throw new Error(`response must contain cards array, got ${JSON.stringify(body).slice(0, 200)}`);
      console.log(`  cards: ${cards.length} (${elapsed} ms)`);
      if (cards.length < min_cards) {
        throw new Error(`expected >= ${min_cards} cards for ${kind}, got ${cards.length}`);
      }
      for (const card of cards) {
        assertCardShape(card);
        assertVerbatimQuote(card, corpusBySlug);
      }
      if (elapsed > 15000) console.log(`  WARN: elapsed ${elapsed} ms > 15000 ms target (spec acceptance #1)`);
      console.log(`  PASS — shape ok, verbatim contract holds`);
      pass += 1;
    } catch (e) {
      console.error(`  FAIL — ${e.message}`);
      fail += 1;
    }
  }
  console.log(`\n=== ${pass} pass / ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
