#!/usr/bin/env node
// Maester evidence extractor — unit mode.
//
// stdin:  JSON {slug, raw_text}
// stdout: JSON array of evidence cards (per SKILL.md card shape)
// stderr: counts of dropped cards (verbatim-quote contract violations)
//
// Shells out `claude --print --model sonnet` against the Claude Code
// subscription. The extraction prompt is loaded from skills/maester/SKILL.md
// (single source of truth — the fenced block tagged `# extraction-prompt`).

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_MD = path.resolve(__dirname, '..', 'SKILL.md');

const REQUIRED_LLM_FIELDS = ['customer', 'metric', 'baseline', 'exact_quote', 'claim_type'];
const VALID_CLAIM_TYPES = new Set(['customer-claimed', 'verified-by-source', 'stripe-internal']);

function readStdin() {
  return readFileSync(0, 'utf8');
}

function loadExtractionPrompt() {
  const skill = readFileSync(SKILL_MD, 'utf8');
  // Match the fenced block tagged "# extraction-prompt":
  //   ```text # extraction-prompt
  //   ...prompt body...
  //   ```
  const re = /```[a-z]*\s*#\s*extraction-prompt\s*\n([\s\S]*?)\n```/;
  const m = skill.match(re);
  if (!m) throw new Error(`Could not find extraction-prompt block in ${SKILL_MD}`);
  return m[1].trim();
}

function callClaude(fullPrompt) {
  const result = spawnSync('claude', ['--print', '--model', 'sonnet'], {
    input: fullPrompt,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Failed to spawn claude: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`claude --print exited ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout.slice(0, 500)}`);
  }
  return result.stdout;
}

// Tolerant JSON-array extractor: handles ```json fence, bare ``` fence, plain
// top-level array, and balanced-bracket arrays embedded in prose. Returns the
// parsed array or throws.
function extractJsonArray(text) {
  // Try fenced first.
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/;
  const fenceMatch = text.match(fenceRe);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // fall through to balanced-bracket
    }
  }
  // Balanced-bracket: find the first '[', walk depth, parse the substring
  // when depth returns to 0.
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

// Normalize typographic punctuation that LLMs commonly "improve" when echoing
// back. Each replaced character is single-code-unit so offsets stay aligned
// 1:1 between the normalized and original strings.
function normalizeQuotes(s) {
  return s
    .replace(/[‘’′]/g, "'")  // curly single quotes, prime
    .replace(/[“”″]/g, '"')  // curly double quotes, double prime
    .replace(/[–—]/g, '-')        // en dash, em dash
    .replace(/ /g, ' ');               // non-breaking space
}

function findVerbatimSpan(rawText, llmQuote) {
  // Fast path: literal substring.
  const direct = rawText.indexOf(llmQuote);
  if (direct !== -1) return [direct, direct + llmQuote.length];
  // Tolerant path: normalize curly punctuation, find in normalized rawText,
  // map the offset back to the original (1:1 by construction).
  const normRaw = normalizeQuotes(rawText);
  const normQuote = normalizeQuotes(llmQuote);
  if (normQuote.length !== llmQuote.length) return null;  // safety net
  const idx = normRaw.indexOf(normQuote);
  if (idx === -1) return null;
  return [idx, idx + normQuote.length];
}

function validateAndAnnotate(rawCards, rawText, slug) {
  const valid = [];
  const drops = { missing_field: 0, bad_type: 0, bad_claim_type: 0, quote_not_substring: 0 };
  const droppedQuotes = [];
  for (const card of rawCards) {
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
    const span = findVerbatimSpan(rawText, card.exact_quote);
    if (span === null) {
      drops.quote_not_substring++;
      droppedQuotes.push(card.exact_quote.slice(0, 120));
      continue;
    }
    const [start, end] = span;
    valid.push({
      customer: card.customer,
      metric: card.metric,
      baseline: card.baseline,
      exact_quote: rawText.slice(start, end),  // canonical raw_text span
      source_span: [start, end],
      claim_type: card.claim_type,
    });
  }
  const droppedTotal = drops.missing_field + drops.bad_type + drops.bad_claim_type + drops.quote_not_substring;
  if (droppedTotal > 0) {
    console.error(
      `[maester:${slug}] dropped ${droppedTotal} card(s): ` +
      `${drops.missing_field} missing_field, ${drops.bad_type} bad_type, ` +
      `${drops.bad_claim_type} bad_claim_type, ${drops.quote_not_substring} quote_not_substring`,
    );
    for (const q of droppedQuotes) {
      console.error(`[maester:${slug}]   dropped quote: ${JSON.stringify(q)}`);
    }
  }
  return valid;
}

async function main() {
  const input = readStdin();
  let story;
  try {
    story = JSON.parse(input);
  } catch (e) {
    console.error(`Failed to parse stdin as JSON: ${e.message}`);
    process.exit(2);
  }
  if (!story || typeof story.raw_text !== 'string' || !story.raw_text) {
    console.error(`stdin must be JSON {slug, raw_text}; got: ${JSON.stringify(story).slice(0, 200)}`);
    process.exit(2);
  }
  const slug = story.slug || '<no-slug>';

  const promptHeader = loadExtractionPrompt();
  const fullPrompt = `${promptHeader}\n\n${story.raw_text}\n`;

  const llmText = callClaude(fullPrompt);
  let rawCards;
  try {
    rawCards = extractJsonArray(llmText);
  } catch (e) {
    console.error(`[maester:${slug}] JSON parse failed: ${e.message}`);
    console.error(`[maester:${slug}] LLM output head: ${llmText.slice(0, 500)}`);
    process.exit(1);
  }

  const validCards = validateAndAnnotate(rawCards, story.raw_text, slug);
  process.stdout.write(JSON.stringify(validCards, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
