#!/usr/bin/env node
// Acceptance test for chunk 7 abuse-protection-as-recruiting-hook.
//
// Posture: this is NOT a 429 / cost-ceiling test. The wall is reframed as a
// fourth-wall recruiting hook — a reviewer using the demo hard enough to trip
// it sees an "if Maester feels like the right kind of tool, give me an
// interview" card instead of evidence. So the 11th request must still return
// status 200, just with { easter_egg: true } body and no cards.
//
// 11 requests from a single x-forwarded-for IP:
//   attempts 1..10 → 200, { cards: [...] }
//   attempt  11    → 200, { easter_egg: true, ... }
//
// Prereqs:
//   - dev server running locally: `npm run dev` (port 3000)
//   - counter state per-process / per-IP; a fresh `npm run dev` resets it
//     (in-memory adapter), OR Upstash is wired and the test IP key has
//     been flushed for the day.
//
// Run: node scripts/test-rate-wall.mjs

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const ENDPOINT = `${BASE_URL}/api/find-evidence`;
// RFC5737 documentation IP — never a real client, safe to use in tests
const TEST_IP = process.env.TEST_IP ?? '203.0.113.42';
const ALLOWED = 10; // first 10 allowed; 11th trips
// Nonsense claim: chosen so the chunk-4 pre-filter scores it at 0 against
// the entire 1,243-card index and the route short-circuits with
// { cards: [], no_match: true } BEFORE calling Anthropic. The rate-wall
// test is about middleware behavior, not retrieval — keep it fast and free,
// and crucially decoupled from the Anthropic API key being valid.
const CLAIM = 'Xyzzy plugh fnord quux blorple grault wibble flarp.';

async function postClaim(ip) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ claim: CLAIM }),
    });
  } catch (e) {
    throw new Error(`POST failed (is dev server running at ${BASE_URL}?): ${e.message}`);
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, elapsed: Date.now() - t0, raw: text };
}

function fmtBody(body, raw) {
  if (body !== null) return JSON.stringify(body).slice(0, 140);
  return (raw ?? '').slice(0, 140);
}

async function main() {
  console.log(`endpoint: ${ENDPOINT}`);
  console.log(`test ip:  ${TEST_IP}`);
  console.log(`allowed:  ${ALLOWED} (11th request must trip easter_egg)\n`);
  console.log(`NOTE: counter state is per-process (in-memory dev adapter) or per-day`);
  console.log(`      (Upstash). To reset: restart dev server, OR delete the day's key`);
  console.log(`      in Upstash for this IP.\n`);

  let pass = 0, fail = 0;
  for (let i = 1; i <= ALLOWED + 1; i++) {
    const expectEgg = i > ALLOWED;
    const result = await postClaim(TEST_IP);
    const isEgg = result.body && result.body.easter_egg === true;
    const label = `attempt ${i.toString().padStart(2)}/${ALLOWED + 1}`;

    if (expectEgg) {
      if (result.status === 200 && isEgg) {
        console.log(`  PASS  ${label} — easter_egg=true (${result.elapsed} ms)`);
        pass += 1;
      } else {
        console.error(
          `  FAIL  ${label} — expected easter_egg=true 200, got status=${result.status} body=${fmtBody(result.body, result.raw)}`,
        );
        fail += 1;
      }
    } else {
      const hasCards = result.body && Array.isArray(result.body.cards);
      if (result.status === 200 && !isEgg && hasCards) {
        console.log(`  PASS  ${label} — cards=${result.body.cards.length} (${result.elapsed} ms)`);
        pass += 1;
      } else {
        console.error(
          `  FAIL  ${label} — expected normal cards, got status=${result.status} body=${fmtBody(result.body, result.raw)}`,
        );
        fail += 1;
      }
    }
  }
  console.log(`\n=== ${pass} pass / ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
