const { parseTargetBuyUrl } = require("./target-buy-input");
const { normalizeTargetSettings } = require("./target-deal-settings");
const { targetProductFromUrl } = require("../target-availability");
const { prepareTargetBuyRun } = require("../target-direct-buy");

const maximumWatchlistProducts = 8;
const defaultItemLimit = "100.00";
const defaultOrderLimit = "125.00";
const allowedRedirectHosts = new Set([
  "howl.link",
  "goto.target.com",
  "www.ojrq.net",
]);

function validateWatchlistEntries(entries) {
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > maximumWatchlistProducts
  ) {
    throw new Error(
      `Target watchlist requires 1 to ${maximumWatchlistProducts} products.`,
    );
  }
  const productIds = new Set();
  for (const entry of entries) {
    if (
      !entry ||
      !String(entry.label || "").trim() ||
      !/^A-\d{7,}$/.test(String(entry.expectedProductId || ""))
    ) {
      throw new Error("Each watchlist product requires a label and expected Target product ID.");
    }
    parseTargetBuyUrl(entry.shortUrl);
    if (productIds.has(entry.expectedProductId)) {
      throw new Error("Duplicate Target watchlist product IDs are not allowed.");
    }
    productIds.add(entry.expectedProductId);
  }
  return entries;
}

/**
 * Resolve each supplied short link without opening a Target product page.
 * The expected TCIN is the authority; a changed redirect stops the run.
 * Return a canonical Target path so affiliate query values never reach logs.
 */
async function resolveWatchlistEntries(entries, { fetchImpl = fetch } = {}) {
  validateWatchlistEntries(entries);
  const resolved = [];
  for (const entry of entries) {
    let current = new URL(parseTargetBuyUrl(entry.shortUrl).url);
    let product = null;
    for (let hop = 0; hop < 6; hop += 1) {
      product = targetProductFromUrl(current.href);
      if (product) {
        break;
      }
      // Current Howl/Target affiliate links pass through ojrq.net before
      // returning to Target. Reject any other redirect host.
      if (!allowedRedirectHosts.has(current.hostname)) {
        break;
      }
      const response = await fetchImpl(current, {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0" },
      });
      const location = response.headers.get("location");
      if (!location) {
        break;
      }
      current = new URL(location, current);
    }
    product ||= targetProductFromUrl(current.href);
    if (!product || product.id !== entry.expectedProductId) {
      throw new Error(
        `Short-link destination does not match expected Target product ID for ${entry.label}.`,
      );
    }
    resolved.push({
      label: entry.label,
      group: entry.group || "",
      productId: product.id,
      url: `https://www.target.com/p/-/${product.id}`,
    });
  }
  return resolved;
}

function watchlistSettings(settings) {
  const normalized = normalizeTargetSettings(settings);
  const capped = (saved, limit) =>
    saved ? Math.min(Number(saved), Number(limit)).toFixed(2) : limit;
  return normalizeTargetSettings({
    ...normalized,
    maxItemPrice: capped(normalized.maxItemPrice, defaultItemLimit),
    maxOrderTotal: capped(normalized.maxOrderTotal, defaultOrderLimit),
    expectedFulfillment: normalized.expectedFulfillment || "shipping",
  });
}

function prepareWatchlistRun({
  entries,
  settings,
  secrets,
  env = process.env,
} = {}) {
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > maximumWatchlistProducts
  ) {
    throw new Error("Resolved Target watchlist must contain 1 to 8 products.");
  }
  const seen = new Set();
  for (const entry of entries) {
    const product = targetProductFromUrl(entry.url);
    if (
      !product ||
      product.id !== entry.productId ||
      seen.has(product.id)
    ) {
      throw new Error("Resolved Target watchlist has a missing or duplicate product ID.");
    }
    seen.add(product.id);
  }
  const effectiveSettings = watchlistSettings(settings);
  const prepared = prepareTargetBuyRun({
    targetUrl: entries[0].url,
    settings: effectiveSettings,
    secrets,
    env,
  });
  return {
    effectiveSettings: prepared.effectiveSettings,
    run: {
      ...prepared.run,
      args: [
        prepared.run.args[0],
        ...entries.map((entry) => `direct-buy=${entry.url}`),
      ],
      env: {
        ...prepared.run.env,
        TARGET_MULTI_DIRECT_BUY: "1",
        TARGET_REPEAT_CONFIRMED_ORDERS: "1",
        TARGET_MAX_CONCURRENT: String(entries.length),
        // This watchlist deliberately polls the shared queue every second.
        // Keep saved catalog cadence separate; the worker still backs off on
        // verification and HTTP 429 before it permits another request.
        TARGET_MONITOR_POLL_MS: "1000",
      },
    },
  };
}

module.exports = {
  maximumWatchlistProducts,
  prepareWatchlistRun,
  resolveWatchlistEntries,
  validateWatchlistEntries,
  watchlistSettings,
};
