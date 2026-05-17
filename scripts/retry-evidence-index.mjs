#!/usr/bin/env node
// Chunk 3 retry runner: re-processes stories that the main batch runner missed.
// Reasons for misses: parse failure on the bundle's claude output, or Claude
// returning a response that omitted some input slugs. The main runner records
// both in tmp/bundles/*.json (as `error` or `missing_slugs`).
//
// Strategy: bundle the missed stories in groups of RETRY_BUNDLE_SIZE (default
// 10 — half the main run's 20, to reduce output volume per call) and call
// claude --print per bundle. Results land in tmp/retry-bundles/<idx>.json.
// Then concatenate every tmp/bundles/*.json and tmp/retry-bundles/*.json into
// the final corpus/evidence-index.json, dedup'd by (slug, source_span).
//
// Env overrides:
//   RETRY_BUNDLE_SIZE=10        stories per retry call
//   MODEL=claude-sonnet-4-6[1m]
//   TIMEOUT_MS=2400000          per-bundle subprocess timeout (default 40 min)
//   RESET=0                     1 = wipe tmp/retry-bundles/ before starting
//
// Run: node scripts/retry-evidence-index.mjs

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
const MAIN_BUNDLES_DIR = path.join(ROOT, 'tmp/bundles');
const RETRY_BUNDLES_DIR = path.join(ROOT, 'tmp/retry-bundles');

const RETRY_BUNDLE_SIZE = parseInt(process.env.RETRY_BUNDLE_SIZE || '10', 10);
const MODEL = process.env.MODEL || 'claude-sonnet-4-6[1m]';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || String(40 * 60 * 1000), 10);
const RESET = process.env.RESET === '1';

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
  if (result.error) return { ok: false, error: `spawn: ${result.error.message}`, elapsedMs };
  if (result.status !== 0) {
    return { ok: false, error: `claude exited ${result.status}: ${result.stderr.slice(0, 800)}`, elapsedMs };
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
    } catch (e) { /* fall through */ }
  }
  const start = text.indexOf('[');
  if (start === -1) throw new Error(`No JSON array found: ${text.slice(0, 300)}`);
  let depth = 0, inString = false, escape = false;
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
  throw new Error(`Unbalanced brackets: ${text.slice(start, start + 300)}`);
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
  for (const card of rawCards || []) {
    if (typeof card !== 'object' || card === null) continue;
    let missing = false;
    for (const f of REQUIRED_LLM_FIELDS) { if (!(f in card)) { missing = true; break; } }
    if (missing) continue;
    if (typeof card.customer !== 'string' || !card.customer) continue;
    if (typeof card.metric !== 'string' || !card.metric) continue;
    if (card.baseline !== null && typeof card.baseline !== 'string') continue;
    if (typeof card.exact_quote !== 'string' || !card.exact_quote) continue;
    if (!VALID_CLAIM_TYPES.has(card.claim_type)) continue;
    const span = findVerbatimSpan(story.raw_text, card.exact_quote);
    if (span === null) continue;
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
  return valid;
}

function findMissedSlugs() {
  const missed = new Set();
  const files = readdirSync(MAIN_BUNDLES_DIR).filter((f) => /^\d{3}\.json$/.test(f));
  for (const f of files) {
    const data = JSON.parse(readFileSync(path.join(MAIN_BUNDLES_DIR, f), 'utf8'));
    const got = new Set((data.cards || []).map((c) => c.slug));
    for (const slug of data.slugs || []) {
      if (!got.has(slug)) missed.add(slug);
    }
  }
  return [...missed].sort();
}

