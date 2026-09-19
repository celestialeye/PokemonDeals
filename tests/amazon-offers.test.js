const assert = require("assert");
const {
  buildOfferListingUrl,
  isQualifyingAmazonOffer,
  offerAddToCartSelector,
  offerContainerSelector,
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
