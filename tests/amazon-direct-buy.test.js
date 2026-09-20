const assert = require("node:assert/strict");
const test = require("node:test");

process.env.AMAZON_PRODUCT_URL =
  "https://www.amazon.com/dp/B0GW2DK37Q?m=ATVPDKIKX0DER";
delete process.env.AMAZON_CHECKOUT_URL;
process.env.AMAZON_MAX_ITEM_PRICE = "30";

const {
  findAmazonDirectBuyOffer,
  getDirectOffer,
  hasVerifiedDirectCheckoutIdentity,
  isAmazonCheckoutPageUrl,
  parseCheckoutLineItemPrice,
  parseCheckoutQuantity,
  parseOrderTotal,
  resolveVerifiedCheckoutUrl,
  selectExpectedCheckoutLineItem,
  validateAmazonCheckoutEvidence,
} = require("../amazon-preorder");
const {
  offerAsinSelector,
  offerAddToCartSelector,
  offerContainerSelector,
  offerListingIdSelector,
} = require("../src/amazon-offers");

function control(ready) {
  const locator = {
    count: async () => (ready ? 1 : 0),
    isEnabled: async () => ready,
    isVisible: async () => ready,
  };
  locator.first = () => locator;
  return locator;
}

function inputs(values) {
  return {
    count: async () => values.length,
    nth: (index) => ({
      inputValue: async () => values[index],
    }),
  };
}

function buyBox({ text, asin, offerListingId, actionable = true }) {
  return {
    count: async () => 1,
    getByRole: () => control(actionable),
    innerText: async () => text,
    locator: (selector) => {
      if (selector === offerAsinSelector) {
        return inputs([asin]);
      }
      if (selector === offerListingIdSelector) {
        return inputs([offerListingId]);
      }
      throw new Error(`Unexpected buy-box selector: ${selector}`);
    },
  };
}

function productPage(options) {
  const box = buyBox(options);
  return {
    locator: (selector) => {
      assert.equal(selector, "#desktop_buybox, #buybox");
      return {
        first: () => box,
      };
    },
  };
}

test("accepts a live Amazon Buy Box with a matching ASIN and offer token", async () => {
  const offer = await findAmazonDirectBuyOffer(
    productPage({
      text: "$26.87 Buy Now Shipper / Seller Amazon.com",
      asin: "B0GW2DK37Q",
      offerListingId: "current%2Boffer%3D",
    }),
  );

  assert.deepEqual(offer, {
    actionable: true,
    asin: "B0GW2DK37Q",
    offerListingId: "current%2Boffer%3D",
    price: 26.87,
    qualifying: true,
    source: "buy-box",
  });
});

test("rejects a Buy Box that Amazon ships but a third party sells", async () => {
  const offer = await getDirectOffer(
    productPage({
      text: "$29.99 Buy Now Ships from Amazon Sold by Vault X Ltd",
      asin: "B0GW2DK37Q",
      offerListingId: "third-party-token",
    }),
  );

  assert.equal(offer.qualifying, false);
});

test("discovers a qualifying Amazon offer from buying options without adding it to cart", async () => {
  const offer = {
    getByText: () => control(false),
    innerText: async () =>
      "$26.87 Add to Cart from seller Amazon.com and price $26.87 Ships from Amazon.com Sold by Amazon.com",
    locator: (selector) => {
      if (selector === offerAddToCartSelector) {
        return {
          first: () => control(true),
        };
      }
      if (selector === offerAsinSelector) {
        return inputs(["B0GW2DK37Q"]);
      }
      if (selector === offerListingIdSelector) {
        return inputs(["buying-options-token"]);
      }
      throw new Error(`Unexpected offer selector: ${selector}`);
    },
  };
  const page = {
    getByRole: () => ({
      first: () => control(false),
    }),
    locator: (selector) => {
      if (selector === "#desktop_buybox, #buybox") {
        return {
          first: () => ({
            count: async () => 0,
          }),
        };
      }
      if (selector === offerContainerSelector) {
        return {
          count: async () => 1,
          nth: () => offer,
        };
      }
      throw new Error(`Unexpected page selector: ${selector}`);
    },
    url: () =>
      "https://www.amazon.com/gp/offer-listing/B0GW2DK37Q",
  };

  assert.deepEqual(await findAmazonDirectBuyOffer(page), {
    asin: "B0GW2DK37Q",
    offerListingId: "buying-options-token",
    price: 26.87,
    source: "buying-options",
  });
});

