// POST /api/find-evidence
//
// Takes { claim: string }, asks Claude to rank the most relevant evidence cards
// against the claim, returns { cards: [...] } with up to 5 ranked cards.
//
// Two-stage retrieval:
//   1. Local pre-filter: token-overlap score against (customer + metric + exact_quote).
//      Top N=80 candidates go to the LLM; cards with score 0 don't.
//      If best score is 0, return { cards: [] } without calling the API at all.
//   2. LLM ranks the candidates and assigns fit_score 0-100.
//
// Earlier iteration sent the full 1,243-card index in a cached system block
// (~100k tokens). First-call latency hit 5 min (undici headersTimeout); reverted.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, 'corpus/evidence-index.json');
const CORPUS_PATH = path.join(ROOT, 'corpus/stripe-customers.json');
const MODEL = 'claude-sonnet-4-6';
const TOP_N = 5;
const CANDIDATE_N = 80;
const VALID_CLAIM_TYPES = new Set(['customer-claimed', 'verified-by-source', 'stripe-internal']);

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','of','to','in','on','at','by','for','with','from','as',
  'is','are','was','were','be','been','being','has','have','had','do','does','did','will','would',
  'can','could','should','may','might','must','this','that','these','those','it','its','their','our',
  'we','you','your','his','her','they','them','i','me','my','him','she','he','what','which','who',
  'how','why','when','where','very','much','more','most','some','any','all','no','not','than','about',
  'into','out','up','down','over','under','also','just','only',
]);

type IndexCard = {
  slug: string;
  customer: string;
  metric: string;
  baseline: string | null;
  exact_quote: string;
  source_span: [number, number];
  claim_type: string;
};

type CorpusEntry = { slug: string; url: string; customer: string };

type RankedPick = {
  slug: string;
  source_span: [number, number];
  fit_score: number;
  reason?: string;
};

type ResponseCard = IndexCard & {
  source_url: string;
  has_baseline: boolean;
  fit_score: number;
  reason?: string;
};

// Load once at module init (server-side).
const INDEX: IndexCard[] = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
const CORPUS: CorpusEntry[] = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
const URL_BY_SLUG = new Map(CORPUS.map((e) => [e.slug, e.url]));
const CARDS_BY_KEY = new Map(INDEX.map((c) => [`${c.slug}|${c.source_span[0]}|${c.source_span[1]}`, c]));

// Pre-tokenize each card's searchable text once at boot so per-request scoring is cheap.
const CARD_TOKENS: Set<string>[] = INDEX.map((c) =>
  tokenize(`${c.customer} ${c.metric} ${c.exact_quote}`),
);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 3 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

function preFilter(claim: string): { cards: IndexCard[]; bestScore: number } {
  const claimTokens = tokenize(claim);
  if (claimTokens.size === 0) return { cards: [], bestScore: 0 };
  const scored: { idx: number; score: number }[] = [];
  for (let i = 0; i < INDEX.length; i++) {
    let score = 0;
    for (const tok of claimTokens) if (CARD_TOKENS[i].has(tok)) score += 1;
    if (score > 0) scored.push({ idx: i, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, CANDIDATE_N);
  return {
    cards: top.map((s) => INDEX[s.idx]),
    bestScore: scored[0]?.score ?? 0,
  };
}

const PERSONA = [
  'You are an evidence retrieval tool for Stripe marketing copy.',
  '',
  'Given a marketing claim from a Stripe PMM and a list of candidate evidence cards from real Stripe customer stories, rank the cards that BEST back up the claim. A good ranking favors:',
  '  1. Specific quantitative metrics (numbers, percentages, dollar amounts) over vague language.',
  '  2. Customers whose situation or product matches the claim\'s subject.',
  '  3. Cards where the verbatim quote directly supports the claim\'s assertion.',
  '  4. Verified-by-source claims over customer-claimed, all else equal.',
  '',
  'Return up to ' + TOP_N + ' cards. If NOTHING in the candidates plausibly supports the claim, return an empty array.',
  '',
  'Output format: a JSON array of objects, each with:',
  '  - slug: the card\'s slug (must match a candidate exactly)',
  '  - source_span: the card\'s [start, end] source_span (must match a candidate exactly, two integers)',
  '  - fit_score: integer 0-100 (how strongly this card backs the claim)',
  '  - reason: one short sentence on why this card fits',
  '',
  'Do not invent slugs. Do not modify source_span values. Output only the JSON array; no prose, no fence, no commentary.',
].join('\n');

// Tolerant JSON-array extractor: try fenced first, then balanced-bracket fallback.
function extractJsonArray(text: string): unknown[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (Array.isArray(parsed)) return parsed;
        } catch {}
        return null;
      }
    }
  }
  return null;
}

