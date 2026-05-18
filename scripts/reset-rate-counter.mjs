#!/usr/bin/env node
// Reset the prod rate-wall counter. Reads UPSTASH_REDIS_REST_URL + _TOKEN
// from env; scans for maester:rate:* keys and DELs them.
//
// Usage:
//   set -a; source .env.local; set +a; node scripts/reset-rate-counter.mjs

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!URL || !TOKEN) {
  console.error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
  process.exit(1);
}

async function upstash(cmd) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`upstash ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  let cursor = '0';
  const keys = [];
  do {
    const { result } = await upstash(['SCAN', cursor, 'MATCH', 'maester:rate:*', 'COUNT', '500']);
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== '0');

  if (keys.length === 0) {
    console.log('no maester:rate:* keys found — nothing to reset');
    return;
  }

  console.log(`found ${keys.length} keys:`);
  for (const k of keys) console.log(`  ${k}`);

  const { result } = await upstash(['DEL', ...keys]);
  console.log(`deleted ${result} keys`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
