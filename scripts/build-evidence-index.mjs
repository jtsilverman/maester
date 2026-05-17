#!/usr/bin/env node
// Chunk 3 batch runner: applies the maester skill across every entry in
// corpus/stripe-customers.json and writes corpus/evidence-index.json — a flat
// array of evidence cards, each tagged with its source story slug.
//
// Design:
//   - Bundles BUNDLE_SIZE stories per `claude --print` invocation to amortize
//     the ~50k cache_creation tokens per call. Bundled prompt asks Claude to
//     return [{slug, cards: [...]}, ...] so the runner can demux by slug.
//   - Per-bundle resumability: each bundle writes tmp/bundles/<idx>.json on
//     completion (success or failure). Re-running skips bundles whose file
//     already exists. Delete tmp/bundles/ to start fresh.
//   - Failure isolation: a failed bundle does not lose 50 stories — its tmp
//     file records {error, slugs, cards: []} and the runner continues.
//   - Atomic final write: tmp/evidence-index.json.tmp → rename to canonical
//     path so partial JSON is never visible to consumers.
//
// Env overrides:
//   BUNDLE_SIZE=50        stories per claude --print invocation
//   FIRST_N=0             0 = all stories; N = only first N (for smoke runs)
//   BUNDLE_LIMIT=0        0 = all bundles; N = stop after N bundles
//   MODEL=claude-sonnet-4-6[1m]   1M-context Sonnet
//   TIMEOUT_MS=1200000    per-bundle subprocess timeout (default 20 min)
//   RESET=0               1 = wipe tmp/bundles/ before starting
//
// Run:
//   FIRST_N=5 node scripts/build-evidence-index.mjs   # smoke test
//   node scripts/build-evidence-index.mjs             # full corpus

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, 'corpus/stripe-customers.json');
const SKILL_MD = path.join(ROOT, 'skills/maester/SKILL.md');
const INDEX_OUT = path.join(ROOT, 'corpus/evidence-index.json');
const BUNDLES_DIR = path.join(ROOT, 'tmp/bundles');

const BUNDLE_SIZE = parseInt(process.env.BUNDLE_SIZE || '50', 10);
const FIRST_N = parseInt(process.env.FIRST_N || '0', 10);
const BUNDLE_LIMIT = parseInt(process.env.BUNDLE_LIMIT || '0', 10);
const MODEL = process.env.MODEL || 'claude-sonnet-4-6[1m]';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || String(20 * 60 * 1000), 10);
const RESET = process.env.RESET === '1';
const MIN_RAW_TEXT = 200;

const REQUIRED_LLM_FIELDS = ['customer', 'metric', 'baseline', 'exact_quote', 'claim_type'];
const VALID_CLAIM_TYPES = new Set(['customer-claimed', 'verified-by-source', 'stripe-internal']);

function loadExtractionPrompt() {
  const skill = readFileSync(SKILL_MD, 'utf8');
  const re = /```[a-z]*\s*#\s*extraction-prompt\s*\n([\s\S]*?)\n```/;
  const m = skill.match(re);
  if (!m) throw new Error(`Could not find extraction-prompt block in ${SKILL_MD}`);
  return m[1].trim();
}

function buildBundledPrompt(extractionPrompt, stories) {
  const header = `You will be given ${stories.length} customer stories. Apply the extraction process below to EACH story independently and return ONE JSON array with one entry per story, in the same order:

[
  {"slug": "<story-1-slug>", "cards": [<card>, <card>, ...]},
  {"slug": "<story-2-slug>", "cards": [<card>, ...]},
  ...
]

If a story yields no valid metrics, return "cards": [] for that story. Every story slug from the input MUST appear in the output array exactly once. Output ONLY the JSON array, no preamble, no markdown fence, no commentary.

=== EXTRACTION PROCESS (apply to each story below) ===

${extractionPrompt}

=== END EXTRACTION PROCESS ===

=== STORIES ===
`;
  const body = stories.map((s, i) => {
    return `\n--- STORY ${i + 1} OF ${stories.length} (slug: ${s.slug}) ---\n${s.raw_text}\n--- END STORY ${i + 1} (slug: ${s.slug}) ---\n`;
  }).join('');
  return header + body;
}

