const { productIdFromUrl, validateCartContents } = require("./target-products");

const checkoutUrl = "https://www.target.com/checkout";
const verificationPattern =
  /verify (?:that )?you(?:'re| are) human|security check|press and hold|captcha|not a robot|access denied/i;
const highDemandPattern =
  /high-demand item in your cart|a popular item in your cart is causing a delay|checkout is busy right now|limiting how many guests can check out/i;
const confirmationPattern =
  /thank you for your order|your order has been placed|we received your order|order number\s*#?/i;
const decimalCurrencyPattern = /\$\s*\d+(?:,\d{3})*\.\d{2}\b/;
const signInPattern =
  /\bsign in\b.*(?:checkout|continue)|(?:checkout|continue).*\bsign in\b/i;
const paymentSetupPattern =
  /add (?:a )?(?:payment method|credit or debit card)|enter card information|payment method required|select a payment method/i;
const unavailablePattern =
  /item (?:is )?(?:no longer )?available|out of stock|currently unavailable/i;
const emptyCartPattern = /your cart is empty|no items in your cart/i;
const cartHandshakeTimeoutMs = Math.max(
  1000,
  Number.parseInt(process.env.TARGET_CART_HANDSHAKE_TIMEOUT_MS || "5000", 10) ||
    5000,
);

function detectFulfillment(text) {
  const matches = new Set();
  const value = String(text || "");
  if (/\bshipping\b|\bship(?:ped)?\b/i.test(value)) {
    matches.add("shipping");
  }
  if (/\bdelivery\b/i.test(value)) {
    matches.add("delivery");
  }
  if (/\border pickup\b|\bpickup\b/i.test(value)) {
    matches.add("pickup");
  }
  if (/\bdrive[\s-]?up\b/i.test(value)) {
    matches.add("drive-up");
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function normalizeFulfillment(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return {
    shipping: "shipping",
    ship: "shipping",
    delivery: "delivery",
    pickup: "pickup",
    "order pickup": "pickup",
    driveup: "drive-up",
    "drive up": "drive-up",
    "drive-up": "drive-up",
  }[normalized] || null;
}

function currencyValues(text) {
  const values = [];
  const pattern = /\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\b/g;
  for (const match of String(text || "").matchAll(pattern)) {
    const amount = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(amount)) {
      values.push(Math.round(amount * 100));
    }
  }
  return [...new Set(values)];
}

function parseUnambiguousCurrencyCents(text) {
  const values = currencyValues(text);
  return values.length === 1 ? values[0] : null;
}

function parseLabeledCurrencyCents(text, labelPattern) {
  const values = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    labelPattern.lastIndex = 0;
    const normalizedLine = line.trim();
    if (!labelPattern.test(normalizedLine)) {
      continue;
    }
    labelPattern.lastIndex = 0;
    values.push(...currencyValues(normalizedLine));
  }
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function parseMaximumCents(name, value, { required = true } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    if (required) {
      throw new Error(`${name} is required for active Target purchasing.`);
    }
    return null;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`${name} must be a positive decimal currency amount.`);
  }
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error(`${name} must be a positive decimal currency amount.`);
  }
  return cents;
}

function readPurchaseGuardConfig(env = process.env, { required = true } = {}) {
  const expectedValue = String(env.TARGET_EXPECTED_FULFILLMENT || "").trim();
  const expectedFulfillment = expectedValue
    ? normalizeFulfillment(expectedValue)
    : null;
  if (expectedValue && !expectedFulfillment) {
    throw new Error(
      "TARGET_EXPECTED_FULFILLMENT must be shipping, delivery, pickup, or drive-up.",
    );
  }
  return {
    expectedFulfillment,
    maxItemPriceCents: parseMaximumCents(
      "TARGET_MAX_ITEM_PRICE",
      env.TARGET_MAX_ITEM_PRICE,
      { required },
    ),
    maxOrderTotalCents: parseMaximumCents(
      "TARGET_MAX_ORDER_TOTAL",
      env.TARGET_MAX_ORDER_TOTAL,
      { required },
    ),
  };
}

