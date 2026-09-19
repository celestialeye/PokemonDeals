const offerContainerSelector = "#aod-pinned-offer, #aod-offer, .olpOffer";
const offerAddToCartSelector = 'input[name="submit.addToCart"]';

function buildOfferListingUrl(asin) {
  return `https://www.amazon.com/gp/offer-listing/${asin}`;
}

function parseOfferPrice(text) {
  const match = text.match(/\$([\d,]+(?:\.\d{2})?)/);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function isQualifyingAmazonOffer(text, maxItemPrice) {
  const normalizedText = text.replace(/\s+/g, " ");
  const sellerControlSaysAmazon =
    /add to cart from seller amazon\.com/i.test(normalizedText);
  const shipsFromAmazon =
    /ships from\s+amazon(?:\.com)?(?: services llc)?(?:\s|$)/i.test(
      normalizedText,
    ) ||
    /shipper\s*\/\s*seller\s+amazon(?:\.com)?(?:\s|$)/i.test(normalizedText);
  const soldByAmazon =
    /sold by\s+amazon(?:\.com)?(?: services llc)?(?:\s|$)/i.test(
      normalizedText,
    ) ||
    /shipper\s*\/\s*seller\s+amazon(?:\.com)?(?:\s|$)/i.test(normalizedText) ||
    sellerControlSaysAmazon;
  const price = parseOfferPrice(normalizedText);

  return (
    shipsFromAmazon &&
    soldByAmazon &&
    price !== null &&
    price <= maxItemPrice
  );
}

module.exports = {
  buildOfferListingUrl,
  isQualifyingAmazonOffer,
  offerAddToCartSelector,
  offerContainerSelector,
};
