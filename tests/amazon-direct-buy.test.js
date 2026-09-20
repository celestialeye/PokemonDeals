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
  resolveVerifiedCheckoutUrl,
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

test("preserves product identity when checkout omits visible ASIN markup", () => {
  assert.equal(
    hasVerifiedDirectCheckoutIdentity({
      activeCheckoutUrl:
        "https://www.amazon.com/checkout/entry/buynow?<redacted>",
      activeOfferAsin: "B0GW2DK37Q",
      activeOfferListingId: "verified-offer-token",
      expectedAsin: "B0GW2DK37Q",
    }),
    true,
  );
  assert.equal(
    hasVerifiedDirectCheckoutIdentity({
      activeCheckoutUrl:
        "https://www.amazon.com/checkout/entry/buynow?<redacted>",
      activeOfferAsin: "B0007VO0DU",
      activeOfferListingId: "wrong-product-token",
      expectedAsin: "B0GW2DK37Q",
    }),
    false,
  );
});

test("uses a supplied Buy Now URL only when its token matches the verified Amazon offer", () => {
  const suppliedUrl =
    "https://www.amazon.com/checkout/entry/buynow?asin=B0GW2DK37Q&offeringID=verified%2Boffer%3D&quantity=1&buyNow=1&tag=emeraldalerts-20";

  assert.deepEqual(
    resolveVerifiedCheckoutUrl({
      asin: "B0GW2DK37Q",
      offerListingId: "verified%2Boffer%3D",
      tag: "emeraldalerts-20",
      suppliedUrl,
      suppliedListingId: "verified+offer=",
    }),
    {
      url: suppliedUrl,
      usesSuppliedUrl: true,
    },
  );

  const replacement = resolveVerifiedCheckoutUrl({
    asin: "B0GW2DK37Q",
    offerListingId: "current%2Bamazon%3D",
    tag: "emeraldalerts-20",
    suppliedUrl,
    suppliedListingId: "stale+offer=",
  });
  const parsedReplacement = new URL(replacement.url);
  assert.equal(replacement.usesSuppliedUrl, false);
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