function callClaude(fullPrompt) {
  const t0 = Date.now();
  const result = spawnSync('claude', ['--print', '--model', MODEL], {
    input: fullPrompt,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - t0;
  if (result.error) {
    return { ok: false, error: `spawn: ${result.error.message}`, elapsedMs };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `claude exited ${result.status}: ${result.stderr.slice(0, 800)}`,
      stdout: result.stdout.slice(0, 800),
      elapsedMs,
    };
  }
  return { ok: true, stdout: result.stdout, elapsedMs };
}

function extractJsonArray(text) {
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/;
  const fenceMatch = text.match(fenceRe);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // fall through
    }
  }
  const start = text.indexOf('[');
  if (start === -1) throw new Error(`No JSON array found in LLM output: ${text.slice(0, 300)}`);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        const parsed = JSON.parse(slice);
        if (!Array.isArray(parsed)) throw new Error(`Parsed value is not an array`);
        return parsed;
      }
    }
  }
  throw new Error(`Unbalanced brackets in LLM output: ${text.slice(start, start + 300)}`);
}

function normalizeQuotes(s) {
  return s
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ');
}

function findVerbatimSpan(rawText, llmQuote) {
  const direct = rawText.indexOf(llmQuote);
  if (direct !== -1) return [direct, direct + llmQuote.length];
  const normRaw = normalizeQuotes(rawText);
  const normQuote = normalizeQuotes(llmQuote);
  if (normQuote.length !== llmQuote.length) return null;
  const idx = normRaw.indexOf(normQuote);
  if (idx === -1) return null;
  return [idx, idx + normQuote.length];
}

function validateAndAnnotate(rawCards, story) {
  const valid = [];
  const drops = { missing_field: 0, bad_type: 0, bad_claim_type: 0, quote_not_substring: 0 };
  for (const card of rawCards || []) {
    if (typeof card !== 'object' || card === null) { drops.bad_type++; continue; }
    let missing = false;
    for (const f of REQUIRED_LLM_FIELDS) {
      if (!(f in card)) { missing = true; break; }
    }
    if (missing) { drops.missing_field++; continue; }
    if (typeof card.customer !== 'string' || !card.customer) { drops.bad_type++; continue; }
    if (typeof card.metric !== 'string' || !card.metric) { drops.bad_type++; continue; }
    if (card.baseline !== null && typeof card.baseline !== 'string') { drops.bad_type++; continue; }
    if (typeof card.exact_quote !== 'string' || !card.exact_quote) { drops.bad_type++; continue; }
    if (!VALID_CLAIM_TYPES.has(card.claim_type)) { drops.bad_claim_type++; continue; }
    const span = findVerbatimSpan(story.raw_text, card.exact_quote);
    if (span === null) { drops.quote_not_substring++; continue; }
    const [start, end] = span;
    valid.push({
      slug: story.slug,
      customer: card.customer,
      metric: card.metric,
      baseline: card.baseline,
      exact_quote: story.raw_text.slice(start, end),
      source_span: [start, end],
      claim_type: card.claim_type,
    });
  }
  return { valid, drops };
}

function bundleFilePath(idx) {
  return path.join(BUNDLES_DIR, `${String(idx).padStart(3, '0')}.json`);
}

function processBundle(idx, stories, extractionPrompt) {
  const outFile = bundleFilePath(idx);
  if (existsSync(outFile)) {
    const existing = JSON.parse(readFileSync(outFile, 'utf8'));
    return { skipped: true, idx, cards: existing.cards || [], error: existing.error || null };
  }

  const slugs = stories.map((s) => s.slug);
  const prompt = buildBundledPrompt(extractionPrompt, stories);
  const promptKB = (prompt.length / 1024).toFixed(1);
  console.log(`bundle ${idx}: ${stories.length} stories, prompt ${promptKB} KB, calling claude --print --model ${MODEL}`);

  const r = callClaude(prompt);
  const elapsedSec = (r.elapsedMs / 1000).toFixed(1);
  if (!r.ok) {
    console.error(`bundle ${idx}: FAILED in ${elapsedSec}s: ${r.error}`);
    writeFileSync(outFile, JSON.stringify({ bundle_idx: idx, slugs, error: r.error, cards: [], elapsed_sec: parseFloat(elapsedSec) }, null, 2));
    return { skipped: false, idx, cards: [], error: r.error };
  }

  let parsed;
  try {
    parsed = extractJsonArray(r.stdout);
  } catch (e) {
    const error = `parse fail: ${e.message}`;
    console.error(`bundle ${idx}: ${error}`);
    writeFileSync(outFile, JSON.stringify({ bundle_idx: idx, slugs, error, raw_stdout_head: r.stdout.slice(0, 1500), cards: [], elapsed_sec: parseFloat(elapsedSec) }, null, 2));
    return { skipped: false, idx, cards: [], error };
  }

  const bySlug = new Map();
  for (const entry of parsed) {
    if (!entry || typeof entry.slug !== 'string') continue;
    const rawCards = entry.cards || entry.evidence_cards || [];
    bySlug.set(entry.slug, rawCards);
  }

  const allValid = [];
  const dropsAgg = { missing_field: 0, bad_type: 0, bad_claim_type: 0, quote_not_substring: 0 };
  const missingSlugs = [];
  for (const story of stories) {
    if (!bySlug.has(story.slug)) {
      missingSlugs.push(story.slug);
      continue;
    }
    const { valid, drops } = validateAndAnnotate(bySlug.get(story.slug), story);
    allValid.push(...valid);
    for (const k of Object.keys(dropsAgg)) dropsAgg[k] += drops[k];
  }
  const cardsPerStory = (allValid.length / stories.length).toFixed(2);
  console.log(
    `bundle ${idx}: OK in ${elapsedSec}s — ${allValid.length} valid cards from ${stories.length} stories (${cardsPerStory}/story)` +
    (missingSlugs.length ? ` — MISSING in response: ${missingSlugs.length}` : '') +
    ` — drops: ${dropsAgg.missing_field}mf/${dropsAgg.bad_type}bt/${dropsAgg.bad_claim_type}bc/${dropsAgg.quote_not_substring}qns`,
  );

  writeFileSync(outFile, JSON.stringify({
    bundle_idx: idx,
    slugs,
    cards: allValid,
    drops: dropsAgg,
    missing_slugs: missingSlugs,
    elapsed_sec: parseFloat(elapsedSec),
  }, null, 2));
  return { skipped: false, idx, cards: allValid, error: null };
}