test("requires the active checkout URL and offer token to match", () => {
  const checkoutUrl =
    "https://www.amazon.com/checkout/entry/buynow?asin=B0GW2DK37Q&offeringID=verified%2Boffer%3D&quantity=1&buyNow=1";

  assert.equal(
    hasVerifiedDirectCheckoutIdentity({
      activeCheckoutUrl: checkoutUrl,
      activeOfferAsin: "B0GW2DK37Q",
      activeOfferListingId: "verified+offer=",
      expectedAsin: "B0GW2DK37Q",
    }),
    true,
  );
  assert.equal(
    hasVerifiedDirectCheckoutIdentity({
      activeCheckoutUrl: checkoutUrl,
      activeOfferAsin: "B0GW2DK37Q",
      activeOfferListingId: "stale-offer-token",
      expectedAsin: "B0GW2DK37Q",
    }),
    false,
  );
  assert.equal(
    hasVerifiedDirectCheckoutIdentity({
      activeCheckoutUrl: "https://www.amazon.com/checkout/entry/buynow?<redacted>",
      activeOfferAsin: "B0GW2DK37Q",
      activeOfferListingId: "verified+offer=",
      expectedAsin: "B0GW2DK37Q",
    }),
    false,
  );
});

test("recognizes Amazon checkout and gp/buy routes only", () => {
  assert.equal(
    isAmazonCheckoutPageUrl(
      "https://www.amazon.com/checkout/entry/buynow?asin=B0GW2DK37Q",
    ),
    true,
  );
  assert.equal(
    isAmazonCheckoutPageUrl(
      "https://www.amazon.com/gp/buy/spc/handlers/display.html",
    ),
    true,
  );
  assert.equal(
    isAmazonCheckoutPageUrl("https://www.amazon.com/gp/buy/thankyou"),
    true,
  );
  assert.equal(
    isAmazonCheckoutPageUrl("https://www.amazon.com/dp/B0GW2DK37Q"),
    false,
  );
  assert.equal(
    isAmazonCheckoutPageUrl("https://example.com/checkout/entry/buynow"),
    false,
  );
});

test("validates current checkout identity, quantity, item price, and total", () => {
  const bodyText = [
    "Pokemon Trading Card Game",
    "Qty: 1",
    "Items: $26.87",
    "Order total: $28.91",
  ].join("\n");
  const lineItem = selectExpectedCheckoutLineItem(
    [
      {
        asins: ["B0GW2DK37Q"],
        text: "Pokemon Trading Card Game Qty: 1 $26.87",
      },
    ],
    { expectedAsin: "B0GW2DK37Q" },
  );

  assert.equal(parseCheckoutQuantity(bodyText), 1);
  assert.equal(parseCheckoutLineItemPrice(lineItem.text), 26.87);
  assert.equal(parseOrderTotal(bodyText), 28.91);
  assert.deepEqual(
    validateAmazonCheckoutEvidence({
      currentCheckoutPageVerified: true,
      directCheckoutIdentityVerified: true,
      lineItem,
      bodyText,
      maxItemPrice: 30,
      maxOrderTotal: 40,
    }),
    {
      ok: true,
      itemPrice: 26.87,
      orderTotal: 28.91,
      quantity: 1,
    },
  );
});

test("blocks stale identity, wrong quantity, and checkout price increases", () => {
  const validText = "Qty: 1 Items: $26.87 Order total: $28.91";
  const validLineItem = {
    asins: ["B0GW2DK37Q"],
    itemPrice: 26.87,
    quantity: 1,
    text: "Pokemon Trading Card Game Qty: 1 $26.87",
  };

  assert.deepEqual(
    validateAmazonCheckoutEvidence({
      currentCheckoutPageVerified: true,
      directCheckoutIdentityVerified: false,
      lineItem: validLineItem,
      bodyText: validText,
      maxItemPrice: 30,
      maxOrderTotal: 40,
    }),
    { ok: false, reason: "product-mismatch" },
  );
  assert.deepEqual(
    validateAmazonCheckoutEvidence({
      currentCheckoutPageVerified: true,
      directCheckoutIdentityVerified: true,
      lineItem: {
        ...validLineItem,
        itemPrice: 53.74,
        quantity: 2,
      },
      bodyText: "Qty: 2 Items: $53.74 Order total: $57.82",
      maxItemPrice: 30,
      maxOrderTotal: 60,
    }),
    { ok: false, reason: "quantity-not-one", quantity: 2 },
  );
  assert.deepEqual(
    validateAmazonCheckoutEvidence({
      currentCheckoutPageVerified: true,
      directCheckoutIdentityVerified: true,
      lineItem: {
        ...validLineItem,
        itemPrice: 31,
      },
      bodyText: "Qty: 1 Items: $31.00 Order total: $33.17",
      maxItemPrice: 30,
      maxOrderTotal: 40,
    }),
    {
      ok: false,
      reason: "item-price-over-limit",
      itemPrice: 31,
    },
  );
});

