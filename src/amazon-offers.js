const offerContainerSelector = "#aod-pinned-offer, #aod-offer, .olpOffer";
const offerAddToCartSelector = 'input[name="submit.addToCart"]';
const offerListingIdSelector =
  'input[name="items[0.base][offerListingId]"], input[name="offerListingID"], input[name="offeringID"]';
const offerAsinSelector =
  'input[name="items[0.base][asin]"], input[name="ASIN"]';

function buildOfferListingUrl(asin) {
  return `https://www.amazon.com/gp/offer-listing/${asin}`;
}

function parseAmazonUrl(rawUrl, environmentName) {
  const value = String(rawUrl || "").trim();
  if (!value) {
    throw new Error(`${environmentName} is required.`);
  }
  if (/\s/.test(value) || (value.match(/https?:\/\//gi) || []).length > 1) {
    throw new Error(`${environmentName} must contain exactly one URL.`);
  }

  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch (error) {
    throw new Error(`${environmentName} is invalid: ${error.message}`);
  }

  if (
    url.protocol !== "https:" ||
    !/(?:^|\.)amazon\.com$/i.test(url.hostname)
  ) {
    throw new Error(`${environmentName} must use https://amazon.com.`);
  }

  return url;
}

function parseAmazonProductUrl(rawUrl) {
  const url = parseAmazonUrl(rawUrl, "AMAZON_PRODUCT_URL");
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

function parseAmazonCheckoutUrl(rawUrl) {
  const url = parseAmazonUrl(rawUrl, "AMAZON_CHECKOUT_URL");
  if (!/^\/checkout\/entry\/buynow\/?$/i.test(url.pathname)) {
    throw new Error(
      "AMAZON_CHECKOUT_URL must use the /checkout/entry/buynow path.",
    );
  }

  const requiredParameter = (name) => {
    const values = url.searchParams.getAll(name);
    if (values.length !== 1 || !values[0].trim()) {
      throw new Error(
        `AMAZON_CHECKOUT_URL must contain exactly one ${name} parameter.`,
      );
    }
    return values[0];
  };

  const asin = requiredParameter("asin").toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new Error(
      "AMAZON_CHECKOUT_URL must contain a valid 10-character ASIN.",
    );
  }

  const offerListingId = requiredParameter("offeringID");
  if (requiredParameter("quantity") !== "1") {
    throw new Error("AMAZON_CHECKOUT_URL quantity must be 1.");
  }
  if (requiredParameter("buyNow") !== "1") {
    throw new Error("AMAZON_CHECKOUT_URL buyNow must be 1.");
  }

  return {
    asin,
    offerListingId,
    url: url.href,
  };
}

function parseAmazonBuyUrl(rawUrl) {
  const url = parseAmazonUrl(rawUrl, "Amazon buy URL");
  if (/\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(url.pathname)) {
    return {
      type: "product",
      ...parseAmazonProductUrl(url.href),
    };
  }
  if (/^\/checkout\/entry\/buynow\/?$/i.test(url.pathname)) {
    return {
      type: "checkout",
      ...parseAmazonCheckoutUrl(url.href),
    };
  }

  throw new Error(
    "Amazon buy URL must contain one /dp/ASIN or /gp/product/ASIN path, or use /checkout/entry/buynow.",
  );
}

function normalizeAmazonOfferListingId(value) {
  const encodedValue = String(value || "").trim();
  if (!encodedValue) {
    return null;
  }

  // Hidden inputs may encode a token that URLSearchParams has already decoded.
  try {
    return decodeURIComponent(encodedValue);
  } catch {
    return null;
  }
}

function amazonOfferListingIdsMatch(left, right) {
  const normalizedLeft = normalizeAmazonOfferListingId(left);
  const normalizedRight = normalizeAmazonOfferListingId(right);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    normalizedLeft === normalizedRight
  );
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
    // URLSearchParams re-encodes once; never carry over a supplied checkout URL.
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
  // Amazon shipping alone does not qualify an offer sold by a third party.
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
  amazonOfferListingIdsMatch,
  buildDirectBuyUrl,
  buildOfferListingUrl,
  isQualifyingAmazonOffer,
  offerAsinSelector,
  offerAddToCartSelector,
  offerContainerSelector,
  offerListingIdSelector,
  parseAmazonBuyUrl,
  parseAmazonCheckoutUrl,
  parseAmazonProductUrl,
  parseOfferPrice,
};
