const { chromium } = require("playwright-core");
const {
  isCartSuccess,
  isPurchaseAction,
  productIdFromUrl,
  productMonitorTabPolicy,
  productPurchaseSelector,
  products,
} = require("./target-products");

const endpoint = "http://127.0.0.1:9444";
const productFilter = new Set(
  (process.env.PRODUCT_FILTER || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const monitoredProducts =
  productFilter.size > 0
    ? products.filter((product) => productFilter.has(product.id))
    : products;
const verificationPattern =
  /verify (?:that )?you(?:'re| are) human|security check|press and hold|captcha|not a robot|access denied/i;
const productPollDelayMs = Math.max(
  1500,
  Number.parseInt(process.env.TARGET_POLL_DELAY_MS || "1500", 10) || 1500,
);
const productStaggerMs = Math.max(
  750,
  Number.parseInt(process.env.TARGET_PRODUCT_STAGGER_MS || "1000", 10) ||
    1000,
);
const productAvailabilityPattern =
  /redsky\.target\.com|product_fulfillment_v1|pdp_client_v1|fulfillment/i;

function buildAvailabilitySummary(payload, fallbackProductId) {
  const candidate =
    payload && typeof payload === "object"
      ? payload
      : { product: {}, fulfillment: {} };
  const data = candidate.data || candidate.product || candidate.fulfillment || candidate;
  const product = data.product || data;
  const fulfillment = product.fulfillment || data.fulfillment || data;
  const onlinePurchaseValidation =
    product.online_purchase_validation ||
    fulfillment.online_purchase_validation ||
    fulfillment;

  const isValidForFulfillment =
    onlinePurchaseValidation.is_valid_for_fulfillment ??
    onlinePurchaseValidation.is_valid_for_online_purchase ??
    product.is_valid_for_fulfillment ??
    product.is_valid_for_online_purchase ??
    null;

  const availability =
    product.availability_status ??
    fulfillment.availability_status ??
    product.availability ??
    fulfillment.availability ??
    null;

  const preorderEligible =
    product.preorder_eligible ??
    fulfillment.preorder_eligible ??
    product.is_preorder_eligible ??
    fulfillment.is_preorder_eligible ??
    null;

  const productId =
    product.tcin ||
    product.id ||
    product.product_id ||
    candidate.tcin ||
    fallbackProductId;

  if (
    isValidForFulfillment === null &&
    availability === null &&
    preorderEligible === null
  ) {
    return null;
  }

  return {
    productId: String(productId || fallbackProductId),
    isValidForFulfillment: Boolean(isValidForFulfillment),
    isAvailable: Boolean(
      availability === "AVAILABLE" ||
        availability === "IN_STOCK" ||
        availability === true ||
        availability === "IN_STOCK_FOR_PICKUP" ||
        String(availability || "").toLowerCase().includes("available"),
    ),
    isPreorderEligible: Boolean(
      preorderEligible === true ||
        String(preorderEligible || "").toLowerCase().includes("preorder") ||
        String(preorderEligible || "").toLowerCase().includes("eligible"),
    ),
  };
}

function attachAvailabilityMonitor(page, product, state) {
  const onResponse = async (response) => {
    if (!productAvailabilityPattern.test(response.url())) {
      return;
    }

    try {
      const body = await response.text();
      const payload = JSON.parse(body);
      const summary = buildAvailabilitySummary(payload, product.id);
      if (!summary) {
        return;
      }

      const fingerprint = JSON.stringify({
        productId: summary.productId,
        isValidForFulfillment: summary.isValidForFulfillment,
        isAvailable: summary.isAvailable,
        isPreorderEligible: summary.isPreorderEligible,
      });

      if (fingerprint !== state.lastFingerprint) {
        state.lastFingerprint = fingerprint;
        state.lastSummary = summary;
        console.log(
          `${product.id} TARGET_FULFILLMENT_SIGNAL ${JSON.stringify(summary)}`,
        );
      }
    } catch (error) {
      // Ignore partial/opaque body payloads from network challenge pages.
    }
  };

  page.on("response", onResponse);
  return () => page.off("response", onResponse);
}

function createAbortError() {
  const error = new Error("MONITOR_BATCH_ABORTED");
  error.code = "MONITOR_BATCH_ABORTED";
  return error;
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw createAbortError();
  }
}

function waitWithAbort(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }

    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };

    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function hasPageVerification(page) {
  if (/captcha|challenge|blocked|verify/i.test(page.url())) {
    return true;
  }

  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return verificationPattern.test(`${title}\n${bodyText}`);
}

async function waitForVerificationClear(
  page,
  productId,
  verificationState,
  signal,
) {
  while (await hasPageVerification(page)) {
    throwIfAborted(signal);
    if (!verificationState.active) {
      console.log(`${productId} VERIFICATION_REQUIRED - pausing this product`);
      verificationState.active = true;
    }
    await waitWithAbort(1000, signal);
  }

  if (verificationState.active) {
    console.log(`${productId} VERIFICATION_CLEARED - resuming this product`);
    verificationState.active = false;
  }
}

async function findPurchaseButton(page) {
  const buttons = page.locator(productPurchaseSelector);
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const candidate = buttons.nth(index);
    const label = await candidate.innerText().catch(() => "");
    if (
      isPurchaseAction(label) &&
      (await candidate.isVisible().catch(() => false)) &&
      (await candidate.isEnabled().catch(() => false))
    ) {
      return candidate;
    }
  }

  return null;
}