function main() {
  if (!existsSync(CORPUS)) { console.error(`corpus not found: ${CORPUS}`); process.exit(2); }
  mkdirSync(BUNDLES_DIR, { recursive: true });

  if (RESET) {
    console.log(`RESET=1 — wiping ${BUNDLES_DIR}`);
    rmSync(BUNDLES_DIR, { recursive: true, force: true });
    mkdirSync(BUNDLES_DIR, { recursive: true });
  }

  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const stories = corpus.filter((s) => typeof s.raw_text === 'string' && s.raw_text.length >= MIN_RAW_TEXT);
  const slice = FIRST_N > 0 ? stories.slice(0, FIRST_N) : stories;
  console.log(`corpus: ${corpus.length} total, ${stories.length} after raw_text>=${MIN_RAW_TEXT} filter, ${slice.length} after FIRST_N`);

  const extractionPrompt = loadExtractionPrompt();
  const bundles = [];
  for (let i = 0; i < slice.length; i += BUNDLE_SIZE) {
    bundles.push(slice.slice(i, i + BUNDLE_SIZE));
  }
  const bundleCount = BUNDLE_LIMIT > 0 ? Math.min(BUNDLE_LIMIT, bundles.length) : bundles.length;
  console.log(`bundling: ${bundles.length} bundles of up to ${BUNDLE_SIZE} stories; processing ${bundleCount}`);

  const results = [];
  for (let i = 0; i < bundleCount; i++) {
    results.push(processBundle(i, bundles[i], extractionPrompt));
  }

  // Concatenate every bundle file currently on disk (including previously-completed runs)
  // so partial reruns produce a complete index.
  const allCards = [];
  const failedBundles = [];
  const bundleFiles = readdirSync(BUNDLES_DIR).filter((f) => /^\d{3}\.json$/.test(f)).sort();
  for (const f of bundleFiles) {
    const data = JSON.parse(readFileSync(path.join(BUNDLES_DIR, f), 'utf8'));
    if (data.error) failedBundles.push({ file: f, error: data.error });
    allCards.push(...(data.cards || []));
  }

  const tmpOut = INDEX_OUT + '.tmp';
  writeFileSync(tmpOut, JSON.stringify(allCards, null, 2));
  renameSync(tmpOut, INDEX_OUT);
  const sizeKB = (Buffer.byteLength(JSON.stringify(allCards)) / 1024).toFixed(1);
  console.log(`\nwrote ${INDEX_OUT}: ${allCards.length} cards (~${sizeKB} KB) from ${bundleFiles.length} bundle files`);
  if (failedBundles.length) {
    console.log(`failed bundles: ${failedBundles.length} (rerun the script to retry; the runner skips completed bundles by default — delete the failing tmp/bundles/*.json files first to retry them)`);
    for (const f of failedBundles) console.log(`  - ${f.file}: ${f.error.slice(0, 160)}`);
  }
}

main();
