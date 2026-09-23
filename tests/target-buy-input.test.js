const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeTargetBuyMode,
  parseTargetBuyUrl,
} = require("../src/target-buy-input");

test("Target buy accepts one canonical product URL", () => {
  const parsed = parseTargetBuyUrl(
    "target.com/p/pokemon-product/-/A-1007918679?preselect=1007918679",
  );

  assert.equal(parsed.type, "product");
  assert.equal(parsed.product.id, "A-1007918679");
  assert.equal(parsed.product.tcin, "1007918679");
  assert.match(parsed.url, /^https:\/\/www\.target\.com\/p\//);
});

test("Target buy accepts a slugged Target product URL", () => {
  const parsed = parseTargetBuyUrl(
    "https://www.target.com/p/women--39-s-iconic-cotton-cardigan---universal-thread--8482--brown-xs/-/A-95025127",
  );

  assert.equal(parsed.type, "product");
  assert.equal(parsed.product.id, "A-95025127");
  assert.equal(parsed.product.tcin, "95025127");
});

test("Target buy accepts supported Target short links without inventing an ID", () => {
  const parsed = parseTargetBuyUrl("https://howl.link/example");

  assert.equal(parsed.type, "short-link");
  assert.equal(parsed.product, null);
  assert.equal(parsed.url, "https://howl.link/example");
});

test("Target buy rejects unsafe or non-product URLs", () => {
  assert.throws(
    () => parseTargetBuyUrl("https://www.target.com/cart"),
    /Target buy requires/,
  );
  assert.throws(
    () => parseTargetBuyUrl("https://user:password@www.target.com/p/-/A-1007918679"),
    /credentials are not allowed/,
  );
  assert.throws(
    () => parseTargetBuyUrl("https://example.com/p/-/A-1007918679"),
    /Target buy requires/,
  );
});

test("Target buy mode aliases preserve the intentional automatic path", () => {
  assert.equal(normalizeTargetBuyMode(), "direct-buy");
  assert.equal(normalizeTargetBuyMode("auto"), "direct-buy");
  assert.equal(normalizeTargetBuyMode("pre-order"), "preorder");
  assert.equal(normalizeTargetBuyMode("add to cart"), "buy");
  assert.equal(normalizeTargetBuyMode("Buy Now"), "buy-now");
  assert.throws(() => normalizeTargetBuyMode("observe"), /Target buy mode/);
});