async function closeNotAddedDialog(page, productId) {
  const notAdded = page.getByText(/^item not added to cart$/i).first();
  const notAddedVisible =
    (await notAdded.count()) > 0 &&
    (await notAdded.isVisible().catch(() => false));
  if (!notAddedVisible) {
    return false;
  }

  const dialog = notAdded.locator('xpath=ancestor::*[@role="dialog"][1]');
  const dialogClose = dialog.getByRole("button", { name: /close/i }).first();
  const pageClose = page.getByRole("button", { name: /close/i }).first();
  const closeButton = (await dialogClose.count()) > 0 ? dialogClose : pageClose;

  if (
    (await closeButton.count()) > 0 &&
    (await closeButton.isVisible().catch(() => false))
  ) {
    await closeButton.click({ timeout: 3000 }).catch(() => {});
    console.log(`${productId} ITEM_NOT_ADDED_CLOSED`);
    await page.waitForTimeout(250);
  }

  return true;
}

async function acquireProductPage(context, product, activePages) {
  const matchingPages = context
    .pages()
    .filter((page) => productIdFromUrl(page.url()) === product.id);
  const page = matchingPages.shift() || (await context.newPage());

  await Promise.all(
    matchingPages.map(async (duplicate) => {
      await duplicate.close().catch(() => {});
    }),
  );
  activePages.add(page);
  return page;
}

async function closeProductTabs(context, productsToClose) {
  const ids = new Set(productsToClose.map((product) => product.id));
  await Promise.all(
    context.pages().map(async (page) => {
      if (!ids.has(productIdFromUrl(page.url()))) {
        return;
      }
      await page.close().catch(() => {});
    }),
  );
}

async function closeDuplicateProductTabs(context, productsToCheck) {
  const ids = new Set(productsToCheck.map((product) => product.id));
  const pagesById = new Map();

  for (const page of context.pages()) {
    const productId = productIdFromUrl(page.url());
    if (!ids.has(productId)) {
      continue;
    }
    const pages = pagesById.get(productId) || [];
    pages.push(page);
    pagesById.set(productId, pages);
  }

  await Promise.all(
    [...pagesById.values()].flatMap((pages) =>
      pages.slice(1).map(async (duplicate) => {
        await duplicate.close().catch(() => {});
      }),
    ),
  );
}

