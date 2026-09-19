const assert = require("assert");
const {
  classifyCheckoutPage,
  classifyProductPage,
  getProductId,
  isSameProductUrl,
  normalizeInterval,
  validateCheckoutCart,
  validateCheckoutProducts,
} = require("../extension/target-purchase/lib/core");

assert.strictEqual(normalizeInterval(undefined), 5000);
assert.strictEqual(normalizeInterval("5000"), 5000);
assert.strictEqual(normalizeInterval(1000), 3000);
assert.strictEqual(normalizeInterval(999999), 300000);
assert.strictEqual(normalizeInterval("invalid"), 5000);

assert.strictEqual(
  getProductId("https://www.target.com/p/pokemon-box/-/A-1010892065"),
  "A-1010892065",
);
assert.strictEqual(
  getProductId("https://www.target.com/p/-/A-1010892068?preselect=123"),
  "A-1010892068",
);
assert.strictEqual(
  getProductId(
    "https://www.target.com/p/women-s-iconic-cotton-cardigan/-/A-95077135",
  ),
  "A-95077135",
);
assert.strictEqual(getProductId("https://www.target.com/checkout"), null);
assert.strictEqual(
  isSameProductUrl(
    "https://www.target.com/p/pokemon-box/-/A-1010892065",
    "https://www.target.com/p/pokemon-box/-/A-1010892065",
  ),
  true,
);
assert.strictEqual(
  isSameProductUrl(
    "https://www.target.com/p/pokemon-box/-/A-1010892065",
    "https://www.target.com/p/other-slug/-/A-1010892065",
  ),
  false,
);
assert.strictEqual(
  isSameProductUrl(
    "https://www.target.com/p/pokemon-box/-/A-1010892065?preselect=1",
    "https://www.target.com/p/pokemon-box/-/A-1010892065?preselect=2",
  ),
  false,
);

const baseProductSnapshot = {
  verificationVisible: false,
  successVisible: false,
  failureVisible: false,
  actionLabel: "",
  actionReady: false,
};

assert.deepStrictEqual(
  classifyProductPage(
    { ...baseProductSnapshot, verificationVisible: true },
    { phase: "monitoring" },
    1000,
  ),
  { type: "verification" },
);
assert.deepStrictEqual(
  classifyProductPage(
    {
      ...baseProductSnapshot,
      actionLabel: "Add to cart",
      actionReady: true,
    },
    { phase: "monitoring" },
    1000,
  ),
  { type: "click-product", label: "Add to cart" },
);
assert.deepStrictEqual(
  classifyProductPage(
    {
      ...baseProductSnapshot,
      actionLabel: "Preorder",
      actionReady: true,
    },
    { phase: "monitoring" },
    1000,
  ),
  { type: "click-product", label: "Preorder" },
);
assert.deepStrictEqual(
  classifyProductPage(
    {
      ...baseProductSnapshot,
      actionLabel: "Add to cart",
      actionReady: false,
    },
    { phase: "monitoring" },
    1000,
  ),
  { type: "refresh", label: "Add to cart" },
);
assert.deepStrictEqual(
  classifyProductPage(
    {
      ...baseProductSnapshot,
      actionLabel: "Buy now",
      actionReady: false,
    },
    { phase: "monitoring" },
    1000,
  ),
  { type: "pause-buy-now" },
);
assert.deepStrictEqual(
  classifyProductPage(baseProductSnapshot, { phase: "monitoring" }, 1000),
  { type: "refresh" },
);
assert.deepStrictEqual(
  classifyProductPage(
    {
      ...baseProductSnapshot,
      actionLabel: "Add to cart",
      actionReady: true,
    },
    { phase: "action-pending" },
    1000,
  ),
  { type: "wait" },
);
assert.deepStrictEqual(
  classifyProductPage(
    { ...baseProductSnapshot, failureVisible: true },
    { phase: "action-pending" },
    1000,
  ),
  { type: "cooldown", until: 11000 },
);
assert.deepStrictEqual(
  classifyProductPage(
    {
      ...baseProductSnapshot,
      successVisible: true,
      failureVisible: true,
    },
    { phase: "action-pending" },
    1000,
  ),
  { type: "cooldown", until: 11000 },
);
assert.deepStrictEqual(
  classifyProductPage(
    { ...baseProductSnapshot, successVisible: true },
    { phase: "action-pending" },
    1000,
  ),
  { type: "added" },
);
assert.deepStrictEqual(
  classifyProductPage(
    { ...baseProductSnapshot, failureVisible: true },
    { phase: "cooldown", cooldownUntil: 5000 },
    1000,
  ),
  { type: "wait" },
);
assert.deepStrictEqual(
  classifyProductPage(
    baseProductSnapshot,
    { phase: "cooldown", cooldownUntil: 5000 },
    5000,
  ),
  { type: "refresh" },
);
assert.deepStrictEqual(
  classifyProductPage(
    { ...baseProductSnapshot, failureVisible: true },
    { phase: "cooldown", cooldownUntil: 5000 },
    5000,
  ),
  { type: "dismiss-failure-refresh" },
);

