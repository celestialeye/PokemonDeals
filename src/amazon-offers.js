const offerContainerSelector = "#aod-pinned-offer, #aod-offer, .olpOffer";
const offerAddToCartSelector = 'input[name="submit.addToCart"]';
const offerListingIdSelector =
  'input[name="items[0.base][offerListingId]"], input[name="offerListingID"], input[name="offeringID"]';
const offerAsinSelector =
  'input[name="items[0.base][asin]"], input[name="ASIN"]';

function buildOfferListingUrl(asin) {
  return `https://www.amazon.com/gp/offer-listing/${asin}`;
}

function parseAmazonProductUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) {
    throw new Error("AMAZON_PRODUCT_URL is required.");
  }
  if (/\s/.test(value) || (value.match(/https?:\/\//gi) || []).length > 1) {
    throw new Error("AMAZON_PRODUCT_URL must contain exactly one URL.");
  }

  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch (error) {
    throw new Error(`AMAZON_PRODUCT_URL is invalid: ${error.message}`);
  }

  if (
    url.protocol !== "https:" ||
    !/(?:^|\.)amazon\.com$/i.test(url.hostname)
  ) {
    throw new Error("AMAZON_PRODUCT_URL must use https://amazon.com.");
  }

  const asinMatches = [
    ...url.pathname.matchAll(
      /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?=\/|$)/gi,
    ),
  ];
  if (asinMatches.length !== 1) {
    throw new Error(
      "AMAZON_PRODUCT_URL must contain exactly one /dp/ASIN or /gp/product/ASIN path.",
    );
  }

  return {
    asin: asinMatches[0][1].toUpperCase(),
    url: url.href,
  };
}

function buildDirectBuyUrl(asin, offerListingId, options = {}) {
  const normalizedAsin = String(asin || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(normalizedAsin)) {
    throw new Error("A valid 10-character ASIN is required.");
  }

  const encodedOfferListingId = String(offerListingId || "").trim();
  if (!encodedOfferListingId) {
    throw new Error("A current Amazon offer listing ID is required.");
  }

  let decodedOfferListingId;
  try {
    decodedOfferListingId = decodeURIComponent(encodedOfferListingId);
  } catch (error) {
    throw new Error(`Amazon offer listing ID is not valid URL encoding: ${error.message}`);
  }

  const url = new URL("https://www.amazon.com/checkout/entry/buynow");
  url.searchParams.set("asin", normalizedAsin);
  url.searchParams.set("offeringID", decodedOfferListingId);
  url.searchParams.set("pipelineType", "Chewbacca");
  url.searchParams.set("d", "tempo");
  url.searchParams.set("quantity", "1");
  url.searchParams.set("buyNow", "1");
  if (options.tag) {
    url.searchParams.set("tag", String(options.tag).trim());
  }
  return url.href;
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
  buildDirectBuyUrl,
  buildOfferListingUrl,
  isQualifyingAmazonOffer,
  offerAsinSelector,
  offerAddToCartSelector,
  offerContainerSelector,
  offerListingIdSelector,
  parseAmazonProductUrl,
  parseOfferPrice,
};
