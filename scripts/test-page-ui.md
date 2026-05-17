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

---

# Chunk 6 — Rewrite mode UI acceptance checklist

Manual + Playwright-driven live-integration acceptance for the rewrite mode in
`app/page.tsx`. Failing-test artifact per chunk 6 (per spec § Test strategy:
"Frontend: manual testing in browser. Mobile (iPhone) + desktop.").

## How to run

Same as chunk 5: `WATCHPACK_POLLING=true npm run dev`, open `http://localhost:3000`.

## Per-card interaction

- [ ] Each evidence card now carries a "Rewrite my claim using this" button
- [ ] Button has a touch-friendly tap target (≥36px high)
- [ ] Hovering or clicking a card does NOT trigger the source link (link `onClick` is `stopPropagation`'d)
- [ ] Clicking "Rewrite my claim using this" highlights the selected card (indigo border + ring)
- [ ] Selected card's button text flips to "Rewrite with this" (active state)
- [ ] Other cards retain "Rewrite my claim using this" label

## Rewrite panel (appears below cards after a card is clicked)

- [ ] Section header "Rewrite"
- [ ] Side-by-side layout: "Your draft" on the left, "Stripe-voice rewrite" on the right (desktop)
- [ ] Stacks vertically on mobile (sm: breakpoint at 640px)
- [ ] Spinner + "Rewriting…" copy during the API call
- [ ] On success: rewrite paragraph + "Source: <Customer> customer story ↗" link to the stripe.com page
- [ ] Source link opens `https://stripe.com/customers/<slug>` in a new tab
- [ ] On error: red error message visible, no crashed UI

## Card-swap behavior

- [ ] Clicking a different card replaces the rewrite (does not stack)
- [ ] Previous card's button reverts to "Rewrite my claim using this"
- [ ] New card's button becomes active "Rewrite with this"
- [ ] Spinner reappears briefly during the second API call
- [ ] New rewrite uses the second card's customer + metric

## Live integration

- [ ] **Stripe-on-Stripe claim** → click any card → rewrite returns in ≤5s with the customer named + a metric token from the card carried verbatim
- [ ] Click a second card → rewrite swaps cleanly, anchored on the second card's evidence
- [ ] **Rapid clicks** on multiple cards: only the most-recently-clicked card's rewrite displays (no stale results race)
- [ ] Banlist check: rewrite contains no `leverage / unlock / seamless / streamline / empower / synergy / etc.` (visual scan or check server log for `rewrite_fallback=banlist_hits` line)

## RED state (pre-implementation)

Run this checklist against the chunk 5 page. Expected: cards render but no
"Rewrite" button per card, no rewrite panel.

## GREEN state (post-implementation)

Every checkbox above passes on both desktop and mobile widths. Logged GREEN run
2026-05-17: claim "Stripe Billing helps subscription companies grow
internationally" → 5 cards in ~12s → clicked Moon Holidays → rewrite carried
"600%" + "Southeast Asia" in 2.2s → clicked Artlogic → rewrite swapped cleanly
with "72%" + "European sales" in 2.0s. Mobile 390px width: panel stacked
vertically, all controls reachable.
