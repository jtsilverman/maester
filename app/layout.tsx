import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Maester',
  description: 'Evidence-anchored marketing claim assistant for Stripe customer stories',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
