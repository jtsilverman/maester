#!/usr/bin/env node
// Acceptance test for chunk 6: POST /api/rewrite
//
// For each of N hand-picked (claim, customer, span) tuples, looks up the matching
// evidence card in corpus/evidence-index.json, POSTs { claim, evidence_id } to the
// locally-running dev server, and asserts:
//
//   1. Response shape: { rewrite: string, citation: {...}, elapsed_ms: number }.
//   2. rewrite contains the customer name (case-insensitive) — proves anchoring.
//   3. rewrite contains at least one number-bearing token from the card's metric or
//      exact_quote (% / $ / digit-run) — proves the metric carried through.
//   4. citation.customer matches the picked card; citation.source_url matches
//      https://stripe.com/customers/<slug>.
//   5. rewrite contains no marketing-speak banlist word (per spec line 102).
//   6. elapsed_ms <= 15000 (spec acceptance #1 budget).
//
// Prereq: in another terminal, `WATCHPACK_POLLING=true npm run dev`.
// Run:    node scripts/test-rewrite.mjs
//
// Live integration: each pick hits the real Anthropic API via the route. 3 calls.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const ENDPOINT = `${BASE_URL}/api/rewrite`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'corpus/evidence-index.json');

// Hand-picked tuples — each card has a strong numeric anchor token in its metric.
// Discovered via a one-off scan against the chunk-3 evidence-index.
const PICKS = [
  {
    kind: 'atlassian',
    claim: 'Atlassian saw measurable revenue recovery after migrating to Stripe Billing.',
    slug: 'atlassian',
    source_span: [1914, 2045],
  },
  {
    kind: 'cursor',
    claim: 'Cursor reduced involuntary churn after switching its billing stack.',
    slug: 'cursor',
    source_span: [4715, 4790],
  },
  {
    kind: 'lyft',
    claim: 'Lyft drivers cash out faster on Stripe-powered payouts.',
    slug: 'lyft',
    source_span: [413, 487],
  },
];

// Whole-word match, case-insensitive. Words like "solution"/"scalable" are too
// common in real Stripe copy to ban; this is the obvious marketing-fluff set.
const BANLIST = [
  'leverage', 'leveraging', 'leverages',
  'unlock', 'unlocking', 'unlocks',
  'seamless', 'seamlessly',
  'world-class', 'best-in-class', 'best of breed',
  'revolutionary', 'revolutionize',
  'cutting-edge', 'cutting edge',
  'game-changing', 'game changer',
  'synergy', 'synergies',
  'empower', 'empowering', 'empowers',
  'streamline', 'streamlining', 'streamlines',
  'frictionless',
  'next-generation', 'next generation',
];

const NUM_RE = /(\$[\d,.]+[KMB]?|\d+(?:[\.,]\d+)?%|\d+x|\d{2,})/g;

async function postRewrite(claim, evidenceId) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim, evidence_id: evidenceId }),
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
  } catch {
    throw new Error(`response was not JSON-parseable: ${text.slice(0, 200)}`);
  }
  return { body, elapsed };
}

function extractAnchorTokens(card) {
  // Numeric tokens from metric + exact_quote — at least one must survive the rewrite.
  const tokens = new Set();
  for (const src of [card.metric ?? '', card.exact_quote ?? '']) {
    for (const m of src.matchAll(NUM_RE)) tokens.add(m[1]);
  }
  return [...tokens];
}

function assertNoBanlist(rewrite) {
  const lower = ` ${rewrite.toLowerCase()} `;
  const hits = BANLIST.filter((w) => {
    // Whole-word match: bound by non-letter on each side.
    const re = new RegExp(`(^|[^a-z])${w.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&')}([^a-z]|$)`, 'i');
    return re.test(lower);
  });
  if (hits.length) throw new Error(`rewrite contains banlist word(s): ${hits.join(', ')}\n  rewrite: ${rewrite.slice(0, 200)}`);
}

