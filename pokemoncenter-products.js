const catalog = require("./data/pokemoncenter-products.json");

const pokemonCenterTabPolicy = "one-per-product";
const purchaseActionPattern = /^(?:add to cart|pre[\s-]?order(?: now)?)$/i;
const emptyCartPattern = /your shopping cart is empty|your cart is empty/i;
const temporaryRestrictionPattern =
  /access is temporarily restricted|temporarily restricted from accessing|unusual activity from your (?:device|network)/i;

function productIdFromUrl(value) {
  const match = String(value || "").match(
    /\/product\/([0-9]+-[0-9]+-[0-9]+)(?:\/|$)/i,
  );
  return match ? match[1] : null;
}

function normalizeProducts(rawProducts = catalog) {
  if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
    throw new Error("Pokemon Center products must contain at least one product.");
  }

  const seenSkus = new Set();
  return rawProducts.map((rawProduct, index) => {
    if (!rawProduct || typeof rawProduct !== "object") {
      throw new Error(`Pokemon Center product ${index + 1} must be an object.`);
    }

    const label = String(rawProduct.label || "").trim();
    const title = String(rawProduct.title || "").trim();
    const url = String(rawProduct.url || "").trim();
    const skuFromUrl = productIdFromUrl(url);
    const sku = String(rawProduct.sku || skuFromUrl || "").trim();

    if (!label || !title || !url || !skuFromUrl) {
      throw new Error(
        `Pokemon Center product ${index + 1} requires label, title, and a /product/SKU URL.`,
      );
    }
    if (sku !== skuFromUrl) {
      throw new Error(
        `Pokemon Center product ${index + 1} SKU does not match its URL.`,
      );
    }
    if (seenSkus.has(sku)) {
      return null;
    }

    seenSkus.add(sku);
    return { label, sku, title, url };
  }).filter(Boolean);
}

function selectProducts(products, filterValue = "") {
  const filters = new Set(
    String(filterValue || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (filters.size === 0) {
    return products;
  }

  const selected = products.filter(
    (product) =>
      filters.has(product.sku) ||
      filters.has(product.label) ||
      filters.has(product.url),
  );
  if (selected.length === 0) {
    throw new Error(
      "POKEMONCENTER_PRODUCT_FILTER did not match a configured product.",
    );
  }
  return selected;
}

function normalizeLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isPurchaseAction(value) {
  return purchaseActionPattern.test(normalizeLabel(value));
}

function isTemporaryRestriction(value) {
  return temporaryRestrictionPattern.test(String(value || ""));
}

function validatePokemonCenterCart({ bodyText = "", hrefs = [], product } = {}) {
  if (!product || emptyCartPattern.test(bodyText)) {
    return false;
  }

  const source = [...hrefs, bodyText].join("\n");
  const detectedSkus = [
    ...new Set(source.match(/\b[0-9]+-[0-9]+-[0-9]+\b/g) || []),
  ];
  if (detectedSkus.length > 0 && detectedSkus.some((sku) => sku !== product.sku)) {
    return false;
  }

  return (
    source.includes(product.sku) ||
    String(bodyText).toLowerCase().includes(product.title.toLowerCase())
  );
}

module.exports = {
  isPurchaseAction,
  isTemporaryRestriction,
  normalizeProducts,
  pokemonCenterTabPolicy,
  productIdFromUrl,
  selectProducts,
  validatePokemonCenterCart,
};
