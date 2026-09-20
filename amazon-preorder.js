const { chromium } = require("playwright-core");
const { installAmazonRunLogger } = require("./src/amazon-run-log");
const {
  confirmAmazonDuplicateOrder,
  isAmazonDuplicateOrderWarning,
  isAmazonOrderConfirmed,
  isAmazonSignInRequired,
  isAmazonVerificationRequired,
  isUnavailableCheckoutText,
  sanitizeAmazonError,
} = require("./amazon-checkout");
const {
  amazonOfferListingIdsMatch,
  buildDirectBuyUrl,
  buildOfferListingUrl,
  isQualifyingAmazonOffer,
  offerAsinSelector,
  offerAddToCartSelector,
  offerContainerSelector,
  offerListingIdSelector,
  parseAmazonCheckoutUrl,
  parseAmazonProductUrl,
  parseOfferPrice,
} = require("./src/amazon-offers");

const endpoint = "http://127.0.0.1:9444";
const configuredProductUrl = process.env.AMAZON_PRODUCT_URL;
const configuredCheckoutUrl = process.env.AMAZON_CHECKOUT_URL;
const parsedProduct = configuredProductUrl
  ? parseAmazonProductUrl(configuredProductUrl)
  : null;
const parsedCheckout = configuredCheckoutUrl
  ? parseAmazonCheckoutUrl(configuredCheckoutUrl)
  : null;
const inputAsin = parsedProduct?.asin || parsedCheckout?.asin;
const productUrl =
  parsedProduct?.url ||
  (parsedCheckout
    ? `https://www.amazon.com/dp/${parsedCheckout.asin}`
    : null);
const suppliedCheckoutUrl = parsedCheckout?.url || null;
const suppliedOfferListingId = parsedCheckout?.offerListingId || null;
const inputUrl = parsedProduct?.url || parsedCheckout?.url;
const associateTag = inputUrl
  ? new URL(inputUrl).searchParams.get("tag")
  : null;
const expectedAsin =
  process.env.AMAZON_EXPECTED_ASIN?.trim().toUpperCase() || inputAsin;
const expectedTitle = process.env.AMAZON_EXPECTED_TITLE || "";
const retryDelayMs = Number(process.env.AMAZON_RETRY_DELAY_MS || 2000);
const maxItemPrice = Number(process.env.AMAZON_MAX_ITEM_PRICE || 30);
const maxOrderTotal = Number(process.env.AMAZON_MAX_ORDER_TOTAL || 40);
const checkoutRetryDelayMs = 1000;
const offerRecheckInterval = 10;
const postSubmitConfirmationTimeoutMs = 60000;

async function readBody(page) {
  return page.locator("body").innerText().catch(() => "");
}

async function isReady(locator) {
  return (
    (await locator.count()) > 0 &&
    (await locator.isVisible().catch(() => false)) &&
    (await locator.isEnabled().catch(() => false))
  );
}

