const { normalizeUrl } = require("./deals-core");
const { targetProductFromUrl } = require("../target-availability");

const targetShortHosts = new Set([
  "howl.link",
  "goto.target.com",
]);

function parseTargetBuyUrl(value) {
  const normalized = normalizeUrl(value);
  const url = new URL(normalized);
  if (url.protocol !== "https:") {
    throw new Error("Target buy URLs must use HTTPS.");
  }

  if (url.hostname === "target.com") {
    url.hostname = "www.target.com";
  }
  const product = targetProductFromUrl(url.href);
  if (product) {
    return {
      type: "product",
      product,
      url: product.url,
    };
  }

  if (targetShortHosts.has(url.hostname)) {
    return {
      type: "short-link",
      product: null,
      url: url.href,
    };
  }

  throw new Error(
    "Target buy requires a https://www.target.com product URL containing A-<TCIN>, or a supported Target short link.",
  );
}

function normalizeTargetBuyMode(value) {
  const normalized = String(value || "auto")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  const aliases = {
    auto: "direct-buy",
    "direct-buy": "direct-buy",
    directbuy: "direct-buy",
    preorder: "preorder",
    "pre-order": "preorder",
    buy: "buy",
    "add-to-cart": "buy",
    addtocart: "buy",
    "buy-now": "buy-now",
    buynow: "buy-now",
  };
  const mode = aliases[normalized];
  if (!mode) {
    throw new Error(
      "Target buy mode must be auto, preorder, buy, or buy-now.",
    );
  }
  return mode;
}

module.exports = {
  normalizeTargetBuyMode,
  parseTargetBuyUrl,
  targetShortHosts,
};
