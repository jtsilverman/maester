// POST /api/rewrite
//
// Takes { claim: string, evidence_id: "slug|start|end" }, looks up the picked
// evidence card in the same in-memory index chunks 3-4 already loaded, asks
// Claude to rewrite the claim in Stripe voice anchored on that card's metric,
// and returns { rewrite, citation, elapsed_ms }.
//
// Stripe voice rubric (encoded in the persona): named subject (the customer),
// specific verbs, economic specificity (carry a number from the metric), no
// marketing-speak banlist words.
//
// Non-streaming for chunk 6 — mirrors chunk 4's same deferral. The rewrite is
// short (~40 words), one Claude call, returns in 2-5s. Streaming adds parser
// complexity for negligible UX win at this length; revisit in chunk 7/8 polish
// if the smoke test surfaces a perceived-latency issue.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, 'corpus/evidence-index.json');
const CORPUS_PATH = path.join(ROOT, 'corpus/stripe-customers.json');
const MODEL = 'claude-sonnet-4-6';

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

const INDEX: IndexCard[] = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
const CORPUS: CorpusEntry[] = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
const URL_BY_SLUG = new Map(CORPUS.map((e) => [e.slug, e.url]));
const CARDS_BY_KEY = new Map(
  INDEX.map((c) => [`${c.slug}|${c.source_span[0]}|${c.source_span[1]}`, c]),
);

// Same banlist as scripts/test-rewrite.mjs — keep these two in sync.
const BANLIST = [
  'leverage', 'leveraging', 'leverages',
  'unlock', 'unlocking', 'unlocks',
  'seamless', 'seamlessly',
  'world-class', 'best-in-class',
  'revolutionary', 'revolutionize',
  'cutting-edge', 'game-changing',
  'synergy', 'synergies',
  'empower', 'empowering', 'empowers',
  'streamline', 'streamlining', 'streamlines',
  'frictionless',
  'next-generation',
];

const NUM_RE = /(\$[\d,.]+[KMB]?|\d+(?:[\.,]\d+)?%|\d+x|\d{2,})/g;

function buildPersona(card: IndexCard, claim: string): string {
  return [
    'You are a Stripe copy editor. A marketer wrote a vague claim and picked one piece of real Stripe-customer evidence to anchor it. Rewrite their sentence in Stripe voice.',
    '',
    'Rules:',
    `- Name the customer (${card.customer}) explicitly as the subject.`,
    '- Carry forward at least one specific number from the evidence verbatim (a percent, dollar amount, multiplier, or count).',
    '- Use specific verbs and concrete nouns. Avoid corporate marketing-speak.',
    '- Banned words: leverage, unlock, seamless, frictionless, empower, streamline, synergy, best-in-class, world-class, revolutionary, cutting-edge, game-changing, next-generation.',
    '- Keep it under 40 words total. One or two sentences.',
    '- Do NOT append a source citation, URL, or parenthetical attribution. The app handles citation separately.',
    '- Output only the rewritten sentence(s). No preamble, no quotes, no fences.',
    '',
    'Evidence:',
    `  customer: ${card.customer}`,
    `  metric:   ${card.metric}`,
    `  source quote: "${card.exact_quote}"`,
    '',
    `Original claim: ${claim}`,
  ].join('\n');
}

function stripWrap(text: string): string {
  // Claude occasionally returns the sentence wrapped in straight or curly quotes
  // despite "no quotes" in the prompt. Strip a single matching outer pair.
  const t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function findBanlistHits(rewrite: string): string[] {
  const lower = ` ${rewrite.toLowerCase()} `;
  return BANLIST.filter((w) => {
    const escaped = w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i');
    return re.test(lower);
  });
}

function carriesAnchorToken(rewrite: string, card: IndexCard): boolean {
  const tokens = new Set<string>();
  for (const src of [card.metric, card.exact_quote]) {
    for (const m of src.matchAll(NUM_RE)) tokens.add(m[1]);
  }
  if (tokens.size === 0) return true; // card has no numeric tokens; can't enforce
  return [...tokens].some((t) => rewrite.includes(t));
}

export async function POST(req: Request) {
  let body: { claim?: unknown; evidence_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const claim = body.claim;
  const evidenceId = body.evidence_id;
  if (typeof claim !== 'string' || !claim.trim()) {
    return Response.json({ error: 'claim_required' }, { status: 400 });
  }
  if (claim.length > 2000) {
    return Response.json({ error: 'claim_too_long' }, { status: 400 });
  }
  if (typeof evidenceId !== 'string' || !evidenceId.includes('|')) {
    return Response.json({ error: 'evidence_id_required' }, { status: 400 });
  }

  const card = CARDS_BY_KEY.get(evidenceId);
  if (!card) {
    console.warn(`rewrite_fallback=unknown_evidence_id id=${evidenceId.slice(0, 80)}`);
    return Response.json({ error: 'unknown_evidence' }, { status: 404 });
  }
  const sourceUrl = URL_BY_SLUG.get(card.slug);
  if (!sourceUrl) {
    console.error(`rewrite_fallback=missing_source_url slug=${card.slug}`);
    return Response.json({ error: 'server_misconfigured' }, { status: 500 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('rewrite_fallback=missing_api_key');
    return Response.json({ error: 'server_misconfigured' }, { status: 500 });
  }

  const t0 = Date.now();
  const client = new Anthropic({ apiKey });
  let raw: string;
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: buildPersona(card, claim.trim()),
      messages: [{ role: 'user', content: 'Rewrite the claim now.' }],
    });
    const block = msg.content[0];
    raw = block && block.type === 'text' ? block.text : '';
  } catch (e) {
    console.error(`rewrite_fallback=api_error reason=${(e as Error).message}`);
    return Response.json({ error: 'upstream_error' }, { status: 502 });
  }

  const rewrite = stripWrap(raw);
  if (!rewrite) {
    console.error('rewrite_fallback=empty_response');
    return Response.json({ error: 'empty_rewrite' }, { status: 502 });
  }

  // Producer-side observability per belt-and-braces pattern: structured warnings
  // when output drifts from the Stripe-voice rubric. We do NOT block on these —
  // the consumer (test + UI) carries the contract. Logs surface drift over time.
  const banHits = findBanlistHits(rewrite);
  if (banHits.length) {
    console.warn(`rewrite_fallback=banlist_hits words=${banHits.join(',')} rewrite=${rewrite.slice(0, 200)}`);
  }
  if (!rewrite.toLowerCase().includes(card.customer.toLowerCase())) {
    console.warn(`rewrite_fallback=missing_customer customer=${card.customer} rewrite=${rewrite.slice(0, 200)}`);
  }
  if (!carriesAnchorToken(rewrite, card)) {
    console.warn(`rewrite_fallback=missing_anchor_token slug=${card.slug} rewrite=${rewrite.slice(0, 200)}`);
  }

  const elapsed = Date.now() - t0;
  console.log(
    `rewrite ok slug=${card.slug} claim_len=${claim.length} rewrite_len=${rewrite.length} ` +
      `banlist=${banHits.length} elapsed_ms=${elapsed}`,
  );
  return Response.json({
    rewrite,
    citation: {
      customer: card.customer,
      source_url: sourceUrl,
      exact_quote: card.exact_quote,
    },
    elapsed_ms: elapsed,
  });
}
