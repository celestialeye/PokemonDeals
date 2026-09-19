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
const unavailablePattern =
  /this item is currently unavailable|items? you selected (?:are|is) not available|item .* is no longer available from the seller you selected|items out of stock/i;
const verificationPattern =
  /verify (?:that )?you(?:'re| are) human|captcha|not a robot|robot check|enter the characters you see/i;
const confirmationPattern =
  /thank you,? your order has been placed|order placed|order number/i;
const postClickCooldownMs = 60000;

function normalizeProducts(rawProducts, defaults = {}) {
  let products;
  try {
    products =
      typeof rawProducts === "string" ? JSON.parse(rawProducts) : rawProducts;
  } catch (error) {
    throw new Error(`AMAZON_PRODUCTS_JSON is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(products) || products.length === 0) {
    throw new Error("AMAZON_PRODUCTS_JSON must contain at least one product.");
  }

  const defaultItemPrice = Number(defaults.maxItemPrice ?? 30);
  const defaultOrderTotal = Number(defaults.maxOrderTotal ?? 40);
  const seenAsins = new Set();

  if (!Number.isFinite(defaultItemPrice) || defaultItemPrice <= 0) {
    throw new Error("AMAZON_MAX_ITEM_PRICE must be greater than zero.");
  }
  if (!Number.isFinite(defaultOrderTotal) || defaultOrderTotal <= defaultItemPrice) {
    throw new Error(
      "AMAZON_MAX_ORDER_TOTAL must be greater than AMAZON_MAX_ITEM_PRICE.",
    );
  }

  return products.map((product, index) => {
    if (!product || typeof product !== "object") {
      throw new Error(`Product ${index + 1} must be an object.`);
    }

    const label = String(product.label || "").trim();
    const url = String(product.url || "").trim();
    const asinFromUrl = url.match(
      /https?:\/\/(?:www\.)?amazon\.com\/dp\/([A-Z0-9]{10})(?:[/?#]|$)/i,
    )?.[1]?.toUpperCase();
    const asin = String(product.asin || asinFromUrl || "").trim().toUpperCase();
    const title = String(product.title || "").trim();

    if (!label || !title) {
      throw new Error(`Product ${index + 1} requires label and title.`);
    }
    if (!asinFromUrl) {
      throw new Error(
        `Product ${index + 1} product URL must be an Amazon /dp/ASIN URL.`,
      );
    }
    if (asin !== asinFromUrl) {
      throw new Error(`Product ${index + 1} ASIN does not match its URL.`);
    }
    if (seenAsins.has(asin)) {
      throw new Error(`Product ${index + 1} has duplicate ASIN ${asin}.`);
    }
    seenAsins.add(asin);

    const maxItemPrice = Number(product.maxItemPrice ?? defaultItemPrice);
    const maxOrderTotal = Number(product.maxOrderTotal ?? defaultOrderTotal);
    if (!Number.isFinite(maxItemPrice) || maxItemPrice <= 0) {
      throw new Error(`${label}: maxItemPrice must be greater than zero.`);
    }
    if (!Number.isFinite(maxOrderTotal) || maxOrderTotal <= maxItemPrice) {
      throw new Error(
        `${label}: maxOrderTotal must be greater than maxItemPrice.`,
      );
    }

    return {
      label,
      url,
      asin,
      title,
      maxItemPrice,
      maxOrderTotal,
    };
  });
}

function findReusableProductPage(
  pages,
  asin,
  claimedPages = new Set(),
) {
  const productPattern = new RegExp(
    `/dp/${asin}(?:[/?#]|$)|/gp/offer-listing/${asin}(?:[/?#]|$)`,
    "i",
  );
  return (
    pages.find(
      (page) =>
        !claimedPages.has(page) && productPattern.test(page.url()),
    ) || null
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function log(product, message) {
  console.log(`[${product.label}] ${message}`);
}

function acquireCheckoutLock(state, asin) {
  if (state.checkoutProductAsin && state.checkoutProductAsin !== asin) {
    return false;
  }
  state.checkoutProductAsin = asin;
  return true;
}

function releaseCheckoutLock(state, asin) {
  if (state.checkoutProductAsin === asin) {
    state.checkoutProductAsin = null;
  }
}

function ownsCheckoutLock(state, asin) {
  return state.checkoutProductAsin === asin;
}

function isProductCoolingDown(state, asin, now = Date.now()) {
  return (state.cooldownUntilByAsin.get(asin) || 0) > now;
}

async function requestShutdown(state) {
  state.shuttingDown = true;
}

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

async function containsExpectedProduct(page, product, bodyText = "") {
  if (
    (await page
      .locator(
        `[data-asin="${product.asin}"], a[href*="/dp/${product.asin}"], input[value="${product.asin}"]`,
      )
      .count()) > 0
  ) {
    return true;
  }

  return bodyText.includes(product.title);
}

async function selectOnlyExpectedCartItem(page, product) {
  if (!/\/(?:gp\/cart|cart)\b/i.test(page.url())) {
    return true;
  }

  const activeCart = page.locator("#sc-active-cart");
  const expectedItem = activeCart
    .locator(`.sc-list-item[data-asin="${product.asin}"]`)
    .first();
  if (
    (await waitForExpectedCartItemCount(() => expectedItem.count())) === 0
  ) {
    log(product, "AMAZON_CART_PRODUCT_MISMATCH - expected ASIN is not in cart");
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

    if (asin === product.asin) {
      await checkbox.check({ force: true }).catch(() => {});
    } else {
      await checkbox.uncheck({ force: true }).catch(() => {});
    }
  }

  return true;
}

async function openBuyingOptions(page, product) {
  const seeAllBuyingOptions = page
    .getByRole("link", { name: /see all buying options/i })
    .first();
  if (await isReady(seeAllBuyingOptions)) {
    const href = await seeAllBuyingOptions.getAttribute("href");
    if (href) {
      await page.goto(new URL(href, page.url()).href, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    } else {
      await seeAllBuyingOptions.click({ timeout: 5000 });
    }
    return;
  }

  if (!/\/gp\/offer-listing\//i.test(page.url())) {
    await page.goto(buildOfferListingUrl(product.asin), {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  }
}

async function moveToCartAfterPurchase(page) {
  if (/\/(?:dp|gp\/offer-listing)\//i.test(page.url())) {
    await navigateToCart(page);
  }
}

async function selectAmazonBuyingOption(page, product, state) {
  if (
    state.checkoutProductAsin &&
    state.checkoutProductAsin !== product.asin
  ) {
    return false;
  }
  if (ownsCheckoutLock(state, product.asin)) {
    return false;
  }

  await openBuyingOptions(page, product);
  await page
    .locator("#aod-offer-list")
    .waitFor({ timeout: 5000 })
    .catch(() => {});

  const offers = page.locator(offerContainerSelector);
  for (let index = 0; index < (await offers.count()); index += 1) {
    const offer = offers.nth(index);
    const seeMore = offer.getByText(/^(?:see more|\.\.\.\s*more)$/i).first();
    if (await isReady(seeMore)) {
      await seeMore.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(250);
    }

    const offerText = (await offer.innerText().catch(() => "")).replace(/\s+/g, " ");
    if (!isQualifyingAmazonOffer(offerText, product.maxItemPrice)) {
      continue;
    }

    if (!acquireCheckoutLock(state, product.asin)) {
      return false;
    }

    const addToCart = offer.locator(offerAddToCartSelector).first();
    if (!(await isReady(addToCart))) {
      releaseCheckoutLock(state, product.asin);
      continue;
    }

    try {
      await addToCart.click({ timeout: 5000 });
      log(
        product,
        `AMAZON_OFFER_ADDED - Amazon seller at $${parsePrice(offerText).toFixed(2)}`,
      );
      await page.waitForTimeout(1000);
      await moveToCartAfterPurchase(page);
      return true;
    } catch (error) {
      releaseCheckoutLock(state, product.asin);
      throw error;
    }
  }

  return false;
}

async function monitorProduct(page, product, state, retryDelayMs) {
  let attempts = 0;
  let verificationActive = false;

  while (!state.shuttingDown && !state.completedAsins.has(product.asin)) {
    try {
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
          log(product, "AMAZON_VERIFICATION_REQUIRED - waiting");
          verificationActive = true;
        }
        await page.waitForTimeout(1000);
        continue;
      }
      if (verificationActive) {
        log(product, "AMAZON_VERIFICATION_CLEARED - resuming");
        verificationActive = false;
      }

      if (
        confirmationPattern.test(bodyText) &&
        state.checkoutProductAsin === product.asin
      ) {
        state.completedAsins.add(product.asin);
        releaseCheckoutLock(state, product.asin);
        log(product, "AMAZON_ORDER_CONFIRMED");
        return;
      }

      if (isProductCoolingDown(state, product.asin)) {
        await page.waitForTimeout(1000);
        continue;
      }

      const unavailable =
        unavailablePattern.test(bodyText) ||
        /\/checkout\/entry\/oos/i.test(page.url());
      if (unavailable) {
        const goBack = page
          .getByRole("button", { name: /^go back$/i })
          .first();
        if (await isReady(goBack)) {
          await goBack.click({ timeout: 5000 }).catch(() => {});
          log(product, "AMAZON_UNAVAILABLE_GO_BACK");
          await page.waitForTimeout(retryDelayMs);
        }

        releaseCheckoutLock(state, product.asin);
        if (
          unavailablePattern.test(await readBody(page)) ||
          /\/checkout\/entry\/oos/i.test(page.url())
        ) {
          await page
            .goto(product.url, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            })
            .catch(() => {});
        }
        continue;
      }

      if (
        state.checkoutProductAsin &&
        state.checkoutProductAsin !== product.asin
      ) {
        await page.waitForTimeout(500);
        continue;
      }
      if (
        ownsCheckoutLock(state, product.asin) &&
        /\/(?:dp|gp\/offer-listing)\//i.test(page.url())
      ) {
        await moveToCartAfterPurchase(page);
        await page.waitForTimeout(1000);
        continue;
      }

      const placeOrder = page
        .getByRole("button", { name: /place (?:your )?order/i })
        .first();
      if (await isReady(placeOrder)) {
        if (!acquireCheckoutLock(state, product.asin)) {
          await page.waitForTimeout(500);
          continue;
        }

        if (!(await containsExpectedProduct(page, product, bodyText))) {
          log(product, "AMAZON_CHECKOUT_PRODUCT_MISMATCH - refusing to place order");
          releaseCheckoutLock(state, product.asin);
          await page
            .goto(product.url, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            })
            .catch(() => {});
          continue;
        }

        const orderTotal = parseOrderTotal(bodyText);
        if (orderTotal === null) {
          log(product, "AMAZON_ORDER_BLOCKED - order total not detected");
          await page.waitForTimeout(1000);
          continue;
        }
        if (orderTotal > product.maxOrderTotal) {
          log(
            product,
            `AMAZON_ORDER_BLOCKED - total $${orderTotal.toFixed(2)} exceeds limit $${product.maxOrderTotal.toFixed(2)}`,
          );
          releaseCheckoutLock(state, product.asin);
          await page
            .goto(product.url, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            })
            .catch(() => {});
          continue;
        }

        log(product, `AMAZON_PLACE_ORDER_FOUND after ${attempts} attempts`);
        await placeOrder.click({ timeout: 5000 });
        log(product, "AMAZON_PLACE_ORDER_CLICKED");
        await page
          .waitForFunction(
            (pattern) =>
              new RegExp(pattern, "i").test(document.body?.innerText || ""),
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
        log(product, "AMAZON_CONTINUE_CLICKED - retrying");
        await page.waitForTimeout(1000);
        continue;
      }

      const proceedToCheckout = page
        .getByRole("button", { name: /proceed to checkout/i })
        .or(page.getByRole("link", { name: /proceed to checkout/i }))
        .first();
      if (await isReady(proceedToCheckout)) {
        if (!acquireCheckoutLock(state, product.asin)) {
          await page.waitForTimeout(500);
          continue;
        }

        const cartReady = await selectOnlyExpectedCartItem(page, product);
        const currentBody = await readBody(page);
        if (
          !cartReady ||
          !(await containsExpectedProduct(page, product, currentBody))
        ) {
          log(product, "AMAZON_CART_PRODUCT_MISMATCH - refusing to enter checkout");
          releaseCheckoutLock(state, product.asin);
          state.cooldownUntilByAsin.set(
            product.asin,
            Date.now() + postClickCooldownMs,
          );
          log(
            product,
            `AMAZON_POST_CLICK_COOLDOWN - waiting ${postClickCooldownMs / 1000}s before retry`,
          );
          await page
            .goto(product.url, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            })
            .catch(() => {});
          continue;
        }

        await proceedToCheckout.click({ timeout: 5000 }).catch(() => {});
        log(product, "AMAZON_PROCEED_TO_CHECKOUT_CLICKED");
        await page.waitForTimeout(1000);
        continue;
      }

      const preorder = page
        .getByRole("button", { name: /^pre-order now$/i })
        .first();
      if (await isReady(preorder)) {
        if (!page.url().toUpperCase().includes(`/DP/${product.asin}`)) {
          await page
            .goto(product.url, {
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
          directOffer.price <= product.maxItemPrice;
        if (!directOfferAllowed) {
          attempts += 1;
          if (attempts === 1 || attempts % 10 === 0) {
            log(
              product,
              `AMAZON_DIRECT_OFFER_REJECTED seller=${directOffer.soldByAmazon && directOffer.shipsFromAmazon ? "Amazon" : "other"} price=${directOffer.price ?? "unknown"}`,
            );
          }
          await page.waitForTimeout(retryDelayMs);
          await page
            .goto(product.url, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            })
            .catch(() => {});
          continue;
        }

        if (!acquireCheckoutLock(state, product.asin)) {
          await page.waitForTimeout(500);
          continue;
        }

        attempts += 1;
        log(
          product,
          `AMAZON_PREORDER_CLICK ${attempts} - Amazon at $${directOffer.price.toFixed(2)}`,
        );
        await preorder.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(retryDelayMs);
        await moveToCartAfterPurchase(page);
        continue;
      }

      if (await selectAmazonBuyingOption(page, product, state)) {
        attempts += 1;
        await page.waitForTimeout(retryDelayMs);
        continue;
      }

      attempts += 1;
      if (attempts === 1 || attempts % 10 === 0) {
        log(product, `AMAZON_PRODUCT_REFRESH ${attempts}`);
      }
      await page.waitForTimeout(retryDelayMs);
      await page
        .goto(product.url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        })
        .catch(() => {});
    } catch (error) {
      log(product, `AMAZON_RECONNECT ${error.message}`);
      await delay(500);
    }
  }
}

async function main() {
  const retryDelayMs = Number(process.env.AMAZON_RETRY_DELAY_MS || 3000);
  const staggerMs = Number(process.env.AMAZON_PRODUCT_STAGGER_MS || 1000);
  const products = normalizeProducts(process.env.AMAZON_PRODUCTS_JSON, {
    maxItemPrice: process.env.AMAZON_MAX_ITEM_PRICE || 30,
    maxOrderTotal: process.env.AMAZON_MAX_ORDER_TOTAL || 40,
  });

  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 1000) {
    throw new Error("AMAZON_RETRY_DELAY_MS must be at least 1000.");
  }
  if (!Number.isFinite(staggerMs) || staggerMs < 0) {
    throw new Error("AMAZON_PRODUCT_STAGGER_MS must be zero or greater.");
  }

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No authenticated Chrome context is available.");
  }

  const state = {
    checkoutProductAsin: null,
    completedAsins: new Set(),
    cooldownUntilByAsin: new Map(),
    shuttingDown: false,
  };
  const pages = [];
  const existingPages = context.pages();
  const claimedPages = new Set();

  const shutdown = async () => {
    if (state.shuttingDown) {
      return;
    }
    await requestShutdown(state);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const monitors = [];
  for (const product of products) {
    const page =
      findReusableProductPage(existingPages, product.asin, claimedPages) ||
      (await context.newPage());
    claimedPages.add(page);
    pages.push(page);
    await page.goto(product.url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    log(product, "AMAZON_TAB_READY");
    monitors.push(monitorProduct(page, product, state, retryDelayMs));
    await delay(staggerMs);
  }

  await Promise.all(monitors);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  findReusableProductPage,
  isProductCoolingDown,
  normalizeProducts,
  ownsCheckoutLock,
  requestShutdown,
};