test("blocks incomplete checkout evidence before submission", () => {
  const base = {
    currentCheckoutPageVerified: true,
    directCheckoutIdentityVerified: true,
    maxItemPrice: 30,
    maxOrderTotal: 40,
  };

  assert.deepEqual(
    validateAmazonCheckoutEvidence({
      ...base,
      currentCheckoutPageVerified: false,
      lineItem: {
        asins: ["B0GW2DK37Q"],
        itemPrice: 26.87,
        quantity: 1,
        text: "Pokemon Trading Card Game Qty: 1 $26.87",
      },
      bodyText: "Order total: $28.91",
    }),
    { ok: false, reason: "product-mismatch" },
  );
  assert.deepEqual(
    validateAmazonCheckoutEvidence({
      ...base,
      lineItem: null,
      bodyText: "Order total: $28.91",
    }),
    { ok: false, reason: "product-mismatch" },
  );
  assert.deepEqual(
    validateAmazonCheckoutEvidence({
      ...base,
      lineItem: {
        asins: ["B0GW2DK37Q"],
        itemPrice: 26.87,
        quantity: 1,
        text: "Pokemon Trading Card Game Qty: 1 $26.87",
      },
      bodyText: "Qty: 1 Items: $26.87",
    }),
    { ok: false, reason: "order-total-missing" },
  );
});

test("does not combine an expected recommendation with another ordered item", () => {
  const candidates = [
    {
      asins: ["B0GW2DK37Q"],
      text: "Recommended Pokemon Trading Card Game $26.87",
    },
    {
      asins: ["B0007VO0DU"],
      text: "Different ordered product Qty: 1 $19.99",
    },
  ];

  assert.equal(
    selectExpectedCheckoutLineItem(candidates, {
      expectedAsin: "B0GW2DK37Q",
    }),
    null,
  );
});

test("requires exactly one visible checkout line item", () => {
  const candidates = [
    {
      asins: ["B0GW2DK37Q"],
      text: "Expected item Qty: 1 $26.87",
    },
    {
      asins: ["B0007VO0DU"],
      text: "Second item Qty: 1 $19.99",
    },
  ];

  assert.equal(
    selectExpectedCheckoutLineItem(candidates, {
      expectedAsin: "B0GW2DK37Q",
    }),
    null,
  );
});

test("counts an unparseable second checkout item as a second item", () => {
  const validItem = {
    id: "item-1",
    asins: ["B0GW2DK37Q"],
    text: "Expected item Qty: 1 $26.87",
  };

  for (const secondItem of [
    {
      id: "item-2",
      asins: ["B0007VO0DU"],
      text: "Second item $19.99",
    },
    {
      id: "item-2",
      asins: ["B0007VO0DU"],
      text: "Second item Qty: 1 $19.99 List price $24.99",
    },
  ]) {
    assert.equal(
      selectExpectedCheckoutLineItem([validItem, secondItem], {
        expectedAsin: "B0GW2DK37Q",
      }),
      null,
    );
  }
});

test("uses a supplied offer token only when it matches the verified Amazon offer", () => {
  const suppliedUrl =
    "https://www.amazon.com/checkout/entry/buynow?asin=B0GW2DK37Q&offeringID=verified%2Boffer%3D&quantity=1&buyNow=1&tag=emeraldalerts-20&unexpected=discard-me";

  const verified = resolveVerifiedCheckoutUrl({
    asin: "B0GW2DK37Q",
    offerListingId: "verified%2Boffer%3D",
    tag: "emeraldalerts-20",
    suppliedUrl,
    suppliedListingId: "verified+offer=",
  });
  const parsedVerified = new URL(verified.url);
  assert.equal(verified.suppliedOfferVerified, true);
  assert.equal(parsedVerified.searchParams.get("unexpected"), null);
  assert.equal(
    parsedVerified.searchParams.get("offeringID"),
    "verified+offer=",
  );

  const replacement = resolveVerifiedCheckoutUrl({
    asin: "B0GW2DK37Q",
    offerListingId: "current%2Bamazon%3D",
    tag: "emeraldalerts-20",
    suppliedUrl,
    suppliedListingId: "stale+offer=",
  });
  const parsedReplacement = new URL(replacement.url);
  assert.equal(replacement.suppliedOfferVerified, false);
  assert.equal(parsedReplacement.searchParams.get("asin"), "B0GW2DK37Q");
  assert.equal(
    parsedReplacement.searchParams.get("offeringID"),
    "current+amazon=",
  );
  assert.equal(
    parsedReplacement.searchParams.get("tag"),
    "emeraldalerts-20",
  );
});
