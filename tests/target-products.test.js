const assert = require("node:assert/strict");

const {
  products,
  isCartSuccess,
  isPurchaseAction,
  normalizeRequestedPurchaseMode,
  directBuyPurchaseModeOrder,
  productIdFromUrl,
  productMonitorTabPolicy,
  productPurchaseSelector,
  purchaseModeFromLabel,
  selectPurchaseCandidate,
  validateCartContents,
} = require("../target-products");

const expectedIds = [
  "A-1010892076",
  "A-1010892065",
  "A-1010892068",
  "A-1010892078",
  "A-1010892067",
  "A-1010892069",
  "A-1010892070",
  "A-1012422107",
  "A-1011407490",
  "A-1010892075",
  "A-1010892071",
];

assert.deepEqual(
  products.map((product) => product.id),
  expectedIds,
);
assert.equal(new Set(products.map((product) => product.id)).size, 11);
assert.ok(products.every((product) => /^https:\/\/www\.target\.com\//.test(product.url)));

assert.equal(isPurchaseAction("Preorder"), true);
assert.equal(isPurchaseAction("Add to cart"), true);
assert.equal(isPurchaseAction("Buy now"), true);
assert.equal(isPurchaseAction("Ship it"), false);
assert.equal(normalizeRequestedPurchaseMode("pre-order"), "preorder");
assert.equal(normalizeRequestedPurchaseMode("add to cart"), "add-to-cart");
assert.equal(normalizeRequestedPurchaseMode("Buy Now"), "buy-now");
assert.equal(normalizeRequestedPurchaseMode("direct buy"), "direct-buy");
assert.equal(purchaseModeFromLabel("Preorder"), "preorder");
assert.equal(
  selectPurchaseCandidate(
    [{ label: "Buy now" }, { label: "Add to cart" }],
    "add-to-cart",
  ).label,
  "Add to cart",
);
assert.equal(
  selectPurchaseCandidate(
    [
      { label: "Buy now" },
      { label: "Add to cart" },
      { label: "Preorder" },
    ],
    "auto",
  ).label,
  "Preorder",
);
assert.equal(
  selectPurchaseCandidate(
    [
      { label: "Add to cart" },
      { label: "Preorder" },
      { label: "Buy now" },
    ],
    "direct-buy",
  ).label,
  "Buy now",
);
assert.equal(selectPurchaseCandidate([{ label: "Buy now" }], "auto"), null);
assert.deepEqual(
  directBuyPurchaseModeOrder,
  ["buy-now", "preorder", "add-to-cart"],
);
assert.equal(productMonitorTabPolicy, "one-per-product");
assert.equal(
  productIdFromUrl("https://www.target.com/p/pokemon/-/A-1010892075"),
  "A-1010892075",
);
assert.equal(productIdFromUrl("https://www.target.com/cart"), null);
assert.equal(
  productPurchaseSelector,
  '[data-test="module-product-detail-add-to-cart"] button',
);

assert.equal(
  isCartSuccess("https://www.target.com/cart", ""),
  true,
);
assert.equal(
  isCartSuccess(
    "https://www.target.com/p/-/A-1010892076",
    "Item not added to cart",
  ),
  false,
);

assert.equal(
  validateCartContents({
    bodyText: "Pokémon 30th Celebration Booster Bundle Box",
    hrefs: [],
  }),
  true,
);
assert.equal(
  validateCartContents({
    bodyText: "Unrelated product",
    hrefs: ["https://www.target.com/p/-/A-9999999999"],
  }),
  false,
);
assert.equal(
  validateCartContents({
    bodyText: "Checkout",
    hrefs: ["https://www.target.com/p/-/A-1010892076"],
  }),
  true,
);

console.log("target-products tests passed");
