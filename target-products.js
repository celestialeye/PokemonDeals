const products = Object.freeze(
  require("./data/target-products.json").map((product) =>
    Object.freeze(product),
  ),
);
const allowedProductIds = new Set(products.map((product) => product.id));
const productMonitorTabPolicy = "one-per-product";
const productPurchaseSelector =
  '[data-test="module-product-detail-add-to-cart"] button';
const purchaseActionPattern = /^(?:pre[\s-]?order|add to cart|buy now)$/i;
const cartEmptyPattern = /your cart is empty|no items in your cart/i;
const notAddedPattern = /item not added to cart/i;
const requestedPurchaseModes = Object.freeze([
  "preorder",
  "add-to-cart",
  "buy-now",
]);
const automaticPurchaseModeOrder = Object.freeze([
  "preorder",
  "add-to-cart",
]);
const directBuyPurchaseModeOrder = Object.freeze([
  "buy-now",
  "preorder",
  "add-to-cart",
]);

function normalizeLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isPurchaseAction(value) {
  return purchaseActionPattern.test(normalizeLabel(value));
}

function normalizeRequestedPurchaseMode(value, { allowAuto = false } = {}) {
  const normalized = normalizeLabel(value).toLowerCase().replace(/\s+/g, "-");
  const aliases = {
    preorder: "preorder",
    "pre-order": "preorder",
    "add-to-cart": "add-to-cart",
    addtocart: "add-to-cart",
    "buy-now": "buy-now",
    buynow: "buy-now",
    "direct-buy": "direct-buy",
    directbuy: "direct-buy",
  };
  if (allowAuto && normalized === "auto") {
    return "auto";
  }
  return aliases[normalized] || null;
}

function purchaseModeFromLabel(value) {
  const normalized = normalizeLabel(value).toLowerCase();
  if (/^pre[\s-]?order$/.test(normalized)) {
    return "preorder";
  }
  if (normalized === "add to cart") {
    return "add-to-cart";
  }
  if (normalized === "buy now") {
    return "buy-now";
  }
  return null;
}

function selectPurchaseCandidate(candidates, requestedMode) {
  const normalizedMode = normalizeRequestedPurchaseMode(requestedMode, {
    allowAuto: true,
  });
  if (!normalizedMode) {
    return null;
  }
  const indexed = (candidates || [])
    .map((candidate) => ({
      ...candidate,
      mode: purchaseModeFromLabel(candidate.label),
    }))
    .filter((candidate) => candidate.mode);
  if (normalizedMode !== "auto" && normalizedMode !== "direct-buy") {
    return indexed.find((candidate) => candidate.mode === normalizedMode) || null;
  }
  const automaticModes = normalizedMode === "direct-buy"
    ? directBuyPurchaseModeOrder
    : automaticPurchaseModeOrder;
  for (const mode of automaticModes) {
    const candidate = indexed.find((entry) => entry.mode === mode);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function productIdFromUrl(value) {
  const match = String(value || "").match(/\bA-\d{7,}\b/i);
  return match ? match[0].toUpperCase() : null;
}

function isCartSuccess(url, bodyText) {
  const text = String(bodyText || "");
  if (notAddedPattern.test(text)) {
    return false;
  }

  return /\/cart(?:[/?#]|$)/i.test(String(url || "")) ||
    /added to cart|view cart|go to cart|check out/i.test(text);
}

function extractProductIds(hrefs, bodyText) {
  const source = [...(hrefs || []), bodyText || ""].join("\n");
  return [...new Set(source.match(/A-\d{7,}/gi) || [])].map((id) =>
    id.toUpperCase(),
  );
}

function validateCartContents(
  { bodyText = "", hrefs = [] } = {},
  expectedProductIds = allowedProductIds,
) {
  if (cartEmptyPattern.test(bodyText)) {
    return false;
  }

  const allowed =
    expectedProductIds instanceof Set
      ? expectedProductIds
      : new Set(expectedProductIds || []);
  const detectedIds = extractProductIds(hrefs, bodyText);
  if (detectedIds.length > 0) {
    return detectedIds.every((id) => allowed.has(id));
  }

  if (allowed !== allowedProductIds) {
    return false;
  }
  const normalizedBody = String(bodyText).toLowerCase();
  return products.some((product) =>
    normalizedBody.includes(product.name.toLowerCase()),
  );
}

module.exports = {
  products,
  automaticPurchaseModeOrder,
  directBuyPurchaseModeOrder,
  isCartSuccess,
  isPurchaseAction,
  normalizeRequestedPurchaseMode,
  productIdFromUrl,
  productMonitorTabPolicy,
  productPurchaseSelector,
  purchaseModeFromLabel,
  requestedPurchaseModes,
  selectPurchaseCandidate,
  validateCartContents,
};
