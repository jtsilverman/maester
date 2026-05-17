export default function Page() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '4rem', maxWidth: '720px', margin: '0 auto' }}>
      <h1>Maester</h1>
      <p>Evidence-anchored marketing claim assistant. UI lands in chunk 5.</p>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        Try: <code>curl -X POST http://localhost:3000/api/find-evidence -H &quot;content-type: application/json&quot; -d &apos;{`{"claim":"Stripe Billing helps subscription companies grow."}`}&apos;</code>
      </p>
    </main>
  );
}