// Producer validation per belt-and-braces pattern: drop picks that don't match
// a real candidate, have bad shape, or are duplicates. Reasons logged for
// observability.
function validatePicks(picks: unknown[], candidateKeys: Set<string>): { picks: RankedPick[]; dropped: string[] } {
  const out: RankedPick[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const p of picks) {
    if (typeof p !== 'object' || p === null) { dropped.push('not_object'); continue; }
    const o = p as Record<string, unknown>;
    const slug = o.slug;
    const span = o.source_span;
    const score = o.fit_score;
    if (typeof slug !== 'string') { dropped.push('bad_slug_type'); continue; }
    if (!Array.isArray(span) || span.length !== 2 || typeof span[0] !== 'number' || typeof span[1] !== 'number') {
      dropped.push(`bad_span_shape:${slug}`); continue;
    }
    if (typeof score !== 'number' || score < 0 || score > 100) {
      dropped.push(`bad_fit_score:${slug}:${score}`); continue;
    }
    const key = `${slug}|${span[0]}|${span[1]}`;
    if (!candidateKeys.has(key)) { dropped.push(`unknown_card:${key}`); continue; }
    if (seen.has(key)) { dropped.push(`duplicate:${key}`); continue; }
    seen.add(key);
    out.push({
      slug,
      source_span: [span[0], span[1]],
      fit_score: Math.round(score),
      reason: typeof o.reason === 'string' ? o.reason : undefined,
    });
  }
  return { picks: out.slice(0, TOP_N), dropped };
}

function augment(pick: RankedPick): ResponseCard | null {
  const key = `${pick.slug}|${pick.source_span[0]}|${pick.source_span[1]}`;
  const card = CARDS_BY_KEY.get(key);
  const source_url = URL_BY_SLUG.get(pick.slug);
  if (!card || !source_url) return null;
  if (!VALID_CLAIM_TYPES.has(card.claim_type)) return null;
  return {
    ...card,
    source_url,
    has_baseline: card.baseline !== null,
    fit_score: pick.fit_score,
    reason: pick.reason,
  };
}

export async function POST(req: Request) {
  let body: { claim?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const claim = body.claim;
  if (typeof claim !== 'string' || !claim.trim()) {
    return Response.json({ error: 'claim_required' }, { status: 400 });
  }
  if (claim.length > 2000) {
    return Response.json({ error: 'claim_too_long' }, { status: 400 });
  }

  const t0 = Date.now();
  const { cards: candidates, bestScore } = preFilter(claim);
  if (bestScore === 0 || candidates.length === 0) {
    console.log(`find_evidence ok claim_len=${claim.length} no_match=true elapsed_ms=${Date.now() - t0}`);
    return Response.json({ cards: [], no_match: true, elapsed_ms: Date.now() - t0 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('find_evidence_fallback=missing_api_key');
    return Response.json({ error: 'server_misconfigured' }, { status: 500 });
  }

  const client = new Anthropic({ apiKey });
  const candidateKeys = new Set(candidates.map((c) => `${c.slug}|${c.source_span[0]}|${c.source_span[1]}`));
  const userMessage = `Marketing claim:\n${claim}\n\nCandidate evidence cards (${candidates.length}):\n${JSON.stringify(candidates)}`;

  let raw: string;
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: PERSONA,
      messages: [{ role: 'user', content: userMessage }],
    });
    const block = msg.content[0];
    raw = block && block.type === 'text' ? block.text : '';
  } catch (e) {
    console.error(`find_evidence_fallback=api_error reason=${(e as Error).message}`);
    return Response.json({ error: 'upstream_error' }, { status: 502 });
  }

  const picks = extractJsonArray(raw);
  if (!picks) {
    console.error(`find_evidence_fallback=parse_error raw=${raw.slice(0, 200)}`);
    return Response.json({ cards: [], parse_error: true }, { status: 200 });
  }

  const { picks: clean, dropped } = validatePicks(picks, candidateKeys);
  if (dropped.length) {
    console.warn(`find_evidence_fallback=validation_drops count=${dropped.length} reasons=${dropped.slice(0, 5).join(',')}`);
  }

  const cards = clean.map(augment).filter((c): c is ResponseCard => c !== null);

  const elapsed = Date.now() - t0;
  console.log(`find_evidence ok claim_len=${claim.length} candidates=${candidates.length} picks_raw=${picks.length} cards=${cards.length} dropped=${dropped.length} elapsed_ms=${elapsed}`);
  return Response.json({ cards, elapsed_ms: elapsed });
}