async function monitorProduct(
  context,
  product,
  staggerMs,
  activePages,
  signal,
) {
  await waitWithAbort(staggerMs, signal);
  const page = await acquireProductPage(context, product, activePages);
  let refreshes = 0;
  const verificationState = { active: false };
  const availabilityState = { lastFingerprint: null, lastSummary: null };
  const stopAvailabilityMonitor = attachAvailabilityMonitor(
    page,
    product,
    availabilityState,
  );

  try {
    await page.goto(product.url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    while (!page.isClosed()) {
      throwIfAborted(signal);
      await page
        .waitForLoadState("domcontentloaded", { timeout: 15000 })
        .catch(() => {});
      await page
        .waitForFunction(
          () =>
            [
              ...document.querySelectorAll(
                '[data-test="module-product-detail-add-to-cart"] button',
              ),
            ].some((button) =>
              /^(?:pre[\s-]?order|add to cart)$/i.test(
                (button.innerText || button.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim(),
              ),
            ),
          null,
          { timeout: 3000 },
        )
        .catch(() => {});

      await waitForVerificationClear(
        page,
        product.id,
        verificationState,
        signal,
      );

      const availabilitySummary = availabilityState.lastSummary;
      const purchaseButton = await findPurchaseButton(page);
      if (purchaseButton) {
        console.log(
          `${product.id} PURCHASE_ACTION_FOUND after ${refreshes} refreshes`,
        );
        if (availabilitySummary) {
          console.log(
            `${product.id} NETWORK_FULFILLMENT_STATUS ${JSON.stringify(availabilitySummary)}`,
          );
        }
        await purchaseButton.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(5000);
        await waitForVerificationClear(
          page,
          product.id,
          verificationState,
          signal,
        );

        if (await closeNotAddedDialog(page, product.id)) {
          refreshes += 1;
          await waitWithAbort(productPollDelayMs, signal);
          await page.goto(product.url, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          continue;
        }

        const bodyText = await page.locator("body").innerText().catch(() => "");
        if (isCartSuccess(page.url(), bodyText)) {
          console.log(`${product.id} PURCHASE_ADDED_TO_CART`);
          return;
        }
      }

      refreshes += 1;
      if (refreshes === 1 || refreshes % 10 === 0) {
        console.log(`${product.id} REFRESH ${refreshes}`);
      }

      await waitWithAbort(productPollDelayMs, signal);
      await page.goto(product.url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    }

    throw new Error(`${product.id} page was closed`);
  } finally {
    stopAvailabilityMonitor();
    activePages.delete(page);
    await page.close().catch(() => {});
  }
}

async function closeActivePages(activePages) {
  await Promise.all(
    [...activePages].map(async (page) => {
      await page.close().catch(() => {});
    }),
  );
  activePages.clear();
}

async function monitorBatch(context, pendingProducts, completed) {
  const controller = new AbortController();
  const activePages = new Set();
  const tasks = pendingProducts.map((product, index) =>
    (async () => {
      try {
        await monitorProduct(
          context,
          product,
          index * productStaggerMs,
          activePages,
          controller.signal,
        );
        completed.add(product.id);
      } catch (error) {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        throw error;
      }
    })(),
  );

  try {
    await closeDuplicateProductTabs(context, pendingProducts);
    await Promise.all(tasks);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(tasks);
    throw error;
  } finally {
    controller.abort();
    await closeActivePages(activePages);
    await closeProductTabs(context, pendingProducts);
  }
}

async function main() {
  const completed = new Set();

  if (monitoredProducts.length === 0) {
    throw new Error("PRODUCT_FILTER did not match a configured product.");
  }
  if (productMonitorTabPolicy !== "one-per-product") {
    throw new Error("Product monitor must use one reusable tab per product.");
  }

  while (completed.size < monitoredProducts.length) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 3000 });
      const context = browser.contexts()[0];
      const pendingProducts = monitoredProducts.filter(
        (product) => !completed.has(product.id),
      );
      await monitorBatch(context, pendingProducts, completed);
    } catch (error) {
      if (error.code !== "MONITOR_BATCH_ABORTED") {
        console.error(`RECONNECT ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  console.log("ALL_PURCHASES_ADDED_TO_CART");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
