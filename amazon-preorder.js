const { chromium } = require("playwright-core");
const {
  navigateToCart,
  waitForExpectedCartItemCount,
} = require("./src/amazon-cart");
const {
  buildOfferListingUrl,
  isQualifyingAmazonOffer,
  offerAddToCartSelector,
  offerContainerSelector,
} = require("./src/amazon-offers");

const endpoint = "http://127.0.0.1:9444";
const productUrl = process.env.AMAZON_PRODUCT_URL;
const expectedAsin =
  process.env.AMAZON_EXPECTED_ASIN ||
  productUrl?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
const expectedTitle = process.env.AMAZON_EXPECTED_TITLE || "";
const retryDelayMs = Number(process.env.AMAZON_RETRY_DELAY_MS || 2000);
const maxItemPrice = Number(process.env.AMAZON_MAX_ITEM_PRICE || 30);
const maxOrderTotal = Number(process.env.AMAZON_MAX_ORDER_TOTAL || 40);
const unavailablePattern =
  /this item is currently unavailable|items? you selected (?:are|is) not available|item .* is no longer available from the seller you selected|items out of stock/i;
const verificationPattern =
  /verify (?:that )?you(?:'re| are) human|captcha|not a robot|robot check|enter the characters you see/i;
const confirmationPattern =
  /thank you,? your order has been placed|order placed|order number/i;

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

function parsePrice(text) {
  const match = text.match(/\$([\d,]+(?:\.\d{2})?)/);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function parseOrderTotal(text) {
  const match = text
    .replace(/\s+/g, " ")
    .match(/order total:?\s*\$([\d,]+(?:\.\d{2})?)/i);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

async function getDirectOffer(page) {
  const buyBox = page.locator("#desktop_buybox, #buybox").first();
  const text = (await buyBox.innerText().catch(() => "")).replace(/\s+/g, " ");
  const soldByAmazon =
    /sold by\s+amazon(?:\.com)?(?: services llc)?(?:\s|$)/i.test(text) ||
    /shipper\s*\/\s*seller\s+amazon(?:\.com)?(?:\s|$)/i.test(text);
  const shipsFromAmazon =
    /ships from\s+amazon(?:\.com)?(?: services llc)?(?:\s|$)/i.test(text) ||
    /shipper\s*\/\s*seller\s+amazon(?:\.com)?(?:\s|$)/i.test(text);

  return {
    price: parsePrice(text),
    soldByAmazon,
    shipsFromAmazon,
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

async function selectOnlyExpectedCartItem(page) {
  if (!/\/(?:gp\/cart|cart)\b/i.test(page.url())) {
    return true;
  }

  const activeCart = page.locator("#sc-active-cart");
  const expectedItem = activeCart
    .locator(`.sc-list-item[data-asin="${expectedAsin}"]`)
    .first();
  if (
    (await waitForExpectedCartItemCount(() => expectedItem.count())) === 0
  ) {
    console.log("AMAZON_CART_PRODUCT_MISMATCH - expected ASIN is not in cart");
    return false;
  }

  const items = activeCart.locator(".sc-list-item[data-asin]");
  for (let index = 0; index < (await items.count()); index += 1) {
    const item = items.nth(index);
    const asin = (await item.getAttribute("data-asin"))?.toUpperCase();
    const checkbox = item.locator('input[type="checkbox"]').first();
    if ((await checkbox.count()) === 0) {
      continue;
    }

    if (asin === expectedAsin) {
      await checkbox.check({ force: true }).catch(() => {});
    } else {
      await checkbox.uncheck({ force: true }).catch(() => {});
    }
  }

  return true;
}

async function selectAmazonBuyingOption(page) {
  const seeAllBuyingOptions = page
    .getByRole("link", { name: /see all buying options/i })
    .first();

  if (await isReady(seeAllBuyingOptions)) {
    await seeAllBuyingOptions.click({ timeout: 5000 });
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
    if (await isReady(addToCart)) {
      const price = parsePrice(offerText);
      await addToCart.click({ timeout: 5000 });
      console.log(
        `AMAZON_OFFER_ADDED - Amazon seller at $${price.toFixed(2)}`,
      );
      await page.waitForTimeout(1000);
      if (/\/(?:dp|gp\/offer-listing)\//i.test(page.url())) {
        await navigateToCart(page);
      }
      return true;
    }
  }

  console.log("AMAZON_OFFER_NOT_FOUND - refreshing");
  return false;
}

async function main() {
  if (!productUrl) {
    throw new Error("AMAZON_PRODUCT_URL is required.");
  }
  if (!expectedAsin) {
    throw new Error(
      "AMAZON_EXPECTED_ASIN is required when it cannot be read from AMAZON_PRODUCT_URL.",
    );
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 1000) {
    throw new Error("AMAZON_RETRY_DELAY_MS must be at least 1000.");
  }
  if (!Number.isFinite(maxItemPrice) || maxItemPrice <= 0) {
    throw new Error("AMAZON_MAX_ITEM_PRICE must be greater than zero.");
  }
  if (!Number.isFinite(maxOrderTotal) || maxOrderTotal <= maxItemPrice) {
    throw new Error(
      "AMAZON_MAX_ORDER_TOTAL must be greater than AMAZON_MAX_ITEM_PRICE.",
    );
  }

  let attempts = 0;
  let verificationActive = false;

  while (true) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 3000 });
      const context = browser.contexts()[0];
      const page = await context.newPage();
      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      while (!page.isClosed()) {
        await page
          .waitForLoadState("domcontentloaded", { timeout: 15000 })
          .catch(() => {});
        await page.waitForTimeout(1000);

        const bodyText = await readBody(page);
        const verificationVisible =
          verificationPattern.test(bodyText) ||
          /captcha|validatecaptcha/i.test(page.url());

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

        if (confirmationPattern.test(bodyText)) {
          console.log("AMAZON_PREORDER_CONFIRMED");
          process.exit(0);
        }

        const unavailable =
          unavailablePattern.test(bodyText) ||
          /\/checkout\/entry\/oos/i.test(page.url());
        if (unavailable) {
          const goBack = page.getByRole("button", { name: /^go back$/i }).first();
          if (await isReady(goBack)) {
            await goBack.click({ timeout: 5000 }).catch(() => {});
            console.log("AMAZON_UNAVAILABLE_GO_BACK");
            await page.waitForTimeout(retryDelayMs);
          }

          if (
            unavailablePattern.test(await readBody(page)) ||
            /\/checkout\/entry\/oos/i.test(page.url())
          ) {
            await page
              .goto(productUrl, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              })
              .catch(() => {});
          }
          continue;
        }

        const placeOrder = page
          .getByRole("button", { name: /place (?:your )?order/i })
          .first();
        if (await isReady(placeOrder)) {
          if (!(await containsExpectedProduct(page, bodyText))) {
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
            throw new Error(
              `Order total $${orderTotal.toFixed(2)} exceeds limit $${maxOrderTotal.toFixed(2)}.`,
            );
          }

          console.log(`AMAZON_PLACE_ORDER_FOUND after ${attempts} attempts`);
          await placeOrder.click({ timeout: 5000 });
          console.log("AMAZON_PLACE_ORDER_CLICKED");
          await page
            .waitForFunction(
              (pattern) => new RegExp(pattern, "i").test(document.body?.innerText || ""),
              confirmationPattern.source,
              { timeout: 15000 },
            )
            .catch(() => {});
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

        const proceedToCheckout = page
          .getByRole("button", { name: /proceed to checkout/i })
          .or(page.getByRole("link", { name: /proceed to checkout/i }))
          .first();
        if (await isReady(proceedToCheckout)) {
          const cartReady = await selectOnlyExpectedCartItem(page);
          const currentBody = await readBody(page);
          if (
            !cartReady ||
            !(await containsExpectedProduct(page, currentBody))
          ) {
            console.log(
              "AMAZON_CART_PRODUCT_MISMATCH - refusing to enter checkout",
            );
            await page
              .goto(productUrl, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              })
              .catch(() => {});
            continue;
          }

          await proceedToCheckout.click({ timeout: 5000 }).catch(() => {});
          console.log("AMAZON_PROCEED_TO_CHECKOUT_CLICKED");
          await page.waitForTimeout(1000);
          continue;
        }

        const preorder = page
          .getByRole("button", { name: /^pre-order now$/i })
          .first();
        if (await isReady(preorder)) {
          if (!page.url().toUpperCase().includes(`/DP/${expectedAsin}`)) {
            console.log(
              "AMAZON_PRODUCT_PAGE_MISMATCH - refusing direct preorder",
            );
            await page
              .goto(productUrl, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              })
              .catch(() => {});
            continue;
          }

          const directOffer = await getDirectOffer(page);
          const directOfferAllowed =
            directOffer.shipsFromAmazon &&
            directOffer.soldByAmazon &&
            directOffer.price !== null &&
            directOffer.price <= maxItemPrice;
          if (!directOfferAllowed) {
            attempts += 1;
            if (attempts === 1 || attempts % 10 === 0) {
              console.log(
                `AMAZON_DIRECT_OFFER_REJECTED seller=${directOffer.soldByAmazon && directOffer.shipsFromAmazon ? "Amazon" : "other"} price=${directOffer.price ?? "unknown"}`,
              );
            }
            await page.waitForTimeout(retryDelayMs);
            await page
              .goto(productUrl, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              })
              .catch(() => {});
            continue;
          }

          attempts += 1;
          console.log(
            `AMAZON_PREORDER_CLICK ${attempts} - Amazon at $${directOffer.price.toFixed(2)}`,
          );
          await preorder.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(retryDelayMs);
          if (/\/(?:dp|gp\/offer-listing)\//i.test(page.url())) {
            await navigateToCart(page);
          }
          continue;
        }

        if (await selectAmazonBuyingOption(page)) {
          attempts += 1;
          await page.waitForTimeout(retryDelayMs);
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
    } catch (error) {
      console.error(`AMAZON_PREORDER_RECONNECT ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
