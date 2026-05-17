# Chunk 5 — Page UI acceptance checklist

Manual + Playwright-driven live-integration acceptance for `app/page.tsx`. Failing-test artifact per chunk 5 (per spec § Test strategy: "Frontend: manual testing in browser. Mobile (iPhone) + desktop.").

## How to run

1. `WATCHPACK_POLLING=true npm run dev` (the polling flag avoids the FSEvents EINTR loop on Syncthing-watched paths, documented in chunk 4 README).
2. Open `http://localhost:3000` in Chrome.
3. Walk the checklist below at desktop width (≥1024px) and again at mobile width (~390px iPhone).
4. The "live integration" section runs a real API call to `/api/find-evidence` which hits the Anthropic API. Account quota applies.

## Visible structure (page load, before submit)

- [ ] Page title "Maester" visible
- [ ] One-line description of what the tool does (e.g., "Evidence-anchored marketing claim assistant for Stripe customer stories")
- [ ] Claim textarea: multi-line, ~3-row height, placeholder text suggests the shape of a claim
- [ ] Submit button: visible, labeled (e.g., "Find evidence")
- [ ] Submit button: disabled when textarea is empty or whitespace-only
- [ ] Submit button: enabled when textarea has non-whitespace content
- [ ] No card area visible yet (empty initial state)

## Submit flow (happy path)

- [ ] Click submit → loading indicator appears (spinner or "Finding evidence..." text)
- [ ] Textarea + submit button disabled during loading
- [ ] On successful response: cards render in the results area
- [ ] On successful response: loading indicator disappears, controls re-enabled
- [ ] User can submit a new claim after results land (form is reusable, not single-shot)

## Submit flow (edge states)

- [ ] Empty result set ("no matches" claim): "No evidence found" message shown, no cards
- [ ] Error response (e.g., backend down): error message visible, retry possible
- [ ] Long claim (~500 chars): textarea grows or scrolls, submit still works
- [ ] Re-submit same claim: previous cards clear or are replaced cleanly

## Each evidence card shows

- [ ] Customer name (prominent — bold, h-level, or color emphasis)
- [ ] Verbatim quote (clearly marked as a quote: blockquote indent, quote marks, or italic)
- [ ] Source link: clickable, opens `https://stripe.com/customers/<slug>` in a new tab (`target="_blank"`)
- [ ] `claim_type` badge: pill/chip, distinct visual for `customer-claimed` vs `verified-by-source`
- [ ] `has_baseline` badge: pill/chip, distinct visual for `true` vs `false` (e.g., "has baseline" vs "no baseline")
- [ ] `fit_score` bar: horizontal fill, 0-100 scale, numeric score visible

## Layout (responsive)

- [ ] Desktop (≥1024px): comfortable max-width (~720-960px), centered, cards in a single column with breathing room
- [ ] Tablet (~768px): same single-column layout, readable
- [ ] Mobile (~390px iPhone): single column, touch-friendly button size (≥44px tap target), readable type (≥16px body), no horizontal scroll
- [ ] Cards adapt: long quotes wrap, badges stay on one line or wrap cleanly, fit bar full-width within card

## Live integration

Paste a real claim, click submit, observe.

- [ ] **Stripe-on-Stripe claim** ("Stripe Billing helps subscription companies grow internationally"): ≥3 cards render in <15s with real customer names from the corpus (e.g., Atlassian, Cursor, Figma)
- [ ] Each rendered card's `source_url` links to a real `stripe.com/customers/<slug>` page (spot-check by clicking one)
- [ ] **Noise claim** ("cookies at high altitude"): tool gracefully returns no/few cards, message is appropriate

## RED state (pre-implementation)

Run this checklist against the current scaffold page. Expected: almost everything fails. The scaffold has only "Maester" title + a curl-suggestion paragraph. No textarea, no button, no cards, no API call.

## GREEN state (post-implementation)

Every checkbox above passes on both desktop and mobile widths.
