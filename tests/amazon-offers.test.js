const assert = require("assert");
const {
  buildDirectBuyUrl,
  buildOfferListingUrl,
  isQualifyingAmazonOffer,
  offerAsinSelector,
  offerAddToCartSelector,
  offerContainerSelector,
  offerListingIdSelector,
  parseAmazonProductUrl,
} = require("../src/amazon-offers");

assert.strictEqual(
  buildOfferListingUrl("B0H77W4411"),
  "https://www.amazon.com/gp/offer-listing/B0H77W4411",
);

assert.strictEqual(
  offerContainerSelector,
  "#aod-pinned-offer, #aod-offer, .olpOffer",
);

assert.strictEqual(
  offerAddToCartSelector,
  'input[name="submit.addToCart"]',
);

assert.strictEqual(
  offerListingIdSelector,
  'input[name="items[0.base][offerListingId]"], input[name="offerListingID"], input[name="offeringID"]',
);

assert.strictEqual(
  offerAsinSelector,
  'input[name="items[0.base][asin]"], input[name="ASIN"]',
);

assert.deepStrictEqual(
  parseAmazonProductUrl(
    "amazon.com/gp/product/B0007VO0DU/ref=example?smid=ATVPDKIKX0DER",
  ),
  {
    asin: "B0007VO0DU",
    url: "https://amazon.com/gp/product/B0007VO0DU/ref=example?smid=ATVPDKIKX0DER",
  },
);

assert.deepStrictEqual(
  parseAmazonProductUrl("https://www.amazon.com/dp/B0GW2DK37Q?m=ATVPDKIKX0DER"),
  {
    asin: "B0GW2DK37Q",
    url: "https://www.amazon.com/dp/B0GW2DK37Q?m=ATVPDKIKX0DER",
  },
);

assert.throws(
  () => parseAmazonProductUrl("https://example.com/dp/B0GW2DK37Q"),
  /must use https:\/\/amazon\.com/i,
);

assert.throws(
  () =>
    parseAmazonProductUrl(
      "https://www.amazon.com/dp/B0007VO0DU https://www.amazon.com/dp/B0GW2DK37Q",
    ),
  /must contain exactly one URL/i,
);

const directBuyUrl = buildDirectBuyUrl(
  "b0007vo0du",
  "token%2Bwith%2Fcharacters%3D",
  { tag: "emeraldalerts-20" },
);
const parsedDirectBuyUrl = new URL(directBuyUrl);
assert.strictEqual(parsedDirectBuyUrl.pathname, "/checkout/entry/buynow");
assert.strictEqual(parsedDirectBuyUrl.searchParams.get("asin"), "B0007VO0DU");
assert.strictEqual(
  parsedDirectBuyUrl.searchParams.get("offeringID"),
  "token+with/characters=",
);
assert.strictEqual(
  directBuyUrl.includes("offeringID=token%2Bwith%2Fcharacters%3D"),
  true,
);
assert.strictEqual(parsedDirectBuyUrl.searchParams.get("quantity"), "1");
assert.strictEqual(parsedDirectBuyUrl.searchParams.get("buyNow"), "1");
assert.strictEqual(
  parsedDirectBuyUrl.searchParams.get("tag"),
  "emeraldalerts-20",
);

assert.strictEqual(
  isQualifyingAmazonOffer(
    [
      "New",
      "$26.99",
      "Add to Cart from seller Amazon.com and price $26.99",
      "Ships from Amazon.com",
      "Sold by Amazon.com",
    ].join("\n"),
    30,
  ),
  true,
);

assert.strictEqual(
  isQualifyingAmazonOffer(
    [
      "$26.87",
      "Buy Now",
      "Shipper / Seller Amazon.com",
    ].join("\n"),
    30,
  ),
  true,
);

assert.strictEqual(
  isQualifyingAmazonOffer(
    [
      "$29.99",
      "Buy Now",
      "Ships from Amazon",
      "Sold by Vault X Ltd",
    ].join("\n"),
    30,
  ),
  false,
);

assert.strictEqual(
  isQualifyingAmazonOffer(
    [
      "New",
      "$26.99",
      "Add to Cart from seller Marketplace Example and price $26.99",
      "Ships from Marketplace Example",
      "Sold by Marketplace Example",
    ].join("\n"),
    30,
  ),
  false,
);

assert.strictEqual(
  isQualifyingAmazonOffer(
    [
      "New",
      "$49.99",
      "Add to Cart from seller Amazon.com and price $49.99",
      "Ships from Amazon.com",
      "Sold by Amazon.com",
    ].join("\n"),
    30,
  ),
  false,
);

console.log("amazon-offers tests passed");