function main() {
  mkdirSync(RETRY_BUNDLES_DIR, { recursive: true });
  if (RESET) {
    rmSync(RETRY_BUNDLES_DIR, { recursive: true, force: true });
    mkdirSync(RETRY_BUNDLES_DIR, { recursive: true });
  }

  const missedSlugs = findMissedSlugs();
  console.log(`identified ${missedSlugs.length} missed slugs from ${MAIN_BUNDLES_DIR}`);

  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const corpusBySlug = new Map(corpus.map((e) => [e.slug, e]));
  const missedStories = missedSlugs
    .map((s) => corpusBySlug.get(s))
    .filter((s) => s && typeof s.raw_text === 'string' && s.raw_text.length >= 200);
  console.log(`${missedStories.length} of those have raw_text >= 200 chars`);

  const extractionPrompt = loadExtractionPrompt();
  const bundles = [];
  for (let i = 0; i < missedStories.length; i += RETRY_BUNDLE_SIZE) {
    bundles.push(missedStories.slice(i, i + RETRY_BUNDLE_SIZE));
  }
  console.log(`retry: ${bundles.length} bundles of up to ${RETRY_BUNDLE_SIZE} stories\n`);

  for (let i = 0; i < bundles.length; i++) {
    const outFile = path.join(RETRY_BUNDLES_DIR, `${String(i).padStart(3, '0')}.json`);
    if (existsSync(outFile)) {
      console.log(`retry ${i}: skipping (already exists)`);
      continue;
    }
    const bundle = bundles[i];
    const slugs = bundle.map((s) => s.slug);
    const prompt = buildBundledPrompt(extractionPrompt, bundle);
    const promptKB = (prompt.length / 1024).toFixed(1);
    console.log(`retry ${i}: ${bundle.length} stories, prompt ${promptKB} KB`);

    const r = callClaude(prompt);
    const elapsedSec = (r.elapsedMs / 1000).toFixed(1);
    if (!r.ok) {
      console.error(`retry ${i}: FAILED in ${elapsedSec}s: ${r.error}`);
      writeFileSync(outFile, JSON.stringify({ retry_idx: i, slugs, error: r.error, cards: [], elapsed_sec: parseFloat(elapsedSec) }, null, 2));
      continue;
    }

    let parsed;
    try { parsed = extractJsonArray(r.stdout); }
    catch (e) {
      const error = `parse fail: ${e.message}`;
      console.error(`retry ${i}: ${error}`);
      writeFileSync(outFile, JSON.stringify({ retry_idx: i, slugs, error, raw_stdout_head: r.stdout.slice(0, 1500), cards: [], elapsed_sec: parseFloat(elapsedSec) }, null, 2));
      continue;
    }

    const bySlug = new Map();
    for (const entry of parsed) {
      if (!entry || typeof entry.slug !== 'string') continue;
      bySlug.set(entry.slug, entry.cards || entry.evidence_cards || []);
    }
    const allValid = [];
    const missingSlugs = [];
    for (const story of bundle) {
      if (!bySlug.has(story.slug)) { missingSlugs.push(story.slug); continue; }
      allValid.push(...validateAndAnnotate(bySlug.get(story.slug), story));
    }
    console.log(
      `retry ${i}: OK in ${elapsedSec}s — ${allValid.length} valid cards from ${bundle.length} stories` +
      (missingSlugs.length ? ` — MISSING in response: ${missingSlugs.length}` : ''),
    );
    writeFileSync(outFile, JSON.stringify({
      retry_idx: i, slugs, cards: allValid, missing_slugs: missingSlugs, elapsed_sec: parseFloat(elapsedSec),
    }, null, 2));
  }

  // Rebuild the index from both main bundles + retry bundles, dedup'd by (slug, source_span).
  const seen = new Set();
  const allCards = [];
  const mainFiles = readdirSync(MAIN_BUNDLES_DIR).filter((f) => /^\d{3}\.json$/.test(f)).sort();
  const retryFiles = readdirSync(RETRY_BUNDLES_DIR).filter((f) => /^\d{3}\.json$/.test(f)).sort();
  for (const f of mainFiles) {
    const data = JSON.parse(readFileSync(path.join(MAIN_BUNDLES_DIR, f), 'utf8'));
    for (const c of data.cards || []) {
      const key = `${c.slug}|${c.source_span[0]}|${c.source_span[1]}`;
      if (!seen.has(key)) { seen.add(key); allCards.push(c); }
    }
  }
  for (const f of retryFiles) {
    const data = JSON.parse(readFileSync(path.join(RETRY_BUNDLES_DIR, f), 'utf8'));
    for (const c of data.cards || []) {
      const key = `${c.slug}|${c.source_span[0]}|${c.source_span[1]}`;
      if (!seen.has(key)) { seen.add(key); allCards.push(c); }
    }
  }

  const tmpOut = INDEX_OUT + '.tmp';
  writeFileSync(tmpOut, JSON.stringify(allCards, null, 2));
  renameSync(tmpOut, INDEX_OUT);
  const sizeKB = (Buffer.byteLength(JSON.stringify(allCards)) / 1024).toFixed(1);
  const uniqueStories = new Set(allCards.map((c) => c.slug)).size;
  console.log(`\nwrote ${INDEX_OUT}: ${allCards.length} cards (~${sizeKB} KB) across ${uniqueStories} stories`);
}

main();
