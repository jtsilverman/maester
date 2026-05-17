'use client';

import { useState } from 'react';

type EvidenceCard = {
  slug: string;
  customer: string;
  metric: string;
  baseline: string | null;
  exact_quote: string;
  source_url: string;
  claim_type: 'customer-claimed' | 'verified-by-source';
  has_baseline: boolean;
  fit_score: number;
};

type ApiResponse = {
  cards: EvidenceCard[];
  elapsed_ms: number;
};

export default function Page() {
  const [claim, setClaim] = useState('');
  const [cards, setCards] = useState<EvidenceCard[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = claim.trim().length > 0 && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setCards(null);
    try {
      const res = await fetch('/api/find-evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claim: claim.trim() }),
      });
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      const data: ApiResponse = await res.json();
      setCards(data.cards);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-2xl px-5 py-10 sm:py-16">
        <header className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
            Maester
          </h1>
          <p className="mt-2 text-sm sm:text-base text-slate-600">
            Anchor a marketing claim in real Stripe customer evidence. Paste a draft sentence,
            get specific metrics with verbatim quotes you can cite.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-3">
          <label htmlFor="claim" className="block text-sm font-medium text-slate-700">
            Your claim
          </label>
          <textarea
            id="claim"
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            disabled={loading}
            rows={3}
            placeholder="e.g. Stripe Billing helps subscription companies grow internationally."
            className="block w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
          />
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-indigo-600 px-5 py-2.5 text-base font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? 'Finding evidence…' : 'Find evidence'}
          </button>
        </form>

        <section className="mt-10" aria-live="polite">
          {loading && <LoadingState />}
          {error && !loading && <ErrorState message={error} />}
          {!loading && !error && cards !== null && cards.length === 0 && <EmptyState />}
          {!loading && !error && cards !== null && cards.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
                {cards.length} {cards.length === 1 ? 'result' : 'results'}
              </h2>
              {cards.map((card) => (
                <EvidenceCardView key={`${card.slug}-${card.exact_quote.slice(0, 24)}`} card={card} />
              ))}
            </div>
          )}
        </section>

        <footer className="mt-16 border-t border-slate-200 pt-6 text-xs text-slate-500">
          Corpus: public Stripe customer stories (scraped snapshot). Cards are LLM-ranked against
          the claim; click each source link to verify the quote on Stripe’s site.
        </footer>
      </div>
    </main>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-6 text-slate-600">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
      <span className="text-sm">Searching the corpus… this takes about 10 seconds.</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
      <p className="font-medium">Something broke.</p>
      <p className="mt-1 text-red-700">{message}</p>
      <p className="mt-2 text-red-700">Try again, or check the dev console for details.</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600">
      No matching evidence in the corpus. Try a different claim, or a Stripe-product angle
      (Billing, Connect, Atlas, Tax, etc.).
    </div>
  );
}

function EvidenceCardView({ card }: { card: EvidenceCard }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md sm:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-slate-900">{card.customer}</h3>
        <a
          href={card.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
        >
          View on stripe.com ↗
        </a>
      </header>

      <blockquote className="mt-3 border-l-4 border-indigo-200 pl-4 italic text-slate-700">
        “{card.exact_quote}”
      </blockquote>

      <div className="mt-4 flex flex-wrap gap-2">
        <ClaimTypeBadge type={card.claim_type} />
        <BaselineBadge hasBaseline={card.has_baseline} />
      </div>

      <FitBar score={card.fit_score} />
    </article>
  );
}

function ClaimTypeBadge({ type }: { type: EvidenceCard['claim_type'] }) {
  const isVerified = type === 'verified-by-source';
  const classes = isVerified
    ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
    : 'bg-slate-100 text-slate-700 ring-slate-200';
  const label = isVerified ? 'Verified by source' : 'Customer-claimed';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${classes}`}>
      {label}
    </span>
  );
}

function BaselineBadge({ hasBaseline }: { hasBaseline: boolean }) {
  const classes = hasBaseline
    ? 'bg-indigo-50 text-indigo-800 ring-indigo-200'
    : 'bg-amber-50 text-amber-800 ring-amber-200';
  const label = hasBaseline ? 'Has baseline' : 'No baseline';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${classes}`}>
      {label}
    </span>
  );
}

function FitBar({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Fit</span>
        <span className="text-xs font-semibold text-slate-700">{clamped}/100</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-indigo-600 transition-all"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