function parseOrderTotal(text) {
  const match = text
    .replace(/\s+/g, " ")
    .match(/order total:?\s*\$([\d,]+(?:\.\d{2})?)/i);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function hasVerifiedDirectCheckoutIdentity({
  activeCheckoutUrl,
  activeOfferAsin,
  activeOfferListingId,
  expectedAsin: requiredAsin,
}) {
  return (
    Boolean(activeCheckoutUrl) &&
    Boolean(activeOfferListingId) &&
    activeOfferAsin === requiredAsin
  );
}

function resolveVerifiedCheckoutUrl({
  asin,
  offerListingId,
  tag,
  suppliedUrl,
  suppliedListingId,
}) {
  const usesSuppliedUrl =
    Boolean(suppliedUrl) &&
    amazonOfferListingIdsMatch(offerListingId, suppliedListingId);

  return {
    url: usesSuppliedUrl
      ? suppliedUrl
      : buildDirectBuyUrl(asin, offerListingId, { tag }),
    usesSuppliedUrl,
  };
}

async function readFirstInputValue(scope, selector) {
  const inputs = scope.locator(selector);
  for (let index = 0; index < (await inputs.count()); index += 1) {
    const value = (await inputs.nth(index).inputValue().catch(() => "")).trim();
    if (value) {
      return value;
    }
  }
  return null;
}

async function getDirectOffer(page) {
  const buyBox = page.locator("#desktop_buybox, #buybox").first();
  if ((await buyBox.count()) === 0) {
    return null;
  }

  const text = (await buyBox.innerText().catch(() => "")).replace(/\s+/g, " ");
  const purchaseControl = buyBox
    .getByRole("button", {
      name: /^(?:buy now|pre-order now|add to cart)$/i,
    })
    .first();
  const offerAsin = (
    (await readFirstInputValue(buyBox, offerAsinSelector)) || ""
  ).toUpperCase();
  const offerListingId = await readFirstInputValue(
    buyBox,
    offerListingIdSelector,
  );

  return {
    actionable: await isReady(purchaseControl),
    asin: offerAsin,
    offerListingId,
    price: parseOfferPrice(text),
    qualifying: isQualifyingAmazonOffer(text, maxItemPrice),
    source: "buy-box",
  };
}

async function containsExpectedProduct(page, bodyText = "") {
  if (
    (await page
      .locator(
        `[data-asin="${expectedAsin}"], a[href*="/dp/${expectedAsin}"], input[value="${expectedAsin}"]`,
      )
      .count()) > 0
  ) {
    return true;
  }

  return expectedTitle.length > 0 && bodyText.includes(expectedTitle);
}

async function findAmazonBuyingOption(page) {
  const seeAllBuyingOptions = page
    .getByRole("link", { name: /see all buying options/i })
    .first();

  if (await isReady(seeAllBuyingOptions)) {
    const href = await seeAllBuyingOptions.getAttribute("href");
    if (href) {
      await page
        .goto(new URL(href, page.url()).href, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        })
        .catch(() => {});
    } else {
      await seeAllBuyingOptions.click({ timeout: 5000 }).catch(() => {});
    }
    await page
      .locator("#aod-offer-list")
      .waitFor({ timeout: 5000 })
      .catch(() => {});
  } else if (!/\/gp\/offer-listing\//i.test(page.url())) {
    await page
      .goto(buildOfferListingUrl(expectedAsin), {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
      .catch(() => {});
  }

  const offers = page.locator(offerContainerSelector);
  for (let index = 0; index < (await offers.count()); index += 1) {
    const offer = offers.nth(index);
    const seeMore = offer.getByText(/^(?:see more|\.\.\.\s*more)$/i).first();
    if (await isReady(seeMore)) {
      await seeMore.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(250);
    }

    const offerText = (await offer.innerText().catch(() => "")).replace(/\s+/g, " ");
    if (!isQualifyingAmazonOffer(offerText, maxItemPrice)) {
      continue;
    }

    const addToCart = offer.locator(offerAddToCartSelector).first();
    const offerAsin = (
      (await readFirstInputValue(offer, offerAsinSelector)) || ""
    ).toUpperCase();
    const offerListingId = await readFirstInputValue(
      offer,
      offerListingIdSelector,
    );
    if (
      offerAsin === expectedAsin &&
      offerListingId &&
      (await isReady(addToCart))
    ) {
      return {
        asin: offerAsin,
        offerListingId,
        price: parseOfferPrice(offerText),
        source: "buying-options",
      };
    }
  }

  return null;
}

async function findAmazonDirectBuyOffer(page) {
  const directOffer = await getDirectOffer(page);
  if (
    directOffer?.actionable &&
    directOffer.asin === expectedAsin &&
    directOffer.offerListingId &&
    directOffer.qualifying
  ) {
    return directOffer;
  }

  return findAmazonBuyingOption(page);
}

async function main() {
  if (!configuredProductUrl && !configuredCheckoutUrl) {
    throw new Error(
      "AMAZON_PRODUCT_URL or AMAZON_CHECKOUT_URL is required.",
    );
  }
  if (configuredProductUrl && configuredCheckoutUrl) {
    throw new Error(
      "Set exactly one of AMAZON_PRODUCT_URL or AMAZON_CHECKOUT_URL.",
    );
  }
  if (!expectedAsin) {
    throw new Error(
      "AMAZON_EXPECTED_ASIN is required when it cannot be read from the configured Amazon URL.",
    );
  }
  if (inputAsin !== expectedAsin) {
    throw new Error(
      "AMAZON_EXPECTED_ASIN does not match the configured Amazon URL.",
    );
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 1000) {
    throw new Error("AMAZON_RETRY_DELAY_MS must be at least 1000.");
  }
  if (!Number.isFinite(maxItemPrice) || maxItemPrice <= 0) {
    throw new Error("AMAZON_MAX_ITEM_PRICE must be greater than zero.");
  }
  if (!Number.isFinite(maxOrderTotal) || maxOrderTotal <= 0) {
    throw new Error("AMAZON_MAX_ORDER_TOTAL must be greater than zero.");
  }

  installAmazonRunLogger({
    workflow: "amazon-direct-buy",
    metadata: {
      asin: expectedAsin,
      quantity: 1,
    },
  });

  let attempts = 0;
  let checkoutRefreshes = 0;
  let activeCheckoutUrl = null;
  let activeOfferAsin = null;
  let activeOfferListingId = null;
  let verificationActive = false;
  let signInActive = false;
  let submissionAttempted = false;
  let submissionAttemptedAt = 0;
  let submissionGuardsValidated = false;
  let submissionPage = null;
  let duplicateConfirmationAttempted = false;
  let suppliedCheckoutDispositionLogged = false;

  while (true) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 3000 });
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("No authenticated Chrome context is available.");
      }
      const page = await context.newPage();
      await page.goto(activeCheckoutUrl || productUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      while (!page.isClosed()) {
        await page
          .waitForLoadState("domcontentloaded", { timeout: 15000 })
          .catch(() => {});
        await page.waitForTimeout(1000);

        const bodyText = await readBody(page);
        const verificationVisible = isAmazonVerificationRequired(
          page.url(),
          bodyText,
        );

        if (verificationVisible) {
          if (!verificationActive) {
            console.log("AMAZON_VERIFICATION_REQUIRED - waiting");
            verificationActive = true;
          }
          await page.waitForTimeout(1000);
          continue;
        }
        if (verificationActive) {
          console.log("AMAZON_VERIFICATION_CLEARED - resuming");
          verificationActive = false;
        }

        const signInVisible = isAmazonSignInRequired(page.url(), bodyText);
        if (signInVisible) {
          if (!signInActive) {
            console.log("AMAZON_SIGN_IN_REQUIRED - waiting");
            signInActive = true;
          }
          await page.waitForTimeout(1000);
          continue;
        }
        if (signInActive) {
          console.log("AMAZON_SIGN_IN_CLEARED - resuming");
          signInActive = false;
        }

        if (
          submissionAttempted &&
          isAmazonOrderConfirmed(page.url(), bodyText)
        ) {
          console.log("AMAZON_ORDER_CONFIRMED");
          process.exit(0);
        }

        if (
          submissionAttempted &&
          submissionPage === page &&
          submissionGuardsValidated &&
          !duplicateConfirmationAttempted &&
          isAmazonDuplicateOrderWarning(bodyText)
        ) {
          try {
            const duplicateConfirmed = await confirmAmazonDuplicateOrder(
              page,
              bodyText,
              {
                beforeClick: () => {
                  duplicateConfirmationAttempted = true;
                  submissionAttemptedAt = Date.now();
                },
                guardsValidated: true,
                submissionAttempted: true,
              },
            );
            if (duplicateConfirmed) {
              console.log("AMAZON_DUPLICATE_ORDER_CONFIRMED");
              await page.waitForTimeout(1000);
              continue;
            }
          } catch (error) {
            console.error(
              `AMAZON_DUPLICATE_ORDER_CONFIRMATION_AMBIGUOUS ${sanitizeAmazonError(error)}`,
            );
            process.exit(1);
          }
        }

        if (submissionAttempted) {
          if (
            Date.now() - submissionAttemptedAt >=
            postSubmitConfirmationTimeoutMs
          ) {
            console.error(
              "AMAZON_ORDER_CONFIRMATION_AMBIGUOUS - stopping to avoid a duplicate submission",
            );
            process.exit(1);
          }
          await page.waitForTimeout(1000);
          continue;
        }

        const outOfStockCheckout = /\/checkout\/entry\/oos/i.test(page.url());
        const onCheckoutPage =
          /amazon\.com\/checkout/i.test(page.url()) || outOfStockCheckout;
        const unavailable =
          outOfStockCheckout ||
          (onCheckoutPage && isUnavailableCheckoutText(bodyText));
        if (unavailable) {
          if (!activeCheckoutUrl) {
            await page
              .goto(productUrl, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              })
              .catch(() => {});
            continue;
          }

          checkoutRefreshes += 1;
          if (checkoutRefreshes === 1 || checkoutRefreshes % 10 === 0) {
            console.log(`AMAZON_CHECKOUT_REFRESH ${checkoutRefreshes}`);
          }

          if (checkoutRefreshes % offerRecheckInterval === 0) {
            await page
              .goto(productUrl, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              })
              .catch(() => {});

            const refreshedOffer = await findAmazonDirectBuyOffer(page);
            if (refreshedOffer) {
              const refreshedCheckout = resolveVerifiedCheckoutUrl({
                asin: expectedAsin,
                offerListingId: refreshedOffer.offerListingId,
                tag: associateTag,
                suppliedUrl: suppliedCheckoutUrl,
                suppliedListingId: suppliedOfferListingId,
              });
              if (refreshedOffer.offerListingId !== activeOfferListingId) {
                console.log(
                  `AMAZON_OFFER_TOKEN_REFRESHED - ${refreshedOffer.source} Amazon at $${refreshedOffer.price.toFixed(2)}`,
                );
                activeOfferAsin = refreshedOffer.asin;
                activeOfferListingId = refreshedOffer.offerListingId;
                activeCheckoutUrl = refreshedCheckout.url;
                checkoutRefreshes = 0;
              }
            }
          }

          await page.waitForTimeout(checkoutRetryDelayMs);
          await page
            .goto(activeCheckoutUrl, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            })
            .catch(() => {});
          continue;
        }

        const placeOrder = page
          .getByRole("button", { name: /place (?:your )?order/i })
          .first();
        if (await isReady(placeOrder)) {
          const productIdentityVerified =
            (await containsExpectedProduct(page, bodyText)) ||
            hasVerifiedDirectCheckoutIdentity({
              activeCheckoutUrl,
              activeOfferAsin,
              activeOfferListingId,
              expectedAsin,
            });
          if (!productIdentityVerified) {
            console.log(
              "AMAZON_CHECKOUT_PRODUCT_MISMATCH - refusing to place order",
            );
            await page
              .goto(productUrl, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              })
              .catch(() => {});
            continue;
          }

          const orderTotal = parseOrderTotal(bodyText);
          if (orderTotal === null) {
            console.log("AMAZON_ORDER_BLOCKED - order total not detected");
            await page.waitForTimeout(1000);
            continue;
          }
          if (orderTotal > maxOrderTotal) {
            console.error(
              `AMAZON_ORDER_BLOCKED - total $${orderTotal.toFixed(2)} exceeds limit $${maxOrderTotal.toFixed(2)}`,
            );
            process.exit(1);
          }

          console.log(`AMAZON_PLACE_ORDER_FOUND after ${attempts} attempts`);
          submissionAttempted = true;
          submissionAttemptedAt = Date.now();
          submissionGuardsValidated = true;
          submissionPage = page;
          try {
            await placeOrder.click({ timeout: 5000 });
          } catch (error) {
            console.error(
              `AMAZON_ORDER_CONFIRMATION_AMBIGUOUS ${sanitizeAmazonError(error)}`,
            );
            process.exit(1);
          }
          console.log("AMAZON_PLACE_ORDER_CLICKED");
          await page.waitForTimeout(1000);
          continue;
        }

        const continueButton = page
          .getByRole("button", { name: /^continue(?: shopping)?$/i })
          .first();
        if (await isReady(continueButton)) {
          await continueButton.click({ timeout: 5000 }).catch(() => {});
          console.log("AMAZON_CONTINUE_CLICKED - retrying");
          await page.waitForTimeout(1000);
          continue;
        }

        if (onCheckoutPage) {
          await page.waitForTimeout(500);
          continue;
        }

        const directOffer = await findAmazonDirectBuyOffer(page);
        if (directOffer) {
          attempts += 1;
          activeOfferAsin = directOffer.asin;
          activeOfferListingId = directOffer.offerListingId;
          const resolvedCheckout = resolveVerifiedCheckoutUrl({
            asin: expectedAsin,
            offerListingId: directOffer.offerListingId,
            tag: associateTag,
            suppliedUrl: suppliedCheckoutUrl,
            suppliedListingId: suppliedOfferListingId,
          });
          activeCheckoutUrl = resolvedCheckout.url;
          checkoutRefreshes = 0;
          if (suppliedCheckoutUrl && !suppliedCheckoutDispositionLogged) {
            console.log(
              resolvedCheckout.usesSuppliedUrl
                ? "AMAZON_SUPPLIED_CHECKOUT_VERIFIED"
                : "AMAZON_SUPPLIED_CHECKOUT_REPLACED - using current qualifying Amazon offer",
            );
            suppliedCheckoutDispositionLogged = true;
          }
          console.log(
            `AMAZON_DIRECT_CHECKOUT_FOUND ${attempts} - ${directOffer.source} Amazon at $${directOffer.price.toFixed(2)}`,
          );
          await page
            .goto(activeCheckoutUrl, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            })
            .catch(() => {});
          continue;
        }

        attempts += 1;
        if (attempts === 1 || attempts % 10 === 0) {
          console.log(`AMAZON_PRODUCT_REFRESH ${attempts}`);
        }
        await page.waitForTimeout(retryDelayMs);
        await page
          .goto(productUrl, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          })
          .catch(() => {});
      }
      if (submissionAttempted) {
        console.error(
          "AMAZON_ORDER_CONFIRMATION_AMBIGUOUS - submitted page closed before confirmation",
        );
        process.exit(1);
      }
    } catch (error) {
      if (submissionAttempted) {
        console.error(
          `AMAZON_ORDER_CONFIRMATION_AMBIGUOUS ${sanitizeAmazonError(error)}`,
        );
        process.exit(1);
      }
      console.error(
        `AMAZON_DIRECT_BUY_RECONNECT ${sanitizeAmazonError(error)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  findAmazonDirectBuyOffer,
  getDirectOffer,
  hasVerifiedDirectCheckoutIdentity,
  readFirstInputValue,
  resolveVerifiedCheckoutUrl,
};
