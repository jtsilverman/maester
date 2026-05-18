'use client';

import { useEffect, useRef, useState } from 'react';

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

type EasterEgg = {
  easter_egg: true;
  message: string;
  cta_label: string;
  cta_url: string;
  author: string;
  author_email: string;
};

function isEasterEgg(body: unknown): body is EasterEgg {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { easter_egg?: unknown }).easter_egg === true
  );
}

function evidenceId(card: EvidenceCard): string {
  return `${card.slug}|${card.source_span[0]}|${card.source_span[1]}`;
}

const DEMO_CLAIMS: { label: string; claim: string }[] = [
  {
    label: 'Stripe-on-Stripe',
    claim: 'Stripe Billing helps subscription companies grow internationally.',
  },
  {
    label: 'Known customer',
    claim:
      'Atlassian saw significant subscription revenue growth after migrating to Stripe Billing.',
  },
  {
    label: 'Vague-generic',
    claim: 'Modern payment platforms drive higher conversion for SaaS.',
  },
];

// Customer names appearing in the corpus — used as a "trust row" under the hero,
// mirroring stripe.com's logo strip. We don't have logos (chunk-1 didn't scrape
// them) so we render names only.
const FEATURED_CUSTOMERS = [
  'Atlassian',
  'Lyft',
  'Cursor',
  'Coinbase',
  'Shopify',
  'Klarna',
  'Mindbody',
  'Reach',
];

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

  const [easterEgg, setEasterEgg] = useState<EasterEgg | null>(null);

  const tryItRef = useRef<HTMLDivElement | null>(null);

  const canSubmit = claim.trim().length > 0 && !loading;

  function loadDemoClaim(text: string) {
    setClaim(text);
    setCards(null);
    setError(null);
    setSelectedId(null);
    setRewrite(null);
    setRewriteError(null);
    setEasterEgg(null);
  }

  function scrollToTryIt() {
    tryItRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  useEffect(() => {
    if (submittedClaim && (cards || error || easterEgg)) {
      // Scroll results into view after a successful submit.
      document
        .getElementById('results')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [cards, error, easterEgg, submittedClaim]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setCards(null);
    setSelectedId(null);
    setRewrite(null);
    setRewriteError(null);
    setEasterEgg(null);
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
      const data = await res.json();
      if (isEasterEgg(data)) {
        setEasterEgg(data);
      } else {
        setCards((data as ApiResponse).cards);
      }
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
      const data = await res.json();
      if (isEasterEgg(data)) {
        setEasterEgg(data);
        setSelectedId(null);
      } else {
        setRewrite(data as RewriteResponse);
      }
    } catch (err) {
      setRewriteError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setRewriteLoading(false);
    }
  }

  return (
    <>
      <NavBar />

      <section className="hero pb-20 sm:pb-32">
        <div className="stripe-gradient" aria-hidden />
        <div className="hero-content mx-auto max-w-7xl px-6 pt-24 sm:px-10 sm:pt-32">
          <p className="inline-flex items-center gap-2 text-[13px] text-ink-soft">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-success-ink animate-pulse" />
            Built for a Stripe Forward Deployed AI Accelerator, Marketing portfolio submission
            <span className="text-ink-faint">·</span>
            <a
              href="https://stripe.com/jobs/listing/forward-deployed-ai-accelerator-marketing/7747638"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-brand hover:text-brand-hover hover:underline"
            >
              View the role →
            </a>
          </p>
          <h1 className="mt-6 max-w-4xl text-5xl sm:text-7xl font-semibold tracking-[-0.025em] text-ink leading-[1.04]">
            Evidence-anchored marketing claims,{' '}
            <span className="gradient-text">in Stripe voice.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg sm:text-xl text-ink-soft leading-[1.55]">
            Paste a marketing claim. Get specific, source-attributed metrics from real
            Stripe customer stories — and a tightened rewrite of your sentence,
            anchored on the evidence you pick.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={scrollToTryIt}
              className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full bg-brand px-5 text-[15px] font-medium text-white shadow-[0_2px_5px_rgba(99,91,255,0.18)] transition hover:bg-brand-hover focus:outline-none focus:ring-2 focus:ring-brand/40 focus:ring-offset-2"
            >
              Try it
              <span aria-hidden>→</span>
            </button>
            <a
              href="https://github.com/jtsilverman/maester"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full bg-white border border-line px-5 text-[15px] font-medium text-ink shadow-[0_1px_2px_rgba(10,37,64,0.04)] transition hover:border-ink-faint focus:outline-none focus:ring-2 focus:ring-brand/30 focus:ring-offset-2"
            >
              <GithubMark />
              See the source
            </a>
          </div>

          <div className="mt-16 sm:mt-20">
            <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-ink-subdued">
              Evidence pool draws from real Stripe customer stories
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-x-7 gap-y-2">
              {FEATURED_CUSTOMERS.map((name) => (
                <span
                  key={name}
                  className="text-[15px] sm:text-base font-medium text-ink-soft"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section ref={tryItRef} className="bg-bg pb-24 sm:pb-32">
        <div className="mx-auto max-w-7xl px-6 sm:px-10">
          <div className="mx-auto max-w-3xl">
            <p className="text-[13px] font-semibold uppercase tracking-[0.14em] text-brand">
              Try a claim
            </p>
            <h2 className="mt-3 text-3xl sm:text-[2.5rem] font-semibold tracking-[-0.02em] text-ink leading-[1.1]">
              Type a marketing claim. Get evidence.
            </h2>
            <p className="mt-4 text-[15px] sm:text-base text-ink-soft leading-relaxed">
              Pick one of the example claims below, or paste your own. Maester ranks
              the static evidence index and returns the strongest matches — each with
              the verbatim quote, the source URL, and a fit score.
            </p>

            <form onSubmit={handleSubmit} className="mt-10 space-y-5">
              <div>
                <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-subdued">
                  Examples
                </p>
                <div className="flex flex-wrap gap-2">
                  {DEMO_CLAIMS.map((demo) => (
                    <button
                      key={demo.label}
                      type="button"
                      onClick={() => loadDemoClaim(demo.claim)}
                      disabled={loading}
                      className="inline-flex items-center rounded-full border border-line bg-white px-3.5 py-1.5 text-[13px] font-medium text-ink-soft transition hover:border-brand hover:bg-brand-faint hover:text-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {demo.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label
                  htmlFor="claim"
                  className="block text-[13px] font-semibold text-ink-soft mb-2"
                >
                  Your claim
                </label>
                <textarea
                  id="claim"
                  value={claim}
                  onChange={(e) => setClaim(e.target.value)}
                  disabled={loading}
                  rows={3}
                  placeholder="e.g. Stripe Billing helps subscription companies grow internationally."
                  className="block w-full rounded-xl border border-line bg-white px-4 py-3.5 text-[15px] text-ink shadow-[0_1px_2px_rgba(10,37,64,0.04)] placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-subdued"
                />
              </div>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full bg-brand px-6 text-[15px] font-medium text-white shadow-[0_2px_5px_rgba(99,91,255,0.18)] transition hover:bg-brand-hover focus:outline-none focus:ring-2 focus:ring-brand/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-line-strong disabled:shadow-none"
              >
                {loading ? 'Finding evidence…' : 'Find evidence'}
                {!loading && <span aria-hidden>→</span>}
              </button>
            </form>

            <section id="results" className="mt-16 scroll-mt-12" aria-live="polite">
              {easterEgg && <EasterEggCard egg={easterEgg} />}
              {!easterEgg && loading && <LoadingState />}
              {!easterEgg && error && !loading && <ErrorState message={error} />}
              {!easterEgg && !loading && !error && cards !== null && cards.length === 0 && (
                <EmptyState />
              )}
            </section>
          </div>

          {!easterEgg && !loading && !error && cards !== null && cards.length > 0 && (
            <div className="mt-2">
              <div className="flex items-baseline justify-between border-b border-line pb-3 mb-6">
                <h3 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-subdued">
                  Evidence — {cards.length} {cards.length === 1 ? 'result' : 'results'}
                </h3>
                <p className="text-[13px] text-ink-faint">Click a tile to rewrite your claim using it.</p>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
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
            </div>
          )}
        </div>
      </section>

      {!easterEgg && submittedClaim && selectedId && (
        <section className="bg-ink py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-6 sm:px-10">
            <RewritePanel
              originalClaim={submittedClaim}
              rewrite={rewrite}
              loading={rewriteLoading}
              error={rewriteError}
            />
          </div>
        </section>
      )}

      <Footer />
    </>
  );
}

function NavBar() {
  return (
    <header className="absolute top-0 inset-x-0 z-10">
      <nav className="mx-auto max-w-7xl px-6 sm:px-10 h-16 flex items-center justify-between">
        <a
          href="/"
          className="text-[18px] font-semibold tracking-[-0.01em] text-ink"
        >
          Maester
        </a>
        <div className="flex items-center gap-5">
          <a
            href="https://github.com/jtsilverman/maester"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline-flex items-center gap-1.5 text-[14px] font-medium text-ink-soft hover:text-ink"
          >
            <GithubMark />
            Source
          </a>
          <a
            href="https://stripe.com/jobs/listing/forward-deployed-ai-accelerator-marketing/7747638"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-ink-soft"
          >
            Forward Deployed AI Accelerator, Marketing role
            <span aria-hidden>→</span>
          </a>
        </div>
      </nav>
    </header>
  );
}

function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className="inline-block">
      <path
        fillRule="evenodd"
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-white px-5 py-5 text-[14px] text-ink-soft shadow-[0_1px_2px_rgba(10,37,64,0.04)]">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
      <span>Searching the corpus… this takes about 10 seconds.</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-danger-line bg-danger-soft px-5 py-4 text-[14px] text-danger-ink">
      <p className="font-semibold">Something broke.</p>
      <p className="mt-1">{message}</p>
      <p className="mt-2 text-ink-soft">Try again, or check the dev console for details.</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-line bg-surface-warm px-5 py-5 text-[14px] text-ink-soft">
      No matching evidence in the corpus. Try a different claim, or a Stripe-product angle
      (Billing, Connect, Atlas, Tax, etc.).
    </div>
  );
}

function EasterEggCard({ egg }: { egg: EasterEgg }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-ink p-8 sm:p-10 text-white shadow-[0_8px_24px_rgba(10,37,64,0.18)]">
      <div
        aria-hidden
        className="absolute -top-1/3 -right-1/3 h-[120%] w-[80%]"
        style={{
          background:
            'radial-gradient(ellipse 60% 60% at 70% 30%, rgba(199,121,255,0.55) 0%, transparent 60%), radial-gradient(ellipse 60% 60% at 30% 70%, rgba(99,91,255,0.55) 0%, transparent 60%)',
          filter: 'blur(6px)',
          pointerEvents: 'none',
        }}
      />
      <div className="relative">
        <p className="text-2xl sm:text-3xl font-semibold tracking-[-0.015em] leading-tight">
          {egg.message}
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <a
            href={egg.cta_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full bg-white px-5 text-[15px] font-medium text-ink shadow-[0_2px_6px_rgba(0,0,0,0.18)] transition hover:bg-white/90 focus:outline-none focus:ring-2 focus:ring-white/60"
          >
            {egg.cta_label}
            <span aria-hidden>→</span>
          </a>
          <a
            href={`mailto:${egg.author_email}?subject=Maester%20%2F%20Forward%20Deployed%20AI%20Accelerator%2C%20Marketing`}
            className="inline-flex min-h-[44px] items-center text-[15px] font-medium text-white/85 hover:text-white hover:underline"
          >
            Email {egg.author} directly →
          </a>
        </div>
      </div>
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
    ? 'border-brand shadow-[0_0_0_3px_rgba(99,91,255,0.18),0_2px_8px_rgba(10,37,64,0.06)]'
    : 'border-line shadow-[0_1px_2px_rgba(10,37,64,0.04)] hover:border-ink-faint hover:shadow-[0_2px_8px_rgba(10,37,64,0.06)]';
  return (
    <article className={`flex h-full flex-col rounded-2xl border bg-white p-6 transition ${ring}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xl font-semibold tracking-[-0.01em] text-ink">{card.customer}</h3>
        <a
          href={card.source_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-[13px] font-medium text-brand hover:text-brand-hover hover:underline"
        >
          stripe.com →
        </a>
      </header>

      <blockquote className="mt-4 text-[15px] text-ink-soft leading-[1.55]">
        &ldquo;{card.exact_quote}&rdquo;
      </blockquote>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <ClaimTypeBadge type={card.claim_type} />
        <BaselineBadge hasBaseline={card.has_baseline} />
      </div>

      <FitBar score={card.fit_score} />

      <div className="mt-6 pt-5 border-t border-line-soft flex-1 flex items-end">
        <button
          type="button"
          onClick={onSelect}
          className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-brand hover:text-brand-hover"
        >
          {selected ? 'Rewriting with this evidence' : 'Rewrite my claim using this'}
          <span aria-hidden>→</span>
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
    <div>
      <p className="text-[13px] font-semibold uppercase tracking-[0.14em] text-white/60">
        Stripe-voice rewrite
      </p>
      <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-[-0.02em] text-white leading-tight">
        Anchored on the evidence you picked.
      </h2>
      <div className="mt-10 grid gap-10 sm:grid-cols-2 sm:gap-14">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-white/50">
            Your draft
          </p>
          <p className="mt-3 text-lg text-white/75 leading-relaxed">{originalClaim}</p>
        </div>
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-white/50">
            Rewritten
          </p>
          {loading && (
            <div className="mt-3 flex items-center gap-2 text-[15px] text-white/65">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Rewriting…
            </div>
          )}
          {error && !loading && (
            <p className="mt-3 text-[15px] text-danger-line">Rewrite failed: {error}</p>
          )}
          {!loading && !error && rewrite && (
            <>
              <p className="mt-3 text-lg font-medium text-white leading-relaxed">
                {rewrite.rewrite}
              </p>
              <p className="mt-5 text-[13px] text-white/55">
                Source:{' '}
                <a
                  href={rewrite.citation.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-white hover:underline"
                >
                  {rewrite.citation.customer} customer story →
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
    ? 'bg-success-soft text-success-ink'
    : 'bg-surface text-ink-soft';
  const label = isVerified ? 'Verified by source' : 'Customer-claimed';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] ${classes}`}>
      {label}
    </span>
  );
}

function BaselineBadge({ hasBaseline }: { hasBaseline: boolean }) {
  const classes = hasBaseline
    ? 'bg-brand-soft text-brand'
    : 'bg-warn-soft text-warn-ink';
  const label = hasBaseline ? 'Has baseline' : 'No baseline';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] ${classes}`}>
      {label}
    </span>
  );
}

function FitBar({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-subdued">
          Fit
        </span>
        <span className="text-[13px] font-semibold tabular-nums text-ink">
          {clamped}/100
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-line-soft">
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="bg-ink text-white">
      <div className="mx-auto max-w-7xl px-6 sm:px-10 py-16 sm:py-20">
        <div className="grid gap-10 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <p className="text-2xl font-semibold tracking-[-0.01em]">Maester</p>
            <p className="mt-3 max-w-md text-[15px] text-white/65 leading-relaxed">
              Built by Jake Silverman as a portfolio piece for Stripe&rsquo;s
              Forward Deployed AI Accelerator (Marketing) role. The corpus and
              skill ship as an open-source Claude Code skill.
            </p>
          </div>
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-white/45">
              Open source
            </p>
            <ul className="mt-4 space-y-2 text-[14px]">
              <li>
                <a
                  href="https://github.com/jtsilverman/maester"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/80 hover:text-white hover:underline"
                >
                  Source code on GitHub →
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/jtsilverman/maester/tree/main/skills/maester"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/80 hover:text-white hover:underline"
                >
                  Claude Code skill →
                </a>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-white/45">
              For Stripe
            </p>
            <ul className="mt-4 space-y-2 text-[14px]">
              <li>
                <a
                  href="https://stripe.com/jobs/listing/forward-deployed-ai-accelerator-marketing/7747638"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/80 hover:text-white hover:underline"
                >
                  The Forward Deployed AI Accelerator, Marketing role →
                </a>
              </li>
              <li>
                <a
                  href="mailto:jakesilverman.pro@gmail.com?subject=Maester%20%2F%20Forward%20Deployed%20AI%20Accelerator%2C%20Marketing"
                  className="text-white/80 hover:text-white hover:underline"
                >
                  Email Jake directly →
                </a>
              </li>
            </ul>
          </div>
        </div>
        <p className="mt-14 border-t border-white/10 pt-8 text-[13px] text-white/45">
          Corpus: public Stripe customer stories, scraped snapshot. Cards are
          LLM-ranked against the claim; the source link on each tile verifies the
          quote on Stripe&rsquo;s site.
        </p>
      </div>
    </footer>
  );
}
