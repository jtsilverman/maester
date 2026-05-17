#!/usr/bin/env node
// Acceptance test for the maester skill: runs the extractor against 3 fixture
// stories from corpus/stripe-customers.json and asserts the verbatim-quote
// contract holds (every emitted exact_quote is the literal substring of
// raw_text at the returned source_span).
//
// Run: node scripts/test-maester.mjs
//
// Integration test: extractor shells out to `claude --print --model sonnet`
// against the Claude Code subscription. ~3 calls, ~1 min total.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, 'corpus/stripe-customers.json');
const EXTRACTOR = path.join(ROOT, 'skills/maester/scripts/extract-evidence.mjs');

const FIXTURE_SLUGS = ['atlassian', 'cursor', 'figma'];
const REQUIRED_FIELDS = ['customer', 'metric', 'baseline', 'exact_quote', 'source_span', 'claim_type'];
const VALID_CLAIM_TYPES = new Set(['customer-claimed', 'verified-by-source', 'stripe-internal']);

function loadFixture(corpus, needle) {
  const entry = corpus.find((e) => e.slug.toLowerCase().includes(needle));
  if (!entry) throw new Error(`No corpus entry matching slug "${needle}"`);
  return entry;
}

function runExtractor(story) {
  const result = spawnSync('node', [EXTRACTOR], {
    input: JSON.stringify({ slug: story.slug, raw_text: story.raw_text }),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Extractor exited with status ${result.status} on ${story.slug}\n` +
      `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  let cards;
  try {
    cards = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`Extractor stdout was not valid JSON for ${story.slug}: ${result.stdout.slice(0, 400)}`);
  }
  if (!Array.isArray(cards)) {
    throw new Error(`Extractor output for ${story.slug} was not an array`);
  }
  return { cards, stderr: result.stderr };
}

function assertCardShape(card, story) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in card)) {
      throw new Error(`Card missing field "${field}" for ${story.slug}: ${JSON.stringify(card)}`);
    }
  }
  if (typeof card.customer !== 'string' || !card.customer) throw new Error(`Bad customer in ${story.slug}`);
  if (typeof card.metric !== 'string' || !card.metric) throw new Error(`Bad metric in ${story.slug}`);
  if (card.baseline !== null && typeof card.baseline !== 'string') {
    throw new Error(`Bad baseline (must be string|null) in ${story.slug}: ${JSON.stringify(card.baseline)}`);
  }
  if (typeof card.exact_quote !== 'string' || !card.exact_quote) throw new Error(`Bad exact_quote in ${story.slug}`);
  if (!Array.isArray(card.source_span) || card.source_span.length !== 2) {
    throw new Error(`Bad source_span shape in ${story.slug}: ${JSON.stringify(card.source_span)}`);
  }
  const [start, end] = card.source_span;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new Error(`Bad source_span values in ${story.slug}: [${start}, ${end}]`);
  }
  if (!VALID_CLAIM_TYPES.has(card.claim_type)) {
    throw new Error(`Bad claim_type in ${story.slug}: ${card.claim_type}`);
  }
}

function assertVerbatimQuote(card, story) {
  const [start, end] = card.source_span;
  const actual = story.raw_text.slice(start, end);
  if (actual !== card.exact_quote) {
    throw new Error(
      `Verbatim-quote contract violated for ${story.slug}:\n` +
      `  exact_quote (len ${card.exact_quote.length}): ${JSON.stringify(card.exact_quote.slice(0, 120))}\n` +
      `  raw_text[${start}:${end}] (len ${actual.length}): ${JSON.stringify(actual.slice(0, 120))}`,
    );
  }
}

function assertNumericMetric(cards, story) {
  const hasNumber = cards.some((c) => /\d/.test(c.metric));
  if (!hasNumber) {
    throw new Error(`No card with numeric metric for ${story.slug}; got: ${cards.map((c) => c.metric).join(' | ')}`);
  }
}

async function main() {
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  console.log(`loaded corpus: ${corpus.length} entries`);

  let pass = 0;
  let fail = 0;
  for (const needle of FIXTURE_SLUGS) {
    const story = loadFixture(corpus, needle);
    console.log(`\n--- ${story.slug} (raw_text ${story.raw_text.length} chars) ---`);
    try {
      const { cards, stderr } = runExtractor(story);
      if (stderr.trim()) console.log(`  stderr: ${stderr.trim().split('\n').slice(0, 3).join(' | ')}`);
      if (cards.length < 1) throw new Error(`Extractor returned 0 cards for ${story.slug}`);
      console.log(`  cards: ${cards.length}`);
      for (const card of cards) {
        assertCardShape(card, story);
        assertVerbatimQuote(card, story);
      }
      assertNumericMetric(cards, story);
      console.log(`  PASS — shape ok, verbatim contract holds, numeric metric present`);
      pass += 1;
    } catch (e) {
      console.error(`  FAIL — ${e.message}`);
      fail += 1;
    }
  }

  console.log(`\n=== ${pass} pass / ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
