#!/usr/bin/env node
/**
 * One-shot scraper for stripe.com/customers.
 *
 * Discovers customer story slugs from the curated /customers/all index, fetches
 * each story page politely (concurrency-limited, throttled), parses the main
 * article body with cheerio, and writes corpus/stripe-customers.json.
 *
 * Re-runnable: per-URL HTML is cached under tmp/raw-html/<slug>.html. Delete the
 * cache dir to force a clean re-fetch.
 */
import { load } from "cheerio";
import pLimit from "p-limit";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TMP_DIR = resolve(ROOT, "tmp", "raw-html");
const CORPUS_DIR = resolve(ROOT, "corpus");
const OUT_FILE = resolve(CORPUS_DIR, "stripe-customers.json");

const INDEX_URLS = [
  "https://stripe.com/customers",
  "https://stripe.com/customers/all",
];
const SITEMAP_INDEX = "https://stripe.com/sitemap/sitemap.xml";
const STORY_BASE = "https://stripe.com";
const USER_AGENT =
  "Mozilla/5.0 (compatible; MaesterPortfolioBot/0.1; +https://github.com/jtsilverman/maester)";
const CONCURRENCY = 4;
const PER_REQUEST_DELAY_MS = 250;

mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(CORPUS_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url, cachePath) {
  if (cachePath && existsSync(cachePath)) {
    return readFileSync(cachePath, "utf8");
  }
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const html = await res.text();
  if (cachePath) writeFileSync(cachePath, html, "utf8");
  return html;
}

async function discoverSlugs() {
  const slugs = new Set();
  const addFromText = (text) => {
    const matches =
      text.match(/(?:^|\/)customers\/[a-z0-9][a-z0-9-]*/g) ?? [];
    for (const m of matches) {
      const slug = m.replace(/.*\/customers\//, "");
      if (slug && slug !== "all") slugs.add(slug);
    }
  };

  // Index pages.
  for (const [i, url] of INDEX_URLS.entries()) {
    const html = await fetchHtml(url, resolve(TMP_DIR, `_index-${i}.html`));
    addFromText(html);
  }

  // Sitemap union.
  try {
    const sitemapIndex = await fetchHtml(
      SITEMAP_INDEX,
      resolve(TMP_DIR, "_sitemap-index.xml"),
    );
    const partitions =
      sitemapIndex.match(/sitemap\/partition-\d+\.xml/g) ?? [];
    for (const part of partitions) {
      const partUrl = `${STORY_BASE}/${part}`;
      const cache = resolve(TMP_DIR, `_${part.replace(/[/]/g, "_")}`);
      const xml = await fetchHtml(partUrl, cache);
      addFromText(xml);
    }
  } catch (err) {
    console.warn("Sitemap discovery failed (continuing):", err.message);
  }

  return [...slugs].sort();
}

/**
 * Extract structured fields from a single story page.
 * Returns null if the page is too thin to count as a story.
 */
function parseStory(slug, url, html) {
  const $ = load(html);

  // Customer name. Stripe is inconsistent: some pages have a proper
  // <head><title>X case study | Stripe</title>; others (e.g. /amazon) omit the
  // document title entirely and only expose an SVG <title>X logo</title> inside
  // the brand mark. Walk through fallbacks until we find a real name.
  const titlecaseSlug = slug
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");

  const headTitle = ($("head > title").first().text() || "").trim();
  const ogTitleRaw = ($('meta[property="og:title"]').attr("content") || "").trim();

  // SVG logo title fallback: collect every <title> text, drop "Stripe logo", and
  // strip trailing " logo".
  const svgTitles = $("title")
    .map((_, n) => $(n).text().trim())
    .get()
    .filter((t) => t && t !== "Stripe logo");
  const svgCustomer = (svgTitles[0] || "").replace(/\s+logo\s*$/i, "").trim();

  const cleanedTitle = (headTitle || ogTitleRaw)
    .replace(/\s*\|\s*Stripe\s*$/i, "")
    .replace(/\s+case study\s*$/i, "")
    .trim();

  const customer = cleanedTitle || svgCustomer || titlecaseSlug;
  const ogTitle = ogTitleRaw || headTitle;

  // Meta description (used as fallback for raw_text seed).
  const description = $('meta[name="description"]').attr("content") || "";

  // Products used: list under <ul class="StripeProductUsedList">; each item is a
  // <div class="StripeProductUsed"> containing an SVG icon + <span>name</span>.
  const products = [];
  $(".StripeProductUsedList .StripeProductUsed span").each((_, n) => {
    const t = $(n).text().trim();
    if (t) products.push(t);
  });

  // Sidebar facts (region, company size): each is a CustomerProfile__customerDetail
  // div containing an inline SVG whose <clipPath id="<icon>-a"> identifies the
  // field type, plus a <span>value</span>. Stripe does NOT publish industry,
  // headquarters, or published_date on the public customer pages.
  let region = "";
  let companySize = "";
  $(".CustomerProfile__customerDetail").each((_, n) => {
    const $n = $(n);
    const value = $n.find("span").first().text().trim();
    if (!value) return;
    // cheerio's HTML parser doesn't expose camelCase SVG tags through selectors,
    // so we regex the raw element HTML for the clipPath id.
    const rawHtml = $.html(n);
    const idMatch = rawHtml.match(/<clipPath\s+id="([^"]+)"/i);
    const iconId = idMatch ? idMatch[1] : "";
    if (iconId.startsWith("globe")) region = value;
    else if (iconId.startsWith("business-size")) companySize = value;
  });

  // Spec asks for industry / headquarters / published_date fields. Stripe doesn't
  // expose these in the customer-profile sidebar; keep the keys for schema
  // stability with empty defaults. The skill (chunk 2) can infer industry from
  // raw_text / customer name when needed.
  const industry = "";
  const headquarters = "";
  const published = "";

  // Main article body: the CaseStudy article contains Challenge / Solution / Results.
  // Fallback: collect every <p> that isn't inside nav/footer/aside.
  let $article =
    $(".CaseStudyContent, .CustomerCaseStudy__content, article").first();
  if ($article.length === 0) {
    // Build a synthetic container of body paragraphs minus chrome.
    $article = $("<div></div>");
    $("p").each((_, p) => {
      const $p = $(p);
      if (
        $p.closest(
          "nav, footer, aside, header, .SiteFooter, .SiteHeader, .ProductsNav, .RefreshedProductsNav, .UniversalChatCtaCard, .CustomersCaseStudyCard, .CustomersCaseStudyStatGrid, .CustomerProfile",
        ).length === 0
      ) {
        $article.append($p.clone());
        $article.append("\n");
      }
    });
  } else {
    // Strip embedded nav/cta inside the article too.
    $article
      .find(
        ".UniversalChatCtaCard, .CustomersCaseStudyCard, .CustomersCaseStudyStatGrid",
      )
      .remove();
  }

  // Pull headings + paragraphs into raw_text with light structure.
  const lines = [];
  $article.find("h1, h2, h3, p, li, blockquote").each((_, n) => {
    const tag = n.tagName.toLowerCase();
    const text = $(n).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    if (/^h[1-3]$/.test(tag)) lines.push(`\n## ${text}\n`);
    else if (tag === "blockquote") lines.push(`> ${text}`);
    else if (tag === "li") lines.push(`- ${text}`);
    else lines.push(text);
  });
  let raw_text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // Fallback: if extraction produced too little, fall back to description.
  if (raw_text.length < 200 && description) {
    raw_text = `${customer}\n\n${description}`;
  }

  // Main-content HTML: prefer the article body markup; cap length to keep
  // corpus JSON manageable (spec asks for an html field; we don't ship the
  // entire 500KB React bundle).
  const main_html = $article
    .html()
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 50_000) ?? "";

  return {
    slug,
    customer,
    url,
    html: main_html,
    raw_text,
    products,
    industry,
    headquarters,
    company_size: companySize,
    region,
    published_date: published,
    title: ogTitle || cleanedTitle,
    description,
  };
}

