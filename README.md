# Maester

**Anchor a marketing claim in real Stripe customer evidence.** Paste a draft sentence; get specific, source-attributed metrics from real Stripe customer stories. Click a card to get the claim rewritten in Stripe voice, cited.

**Live demo:** `https://<pending-chunk-8-deploy>.vercel.app`

![Maester — empty state](docs/screenshot-empty.png)

## Why this exists

Built as a portfolio centerpiece for Stripe's [Forward Deployed AI Accelerator, Marketing](https://stripe.com/jobs/listing/forward-deployed-ai-accelerator-marketing/7747638) role.

The FDA pattern in one paragraph: observe a real workflow, build a focused tool that compresses it, document it as a reusable Claude Code skill, wrap it in a UI a non-technical operator can use. Maester is that pattern applied to a real Stripe PMM workflow — **evidence-anchoring marketing claims** — compressed from a ~30-minute manual loop (claim → search stripe.com/customers → copy quote → tighten sentence) to ~30 seconds. The tool stops where storytelling begins; the marketer keeps voice, angle, and narrative judgment.

## Try one of these

The deployed app pre-loads three demo claims (Stripe-on-Stripe / Known customer / Vague-generic). Pick one and hit **Find evidence**:

- _"Stripe Billing helps subscription companies grow internationally."_
- _"Atlassian saw significant subscription revenue growth after migrating to Stripe Billing."_
- _"Modern payment platforms drive higher conversion for SaaS."_

Or paste anything else. Empty matches (claim has nothing to anchor in the public Stripe corpus) get a graceful "no matches" state.

![Maester — evidence cards + rewrite](docs/screenshot-result.png)

## How it works

Corpus: **524 published Stripe customer stories** (scraped snapshot of `stripe.com/customers`), distilled offline by a Claude Code skill into **1,243 evidence cards** with verbatim metric quotes + character spans into the source text. Each card carries its claim type (`customer-claimed` vs `verified-by-source`) and baseline presence (`has-baseline` vs `missing-baseline`).

At request time:

1. A local token-overlap pre-filter ranks the 1,243-card index down to top 80 candidates in ~10ms.
2. `claude-sonnet-4-6` ranks the 80 and assigns each a `fit_score 0–100`.
3. The UI streams cards back, each linking to its `stripe.com/customers/<slug>` source for verification.
4. Click any card → `claude-sonnet-4-6` rewrites the original claim anchored on that card's metric in Stripe voice (named subject, one numeric token carried verbatim, fluff banlist, ≤40 words).

End-to-end per claim: ~5–10s for evidence, ~2s for rewrite.

```
+----------------+      POST /api/find-evidence       +----------------------+
| Browser UI     |  ───────────────────────────────▶  | Next.js App Router   |
|                |                                    | (Vercel, edge + node)|
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
                                                                 │ (2) LLM-rank top 5
                                                                 ▼
                                                    +------------+------------+
                                                    | Anthropic Messages API  |
                                                    | claude-sonnet-4-6       |
                                                    +-------------------------+
```

## What's in the repo

**Data layer** (chunks 1–3):

- `corpus/stripe-customers.json` (524 stories, ~7.4 MB) — raw scrape of `stripe.com/customers/*` pages. Static snapshot, regenerated only via `npm run scrape`.
- `corpus/evidence-index.json` (1,243 cards across 458 stories) — structured metric extractions. Built by `scripts/build-evidence-index.mjs` + `scripts/retry-evidence-index.mjs` running the `maester` skill across the corpus.
- `skills/maester/SKILL.md` — the per-story extraction prompt, runnable standalone as a Claude Code skill (the single source of truth; the batch runners awk-extract it).

**Server layer** (chunks 4 + 6):

- `app/api/find-evidence/route.ts` — two-stage retrieval (pre-filter + LLM rank).
- `app/api/rewrite/route.ts` — claim rewrite anchored on a chosen card.
- Both follow a belt-and-braces validation pattern: producer-side `<event>_fallback={reason}` logs for observability, consumer-side contract enforcement.

**Polish layer** (chunk 7):

- 3 pre-loaded demo claim chips above the textarea.
- `middleware.ts` per-IP daily counter; the 11th request returns an "if Maester feels like the right kind of tool, give me an interview" easter-egg card instead of a 429 (the wall is a recruiting hook, not a cost gate). Threshold is bot-floor, not human-ceiling — a marketer using the tool at any realistic pace never sees it.
- `lib/counter-store.ts` — DI seam between in-memory `Map` (dev) and Upstash Redis REST (prod). Edge-runtime compatible.

**Why pre-filter, not full-index-cached.** First iteration shipped the full 1,243-card index in a cache-controlled Anthropic system block (~100k tokens). Cold-cache first-call latency hit ~5 min (undici's 300s headers timeout); reverted. Pre-filter is constant-cost (~10ms) and keeps per-call latency to ~5–10s for the LLM second pass.

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
- `npm run test:rate-wall` — 11-request rate-wall acceptance test (uses a pre-filter-short-circuiting nonsense claim → no Anthropic calls).
- `npm run test:smoke` — production smoke test. `MAESTER_URL=https://... npm run test:smoke`; optionally also exports `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` to verify the counter key landed.

## Tech stack

Next.js 15 (App Router) · React 19 · Tailwind v4 · Anthropic Messages API (`claude-sonnet-4-6`) · Upstash Redis REST · Vercel (edge middleware + node runtime).

## Author

Jake Silverman · [jakesilverman.pro@gmail.com](mailto:jakesilverman.pro@gmail.com)