function validatePdpIdentity(url, expectedProductId) {
  return productIdFromUrl(url) === expectedProductId;
}

function validatePurchaseEvidence(evidence, {
  expectedProductId,
  expectedFulfillment = null,
  maxItemPriceCents,
  maxOrderTotalCents,
} = {}) {
  const errors = [];
  const items = Array.isArray(evidence?.items) ? evidence.items : [];
  const item = items.length === 1 ? items[0] : null;
  if (items.length !== 1) {
    errors.push("item-count");
  }
  if (!item?.productId || item.productId !== expectedProductId) {
    errors.push("product-identity");
  }
  if (item?.quantity !== 1) {
    errors.push("quantity");
  }
  if (!item?.fulfillment) {
    errors.push("fulfillment-missing");
  } else if (
    expectedFulfillment &&
    item.fulfillment !== expectedFulfillment
  ) {
    errors.push("fulfillment-mismatch");
  }
  if (!Number.isSafeInteger(item?.itemPriceCents)) {
    errors.push("item-price");
  } else if (
    Number.isSafeInteger(maxItemPriceCents) &&
    item.itemPriceCents > maxItemPriceCents
  ) {
    errors.push("item-price-limit");
  }
  if (!Number.isSafeInteger(evidence?.orderTotalCents)) {
    errors.push("order-total");
  } else if (
    Number.isSafeInteger(maxOrderTotalCents) &&
    evidence.orderTotalCents > maxOrderTotalCents
  ) {
    errors.push("order-total-limit");
  }
  return {
    ok: errors.length === 0,
    errors,
    summary: {
      itemCount: items.length,
      productMatched: item?.productId === expectedProductId,
      quantity: item?.quantity ?? null,
      fulfillment: item?.fulfillment || null,
      itemPriceDetected: Number.isSafeInteger(item?.itemPriceCents),
      orderTotalDetected: Number.isSafeInteger(evidence?.orderTotalCents),
    },
  };
}

