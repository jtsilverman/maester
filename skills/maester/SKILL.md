---
name: maester
description: Extract structured evidence cards from one Stripe customer story's raw text. Each card pairs a customer-claimed metric with its verbatim source quote and a claim-type label, so downstream retrieval can rank evidence by specificity instead of grepping prose.
---

# Maester evidence extractor

Maester reads one Stripe customer story (the `raw_text` field of a row in `corpus/stripe-customers.json`) and emits a JSON array of **evidence cards**, one per measurable metric claim found in the story. A card is the unit of retrieval for the downstream Maester app: it pairs a metric with the exact sentence it came from so the marketer can verify the quote against the source page.

## Card shape

Each card has six fields:

| Field | Type | Meaning |
|---|---|---|
| `customer` | string | Who is making or subject to the claim. Usually the story's customer (e.g. `"Atlassian"`), but can be a person quoted inside the story. |
| `metric` | string | The measurable outcome. Must contain a number, a percentage, a multiplier, a duration, a count, or an unambiguous direction-of-change phrase. E.g. `"32% lift in subscription revenue"`, `"3x faster checkout"`, `"reduced fraud losses by half"`. |
| `baseline` | string \| null | What the metric is measured against, if stated. E.g. `"vs. prior billing system"`, `"year-over-year"`, `"compared to manual invoicing"`. `null` when the story does not state a baseline. |
| `exact_quote` | string | The verbatim sentence (or shortest verbatim span) from `raw_text` that contains the metric. No paraphrase. No edits. No ellipsis. |
| `source_span` | `[number, number]` | Character offsets into `raw_text` such that `raw_text.slice(start, end) === exact_quote`. Computed by the runner script via `indexOf`, not by the LLM. |
| `claim_type` | enum | `"customer-claimed"` (most stories), `"verified-by-source"` (Stripe's own measurement), or `"stripe-internal"` (Stripe-on-Stripe). |

## When to use

- Building or refreshing the corpus-wide evidence index (`corpus/evidence-index.json`) that the Maester app retrieves against.
- Spot-checking a single new customer story before merging into the corpus.
- Re-extracting one story after a prompt-tuning iteration.

## Interface

The skill ships a reference implementation at `scripts/extract-evidence.mjs`. Unit mode: one story in, evidence-card array out.

```bash
# stdin JSON: {slug, raw_text}
# stdout: JSON array of evidence cards
echo '{"slug":"atlassian","raw_text":"..."}' | node skills/maester/scripts/extract-evidence.mjs
```

The script:

1. Reads `{slug, raw_text}` from stdin.
2. Loads the extraction prompt verbatim from this SKILL.md (the fenced block tagged `# extraction-prompt` below — single source of truth).
3. Shells out `claude --print --model sonnet` with the prompt + raw_text as input, against the Claude Code subscription.
4. Tolerantly parses the LLM response as a JSON array (fenced ``` ```json ``` first, then balanced-bracket fallback) — handles the three known shapes LLMs return structured JSON in.
5. For each candidate card: computes `source_span` deterministically via `raw_text.indexOf(exact_quote)`. **Drops any card whose `exact_quote` is not a verbatim substring of `raw_text`** — that is the load-bearing semantic contract.
6. Emits valid cards as JSON to stdout; logs the count of dropped cards to stderr.

## Batch usage (chunk 3, not this skill's contract)

This skill is unit-mode by spec. The full-corpus run (524 stories → `evidence-index.json`) bundles ~50 stories per `claude --print` invocation to amortize the harness-boot overhead. That batch wrapper uses this same prompt as the source of truth but composes it differently; it does not call this unit script 524 times.

## Extraction prompt

This is the single source of truth for what counts as a valid evidence card. The runner script extracts the fenced block below by tag and feeds it to Claude verbatim. To tune extraction, edit this block — don't duplicate the prompt anywhere else.

```text # extraction-prompt
You are an evidence extractor for Stripe customer stories. Your job: read one customer story and emit a JSON array of evidence cards, one per measurable metric claim.

A measurable metric claim has all three:
1. A specific outcome (revenue, time, cost, count, rate, share, etc.).
2. A number, percentage, multiplier, duration, or unambiguous direction-of-change phrase.
3. A verbatim sentence (or sentence fragment) in the source text that contains it.

Examples of VALID metrics:
- "32% lift in subscription revenue"
- "reduced manual reconciliation time by 80%"
- "scaled to billions in recurring revenue"
- "doubled active users in six months"
- "cut chargebacks in half"

Examples of INVALID claims (skip these):
- "improved customer experience" — no measurable outcome
- "fast integration" — no number, no direction
- "best-in-class billing" — marketing language, no metric

For each valid metric, emit one card with these fields:
- customer: string — who is making or subject to the claim. Usually the story's customer name. If a Stripe customer is quoted talking about a third party, use the customer (Stripe's customer), not the third party.
- metric: string — the measurable outcome in plain language. 3-12 words. Keep the number/percentage/direction explicit.
- baseline: string or null — what the metric is measured against, if the source states it. Null when no baseline is given.
- exact_quote: string — the VERBATIM sentence from the source text that contains the metric. Must be a literal substring of the source. No paraphrase, no edits, no ellipsis, no quote-mark normalization. Copy character-for-character including any unusual punctuation, spacing, or HTML entities.
- claim_type: one of "customer-claimed" (customer says the metric, most common), "verified-by-source" (Stripe states the metric as a measurement, e.g. "Stripe Atlas helped X startups"), "stripe-internal" (Stripe is using its own product internally).

Output ONLY a JSON array. No prose. No commentary. No markdown fence. If you find no valid metrics, output [].

Be conservative — better to skip a borderline claim than to include one with a vague metric or a paraphrased quote. Extracting 0-2 strong cards is fine; extracting 6 weak ones is not.

Source text follows below the line.
---
```

## Testing

`scripts/test-maester.mjs` runs this skill against 3 fixture stories (Atlassian, Cursor, Figma) and asserts: each story produces ≥1 card; cards have all 6 fields with correct types; `raw_text.slice(source_span[0], source_span[1]) === exact_quote` for every card; at least one card per story has a numeric metric.

```bash
node scripts/test-maester.mjs
```

The test is integration (calls the real subscription via `claude --print`), ~3 invocations, ~1 minute wall clock.
