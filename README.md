# Maester

Evidence-anchored marketing claim assistant for Stripe customer stories. A PMM pastes a vague marketing claim; Maester surfaces ranked evidence cards from a corpus of real published Stripe customer stories (verbatim metrics + source URLs), and (chunk 6) rewrites the claim in Stripe voice anchored on the chosen evidence.

Built as a portfolio centerpiece for the Stripe Forward Deployed AI Accelerator, Marketing role.

## Architecture

```
+----------------+      POST /api/find-evidence       +----------------------+
| Browser UI     |  ───────────────────────────────▶  | Next.js App Router   |
| (chunk 5)      |                                    | (Vercel, serverless) |
|                |  ◀───────────────────────────────  |                      |
+----------------+      { cards: [...] }              +----------+-----------+
                                                                 │
                                                                 │ (1) pre-filter top 80
                                                                 ▼
                                                    +------------+------------+
                                                    | evidence-index.json     |
                                                    | (1,243 cards, in-memory)|
                                                    +------------+------------+
                                                                 │
                                                                 │ (2) rank top 5
                                                                 ▼
                                                    +------------+------------+
                                                    | Anthropic Messages API  |
                                                    | claude-sonnet-4-6       |
                                                    +-------------------------+
```

**Data layer** (chunks 1–3, shipped):

- `corpus/stripe-customers.json` (524 stories, ~7.4 MB) — raw scrape of `stripe.com/customers/*` pages with `{slug, customer, url, raw_text, ...}`. Static snapshot, regenerated only via `npm run scrape`.
- `corpus/evidence-index.json` (1,243 cards across 458 stories) — structured metric extractions per story. Each card: `{slug, customer, metric, baseline, exact_quote, source_span, claim_type}`. Built by `scripts/build-evidence-index.mjs` + `scripts/retry-evidence-index.mjs` running the `maester` Claude Code skill across the corpus.

**Server layer** (chunk 4, this commit):

- `app/api/find-evidence/route.ts` — POST endpoint. Two-stage retrieval: (1) local token-overlap pre-filter ranks the 1,243-card index down to top 80 candidates; (2) `claude-sonnet-4-6` ranks the candidates and assigns `fit_score 0-100`. Returns augmented cards with `source_url`, `has_baseline`, `fit_score`. Empty-array response when nothing in the corpus matches.
- Producer-side validation drops invalid picks (unknown slug, bad shape, duplicate) with structured `find_evidence_fallback={reason}` logs; consumer-side guarantees downstream contract.

**Why pre-filter, not full-index-cached.** First iteration shipped the full 1,243-card index in a cache-controlled Anthropic system block (~100k tokens). Cold-cache first-call latency hit ~5 min (undici's 300s headers timeout); reverted. Pre-filter is a constant-cost local step (~10ms over 1,243 cards), keeps per-call latency to ~5-10s for the LLM second pass.

**UI + rewrite + polish + deploy** = chunks 5-8, pending.

## Local dev

```
cp .env.example .env.local            # fill in ANTHROPIC_API_KEY
WATCHPACK_POLLING=true npm run dev    # polling watcher; default FSEvents is fragile on Syncthing-watched paths
npm run test:find-evidence            # 5-claim acceptance test against localhost:3000
```

## Scripts

- `npm run dev` — Next.js dev server.
- `npm run build` / `npm start` — production build + serve.
- `npm run scrape` — re-scrape the Stripe customers corpus.
- `npm run test:corpus` — validate `corpus/stripe-customers.json`.
- `npm run test:index` — validate `corpus/evidence-index.json` (shape + 20-card substring-quote spot check).
- `npm run test:find-evidence` — 5-claim integration test against the route (real Anthropic calls).

## Spec

Live spec at `~/Documents/projects/Employment/specs/current.md`.