function cartResponseKind(url) {
  const value = String(url || "");
  if (!/https:\/\/carts\.target\.com\/web_checkouts\/v1\//i.test(value)) {
    return null;
  }
  if (/\/cart_items(?:[/?#]|$)/i.test(value)) {
    return "mutation";
  }
  if (/\/cart(?:[/?#]|$)/i.test(value)) {
    return /[?&]client_feature=add_to_cart(?:[&#]|$)/i.test(value)
      ? "reconciliation"
      : "cart-read";
  }
  return "other";
}

function parseRetryAfterMs(value, now = Date.now()) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return 0;
  }
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0;
}

function cartResponseEvent(response, startedAt = Date.now()) {
  const headers = response.headers();
  return {
    kind: cartResponseKind(response.url()),
    status: response.status(),
    retryAfterMs: parseRetryAfterMs(headers["retry-after"]),
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}

async function observeCartHandshake(page, click, {
  timeoutMs = cartHandshakeTimeoutMs,
  log = console.log,
} = {}) {
  const startedAt = Date.now();
  const events = [];
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const onResponse = (response) => {
    const kind = cartResponseKind(response.url());
    if (!kind) {
      return;
    }
    const event = cartResponseEvent(response, startedAt);
    events.push(event);
    log(`TARGET_CART_RESPONSE ${JSON.stringify(event)}`);
    const mutation = events.find((candidate) => candidate.kind === "mutation");
    const reconciliation = events.find(
      (candidate) => candidate.kind === "reconciliation",
    );
    if (
      event.status === 429 ||
      (["mutation", "reconciliation"].includes(event.kind) &&
        (event.status < 200 || event.status >= 300)) ||
      (mutation && reconciliation)
    ) {
      finish();
    }
  };

  page.on("response", onResponse);
  const timer = setTimeout(finish, timeoutMs);
  try {
    await click();
    await completed;
  } finally {
    clearTimeout(timer);
    page.off("response", onResponse);
  }

  const result = {
    elapsedMs: Math.max(0, Date.now() - startedAt),
    mutation: events.find((event) => event.kind === "mutation") || null,
    reconciliation:
      events.find((event) => event.kind === "reconciliation") || null,
    rateLimited: events.some((event) => event.status === 429),
  };
  log(`TARGET_CART_HANDSHAKE ${JSON.stringify(result)}`);
  return result;
}

function isOrderConfirmed(url, bodyText) {
  return (
    /\/(?:co-thankyou|order-confirmation|thank-you)(?:[/?#]|$)/i.test(
      String(url || ""),
    ) || confirmationPattern.test(String(bodyText || ""))
  );
}

function classifyCheckoutSnapshot(snapshot) {
  if (snapshot.verificationVisible) {
    return "verification";
  }
  if (snapshot.confirmed) {
    return "confirmed";
  }
  if (snapshot.safetyStop) {
    return snapshot.safetyStop;
  }
  if (snapshot.highDemandReady) {
    return "high-demand";
  }
  if (snapshot.saveContinueReady) {
    return "save-continue";
  }
  if (snapshot.pinReady) {
    return "pin";
  }
  if (snapshot.placeOrderReady) {
    return "place-order";
  }
  if (snapshot.onCartPage) {
    return "go-checkout";
  }
  if (snapshot.priceVisible) {
    return "wait-loaded";
  }
  return "reload";
}

async function isReady(locator) {
  return (
    (await locator.count()) > 0 &&
    (await locator.isVisible().catch(() => false)) &&
    (await locator.isEnabled().catch(() => false))
  );
}

async function hasPageVerification(page) {
  if (/captcha|challenge|blocked|verify/i.test(page.url())) {
    return true;
  }
  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return verificationPattern.test(`${title}\n${bodyText}`);
}

async function readCartEvidence(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const rows = page.locator(
    '[data-test="cartItem"], [data-test="cart-item"], [data-test^="cart-item-"], [data-test="order-summary-item"], [data-test^="order-summary-item-"]',
  );
  const rowCount = await rows.count().catch(() => 0);
  const cartRows = [];

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }
    const rowText = await row.innerText().catch(() => "");
    const hrefs = await row
      .locator("a[href]")
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.href))
      .catch(() => []);
    const explicitId =
      (await row.getAttribute("data-item-id").catch(() => null)) ||
      (await row.getAttribute("data-tcin").catch(() => null));
    const productId =
      productIdFromUrl(explicitId) ||
      hrefs.map(productIdFromUrl).find(Boolean) ||
      productIdFromUrl(rowText);
    const quantityControl = row
      .locator('select[aria-label*="quantity" i], input[aria-label*="quantity" i]')
      .first();
    let quantity = null;
    if ((await quantityControl.count().catch(() => 0)) > 0) {
      quantity = Number.parseInt(
        await quantityControl.inputValue().catch(() => ""),
        10,
      );
    }
    if (!Number.isInteger(quantity)) {
      const match = rowText.match(/(?:quantity|qty)\s*[:.]?\s*(\d+)/i);
      quantity = match ? Number.parseInt(match[1], 10) : null;
    }
    cartRows.push({ productId, quantity });
  }

  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.href))
    .catch(() => []);
  return { bodyText, hrefs, cartRows };
}

function quantityFromText(text) {
  const matches = [
    ...String(text || "").matchAll(/(?:quantity|qty)\s*[:.]?\s*(\d+)/gi),
  ].map((match) => Number.parseInt(match[1], 10));
  const unique = [...new Set(matches.filter(Number.isInteger))];
  return unique.length === 1 ? unique[0] : null;
}

