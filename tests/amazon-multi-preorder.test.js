const assert = require("assert");
const {
  findReusableProductPage,
  isProductCoolingDown,
  normalizeProducts,
  ownsCheckoutLock,
  requestShutdown,
} = require("../amazon-multi-preorder");
const {
  amazonCartUrl,
  navigateToCart,
  waitForExpectedCartItemCount,
} = require("../src/amazon-cart");

const products = normalizeProducts(
  JSON.stringify([
    {
      label: "Poster Collection",
      url: "https://www.amazon.com/dp/B0H77W4411",
      asin: "B0H77W4411",
      title: "Pokémon TCG: 30th Celebration Poster Collection",
    },
    {
      label: "Knockout Collection",
      url: "https://www.amazon.com/dp/B0H7FDBNSB",
      asin: "B0H7FDBNSB",
      title: "Pokémon TCG: 30th Celebration Knock Out Collection",
    },
  ]),
  { maxItemPrice: 30, maxOrderTotal: 40 },
);

assert.deepStrictEqual(products, [
  {
    label: "Poster Collection",
    url: "https://www.amazon.com/dp/B0H77W4411",
    asin: "B0H77W4411",
    title: "Pokémon TCG: 30th Celebration Poster Collection",
    maxItemPrice: 30,
    maxOrderTotal: 40,
  },
  {
    label: "Knockout Collection",
    url: "https://www.amazon.com/dp/B0H7FDBNSB",
    asin: "B0H7FDBNSB",
    title: "Pokémon TCG: 30th Celebration Knock Out Collection",
    maxItemPrice: 30,
    maxOrderTotal: 40,
  },
]);

assert.throws(
  () =>
    normalizeProducts(
      JSON.stringify([
        {
          label: "Auto Buy",
          url: "https://www.amazon.com/buying-rules?asin=B0H77W4411",
          asin: "B0H77W4411",
          title: "Auto Buy",
        },
      ]),
      { maxItemPrice: 30, maxOrderTotal: 40 },
    ),
  /product URL must be an Amazon \/dp\/ASIN URL/i,
);

assert.throws(
  () =>
    normalizeProducts(
      JSON.stringify([
        {
          label: "Duplicate A",
          url: "https://www.amazon.com/dp/B0H77W4411",
          asin: "B0H77W4411",
          title: "A",
        },
        {
          label: "Duplicate B",
          url: "https://www.amazon.com/dp/B0H77W4411",
          asin: "B0H77W4411",
          title: "B",
        },
      ]),
      { maxItemPrice: 30, maxOrderTotal: 40 },
    ),
  /duplicate ASIN/i,
);

(async () => {
  const cooldownState = {
    cooldownUntilByAsin: new Map([["B0H77VZBX4", 200]]),
  };
  assert.strictEqual(isProductCoolingDown(cooldownState, "B0H77VZBX4", 100), true);
  assert.strictEqual(isProductCoolingDown(cooldownState, "B0H77VZBX4", 200), false);

  assert.strictEqual(
    ownsCheckoutLock({ checkoutProductAsin: "B0H77VZBX4" }, "B0H77VZBX4"),
    true,
  );
  assert.strictEqual(
    ownsCheckoutLock({ checkoutProductAsin: "B0H77VZBX4" }, "B0H7FDBNSB"),
    false,
  );

  const lifecycleState = { shuttingDown: false };
  let tabClosed = false;
  await requestShutdown(lifecycleState, [
    {
      close: async () => {
        tabClosed = true;
      },
    },
  ]);
  assert.strictEqual(lifecycleState.shuttingDown, true);
  assert.strictEqual(tabClosed, false);

  assert.strictEqual(
    amazonCartUrl,
    "https://www.amazon.com/gp/cart/view.html",
  );

  const navigation = [];
  await navigateToCart({
    goto: async (url, options) => {
      navigation.push({ url, options });
    },
  });
  assert.strictEqual(navigation[0].url, amazonCartUrl);
  assert.strictEqual(navigation[0].options.waitUntil, "commit");

  const reusablePage = { url: () => "https://www.amazon.com/dp/B0H77WZBX4" };
  const matchingPage = { url: () => "https://www.amazon.com/dp/B0H77W4411" };
  assert.strictEqual(
    findReusableProductPage([reusablePage, matchingPage], "B0H77W4411"),
    matchingPage,
  );
  assert.strictEqual(
    findReusableProductPage(
      [matchingPage],
      "B0H77W4411",
      new Set([matchingPage]),
    ),
    null,
  );

  let attempts = 0;
  const count = await waitForExpectedCartItemCount(
    async () => {
      attempts += 1;
      return attempts < 3 ? 0 : 1;
    },
    100,
    10,
  );
  assert.strictEqual(count, 1);
  assert.ok(attempts >= 3);
  console.log("amazon-multi-preorder tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