async function main() {
  console.log("Discovering customer story slugs from indexes + sitemap");
  const slugs = await discoverSlugs();
  console.log(`Found ${slugs.length} slugs.`);

  const limit = pLimit(CONCURRENCY);
  let done = 0;
  const total = slugs.length;
  const results = [];
  const errors = [];

  const tasks = slugs.map((slug) =>
    limit(async () => {
      const url = `${STORY_BASE}/customers/${slug}`;
      const cachePath = resolve(TMP_DIR, `${slug}.html`);
      try {
        const html = await fetchHtml(url, cachePath);
        await sleep(PER_REQUEST_DELAY_MS);
        const parsed = parseStory(slug, url, html);
        if (parsed.raw_text.length < 200) {
          errors.push({ slug, reason: "raw_text too short after parse" });
        } else {
          results.push(parsed);
        }
      } catch (err) {
        errors.push({ slug, reason: err.message });
      } finally {
        done += 1;
        if (done % 10 === 0 || done === total) {
          console.log(`  ${done}/${total} fetched`);
        }
      }
    }),
  );

  await Promise.all(tasks);

  results.sort((a, b) => a.slug.localeCompare(b.slug));
  writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), "utf8");
  console.log(
    `\nWrote ${results.length} entries to ${OUT_FILE} (${(JSON.stringify(results).length / 1024).toFixed(1)} KB).`,
  );
  if (errors.length) {
    console.log(`\n${errors.length} entries failed:`);
    for (const e of errors.slice(0, 20)) console.log(`  - ${e.slug}: ${e.reason}`);
    if (errors.length > 20) console.log(`  ... and ${errors.length - 20} more`);
  }
}

main().catch((err) => {
  console.error("Scraper failed:", err);
  process.exit(1);
});