async function readPurchaseEvidence(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const rowSelector = [
    '[data-test="cartItem"]',
    '[data-test="cart-item"]',
    '[data-test^="cart-item-"]',
    '[data-test="order-summary-item"]',
    '[data-test^="order-summary-item-"]',
    '[data-test*="checkout-item"]',
    '[role="dialog"] [data-test*="item"]',
  ].join(", ");
  const rows = page.locator(rowSelector);
  const rowCount = await rows.count().catch(() => 0);
  const items = [];

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }
    const rowText = await row.innerText().catch(() => "");
    const hrefs = await row
      .locator("a[href]")
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.href))
      .catch(() => []);
    const explicitId =
      (await row.getAttribute("data-item-id").catch(() => null)) ||
      (await row.getAttribute("data-tcin").catch(() => null));
    const quantityControl = row
      .locator('select[aria-label*="quantity" i], input[aria-label*="quantity" i]')
      .first();
    let quantity = null;
    if ((await quantityControl.count().catch(() => 0)) > 0) {
      quantity = Number.parseInt(
        await quantityControl.inputValue().catch(() => ""),
        10,
      );
    }
    items.push({
      productId:
        productIdFromUrl(explicitId) ||
        hrefs.map(productIdFromUrl).find(Boolean) ||
        productIdFromUrl(rowText),
      quantity: Number.isInteger(quantity) ? quantity : quantityFromText(rowText),
      fulfillment: detectFulfillment(rowText),
      itemPriceCents: parseUnambiguousCurrencyCents(rowText),
    });
  }

  if (items.length === 0) {
    const summary = page
      .locator('[role="dialog"], [data-test*="order-summary"]')
      .first();
    if (
      (await summary.count().catch(() => 0)) > 0 &&
      (await summary.isVisible().catch(() => false))
    ) {
      const summaryText = await summary.innerText().catch(() => "");
      const hrefs = await summary
        .locator("a[href]")
        .evaluateAll((anchors) => anchors.map((anchor) => anchor.href))
        .catch(() => []);
      const detectedIds = [
        ...new Set(
          [
            ...hrefs.map(productIdFromUrl),
            ...[...summaryText.matchAll(/\bA-\d{7,}\b/gi)].map(
              (match) => match[0].toUpperCase(),
            ),
          ].filter(Boolean),
        ),
      ];
      items.push({
        productId: detectedIds.length === 1 ? detectedIds[0] : null,
        quantity: quantityFromText(summaryText),
        fulfillment: detectFulfillment(summaryText),
        itemPriceCents: parseLabeledCurrencyCents(
          summaryText,
          /item price|subtotal/i,
        ),
      });
    }
  }

  return {
    items,
    orderTotalCents: parseLabeledCurrencyCents(
      bodyText,
      /^(?:order\s+)?total\b/i,
    ),
  };
}

function validateExpectedCart(evidence, expectedProductIds) {
  const expected = new Set((expectedProductIds || []).filter(Boolean));
  if (evidence.cartRows.length > 0) {
    const seen = new Set();
    for (const row of evidence.cartRows) {
      if (
        !row.productId ||
        !expected.has(row.productId) ||
        row.quantity !== 1 ||
        seen.has(row.productId)
      ) {
        return false;
      }
      seen.add(row.productId);
    }
    return seen.size > 0;
  }
  return validateCartContents(
    { bodyText: evidence.bodyText, hrefs: evidence.hrefs },
    expected.size > 0 ? expected : undefined,
  );
}

