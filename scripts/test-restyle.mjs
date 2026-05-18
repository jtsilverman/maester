#!/usr/bin/env node
// Live Playwright check that chunk 8.1's Stripe-aligned restyle is applied.
// Assertions intentionally narrow: prove the @theme tokens reached the page
// (body / h1 / submit button computed styles), prove a chip click still
// populates the textarea, prove no JS console errors during navigation.
// Card / blockquote geometry is verified via the diff + screenshots, not
// asserted here (would require an API call or fixture-injection route).
//
// Expects dev server on http://localhost:3000. Run `npm run dev` separately.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.MAESTER_BASE_URL ?? 'http://localhost:3000';
const SCREENSHOT_DIR = resolve(__dirname, '..', 'tmp', 'restyle-screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Expected token values (locked by chunk-8.1 spec; if these change the spec
// row 146 needs to update too).
const EXPECT_FONT_INCLUDES = 'Inter';
const EXPECT_INK_RGB = 'rgb(10, 37, 64)'; // #0a2540 (Stripe ink)
const EXPECT_BRAND_RGB = 'rgb(99, 91, 255)'; // #635bff (Stripe brand purple)
const EXPECT_HERO_H1_FRAGMENT = 'Evidence-anchored'; // Stripe-style hero headline

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

const failures = [];
const passed = [];

function record(viewport, name, ok, detail) {
  const label = `[${viewport}] ${name}`;
  if (ok) {
    passed.push(label);
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}: ${detail}`);
    console.log(`  FAIL  ${label}: ${detail}`);
  }
}

async function runViewport(browser, viewport) {
  console.log(`\n=== ${viewport.name} (${viewport.width}×${viewport.height}) ===`);
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
  } catch (err) {
    record(viewport.name, 'page loads', false, `goto failed: ${err.message}`);
    await ctx.close();
    return;
  }
  record(viewport.name, 'page loads', true);

  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  record(
    viewport.name,
    `body font-family includes "${EXPECT_FONT_INCLUDES}"`,
    bodyFont.includes(EXPECT_FONT_INCLUDES),
    `got: ${bodyFont}`,
  );

  const bodyColor = await page.evaluate(() => getComputedStyle(document.body).color);
  record(
    viewport.name,
    `body color == ${EXPECT_INK_RGB}`,
    bodyColor === EXPECT_INK_RGB,
    `got: ${bodyColor}`,
  );

  const h1 = page.locator('h1', { hasText: EXPECT_HERO_H1_FRAGMENT }).first();
  const h1Exists = await h1.count();
  if (!h1Exists) {
    record(viewport.name, `h1 with "${EXPECT_HERO_H1_FRAGMENT}" present`, false, 'not found');
  } else {
    record(viewport.name, `h1 with "${EXPECT_HERO_H1_FRAGMENT}" present`, true);
    const h1Color = await h1.evaluate((el) => getComputedStyle(el).color);
    record(
      viewport.name,
      `h1 base color == ${EXPECT_INK_RGB}`,
      h1Color === EXPECT_INK_RGB,
      `got: ${h1Color}`,
    );
  }

  // Hero gradient swirl is the signature visual — verify the element rendered.
  const gradientCount = await page.locator('.stripe-gradient').count();
  record(
    viewport.name,
    'hero gradient swirl rendered',
    gradientCount >= 1,
    `got count=${gradientCount}`,
  );

  const firstChip = page.locator('button', { hasText: 'Stripe-on-Stripe' }).first();
  await firstChip.click();
  const claimValue = await page.locator('textarea#claim').inputValue();
  record(
    viewport.name,
    'chip click populates textarea',
    claimValue.toLowerCase().includes('stripe billing'),
    `got: "${claimValue.slice(0, 60)}…"`,
  );

  // Submit button computed bg only resolves to the accent token when the
  // form is submittable. Wait for Playwright's :enabled state after the
  // chip click before reading bg.
  const submit = page.locator('button[type="submit"]').first();
  await submit.waitFor({ state: 'attached' });
  await page.waitForFunction(
    () => {
      const b = document.querySelector('button[type="submit"]');
      return b && !b.disabled;
    },
    { timeout: 5000 },
  );
  // The button has `transition`, so bg interpolates from disabled-color to
  // accent over ~150ms; wait past that before reading computed bg.
  await page.waitForTimeout(300);
  const submitDisabled = await submit.isDisabled();
  const submitBg = await submit.evaluate((el) => getComputedStyle(el).backgroundColor);
  record(
    viewport.name,
    `submit button background == ${EXPECT_BRAND_RGB}`,
    submitBg === EXPECT_BRAND_RGB,
    `disabled=${submitDisabled} bg=${submitBg}`,
  );

  const emptyShot = resolve(SCREENSHOT_DIR, `${viewport.name}-empty.png`);
  await page.screenshot({ path: emptyShot, fullPage: true });
  console.log(`  screenshot: ${emptyShot}`);

  // Submit the claim and capture the cards state. The find-evidence API is
  // covered by its own regression test; here we want the visual artifact.
  // Stay forgiving: if the API takes > 15s or returns no cards, snapshot
  // whatever state the page reaches.
  await submit.click();
  await page.waitForFunction(
    () => {
      // Cards live outside the polite region in the redesigned layout;
      // detect terminal state by absence of any loading spinner.
      const spinner = document.querySelector('[aria-live="polite"] .animate-spin');
      return !spinner;
    },
    { timeout: 20000 },
  ).catch(() => {});
  // Settle a beat for results to scroll into view.
  await page.waitForTimeout(800);
  const cardsShot = resolve(SCREENSHOT_DIR, `${viewport.name}-cards.png`);
  await page.screenshot({ path: cardsShot, fullPage: true });
  console.log(`  screenshot: ${cardsShot}`);

  // Terminal state = anything except the loading spinner. LLM stochasticity
  // means cards aren't guaranteed even on a known-good claim (find-evidence
  // regression test owns that contract); any rendered state proves the flow
  // is intact.
  const cardCount = await page.locator('article').count();
  const stillLoading = await page.locator('[aria-live="polite"] .animate-spin').count();
  record(
    viewport.name,
    `submit reached terminal state (cards=${cardCount}, spinner=${stillLoading})`,
    stillLoading === 0,
    'still spinning after 20s',
  );

  if (cardCount > 0) {
    // Click first card's rewrite button, capture the rewrite panel.
    const rewriteBtn = page
      .locator('article button', { hasText: /Rewrite my claim using this|Rewriting with this/ })
      .first();
    await rewriteBtn.click();
    await page.waitForFunction(
      () => {
        // The rewrite panel lives in a dark section below; loading=spinner present anywhere.
        const spinner = document.querySelector('.animate-spin');
        return !spinner;
      },
      { timeout: 15000 },
    ).catch(() => {});
    await page.waitForTimeout(600);
    const rewriteShot = resolve(SCREENSHOT_DIR, `${viewport.name}-rewrite.png`);
    await page.screenshot({ path: rewriteShot, fullPage: true });
    console.log(`  screenshot: ${rewriteShot}`);
  }

  record(
    viewport.name,
    'no JS console errors',
    consoleErrors.length === 0,
    consoleErrors.join(' | '),
  );

  await ctx.close();
}

async function main() {
  console.log(`test-restyle: hitting ${BASE_URL}`);
  const browser = await chromium.launch();
  try {
    for (const vp of VIEWPORTS) {
      await runViewport(browser, vp);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n=== Summary ===`);
  console.log(`  passed: ${passed.length}`);
  console.log(`  failed: ${failures.length}`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  -', f);
    process.exit(1);
  }
  console.log('\nALL GREEN');
}

main().catch((err) => {
  console.error('test-restyle: unexpected error');
  console.error(err);
  process.exit(2);
});
