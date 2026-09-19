const availabilityResponsePattern =
  /^(?:https:\/\/redsky\.target\.com\/redsky_aggregations\/v1\/web\/(?:product_fulfillment_v\d+|pdp_client_v\d+)|https:\/\/www\.target\.com\/cdui_orchestrations\/v1\/pages\/pdp\/deferred_enrichment\/modules)(?:[/?#]|$)/i;
const challengePattern =
  /press\s*&\s*hold|perimeterx|_pxAppId|captcha|verify (?:that )?you(?:'re| are) human|not a robot|access denied/i;
const positiveAvailabilityPattern =
  /^(?:available|in_stock|limited_stock|preorder|pre_order|available_to_promise)$/i;
const negativeAvailabilityPattern =
  /^(?:unavailable|out_of_stock|sold_out|not_available|not_sold_in_store)$/i;
const availabilityKeyPattern =
  /availability|inventory|stock|fulfill|online_purchase|preorder|pre_order|orderable|purchasable/i;

function targetProductFromUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (error) {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname !== "www.target.com") {
    return null;
  }

  const match = url.pathname.match(/\bA-(\d{7,})\b/i);
  if (!match) {
    return null;
  }

  return {
    id: `A-${match[1]}`,
    tcin: match[1],
    url: url.href,
  };
}

function isAvailabilityResponseUrl(value) {
  return availabilityResponsePattern.test(String(value || ""));
}

function isChallengeResponse({ status = 0, contentType = "", body = "" } = {}) {
  if (status === 403 || status === 429) {
    return true;
  }

  if (/text\/html/i.test(contentType) && challengePattern.test(body)) {
    return true;
  }

  return challengePattern.test(body);
}

function normalizeAvailabilityValue(value) {
  return String(value || "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function collectAvailabilityEvidence(value, path, evidence, seen, expectedTcin) {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        collectAvailabilityEvidence(
          item,
          `${path}[${index}]`,
          evidence,
          seen,
          expectedTcin,
        ),
      );
      return;
    }

    const objectTcin = value.tcin || value.product_id;
    if (expectedTcin && objectTcin && String(objectTcin) !== expectedTcin) {
      return;
    }

    Object.entries(value).forEach(([key, child]) => {
      const childPath = path ? `${path}.${key}` : key;
      collectAvailabilityEvidence(
        child,
        childPath,
        evidence,
        seen,
        expectedTcin,
      );
    });
    return;
  }

  if (!availabilityKeyPattern.test(path)) {
    return;
  }

  const normalized = normalizeAvailabilityValue(value);
  if (typeof value === "boolean") {
    const positiveKey =
      /is_valid_for|is_available|orderable|purchasable/i.test(path) &&
      !/not_|ineligible|unavailable/i.test(path);
    if (positiveKey && value) {
      evidence.positive.push({ path, value });
    } else if (positiveKey && !value) {
      evidence.negative.push({ path, value });
    }
  } else if (positiveAvailabilityPattern.test(normalized)) {
    evidence.positive.push({ path, value });
  } else if (negativeAvailabilityPattern.test(normalized)) {
    evidence.negative.push({ path, value });
  }

  const preorderSignal =
    /preorder|pre_order/i.test(path) &&
    ((typeof value === "boolean" && value) ||
      (typeof value === "number" && value > 0) ||
      positiveAvailabilityPattern.test(normalized));
  if (preorderSignal) {
    evidence.preorder.push({ path, value });
  }
}

function summarizeAvailabilityPayload(payload, fallbackProduct) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const evidence = { positive: [], negative: [], preorder: [] };
  const product = fallbackProduct || {};
  collectAvailabilityEvidence(
    payload,
    "",
    evidence,
    new Set(),
    product.tcin ? String(product.tcin) : null,
  );

  const productId = product.id || (product.tcin ? `A-${product.tcin}` : null);
  const positive = evidence.positive.length > 0;
  const preorder = positive && evidence.preorder.length > 0;

  return {
    productId,
    available: positive,
    action: positive ? (preorder ? "preorder" : "purchase") : null,
    confidence: positive ? "candidate" : evidence.negative.length > 0 ? "unavailable" : "unknown",
    positiveEvidence: evidence.positive.slice(0, 5),
    negativeEvidence: evidence.negative.slice(0, 5),
  };
}

function replaceEndpointProduct(endpointUrl, tcin) {
  const url = new URL(endpointUrl);
  let replaced = false;

  for (const name of ["tcin", "tcins"]) {
    if (url.searchParams.has(name)) {
      url.searchParams.set(name, tcin);
      replaced = true;
    }
  }

  return replaced ? url.href : null;
}

function calculateBackoffMs(attempt, baseMs, maximumMs) {
  const exponent = Math.max(0, Math.min(Number(attempt) || 0, 8));
  return Math.min(maximumMs, baseMs * 2 ** exponent);
}

module.exports = {
  calculateBackoffMs,
  isAvailabilityResponseUrl,
  isChallengeResponse,
  replaceEndpointProduct,
  summarizeAvailabilityPayload,
  targetProductFromUrl,
};
