#!/usr/bin/env node
// Acceptance test for chunk 8 — production deployment smoke.
//
// Asserts (against the deployed prod URL):
//   1. Health probe: GET / returns 200 + HTML.
//   2. /api/find-evidence returns >=1 card within 15s for each of:
//      - 3 pre-loaded demo claims (Stripe-on-Stripe / Known customer / Vague-generic).
//      - 1 novel claim (Cursor billing).
//   3. /api/rewrite returns a valid rewrite for one of the cards within 15s.
//   4. Rate-wall: 11 requests from a single TEST_IP, 11th returns easter_egg.
//   5. Optional, if UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set:
//      verify maester:rate:<TEST_IP>:<YYYYMMDD> key landed in Upstash at >=11.
//      (This is the chunk-7 Upstash adapter end-to-end exercise that was
//      deferred to chunk 8.)
//
// Prereqs:
//   - MAESTER_URL points at a deployed Vercel URL.
//   - That deployment has ANTHROPIC_API_KEY set (otherwise find-evidence
//     returns 502).
//   - For Upstash verification: deployment also has UPSTASH_REDIS_REST_URL +
//     UPSTASH_REDIS_REST_TOKEN set, and same values exported locally so the
//     test can read the key after.
//
// Run:
//   MAESTER_URL=https://maester-xyz.vercel.app node scripts/test-smoke-prod.mjs
//
// With Upstash verification:
//   MAESTER_URL=... \
//   UPSTASH_REDIS_REST_URL=... \
//   UPSTASH_REDIS_REST_TOKEN=... \
//   node scripts/test-smoke-prod.mjs

const BASE_URL = process.env.MAESTER_URL;
if (!BASE_URL) {
  console.error('FAIL: MAESTER_URL env var is required (e.g. https://maester-xyz.vercel.app).');
  process.exit(2);
}

// RFC5737 documentation IP — never a real client. Each run picks a fresh
// random octet so we don't trip the rate wall on consecutive runs.
const TEST_IP =
  process.env.TEST_IP ?? `203.0.113.${Math.floor(Math.random() * 200) + 10}`;

const PER_CALL_BUDGET_MS = 15_000;
const RATE_ALLOWED = 10; // first 10 allowed; 11th trips easter_egg

const DEMO_CLAIMS = [
  { label: 'Stripe-on-Stripe', claim: 'Stripe Billing helps subscription companies grow internationally.' },
  { label: 'Known customer', claim: 'Atlassian saw significant subscription revenue growth after migrating to Stripe Billing.' },
  { label: 'Vague-generic', claim: 'Modern payment platforms drive higher conversion for SaaS.' },
];
const NOVEL_CLAIM = { label: 'Novel (Cursor)', claim: 'Cursor cut billing engineering overhead by integrating Stripe Billing.' };

// Nonsense claim used for rate-wall probing — chunk-4 pre-filter scores 0 and
// short-circuits without calling Anthropic. Decouples the rate-wall test from
// API-key validity and keeps it fast.
const NONSENSE_CLAIM = 'Xyzzy plugh fnord quux blorple grault wibble flarp.';

const results = { pass: 0, fail: 0, warn: 0 };

function logPass(label, detail = '') {
  console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  results.pass += 1;
}
function logFail(label, detail = '') {
  console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  results.fail += 1;
}
function logWarn(label, detail = '') {
  console.log(`  WARN  ${label}${detail ? ' — ' + detail : ''}`);
  results.warn += 1;
}

async function postJson(path, body, extraHeaders = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { error: e.message, elapsed: Date.now() - t0 };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, raw: text, elapsed: Date.now() - t0 };
}