assert.strictEqual(
  validateCheckoutProducts(
    ["A-1010892065"],
    ["A-1010892065", "A-1010892068"],
  ),
  true,
);
assert.strictEqual(validateCheckoutProducts([], ["A-1010892065"]), false);
assert.strictEqual(
  validateCheckoutProducts(
    ["A-1010892065", "A-9999999999"],
    ["A-1010892065"],
  ),
  false,
);
assert.strictEqual(
  validateCheckoutCart(
    [{ productId: "A-1010892065", quantity: 1 }],
    ["A-1010892065"],
    1,
  ),
  true,
);
assert.strictEqual(
  validateCheckoutCart(
    [{ productId: "A-1010892065", quantity: 1 }],
    ["A-1010892065"],
    null,
  ),
  false,
);
assert.strictEqual(
  validateCheckoutCart(
    [
      {
        productId: null,
        productLabel:
          "women's iconic cotton cardigan - universal thread™ brown xs",
        quantity: 1,
      },
    ],
    [],
    1,
    ["women's iconic cotton cardigan - universal thread™ brown xs"],
  ),
  true,
);
assert.strictEqual(
  validateCheckoutCart(
    [
      { productId: "A-1010892065", quantity: 1 },
      { productId: null, quantity: 1 },
    ],
    ["A-1010892065"],
    2,
  ),
  false,
);
assert.strictEqual(
  validateCheckoutCart(
    [{ productId: "A-1010892065", quantity: 2 }],
    ["A-1010892065"],
    1,
  ),
  false,
);
assert.strictEqual(
  validateCheckoutCart(
    [
      { productId: "A-1010892065", quantity: 1 },
      { productId: "A-1010892065", quantity: 1 },
    ],
    ["A-1010892065"],
    2,
  ),
  false,
);

const baseCheckoutSnapshot = {
  verificationVisible: false,
  confirmationVisible: false,
  cartRows: [{ productId: "A-1010892065", quantity: 1 }],
  cartItemCount: 1,
  armedProductLabels: [],
  onCartPage: false,
  highDemandReady: false,
  saveContinueReady: false,
  pinReady: false,
  placeOrderReady: false,
  transientBusy: false,
};

assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, verificationVisible: true },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "verification" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, confirmationVisible: true },
    { phase: "placing", armedProductIds: ["A-1010892065"] },
  ),
  { type: "confirmed" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    {
      ...baseCheckoutSnapshot,
      cartRows: [{ productId: "A-9999999999", quantity: 1 }],
      placeOrderReady: true,
    },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "blocked-cart" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    {
      ...baseCheckoutSnapshot,
      cartRows: [],
      cartItemCount: 1,
      pinReady: true,
    },
    {
      phase: "blocked",
      orderSubmittedAt: 1000,
      armedProductIds: ["A-1010892065"],
    },
  ),
  { type: "confirm-pin" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, placeOrderReady: true },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "place-order" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, placeOrderReady: true },
    { phase: "placing", armedProductIds: ["A-1010892065"] },
  ),
  { type: "wait" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, placeOrderReady: true },
    {
      phase: "placing",
      orderSubmittedAt: 1000,
      pinConfirmedAt: 2000,
      armedProductIds: ["A-1010892065"],
    },
  ),
  { type: "place-order" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, placeOrderReady: true },
    {
      phase: "placing",
      orderSubmittedAt: 1000,
      pinConfirmedAt: 2000,
      finalPlaceOrderAt: 3000,
      armedProductIds: ["A-1010892065"],
    },
  ),
  { type: "wait" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, onCartPage: true },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "go-checkout" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, cartRows: [], cartItemCount: 0 },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "refresh" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, highDemandReady: true },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "dismiss-high-demand" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, saveContinueReady: true },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "save-continue" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, pinReady: true },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "confirm-pin" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    {
      ...baseCheckoutSnapshot,
      cartRows: [{ productId: "A-9999999999", quantity: 2 }],
      pinReady: true,
    },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "blocked-cart" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, saveContinueReady: true },
    {
      phase: "transitioning",
      pendingAction: "save-continue",
      armedProductIds: ["A-1010892065"],
    },
  ),
  { type: "wait" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, pinReady: true },
    {
      phase: "transitioning",
      pendingAction: "save-continue",
      armedProductIds: ["A-1010892065"],
    },
  ),
  { type: "confirm-pin" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(
    { ...baseCheckoutSnapshot, transientBusy: true },
    { phase: "monitoring", armedProductIds: ["A-1010892065"] },
  ),
  { type: "refresh" },
);
assert.deepStrictEqual(
  classifyCheckoutPage(baseCheckoutSnapshot, {
    phase: "placing",
    armedProductIds: ["A-1010892065"],
  }),
  { type: "wait" },
);

console.log("target-extension-core tests passed");
