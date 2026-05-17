'use client';

import { useState } from 'react';

type EvidenceCard = {
  slug: string;
  customer: string;
  metric: string;
  baseline: string | null;
  exact_quote: string;
  source_span: [number, number];
  source_url: string;
  claim_type: 'customer-claimed' | 'verified-by-source';
  has_baseline: boolean;
  fit_score: number;
};

type ApiResponse = {
  cards: EvidenceCard[];
  elapsed_ms: number;
};

type RewriteResponse = {
  rewrite: string;
  citation: {
    customer: string;
    source_url: string;
    exact_quote: string;
  };
  elapsed_ms: number;
};

function evidenceId(card: EvidenceCard): string {
  return `${card.slug}|${card.source_span[0]}|${card.source_span[1]}`;
}

export default function Page() {
  const [claim, setClaim] = useState('');
  const [submittedClaim, setSubmittedClaim] = useState<string | null>(null);
  const [cards, setCards] = useState<EvidenceCard[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rewrite, setRewrite] = useState<RewriteResponse | null>(null);
  const [rewriteLoading, setRewriteLoading] = useState(false);
  const [rewriteError, setRewriteError] = useState<string | null>(null);

  const canSubmit = claim.trim().length > 0 && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setCards(null);
    setSelectedId(null);
    setRewrite(null);
    setRewriteError(null);
    const trimmed = claim.trim();
    setSubmittedClaim(trimmed);
    try {
      const res = await fetch('/api/find-evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claim: trimmed }),
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

  async function handleCardClick(card: EvidenceCard) {
    if (!submittedClaim) return;
    const id = evidenceId(card);
    setSelectedId(id);
    setRewrite(null);
    setRewriteError(null);
    setRewriteLoading(true);
    try {
      const res = await fetch('/api/rewrite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claim: submittedClaim, evidence_id: id }),
      });
      if (!res.ok) {
        throw new Error(`Rewrite failed (${res.status})`);
      }
      const data: RewriteResponse = await res.json();
      setRewrite(data);
    } catch (err) {
      setRewriteError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setRewriteLoading(false);
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
                {cards.length} {cards.length === 1 ? 'result' : 'results'} — click one to rewrite
              </h2>
              {cards.map((card) => {
                const id = evidenceId(card);
                return (
                  <EvidenceCardView
                    key={id}
                    card={card}
                    selected={selectedId === id}
                    onSelect={() => handleCardClick(card)}
                  />
                );
              })}
            </div>
          )}
        </section>

        {submittedClaim && selectedId && (
          <section className="mt-8" aria-live="polite">
            <RewritePanel
              originalClaim={submittedClaim}
              rewrite={rewrite}
              loading={rewriteLoading}
              error={rewriteError}
            />
          </section>
        )}

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

function EvidenceCardView({
  card,
  selected,
  onSelect,
}: {
  card: EvidenceCard;
  selected: boolean;
  onSelect: () => void;
}) {
  const ring = selected
    ? 'border-indigo-500 ring-2 ring-indigo-500/30'
    : 'border-slate-200 hover:border-indigo-300 hover:shadow-md';
  return (
    <article className={`rounded-xl border bg-white p-5 shadow-sm transition sm:p-6 ${ring}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-slate-900">{card.customer}</h3>
        <a
          href={card.source_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
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

      <div className="mt-4">
        <button
          type="button"
          onClick={onSelect}
          className="inline-flex min-h-[36px] items-center justify-center rounded-md bg-slate-900 px-3.5 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
        >
          {selected ? 'Rewrite with this' : 'Rewrite my claim using this'}
        </button>
      </div>
    </article>
  );
}

function RewritePanel({
  originalClaim,
  rewrite,
  loading,
  error,
}: {
  originalClaim: string;
  rewrite: RewriteResponse | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">Rewrite</h2>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Your draft
          </p>
          <p className="mt-2 text-base text-slate-700">{originalClaim}</p>
        </div>
        <div className="border-l-0 border-t border-slate-100 pt-6 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
            Stripe-voice rewrite
          </p>
          {loading && (
            <div className="mt-2 flex items-center gap-2 text-sm text-slate-500">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
              Rewriting…
            </div>
          )}
          {error && !loading && (
            <p className="mt-2 text-sm text-red-700">Rewrite failed: {error}</p>
          )}
          {!loading && !error && rewrite && (
            <>
              <p className="mt-2 text-base font-medium text-slate-900">{rewrite.rewrite}</p>
              <p className="mt-3 text-xs text-slate-500">
                Source:{' '}
                <a
                  href={rewrite.citation.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
                >
                  {rewrite.citation.customer} customer story ↗
                </a>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
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