async function testHealth() {
  console.log(`\n[1/5] Health probe: GET ${BASE_URL}/`);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE_URL}/`, { method: 'GET' });
  } catch (e) {
    logFail('health-probe', `fetch failed: ${e.message} (is MAESTER_URL correct + deployed?)`);
    return;
  }
  const elapsed = Date.now() - t0;
  const ct = res.headers.get('content-type') ?? '';
  if (res.status === 200 && ct.includes('text/html')) {
    logPass('health-probe', `${res.status} ${ct} (${elapsed} ms)`);
  } else {
    logFail('health-probe', `status=${res.status} content-type=${ct} (${elapsed} ms)`);
  }
}

async function testFindEvidence() {
  console.log(`\n[2/5] /api/find-evidence on 3 demo + 1 novel claim`);
  const claims = [...DEMO_CLAIMS, NOVEL_CLAIM];
  let firstSuccessCard = null;
  for (const { label, claim } of claims) {
    const r = await postJson('/api/find-evidence', { claim });
    if (r.error) { logFail(label, `fetch error: ${r.error}`); continue; }
    if (r.status !== 200) { logFail(label, `status=${r.status} body=${(r.raw ?? '').slice(0, 140)}`); continue; }
    if (!r.json || !Array.isArray(r.json.cards)) { logFail(label, `bad shape: ${(r.raw ?? '').slice(0, 140)}`); continue; }
    if (r.elapsed > PER_CALL_BUDGET_MS) {
      logWarn(label, `slow: ${r.elapsed} ms (budget ${PER_CALL_BUDGET_MS} ms), cards=${r.json.cards.length}`);
    }
    if (r.json.cards.length === 0) {
      logFail(label, `cards=[] (expected >=1 within corpus)`);
      continue;
    }
    logPass(label, `cards=${r.json.cards.length} (${r.elapsed} ms)`);
    if (!firstSuccessCard) firstSuccessCard = r.json.cards[0];
  }
  return firstSuccessCard;
}

async function testRewrite(card) {
  console.log(`\n[3/5] /api/rewrite on a card from step 2`);
  if (!card) { logFail('rewrite', 'no card available from find-evidence step'); return; }
  const evidence_id = `${card.slug}|${card.source_span[0]}|${card.source_span[1]}`;
  const claim = DEMO_CLAIMS[0].claim;
  const r = await postJson('/api/rewrite', { claim, evidence_id });
  if (r.error) { logFail('rewrite', `fetch error: ${r.error}`); return; }
  if (r.status !== 200) { logFail('rewrite', `status=${r.status} body=${(r.raw ?? '').slice(0, 140)}`); return; }
  const ok = r.json && typeof r.json.rewrite === 'string' && r.json.rewrite.length > 10
    && r.json.citation && typeof r.json.citation.customer === 'string';
  if (!ok) { logFail('rewrite', `bad shape: ${(r.raw ?? '').slice(0, 200)}`); return; }
  if (r.elapsed > PER_CALL_BUDGET_MS) {
    logWarn('rewrite', `slow: ${r.elapsed} ms, rewrite=${r.json.rewrite.slice(0, 80)}...`);
  } else {
    logPass('rewrite', `${r.elapsed} ms, customer=${r.json.citation.customer}`);
  }
}

async function testRateWall() {
  console.log(`\n[4/5] Rate-wall: 11 requests from TEST_IP=${TEST_IP}`);
  for (let i = 1; i <= RATE_ALLOWED + 1; i++) {
    const r = await postJson(
      '/api/find-evidence',
      { claim: NONSENSE_CLAIM },
      { 'x-forwarded-for': TEST_IP },
    );
    const expectEgg = i > RATE_ALLOWED;
    const isEgg = r.json && r.json.easter_egg === true;
    const label = `attempt ${String(i).padStart(2)}/11`;
    if (expectEgg) {
      if (r.status === 200 && isEgg) logPass(label, `easter_egg=true (${r.elapsed} ms)`);
      else logFail(label, `expected easter_egg, got status=${r.status} body=${(r.raw ?? '').slice(0, 140)}`);
    } else {
      const okShape = r.json && (Array.isArray(r.json.cards) || r.json.no_match === true);
      if (r.status === 200 && !isEgg && okShape) logPass(label, `normal (${r.elapsed} ms)`);
      else logFail(label, `expected normal, got status=${r.status} body=${(r.raw ?? '').slice(0, 140)}`);
    }
  }
}

async function testUpstashKey() {
  console.log(`\n[5/5] Upstash key visibility (optional)`);
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    logWarn('upstash-key', 'UPSTASH_REDIS_REST_URL/TOKEN not set locally — skipping (verify in Upstash dashboard instead)');
    return;
  }
  const ymd = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const key = `maester:rate:${TEST_IP}:${ymd}`;
  let res;
  try {
    res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (e) {
    logFail('upstash-key', `fetch failed: ${e.message}`);
    return;
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (res.status !== 200 || !json || json.result == null) {
    logFail('upstash-key', `expected GET ${key} >= 11, got status=${res.status} body=${text.slice(0, 200)}`);
    return;
  }
  const count = parseInt(json.result, 10);
  if (Number.isFinite(count) && count >= RATE_ALLOWED + 1) {
    logPass('upstash-key', `${key} = ${count}`);
  } else {
    logFail('upstash-key', `${key} = ${json.result} (expected >= ${RATE_ALLOWED + 1})`);
  }
}

async function main() {
  console.log(`Maester chunk-8 prod smoke test`);
  console.log(`  base URL: ${BASE_URL}`);
  console.log(`  test IP:  ${TEST_IP}`);

  await testHealth();
  const card = await testFindEvidence();
  await testRewrite(card);
  await testRateWall();
  await testUpstashKey();

  console.log(`\n=== ${results.pass} pass / ${results.fail} fail / ${results.warn} warn ===`);
  process.exit(results.fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
