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

**Server layer** (chunks 4 + 6):

- `app/api/find-evidence/route.ts` — POST endpoint. Two-stage retrieval: (1) local token-overlap pre-filter ranks the 1,243-card index down to top 80 candidates; (2) `claude-sonnet-4-6` ranks the candidates and assigns `fit_score 0-100`. Returns augmented cards with `source_url`, `has_baseline`, `fit_score`. Empty-array response when nothing in the corpus matches.
- `app/api/rewrite/route.ts` — POST endpoint. Takes `{ claim, evidence_id }` (where `evidence_id` is the `slug|start|end` key of the picked card), asks `claude-sonnet-4-6` to rewrite the claim in Stripe voice anchored on that card's metric. Returns `{ rewrite, citation: { customer, source_url, exact_quote }, elapsed_ms }`. ~2s per call.
- Both endpoints follow producer-side validation per the belt-and-braces pattern: structured `<event>_fallback={reason}` logs for observability (banlist hits, missing customer, missing anchor token); consumer (test + UI) carries the contract.

**Why pre-filter, not full-index-cached.** First iteration shipped the full 1,243-card index in a cache-controlled Anthropic system block (~100k tokens). Cold-cache first-call latency hit ~5 min (undici's 300s headers timeout); reverted. Pre-filter is a constant-cost local step (~10ms over 1,243 cards), keeps per-call latency to ~5-10s for the LLM second pass.

**Polish** (chunk 7, shipped):

- 3 pre-loaded demo claim buttons above the textarea (Stripe-on-Stripe / Known customer / Vague-generic) for one-click reviewer onboarding.
- `middleware.ts` at root: per-IP daily counter; 11th request from same IP in 24h returns 200 with `{ easter_egg: true, message, cta_url, ... }`. UI swaps the evidence-cards section for a fourth-wall recruiting card (links to the Stripe FDA Marketing job posting + my email). Counter posture is recruiting hook, not 429 cost gate; a marketer using the demo at a realistic pace will never see it. Bot-floor protection only.
- Counter store DI seam at `lib/counter-store.ts`: Upstash Redis adapter (edge-runtime, REST-mode, via `@upstash/redis`) when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set in env; in-memory Map adapter otherwise (dev / fallback). Cost ceiling for runaway-script abuse is `DEMO_PAUSED=true` env-var kill-switch (manual, not automatic) — the Anthropic dashboard is the tripwire.
- Branding pass: indigo accent kept, tagline "Claim → evidence → Stripe-voice rewrite" above the title, demo-claim chip styling, cleaner heading hierarchy.

**Deploy** = chunk 8, pending.

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
- `npm run test:find-evidence` — 5-claim integration test against `/api/find-evidence` (real Anthropic calls).
- `npm run test:rewrite` — 3-pick integration test against `/api/rewrite` (real Anthropic calls).
- `npm run test:rate-wall` — 11-request rate-wall acceptance test (uses nonsense claim → no Anthropic calls). Counter state is per-process (in-memory) or per-day (Upstash); restart `npm run dev`, or pass a fresh `TEST_IP=...`, between runs.

## Spec

Live spec at `~/Documents/projects/Employment/specs/current.md`.
