// Chunk 7: per-IP daily counter as recruiting hook.
//
// Posture: this is NOT a 429 / cost-ceiling gate. The wall is reframed as a
// fourth-wall hook — a reviewer using the demo hard enough to trip it gets
// an "if Maester feels like the right kind of tool, give me an interview"
// response instead of a denied request. So the trip returns 200 with an
// easter-egg payload, never 4xx.
//
// Counter: per-IP per-UTC-day key in either Upstash Redis (when creds in
// env) or in-memory Map (dev). First 10 calls/day per IP pass through;
// 11th and onward short-circuit with the easter-egg JSON.
//
// Matches /api/find-evidence and /api/rewrite; static assets and the page
// itself are unaffected.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getCounterStore } from './lib/counter-store';

export const config = {
  matcher: ['/api/find-evidence', '/api/rewrite'],
};

const DAILY_LIMIT = 10;
const TTL_SECONDS = 60 * 60 * 24; // 24h
const STRIPE_JOB_URL =
  'https://stripe.com/jobs/listing/forward-deployed-ai-accelerator-marketing/7747638';

function extractIP(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    // x-forwarded-for is a comma-separated list; leftmost is the original client
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

function utcDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${d}`;
}

function easterEggResponse() {
  return NextResponse.json(
    {
      easter_egg: true,
      message:
        "You've put Maester through its paces — if it feels like the kind of tool to build at Stripe, I'd love to talk about the FDA Marketing role.",
      cta_label: 'View the role',
      cta_url: STRIPE_JOB_URL,
      author: 'Jake Silverman',
      author_email: 'jakesilverman.pro@gmail.com',
    },
    { status: 200 },
  );
}

export async function middleware(req: NextRequest) {
  const ip = extractIP(req);
  const day = utcDateKey(new Date());
  const key = `maester:rate:${ip}:${day}`;
  let count = 0;
  try {
    const store = getCounterStore();
    count = await store.incrWithTTL(key, TTL_SECONDS);
  } catch (e) {
    // Counter-store failure is observability-only; never block traffic on it.
    console.error('counter_store_fallback', e instanceof Error ? e.message : String(e));
    return NextResponse.next();
  }
  if (count > DAILY_LIMIT) {
    return easterEggResponse();
  }
  return NextResponse.next();
}