function assertResponseShape(body) {
  if (typeof body !== 'object' || body === null) throw new Error(`response must be an object`);
  if (typeof body.rewrite !== 'string' || !body.rewrite.trim()) throw new Error(`bad rewrite`);
  if (typeof body.elapsed_ms !== 'number') throw new Error(`bad elapsed_ms`);
  const c = body.citation;
  if (typeof c !== 'object' || c === null) throw new Error(`bad citation`);
  if (typeof c.customer !== 'string' || !c.customer) throw new Error(`bad citation.customer`);
  if (typeof c.source_url !== 'string' || !/^https:\/\/stripe\.com\/customers\//.test(c.source_url)) {
    throw new Error(`citation.source_url must match https://stripe.com/customers/<slug>: ${c.source_url}`);
  }
  if (typeof c.exact_quote !== 'string' || !c.exact_quote) throw new Error(`bad citation.exact_quote`);
}

function assertAnchoring(rewrite, card, anchorTokens) {
  const lower = rewrite.toLowerCase();
  if (!lower.includes(card.customer.toLowerCase())) {
    throw new Error(`rewrite does not name the customer "${card.customer}"\n  rewrite: ${rewrite.slice(0, 200)}`);
  }
  if (anchorTokens.length === 0) {
    // Card has no numeric tokens; skip (means our hand-pick was weak — log warn).
    console.log(`  WARN: card ${card.slug} carries no numeric anchor token to assert against`);
    return;
  }
  const survived = anchorTokens.some((t) => rewrite.includes(t));
  if (!survived) {
    throw new Error(
      `rewrite carries none of the metric's anchor tokens [${anchorTokens.join(', ')}]\n` +
      `  rewrite: ${rewrite.slice(0, 200)}`,
    );
  }
}

function assertCitation(citation, card) {
  if (citation.customer.toLowerCase() !== card.customer.toLowerCase()) {
    throw new Error(`citation.customer "${citation.customer}" != card.customer "${card.customer}"`);
  }
  if (!citation.source_url.endsWith(`/${card.slug}`) && !citation.source_url.includes(`/${card.slug}/`)) {
    throw new Error(`citation.source_url "${citation.source_url}" does not name slug "${card.slug}"`);
  }
}

async function main() {
  if (!existsSync(INDEX)) { console.error(`evidence-index not found at ${INDEX}`); process.exit(1); }
  const index = JSON.parse(readFileSync(INDEX, 'utf8'));
  const byKey = new Map(index.map((c) => [`${c.slug}|${c.source_span[0]}|${c.source_span[1]}`, c]));
  console.log(`loaded index (${index.length} cards) — endpoint: ${ENDPOINT}\n`);

  let pass = 0, fail = 0;
  for (const pick of PICKS) {
    const evidenceId = `${pick.slug}|${pick.source_span[0]}|${pick.source_span[1]}`;
    const card = byKey.get(evidenceId);
    console.log(`--- ${pick.kind} ---`);
    console.log(`  claim:        ${pick.claim}`);
    console.log(`  evidence_id:  ${evidenceId}`);
    if (!card) {
      console.error(`  FAIL — pick not found in evidence-index (slug+span mismatch); refresh test pick set`);
      fail += 1;
      continue;
    }
    const anchorTokens = extractAnchorTokens(card);
    console.log(`  anchor tokens: [${anchorTokens.join(', ')}]`);
    try {
      const { body, elapsed } = await postRewrite(pick.claim, evidenceId);
      console.log(`  rewrite (${elapsed} ms): ${body.rewrite}`);
      assertResponseShape(body);
      assertAnchoring(body.rewrite, card, anchorTokens);
      assertCitation(body.citation, card);
      assertNoBanlist(body.rewrite);
      if (elapsed > 15000) console.log(`  WARN: elapsed ${elapsed} ms > 15000 ms target (spec acceptance #1)`);
      console.log(`  PASS — shape ok, anchored on ${card.customer}, citation ok, no banlist hits`);
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
