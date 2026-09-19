const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const cdpEndpoint = "http://127.0.0.1:9444";
const browserDriverName = (
  process.env.TARGET_BROWSER_DRIVER || "patchright"
).toLowerCase();
if (!new Set(["patchright", "playwright"]).has(browserDriverName)) {
  throw new Error("TARGET_BROWSER_DRIVER must be patchright or playwright.");
}
const { chromium } = require(
  browserDriverName === "patchright" ? "patchright" : "playwright-core",
);

const minimumCooldownMs = 5 * 60 * 1000;
const discoveryCooldownMs = Math.max(
  minimumCooldownMs,
  Number.parseInt(process.env.TARGET_DISCOVERY_COOLDOWN_MS || "900000", 10) ||
    900000,
);
const discoveryWaitMs = Math.max(
  3000,
  Number.parseInt(process.env.TARGET_DISCOVERY_WAIT_MS || "6000", 10) || 6000,
);
const statePath = path.join(os.tmpdir(), "pokemon-deals-target-discovery.json");
const challengePattern =
  /press\s*&\s*hold|perimeterx|captcha|verify (?:that )?you(?:'re| are) human|not a robot|access denied|security check/i;
const preorderPattern = /\bpre[ -]?order(?:s|ed|ing)?\b/i;

function normalizeProductUrl(value) {
  try {
    const url = new URL(value, "https://www.target.com");
    const match = url.pathname.match(/\/p\/(?:[^/]+\/)?-\/A-(\d+)/i);
    return match ? `https://www.target.com/p/-/A-${match[1]}` : null;
  } catch (error) {
    return null;
  }
}

function selectPreorderCandidates(records) {
  const candidates = new Map();
  for (const record of records) {
    const url = normalizeProductUrl(record.href);
    if (!url || !preorderPattern.test(record.text || "")) {
      continue;
    }
    if (!candidates.has(url)) {
      candidates.set(url, {
        url,
        label: String(record.text || "").replace(/\s+/g, " ").trim(),
      });
    }
  }
  return [...candidates.values()];
}

async function readLastAttempt() {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    return Number.isFinite(state.lastAttemptAt) ? state.lastAttemptAt : 0;
  } catch (error) {
    return 0;
  }
}

async function reserveAttempt(now = Date.now()) {
  const lastAttemptAt = await readLastAttempt();
  const remainingMs = lastAttemptAt + discoveryCooldownMs - now;
  if (remainingMs > 0) {
    throw new Error(
      `TARGET_DISCOVERY_COOLDOWN remainingMs=${remainingMs} retryAfter=${new Date(now + remainingMs).toISOString()}`,
    );
  }
  await fs.writeFile(statePath, JSON.stringify({ lastAttemptAt: now }), "utf8");
}

async function hasVerification(page) {
  if (/captcha|challenge|blocked|verify/i.test(page.url())) {
    return true;
  }
  const title = await page.title().catch(() => "");
  const body = await page.locator("body").innerText().catch(() => "");
  return challengePattern.test(`${title}\n${body}`);
}

async function collectProductRecords(page) {
  return page.evaluate(() => {
    const records = [];
    const cardSelector =
      '[data-test="@web/site-top-of-funnel/ProductCardWrapper"], [data-test*="ProductCard"]';
    for (const anchor of document.querySelectorAll('a[href*="/p/"]')) {
      const card = anchor.closest(cardSelector);
      if (!card) {
        continue;
      }
      records.push({
        href: anchor.getAttribute("href"),
        text: card.innerText || "",
      });
    }
    return records;
  });
}

async function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    throw new Error(
      'Provide exactly one search query, for example: npm run target:discover-preorder -- "pokemon preorder"',
    );
  }

  const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 5000 });
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("Chrome has no browser context.");
  }

  const page = await context.newPage();
  try {
    await reserveAttempt();
    const searchUrl = `https://www.target.com/s?searchTerm=${encodeURIComponent(query)}`;
    console.log(
      `TARGET_DISCOVERY_STARTED query=${JSON.stringify(query)} cooldownMs=${discoveryCooldownMs} driver=${browserDriverName}`,
    );
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(discoveryWaitMs);

    if (await hasVerification(page)) {
      console.log("TARGET_DISCOVERY_CHALLENGE stop=true");
      process.exitCode = 2;
      return;
    }

    const candidates = selectPreorderCandidates(
      await collectProductRecords(page),
    );
    console.log(`TARGET_DISCOVERY_RESULTS count=${candidates.length}`);
    for (const candidate of candidates) {
      console.log(
        `TARGET_PREORDER_CANDIDATE ${JSON.stringify({
          url: candidate.url,
          label: candidate.label.slice(0, 240),
        })}`,
      );
    }
    if (candidates.length === 0) {
      console.log("TARGET_DISCOVERY_NO_PREORDER_FOUND");
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  normalizeProductUrl,
  selectPreorderCandidates,
};