async function snapshotCheckoutPage(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const visibleDialogs = page.locator('[role="dialog"]');
  const pinHeading = page.getByText(/^confirm your pin$/i).first();
  const pinInput = page.getByLabel(/enter pin|pin/i).first();
  const pinConfirm = page.getByRole("button", { name: /^confirm$/i }).first();
  const highDemand = page.getByText(highDemandPattern).first();
  const highDemandDialog = page
    .getByRole("dialog")
    .filter({ hasText: highDemandPattern })
    .first();
  const dialogOk = highDemandDialog.getByRole("button", { name: /^ok$/i }).first();
  const pageOk = page.getByRole("button", { name: /^ok$/i }).first();
  const highDemandOk = (await dialogOk.count()) > 0 ? dialogOk : pageOk;
  const saveContinue = page
    .getByRole("button", { name: /^save and continue$/i })
    .first();
  const placeOrder = page
    .getByRole("button", { name: /^place(?: your)? order$/i })
    .first();

  const pinVisible =
    (await pinHeading.count()) > 0 &&
    (await pinHeading.isVisible().catch(() => false));
  const highDemandVisible =
    (await highDemand.count()) > 0 &&
    (await highDemand.isVisible().catch(() => false));
  let buyNowPanelVisible = false;
  for (
    let index = 0;
    index < (await visibleDialogs.count().catch(() => 0));
    index += 1
  ) {
    const dialog = visibleDialogs.nth(index);
    if (!(await dialog.isVisible().catch(() => false))) {
      continue;
    }
    const dialogText = await dialog.innerText().catch(() => "");
    if (
      decimalCurrencyPattern.test(dialogText) ||
      /save and continue|confirm your pin|place(?: your)? order/i.test(
        dialogText,
      )
    ) {
      buyNowPanelVisible = true;
      break;
    }
  }

  return {
    bodyText,
    buyNowPanelVisible,
    controls: { highDemandOk, pinConfirm, pinInput, placeOrder, saveContinue },
    state: classifyCheckoutSnapshot({
      verificationVisible: await hasPageVerification(page),
      confirmed: isOrderConfirmed(page.url(), bodyText),
      safetyStop: signInPattern.test(bodyText)
        ? "sign-in-required"
        : paymentSetupPattern.test(bodyText)
          ? "payment-setup-required"
          : unavailablePattern.test(bodyText)
            ? "item-unavailable"
            : emptyCartPattern.test(bodyText)
              ? "empty-cart"
              : null,
      pinReady: pinVisible && (await isReady(pinInput)) && (await isReady(pinConfirm)),
      highDemandReady: highDemandVisible && (await isReady(highDemandOk)),
      saveContinueReady: await isReady(saveContinue),
      placeOrderReady: await isReady(placeOrder),
      onCartPage: /target\.com\/cart(?:[/?#]|$)/i.test(page.url()),
      priceVisible: decimalCurrencyPattern.test(bodyText),
    }),
  };
}

function createCheckoutProgress({
  now = Date.now,
  stateTimeoutMs = 30000,
  maximumRecoveries = 2,
} = {}) {
  let currentState = null;
  let previousState = null;
  let stateEnteredAt = now();
  let lastProgressAt = stateEnteredAt;
  let recoveries = 0;
  let submissionMayHaveOccurred = false;
  const actionCounts = new Map();
  return {
    observe(state) {
      const transition = state !== currentState;
      if (transition) {
        previousState = currentState;
        currentState = state;
        stateEnteredAt = now();
        lastProgressAt = stateEnteredAt;
      }
      return {
        transition,
        currentState,
        previousState,
        stateEnteredAt,
        lastProgressAt,
        stalled: now() - lastProgressAt >= stateTimeoutMs,
        recoveries,
        submissionMayHaveOccurred,
      };
    },
    markProgress() {
      lastProgressAt = now();
    },
    recordAction(state, maximumAttempts = 3) {
      const count = (actionCounts.get(state) || 0) + 1;
      actionCounts.set(state, count);
      return count <= maximumAttempts;
    },
    markRecovery() {
      recoveries += 1;
      lastProgressAt = now();
      return recoveries <= maximumRecoveries;
    },
    markSubmission() {
      submissionMayHaveOccurred = true;
      lastProgressAt = now();
    },
    snapshot() {
      return {
        currentState,
        previousState,
        stateEnteredAt,
        lastProgressAt,
        recoveries,
        submissionMayHaveOccurred,
      };
    },
  };
}

async function runTargetCheckout({
  page,
  expectedProductIds = [],
  purchaseGuardConfig = null,
  targetPin = process.env.TARGET_PIN,
  buyNow = false,
  stopBeforeSubmit = /^(?:1|true|yes)$/i.test(
    process.env.TARGET_STOP_BEFORE_SUBMIT || "",
  ),
  handleVerification = null,
  shouldPause = () => false,
  now = Date.now,
  stateTimeoutMs = 30000,
  maximumRecoveries = 2,
  snapshotReader = snapshotCheckoutPage,
  evidenceReader = readPurchaseEvidence,
  log = console.log,
  error = console.error,
}) {
  let refreshes = 0;
  let buyNowEngaged = false;
  const progress = createCheckoutProgress({
    now,
    stateTimeoutMs,
    maximumRecoveries,
  });

  if (!buyNow && !/target\.com\/(?:checkout|cart)/i.test(page.url())) {
    await page.goto(checkoutUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
  }

  const runLoop = async () => {
    while (true) {
      if (page.isClosed()) {
      if (progress.snapshot().submissionMayHaveOccurred) {
        error("PLACE_ORDER_OUTCOME_AMBIGUOUS page-closed");
        return "ambiguous";
      }
      throw new Error("Checkout page was closed before order confirmation.");
    }
    if (shouldPause()) {
      if (progress.snapshot().submissionMayHaveOccurred) {
        error("PLACE_ORDER_OUTCOME_AMBIGUOUS shared-pause");
        return "ambiguous";
      }
      log("CHECKOUT_PAUSED_BY_GLOBAL_CIRCUIT_BREAKER");
      return "blocked";
    }
    let snapshot;
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      snapshot = await snapshotReader(page);
    } catch (snapshotError) {
      if (progress.snapshot().submissionMayHaveOccurred) {
        error(`PLACE_ORDER_OUTCOME_AMBIGUOUS snapshot-error ${snapshotError.message}`);
        return "ambiguous";
      }
      throw snapshotError;
    }
    if (shouldPause()) {
      if (progress.snapshot().submissionMayHaveOccurred) {
        error("PLACE_ORDER_OUTCOME_AMBIGUOUS shared-pause");
        return "ambiguous";
      }
      log("CHECKOUT_PAUSED_BY_GLOBAL_CIRCUIT_BREAKER");
      return "blocked";
    }
    const observed = progress.observe(snapshot.state);
    if (buyNow && snapshot.buyNowPanelVisible) {
      buyNowEngaged = true;
    }
    if (observed.transition) {
      log(
        `TARGET_CHECKOUT_STATE state=${observed.currentState} previous=${observed.previousState || "none"} buyNow=${buyNow}`,
      );
    }

    if (snapshot.state === "confirmed") {
      log("ORDER_CONFIRMED");
      return "confirmed";
    }

    if (snapshot.state === "verification") {
      if (!handleVerification) {
        if (progress.snapshot().submissionMayHaveOccurred) {
          error("PLACE_ORDER_OUTCOME_AMBIGUOUS post-submit-verification");
          return "ambiguous";
        }
        error("VERIFICATION_REQUIRED - checkout paused");
        return "blocked";
      }
      let result;
      try {
        result = await handleVerification(page);
      } catch (verificationError) {
        if (progress.snapshot().submissionMayHaveOccurred) {
          error(
            `PLACE_ORDER_OUTCOME_AMBIGUOUS post-submit-verification ${verificationError.message}`,
          );
          return "ambiguous";
        }
        throw verificationError;
      }
      if (result !== "resolved") {
        if (progress.snapshot().submissionMayHaveOccurred) {
          error("PLACE_ORDER_OUTCOME_AMBIGUOUS post-submit-verification");
          return "ambiguous";
        }
        return "blocked";
      }
      if (!progress.recordAction("verification", 6)) {
        if (progress.snapshot().submissionMayHaveOccurred) {
          error("PLACE_ORDER_OUTCOME_AMBIGUOUS post-submit-verification-repeated");
          return "ambiguous";
        }
        error("CHECKOUT_BLOCKED verification-repeated");
        return "blocked";
      }
      progress.markProgress();
      continue;
    }

    if (
      [
        "sign-in-required",
        "payment-setup-required",
        "item-unavailable",
        "empty-cart",
      ].includes(snapshot.state)
    ) {
      if (progress.snapshot().submissionMayHaveOccurred) {
        error(`PLACE_ORDER_OUTCOME_AMBIGUOUS post-submit-${snapshot.state}`);
        return "ambiguous";
      }
      error(`CHECKOUT_BLOCKED ${snapshot.state}`);
      return "blocked";
    }

    if (snapshot.state === "pin") {
      buyNowEngaged = true;
      if (!progress.recordAction("pin")) {
        error("CHECKOUT_BLOCKED pin-repeated");
        return "blocked";
      }
      if (!targetPin) {
        throw new Error("TARGET_PIN is required for the PIN confirmation dialog.");
      }
      try {
        await snapshot.controls.pinInput.fill(targetPin);
        await snapshot.controls.pinConfirm.click({ timeout: 5000 });
      } catch (clickError) {
        error(`PIN_CONTROL_REPLACED ${clickError.message}`);
        continue;
      }
      log("PIN_CONFIRMED");
      progress.markProgress();
      await page.waitForTimeout(500);
      continue;
    }

    if (snapshot.state === "high-demand") {
      buyNowEngaged = true;
      if (!progress.recordAction("high-demand")) {
        error("CHECKOUT_BLOCKED high-demand-repeated");
        return "blocked";
      }
      try {
        await snapshot.controls.highDemandOk.click({ timeout: 3000 });
      } catch (clickError) {
        error(`HIGH_DEMAND_CONTROL_REPLACED ${clickError.message}`);
        continue;
      }
      log("HIGH_DEMAND_OK_CLICKED");
      progress.markProgress();
      await page.waitForTimeout(500);
      continue;
    }

    if (snapshot.state === "save-continue") {
      buyNowEngaged = true;
      if (!progress.recordAction("save-continue")) {
        error("CHECKOUT_BLOCKED save-continue-repeated");
        return "blocked";
      }
      try {
        await snapshot.controls.saveContinue.click({ timeout: 5000 });
      } catch (clickError) {
        error(`SAVE_CONTINUE_CONTROL_REPLACED ${clickError.message}`);
        continue;
      }
      log("SAVE_AND_CONTINUE_CLICKED");
      progress.markProgress();
      await page.waitForTimeout(1000);
      continue;
    }

    if (snapshot.state === "go-checkout") {
      if (buyNow) {
        error("CHECKOUT_BLOCKED buy-now-route-changed");
        return "blocked";
      }
      await page.goto(checkoutUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      progress.markProgress();
      continue;
    }

    if (snapshot.state === "place-order") {
      buyNowEngaged = true;
      if (progress.snapshot().submissionMayHaveOccurred) {
        error("PLACE_ORDER_OUTCOME_AMBIGUOUS place-order-still-present");
        return "ambiguous";
      }
      const evidence = await evidenceReader(page);
      const validation = validatePurchaseEvidence(evidence, {
        expectedProductId: expectedProductIds[0],
        ...purchaseGuardConfig,
      });
      log(
        `TARGET_PURCHASE_VALIDATION ${JSON.stringify({
          ok: validation.ok,
          errors: validation.errors,
          ...validation.summary,
        })}`,
      );
      if (!validation.ok) {
        throw new Error(
          `PURCHASE_VALIDATION_FAILED ${validation.errors.join(",")}`,
        );
      }
      if (stopBeforeSubmit) {
        log("TARGET_READY_TO_SUBMIT_STOPPED");
        return "ready-to-submit";
      }
      log(`PLACE_ORDER_FOUND after ${refreshes} refreshes`);
      progress.markSubmission();
      try {
        await snapshot.controls.placeOrder.click({ timeout: 5000 });
        log("PLACE_ORDER_CLICKED");
      } catch (clickError) {
        error(`PLACE_ORDER_OUTCOME_AMBIGUOUS ${clickError.message}`);
        return "ambiguous";
      }
      try {
        await page.waitForTimeout(500);
      } catch (waitError) {
        error(`PLACE_ORDER_OUTCOME_AMBIGUOUS post-click ${waitError.message}`);
        return "ambiguous";
      }
      continue;
    }

    if (snapshot.state === "wait-loaded" || buyNow) {
      if (observed.stalled && progress.snapshot().submissionMayHaveOccurred) {
        error("PLACE_ORDER_OUTCOME_AMBIGUOUS post-submit-timeout");
        return "ambiguous";
      }
      if (buyNow && !buyNowEngaged && observed.stalled) {
        log("BUY_NOW_PANEL_NOT_READY - retrying product action");
        return "retry";
      }
      if (buyNow && buyNowEngaged && observed.stalled) {
        error("CHECKOUT_BLOCKED buy-now-panel-stalled-or-disappeared");
        return "blocked";
      }
      if (snapshot.state === "wait-loaded" && observed.stalled) {
        if (!progress.markRecovery()) {
          error("CHECKOUT_BLOCKED checkout-unchanged");
          return "blocked";
        }
        log(`CHECKOUT_RECOVERY ${progress.snapshot().recoveries}`);
        await page.waitForTimeout(1000);
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: 15000,
        }).catch((reloadError) => {
          error(`CHECKOUT_RECOVERY_RELOAD_FAILED ${reloadError.message}`);
        });
        continue;
      }
      await page.waitForTimeout(250);
      continue;
    }

    if (observed.stalled) {
      if (progress.snapshot().submissionMayHaveOccurred) {
        error("PLACE_ORDER_OUTCOME_AMBIGUOUS post-submit-unreadable");
        return "ambiguous";
      }
      if (!progress.markRecovery()) {
        error("CHECKOUT_BLOCKED checkout-recovery-exhausted");
        return "blocked";
      }
    }
    refreshes += 1;
    if (refreshes === 1 || refreshes % 10 === 0) {
      log(`REFRESH ${refreshes}`);
    }
    await page.waitForTimeout(1000);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    }
  };

  try {
    const result = await runLoop();
    if (
      progress.snapshot().submissionMayHaveOccurred &&
      result !== "confirmed" &&
      result !== "ambiguous"
    ) {
      error(`PLACE_ORDER_OUTCOME_AMBIGUOUS normalized-${result}`);
      return "ambiguous";
    }
    return result;
  } catch (checkoutError) {
    if (progress.snapshot().submissionMayHaveOccurred) {
      error(`PLACE_ORDER_OUTCOME_AMBIGUOUS checkout-error ${checkoutError.message}`);
      return "ambiguous";
    }
    throw checkoutError;
  }
}

module.exports = {
  cartResponseEvent,
  cartResponseKind,
  checkoutUrl,
  classifyCheckoutSnapshot,
  createCheckoutProgress,
  currencyValues,
  detectFulfillment,
  hasPageVerification,
  highDemandPattern,
  isOrderConfirmed,
  normalizeFulfillment,
  observeCartHandshake,
  paymentSetupPattern,
  parseLabeledCurrencyCents,
  parseMaximumCents,
  parseRetryAfterMs,
  parseUnambiguousCurrencyCents,
  readCartEvidence,
  readPurchaseGuardConfig,
  readPurchaseEvidence,
  runTargetCheckout,
  validatePdpIdentity,
  validatePurchaseEvidence,
  validateExpectedCart,
  verificationPattern,
};
