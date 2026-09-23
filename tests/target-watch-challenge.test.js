const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { findFulfillmentControl } = require("../target-checkout");
const {
  acquireProductPage,
  closeNewProductPages,
  continueCheckout,
  createMonitorState,
  findPurchaseButton,
  handleChallenge,
  inspectAndTrigger,
  inspectDirectBuyCheckout,
  parseJobArgument,
  parseProducts,
  pollAvailability,
  readCheckoutCartView,
  rearmConfirmedJob,
  reconcilePendingCart,
  selectProductFulfillment,
  triggerPurchase,
  waitForPausedPages,
  waitForHydratedPurchaseAction,
  waitForTargetSignIn,
} = require("../target-watch");
const { fakePage } = require("./helpers/target-challenge-fakes");

const noWait = async () => {};
const stateFor = (options = {}) => createMonitorState({
  observe: true, validation: false, maximumPolls: 0, runtimeMs: 0,
  log: () => {}, error: () => {}, notify: noWait, ...options,
});

test("watchlist releases checkout after each confirmed product and continues the others", () => {
  const state = stateFor({ observe: false, continueAfterOrder: true });
  assert.equal(state.claimPurchase("A-1010892076"), true);
  state.blockCartFallback();
  state.markOrderConfirmed("A-1010892076", "add-to-cart");
  assert.equal(state.isOrderConfirmed(), false);
  assert.equal(state.purchaseOwner(), null);
  assert.equal(state.cartFallbackBlocked(), false);
  assert.equal(state.canAttemptPurchase("A-1010892076"), false);
  assert.equal(state.claimPurchase("A-1010892067"), true);
  state.markOrderConfirmed("A-1010892067", "buy-now");
  assert.equal(state.isOrderConfirmed(), false);
  assert.equal(state.purchaseOwner(), null);
  assert.deepEqual(
    state.calibrationSummary().confirmedOrders.map((order) => order.productId),
    ["A-1010892076", "A-1010892067"],
  );
});

test("overnight watchlist can claim the same product for a new order", () => {
  const state = stateFor({
    observe: false,
    continueAfterOrder: true,
    repeatAfterOrder: true,
  });
  assert.equal(state.claimPurchase("A-1010892076"), true);
  state.markOrderConfirmed("A-1010892076", "buy-now");
  assert.equal(state.claimPurchase("A-1010892076"), true);
  state.markOrderConfirmed("A-1010892076", "buy-now");
  assert.equal(state.calibrationSummary().confirmedOrders.length, 2);
  assert.equal(state.isOrderConfirmed(), false);
});

const jobFor = (page, requestedMode = "add-to-cart") => ({
  page, product: { id: "A-1007918679", tcin: "1007918679", url: page.url() },
  availabilityRequest: { url: "stale" }, challengeSignal: "old", lastSummary: {},
  lastFingerprint: "old", nextNavigationAt: 123, triggered: false,
  addedToCart: false, purchaseMode: null, requestedMode, checkoutPage: {},
  completed: false, terminal: false, pendingCartReconciliation: false,
});

function productFulfillmentPage() {
  const dom = new JSDOM(`
    <main>
      <div role="region" aria-label="Fulfillment" data-test="module-product-detail-fulfillment-v1">
        <button id="PICKUP" aria-label="Pickup Ready tomorrow, selected">Pickup</button>
        <button id="DELIVERY" aria-label="Delivery As soon as tomorrow, ">Delivery</button>
        <button id="SHIPPING" aria-label="Shipping Arrives by Thu, Sep 24, ">Shipping</button>
      </div>
      <div data-test="@web/site-top-of-funnel/ProductDetailCollapsible-ShippingAndReturns">
        <button>Shipping & Returns</button>
      </div>
    </main>
  `);
  const { document } = dom.window;
  const wrap = (getNodes) => ({
    count: async () => getNodes().length,
    nth: (index) => wrap(() => [getNodes()[index]].filter(Boolean)),
    first: () => wrap(() => [getNodes()[0]].filter(Boolean)),
    locator: (selector) => wrap(() => getNodes().flatMap((node) =>
      [...node.querySelectorAll(selector)])),
    getAttribute: async (name) => getNodes()[0]?.getAttribute(name) ?? null,
    innerText: async () => getNodes()[0]?.textContent || "",
    isVisible: async () => Boolean(getNodes()[0] && !getNodes()[0].hidden),
    isEnabled: async () => Boolean(getNodes()[0] && !getNodes()[0].disabled),
    isChecked: async () => Boolean(getNodes()[0]?.checked),
    click: async () => getNodes()[0].click(),
  });
  return {
    document,
    close: () => dom.window.close(),
    locator: (selector) => wrap(() => [...document.querySelectorAll(selector)]),
    url: () => "https://www.target.com/p/example/-/A-1007918679",
  };
}

test("direct buy enables Buy Now priority while bare URLs retain legacy auto mode", () => {
  assert.deepEqual(
    parseJobArgument(
      "buy-now=https://www.target.com/p/-/A-1007918679",
    ),
    {
      requestedMode: "buy-now",
      url: "https://www.target.com/p/-/A-1007918679",
    },
  );
  assert.equal(
    parseJobArgument(
      "https://www.target.com/p/-/A-1007918679",
    ).requestedMode,
    "auto",
  );
  assert.equal(
    parseJobArgument(
      "direct-buy=https://www.target.com/p/-/A-1007918679",
    ).requestedMode,
    "direct-buy",
  );
});

test("product page acquisition prefers an existing same-product challenge tab", async () => {
  const challengePage = {
    url: () => "https://www.target.com/p/example/-/A-1007918679",
  };
  const clearPage = {
    url: () => "https://www.target.com/p/example/-/A-1007918679",
  };
  const freshPage = {
    url: () => "about:blank",
  };
  const selected = await acquireProductPage(
    {
      pages: () => [clearPage, challengePage],
      newPage: async () => freshPage,
    },
    { id: "A-1007918679" },
    {
      inspect: async (page) =>
        page === challengePage
          ? { detected: true, kind: "press_and_hold" }
          : { detected: false, kind: "none" },
    },
  );
  assert.equal(selected, challengePage);
});

test("product page acquisition avoids taking a clear user tab", async () => {
  const clearPage = {
    url: () => "https://www.target.com/p/example/-/A-1007918679",
  };
  const freshPage = {
    url: () => "about:blank",
  };
  const selected = await acquireProductPage(
    {
      pages: () => [clearPage],
      newPage: async () => freshPage,
    },
    { id: "A-1007918679" },
    {
      inspect: async () => ({ detected: false, kind: "none" }),
    },
  );
  assert.equal(selected, freshPage);
});

test("watchlist reuses an existing clear product tab without opening another", async () => {
  const clearPage = {
    url: () => "https://www.target.com/p/example/-/A-1007918679",
  };
  let created = 0;
  const selected = await acquireProductPage(
    {
      pages: () => [clearPage],
      newPage: async () => {
        created += 1;
        return { url: () => "about:blank" };
      },
    },
    { id: "A-1007918679" },
    {
      inspect: async () => ({ detected: false, kind: "none" }),
      reuseClearProductPage: true,
    },
  );
  assert.equal(selected, clearPage);
  assert.equal(created, 0);
});

test("worker shutdown preserves reused product tabs", async () => {
  const closed = [];
  const existing = { close: async () => { closed.push("existing"); } };
  const created = { close: async () => { closed.push("created"); } };
  await closeNewProductPages(
    [{ page: existing }, { page: created }],
    new Set([existing]),
  );
  assert.deepEqual(closed, ["created"]);
});

test("mode-specific button selection ignores other enabled controls", async () => {
  const controls = [
    { label: "Buy now" },
    { label: "Add to cart" },
    { label: "Preorder" },
  ];
  const page = {
    locator: () => ({
      count: async () => controls.length,
      nth: (index) => ({
        innerText: async () => controls[index].label,
        isVisible: async () => true,
        isEnabled: async () => true,
      }),
    }),
  };
  assert.equal(
    (await findPurchaseButton(page, "add-to-cart")).label,
    "Add to cart",
  );
  assert.equal((await findPurchaseButton(page, "buy-now")).label, "Buy now");
  assert.equal((await findPurchaseButton(page, "preorder")).label, "Preorder");
  assert.equal((await findPurchaseButton(page, "auto")).label, "Preorder");
  assert.equal((await findPurchaseButton(page, "direct-buy")).label, "Buy now");
});

test("direct buy selects Shipping on the product page before purchase action", async () => {
  const page = fakePage({ body: "Product" });
  const job = jobFor(page);
  job.purchaseGuardConfig = { expectedFulfillment: "shipping" };
  let clicks = 0;
  const result = await selectProductFulfillment(job, {
    findControl: async () => ({
      selected: clicks > 0,
      ambiguous: false,
      control: {
        click: async () => { clicks += 1; },
      },
    }),
    waitFor: noWait,
  });
  assert.equal(result, "selected");
  assert.equal(clicks, 1);
});

test("direct buy does not claim Shipping was selected when the click did not change the page", async () => {
  const page = fakePage({ body: "Product" });
  const job = jobFor(page);
  job.purchaseGuardConfig = { expectedFulfillment: "shipping" };
  const messages = [];
  const result = await selectProductFulfillment(job, {
    findControl: async () => ({
      selected: false,
      ambiguous: false,
      control: { click: async () => {} },
    }),
    waitFor: noWait,
    log: (message) => messages.push(message),
  });
  assert.equal(result, "blocked");
  assert.match(messages[0], /^TARGET_FULFILLMENT_SELECTION_UNCONFIRMED\b/);
  assert.equal(messages.some((message) => message.startsWith("TARGET_FULFILLMENT_SELECTED")), false);
});

test("product Shipping selection targets the fulfillment button, not Shipping & Returns", async () => {
  const page = productFulfillmentPage();
  try {
    const shipping = page.document.querySelector('button[id="SHIPPING"]');
    const wrong = page.document.querySelector('[data-test*="ShippingAndReturns"] button');
    let shippingClicks = 0;
    let wrongClicks = 0;
    shipping.addEventListener("click", () => {
      shippingClicks += 1;
      shipping.setAttribute("aria-label", "Shipping Arrives by Thu, Sep 24, selected");
    });
    wrong.addEventListener("click", () => { wrongClicks += 1; });
    const job = jobFor(page);
    job.purchaseGuardConfig = { expectedFulfillment: "shipping" };

    const result = await selectProductFulfillment(job, { waitFor: noWait });
    assert.equal(result, "selected");
    assert.equal(shippingClicks, 1);
    assert.equal(wrongClicks, 0);
    assert.equal(await selectProductFulfillment(job, { waitFor: noWait }), "selected");
    assert.equal(shippingClicks, 1);
  } finally {
    page.close();
  }
});

test("product fulfillment does not substitute Shipping & Returns for a missing Shipping button", async () => {
  const page = productFulfillmentPage();
  try {
    page.document.querySelector('button[id="SHIPPING"]').remove();
    const wrong = page.document.querySelector('[data-test*="ShippingAndReturns"] button');
    let wrongClicks = 0;
    wrong.addEventListener("click", () => { wrongClicks += 1; });
    const job = jobFor(page);
    job.purchaseGuardConfig = { expectedFulfillment: "shipping" };

    assert.equal(await selectProductFulfillment(job, {
      waitFor: noWait,
      log: () => {},
    }), "blocked");
    assert.equal(wrongClicks, 0);
  } finally {
    page.close();
  }
});

test("product fulfillment accepts an unambiguous Ship to arrival summary", async () => {
  const page = productFulfillmentPage();
  try {
    const region = page.document.querySelector(
      '[data-test="module-product-detail-fulfillment-v1"]',
    );
    region.removeAttribute("data-test");
    region.innerHTML = "<div>Ship to 12345 </div><div>Arrives by Friday</div>";
    const job = jobFor(page);
    job.purchaseGuardConfig = { expectedFulfillment: "shipping" };
    assert.equal(await selectProductFulfillment(job, {
      waitFor: noWait,
      log: () => {},
    }), "selected");
  } finally {
    page.close();
  }
});

test("duplicate product Shipping buttons block instead of choosing the first", async () => {
  const page = productFulfillmentPage();
  try {
    const shipping = page.document.querySelector('button[id="SHIPPING"]');
    shipping.after(shipping.cloneNode(true));
    const job = jobFor(page);
    job.purchaseGuardConfig = { expectedFulfillment: "shipping" };

    assert.equal(await selectProductFulfillment(job, {
      waitFor: noWait,
      log: () => {},
    }), "blocked");
  } finally {
    page.close();
  }
});

test("checkout fulfillment finder ignores PDP Shipping and Shipping & Returns content", async () => {
  const page = productFulfillmentPage();
  try {
    assert.equal(await findFulfillmentControl(page, "shipping"), null);
    const checkout = page.document.createElement("div");
    checkout.innerHTML = '<button aria-label="Shipping, selected">Shipping</button>';
    page.document.querySelector("main").append(checkout);
    const selected = await findFulfillmentControl(page, "shipping");
    assert.equal(selected?.selected, true);
    assert.equal(await selected.control.getAttribute("aria-label"), "Shipping, selected");
  } finally {
    page.close();
  }
});

test("cart 429 cools the cart lane and deduplicates listeners", () => {
  const state = stateFor({ observe: false });
  const identity = {};
  state.recordCartResponse(
    { kind: "reconciliation", status: 429, retryAfterMs: 7000, elapsedMs: 10 },
    identity,
    "product",
  );
  state.recordCartResponse(
    { kind: "reconciliation", status: 429, retryAfterMs: 7000, elapsedMs: 10 },
    identity,
    "product",
  );
  assert.equal(state.isPaused(), false);
  assert.equal(state.isCartRateLimited(), true);
  assert.equal(state.calibrationSummary().cartResponses, 1);
  assert.equal(state.calibrationSummary().cartRateLimitCount, 1);
});

test("simultaneous cart 429 events share one backoff window", () => {
  let now = 1000;
  const state = stateFor({ observe: false, now: () => now });
  state.recordCartResponse(
    { kind: "cart-read", status: 429, retryAfterMs: 0, elapsedMs: 1 },
    {},
    "product-one",
  );
  const firstRemaining = state.remainingCartRateLimitMs();
  assert.equal(firstRemaining, 60000);
  state.recordCartResponse(
    { kind: "cart-read", status: 429, retryAfterMs: 0, elapsedMs: 1 },
    {},
    "product-two",
  );
  assert.equal(state.remainingCartRateLimitMs(), firstRemaining);
});

test("normal observe-only calibration remains stopped after a challenged API poll", () => {
  const state = stateFor();
  state.recordApiPoll({ status: 403, outcome: "challenge" });
  state.recordChallengeSolved("press_and_hold", 1);
  assert.equal(state.shouldStop(), true);
});

test("explicit validation defers a challenge stop until resolution and then allows polling", async () => {
  const logs = [];
  const state = stateFor({ validation: true, log: (message) => logs.push(message) });
  state.recordApiPoll({ status: 403, outcome: "challenge" });
  assert.equal(state.shouldStop(), false);
  assert.equal(state.calibrationSummary().challengePending, true);
  state.recordChallengeSolved("press_and_hold", 1, "A-1007918679");
  await state.enqueueGlobalPoll(async () => state.recordApiPoll({ status: 200, outcome: "response" }));
  assert.equal(state.calibrationSummary().apiPolls, 2);
  assert.equal(state.calibrationSummary().challengePending, false);
  assert.ok(
    logs.some((line) =>
      line.includes('"productId":"A-1007918679"'),
    ),
  );
});

test("validation does not resume an unresolved challenge or unrelated error", () => {
  for (const result of [{ status: 500, outcome: "response" }, { status: 0, outcome: "fetch_error" }]) {
    const state = stateFor({ validation: true });
    state.recordApiPoll(result);
    state.recordChallengeSolved("press_and_hold", 1);
    assert.equal(state.shouldStop(), true);
  }
  const state = stateFor({ validation: true });
  state.recordApiPoll({ status: 403, outcome: "challenge" });
  state.pauseForChallenge("unresolved");
  assert.equal(state.shouldStop(), true);
  assert.ok(state.remainingPauseMs() > 0);
});

test("unreadable page retries at the base challenge cooldown", () => {
  let now = 1000;
  const state = stateFor({ observe: false, now: () => now });
  state.pauseForChallenge("unreadable page", { fixed: true });
  assert.equal(state.remainingPauseMs(), 300000);
  now += 300000;
  assert.equal(state.remainingPauseMs(), 0);
});

test("paused challenge resumes immediately when local page clearance is observed", async () => {
  let now = 0;
  let inspections = 0;
  const state = stateFor({ observe: false, now: () => now });
  const job = jobFor(fakePage());
  state.pauseForChallenge("unreadable page", { fixed: true });
  const resumed = await waitForPausedPages([job], state, {
    inspect: async () => {
      inspections += 1;
      return inspections > 1
        ? { detected: false, unreadable: false }
        : { detected: true, unreadable: false };
    },
    waitFor: async () => {
      now += 1000;
    },
  });
  assert.equal(resumed, true);
  assert.equal(state.isPaused(), false);
  assert.equal(job.availabilityRequest, null);
  assert.equal(job.challengeSignal, null);
  assert.equal(job.nextNavigationAt, 0);
});

test("unavailable product skips fulfillment inspection until an action is enabled", async () => {
  const page = {
    url: () => "https://www.target.com/p/-/A-1007918679",
    locator: (selector) => {
      if (selector === '[data-test="module-product-detail-add-to-cart"] button') {
        return { count: async () => 0 };
      }
      throw new Error("Fulfillment must not be inspected without a purchase action.");
    },
  };
  const job = jobFor(page, "direct-buy");
  job.purchaseGuardConfig = { expectedFulfillment: "shipping" };
  assert.equal(
    await inspectAndTrigger(job, stateFor({ observe: false }), "product page", null),
    false,
  );
});

test("stock candidate waits for a hydrated purchase action on the current page", async () => {
  let inspections = 0;
  const waits = [];
  const found = await waitForHydratedPurchaseAction({}, {}, {
    inspect: async () => {
      inspections += 1;
      return inspections === 3;
    },
    waitFor: async (milliseconds) => { waits.push(milliseconds); },
    attempts: 4,
  });
  assert.equal(found, true);
  assert.equal(inspections, 3);
  assert.deepEqual(waits, [250, 250]);
});

test("stock candidate uses an already actionable product tab before navigation", async () => {
  const calls = [];
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  const { actOnAvailabilityCandidate } = require("../target-watch");
  await actOnAvailabilityCandidate(job, stateFor({ observe: false }), {
    inspect: async () => { calls.push("inspect"); return true; },
    navigate: async () => { calls.push("navigate"); },
  });
  assert.deepEqual(calls, ["inspect"]);
});

test("stock candidate navigates once when the current tab has no action", async () => {
  const calls = [];
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  const { actOnAvailabilityCandidate } = require("../target-watch");
  await actOnAvailabilityCandidate(job, stateFor({ observe: false }), {
    inspect: async () => { calls.push("inspect"); return false; },
    navigate: async () => { calls.push("navigate"); },
  });
  assert.deepEqual(calls, ["inspect", "navigate"]);
});

test("eight direct-buy jobs require the explicit watchlist mode", () => {
  const jobs = Array.from({ length: 8 }, (_, index) =>
    `direct-buy=https://www.target.com/p/-/A-${1010000000 + index}`);
  assert.throws(() => parseProducts(jobs), /configured maximum/);
  assert.equal(
    parseProducts(jobs, { jobLimit: 8, requireDirectBuy: true }).length,
    8,
  );
  assert.throws(
    () => parseProducts(
      [jobs[0], "https://www.target.com/p/-/A-1010000001"],
      { jobLimit: 8, requireDirectBuy: true },
    ),
    /direct-buy/,
  );
});

test("matched-cart challenge pause follows the checkout tab", async () => {
  let now = 1000;
  const state = stateFor({ observe: false, now: () => now });
  const job = jobFor(fakePage({ body: "Product", controls: [] }), "direct-buy");
  const checkoutPage = fakePage({ body: "Press and hold" });
  job.addedToCart = true;
  job.checkoutPage = checkoutPage;
  const inspected = [];
  state.pauseForChallenge("checkout verification", {
    fixed: true,
    productId: job.product.id,
  });
  assert.equal(await waitForPausedPages([job], state, {
    inspect: async (page) => {
      inspected.push(page);
      return page === checkoutPage && now < 3000
        ? { detected: true, kind: "press_and_hold" }
        : { detected: false, kind: "none" };
    },
    waitFor: async () => { now += 1000; },
  }), true);
  assert.ok(now >= 3000);
  assert.ok(inspected.every((page) => page === checkoutPage));
});

test("preflight challenge pause follows the retained checkout tab", async () => {
  let now = 1000;
  const state = stateFor({ observe: false, now: () => now });
  const job = jobFor(fakePage({ body: "Product", controls: [] }), "direct-buy");
  const preflightPage = fakePage({ body: "Press and hold" });
  job.preflightPage = preflightPage;
  job.preflightChallengePending = true;
  state.pauseForChallenge("preflight verification", {
    fixed: true,
    productId: job.product.id,
  });
  const inspected = [];
  assert.equal(await waitForPausedPages([job], state, {
    inspect: async (page) => {
      inspected.push(page);
      return now < 3000
        ? { detected: true, kind: "press_and_hold" }
        : { detected: false, kind: "none" };
    },
    waitFor: async () => { now += 1000; },
  }), true);
  assert.ok(inspected.every((page) => page === preflightPage));
});

test("solving one paused product keeps other challenge owners paused", () => {
  let now = 0;
  const state = stateFor({ observe: false, now: () => now });
  state.pauseForChallenge("product one", { fixed: true, productId: "A-1" });
  state.pauseForChallenge("product two", { fixed: true, productId: "A-2" });
  assert.deepEqual(state.challengePauseProductIds().sort(), ["A-1", "A-2"]);

  state.recordChallengeSolved("press_and_hold", 1, "A-1");
  assert.equal(state.isPaused(), true);
  assert.deepEqual(state.challengePauseProductIds(), ["A-2"]);

  state.recordChallengeSolved("press_and_hold", 1, "A-2");
  assert.equal(state.isPaused(), false);
  assert.deepEqual(state.challengePauseProductIds(), []);
});

test("successful recovery does not override poll, time, or malformed-response limits", () => {
  const count = stateFor({ validation: true, maximumPolls: 1 });
  count.recordApiPoll({ status: 403, outcome: "challenge" });
  count.recordChallengeSolved("press_and_hold", 1);
  assert.ok(count.shouldStop());
  let now = 0;
  const timed = stateFor({ runtimeMs: 1000, now: () => now });
  now = 1000;
  timed.recordChallengeSolved("press_and_hold", 1);
  assert.ok(timed.shouldStop());
  const malformed = stateFor({ validation: true });
  malformed.stopCalibration("non-JSON");
  malformed.recordChallengeSolved("press_and_hold", 1);
  assert.ok(malformed.shouldStop());
});

test("all successful handling clears stale templates and signals", async () => {
  const page = fakePage();
  const job = jobFor(page);
  const result = await handleChallenge(job, stateFor(), "test", {
    solver: async () => { page.state.body = "Pokemon Add to cart"; },
    waitFor: noWait,
  });
  assert.equal(result, "resolved");
  for (const key of ["availabilityRequest", "challengeSignal", "lastSummary", "lastFingerprint"]) {
    assert.equal(job[key], null);
  }
  assert.equal(job.nextNavigationAt, 0);
});

test("network challenge without live evidence backs off without invoking the solver", async () => {
  const page = fakePage({ body: "Product" });
  const state = stateFor();
  let called = false;
  assert.equal(await handleChallenge(jobFor(page), state, "API challenge", {
    assumeDetected: true, solver: async () => { called = true; }, waitFor: noWait,
  }), "blocked");
  assert.equal(called, false);
  assert.ok(state.shouldStop());
});

test("initially unreadable state cannot invoke even a custom solver", async () => {
  const page = fakePage({ readError: true, controls: [] });
  let calls = 0;
  const job = jobFor(page);
  const result = await handleChallenge(job, stateFor(), "read failure", {
    solver: async () => { calls += 1; }, waitFor: noWait,
  });
  assert.equal(result, "blocked");
  assert.equal(calls, 0);
  for (const key of ["availabilityRequest", "challengeSignal", "lastSummary", "lastFingerprint"]) {
    assert.equal(job[key], null);
  }
  assert.equal(job.nextNavigationAt, 0);
});

test("unreadable post-solve state is blocked even when solver returns true", async () => {
  const page = fakePage();
  const state = stateFor();
  assert.equal(await handleChallenge(jobFor(page), state, "test", {
    solver: async () => { page.state.body = ""; return true; },
    maxAttempts: 1, waitFor: noWait,
  }), "blocked");
  assert.equal(state.calibrationSummary().challengeSolvedCount, 0);
});

test("actual post-click path resolves inside its existing mutation without deadlock", { timeout: 1500 }, async () => {
  const page = fakePage({ body: "Product" });
  page.waitForTimeout = noWait;
  page.getByText = () => ({ first: () => ({ count: async () => 0 }) });
  const job = jobFor(page);
  const state = stateFor();
  const candidate = {
    label: "Add to cart", mode: "add-to-cart",
    button: {
      hover: noWait,
      click: async () => {
        assert.equal(state.purchaseOwner(), job.product.id);
        page.state.body = "Quick verification Press & Hold";
      },
    },
  };
  await state.enqueueMutation(() => triggerPurchase(job, state, "test", null, candidate, {
    notify: noWait,
    challengeOptions: {
      solver: async () => { page.state.body = "Added to cart"; },
      waitFor: noWait,
    },
    checkoutRunner: async () => "confirmed",
    cartHandshake: async (_page, click) => {
      await click();
      return { mutation: null, reconciliation: null, rateLimited: false };
    },
  }));
  assert.equal(state.calibrationSummary().challengeSolvedCount, 1);
  assert.equal(job.completed, true);
  assert.equal(state.isOrderConfirmed(), true);
  let nextRan = false;
  await state.enqueueMutation(async () => { nextRan = true; });
  assert.equal(nextRan, true);
});

test("cart redirect goes directly to checkout without inspecting the cart challenge", async () => {
  const page = fakePage({ body: "Press & Hold" });
  page.waitForTimeout = noWait;
  page.on = () => {};
  page.off = () => {};
  const job = jobFor(page, "direct-buy");
  job.checkoutPage = null;
  job.checkoutPages = new Set();
  let preflightClosed = 0;
  job.preflightPage = {
    close: async () => { preflightClosed += 1; },
  };
  job.checkoutPages.add(job.preflightPage);
  job.context = {
    newPage: async () => { throw new Error("Redirected product tab must be reused."); },
  };
  const state = stateFor({ observe: false });
  let checkoutPage = null;
  await state.enqueueMutation(() => triggerPurchase(
    job,
    state,
    "product page",
    null,
    {
      label: "Add to cart",
      mode: "add-to-cart",
      button: {
        click: async () => { page.state.url = "https://www.target.com/cart"; },
      },
    },
    {
      notify: noWait,
      challengeOptions: {
        inspect: async () => { throw new Error("Cart page must not be inspected."); },
      },
      cartHandshake: async (_page, click) => {
        await click();
        return {
          mutation: { kind: "mutation", status: 201 },
          reconciliation: { kind: "reconciliation", status: 200 },
          rateLimited: false,
        };
      },
      checkoutRunner: async ({ page: selected }) => {
        checkoutPage = selected;
        return "confirmed";
      },
    },
  ));
  assert.equal(checkoutPage, page);
  assert.equal(preflightClosed, 1);
  assert.equal(job.preflightPage, null);
  assert.equal(state.isOrderConfirmed(), true);
});

test("buy now drives the side-panel checkout and claims the transaction", async () => {
  const page = fakePage({ body: "Product" });
  page.waitForTimeout = noWait;
  page.getByText = () => ({ first: () => ({ count: async () => 0 }) });
  const job = jobFor(page, "buy-now");
  const state = stateFor();
  let checkoutOptions;
  await state.enqueueMutation(() => triggerPurchase(
    job,
    state,
    "test",
    null,
    {
      label: "Buy now",
      mode: "buy-now",
      button: {
        hover: noWait,
        click: async () => {
          assert.equal(state.purchaseOwner(), job.product.id);
        },
      },
    },
    {
      notify: noWait,
      checkoutRunner: async (options) => {
        checkoutOptions = options;
        return "confirmed";
      },
    },
  ));
  assert.equal(checkoutOptions.page, page);
  assert.equal(checkoutOptions.buyNow, true);
  assert.equal(state.purchaseOwner(), job.product.id);
  assert.equal(state.isOrderConfirmed(), true);
});

test("buy now starts checkout without fixed product-page waits", async () => {
  const page = fakePage({ body: "Product" });
  const waits = [];
  page.waitForTimeout = async (milliseconds) => { waits.push(milliseconds); };
  const job = jobFor(page, "buy-now");
  const state = stateFor({ observe: false });
  await state.enqueueMutation(() => triggerPurchase(
    job,
    state,
    "product page",
    null,
    {
      label: "Buy now",
      mode: "buy-now",
      button: { hover: noWait, click: noWait },
    },
    { notify: noWait, checkoutRunner: async () => "confirmed" },
  ));
  assert.equal(state.isOrderConfirmed(), true);
  assert.deepEqual(waits, []);
});

test("buy-now panel-open failure releases ownership", async () => {
  const page = fakePage({ body: "Product" });
  page.waitForTimeout = noWait;
  const job = jobFor(page, "buy-now");
  const state = stateFor({ observe: false });
  await state.enqueueMutation(() => triggerPurchase(
    job,
    state,
    "test",
    null,
    {
      label: "Buy now",
      mode: "buy-now",
      button: { hover: noWait, click: noWait },
    },
    {
      notify: noWait,
      checkoutRunner: async () => "retry",
    },
  ));
  assert.equal(state.purchaseOwner(), null);
});

test("cart 429 after a successful mutation preserves the owner", async () => {
  const page = fakePage({ body: "Product" });
  page.waitForTimeout = noWait;
  const job = jobFor(page, "add-to-cart");
  const state = stateFor({ observe: false });
  await state.enqueueMutation(() => triggerPurchase(
    job,
    state,
    "test",
    null,
    {
      label: "Add to cart",
      mode: "add-to-cart",
      button: { hover: noWait, click: noWait },
    },
    {
      notify: noWait,
      cartHandshake: async (_page, click) => {
        await click();
        return {
          mutation: { kind: "mutation", status: 201, retryAfterMs: 0 },
          reconciliation: {
            kind: "reconciliation",
            status: 429,
            retryAfterMs: 7000,
          },
          rateLimited: true,
        };
      },
    },
  ));
  assert.equal(state.purchaseOwner(), job.product.id);
  assert.equal(job.pendingCartReconciliation, true);
  assert.equal(job.purchaseMode, "add-to-cart");
});

test("cart 429 cools the cart lane without pausing availability work", () => {
  let now = 1000;
  const state = stateFor({ observe: false, now: () => now });
  state.recordCartResponse({
    kind: "mutation", status: 429, retryAfterMs: 70000,
  });
  assert.equal(state.isPaused(), false);
  assert.equal(state.isCartRateLimited(), true);
  assert.equal(state.remainingCartRateLimitMs(), 70000);
  state.recordCartResponse({
    kind: "reconciliation", status: 200, retryAfterMs: 0,
  });
  assert.equal(state.isCartRateLimited(), true);
  now += 70000;
  assert.equal(state.isCartRateLimited(), false);
  state.recordCartResponse({
    kind: "mutation", status: 429, retryAfterMs: 0,
  });
  assert.ok(state.remainingCartRateLimitMs() >= 120000);
  state.recordCartResponse({
    kind: "mutation", status: 201, retryAfterMs: 0,
  });
  assert.equal(state.isCartRateLimited(), false);
});

test("poll telemetry records actual per-product gaps and recovery health", () => {
  let now = 1000;
  const lines = [];
  const state = stateFor({
    observe: false,
    now: () => now,
    log: (line) => lines.push(line),
  });
  state.recordApiPoll({
    productId: "A-1010892076", status: 200, latencyMs: 10, outcome: "response",
  });
  now += 6500;
  state.recordApiPoll({
    productId: "A-1010892076", status: 200, latencyMs: 12, outcome: "response",
  });
  const poll = JSON.parse(lines.filter((line) =>
    line.startsWith("TARGET_API_POLL ")).at(-1).slice("TARGET_API_POLL ".length));
  assert.equal(poll.pollGapMs, 6500);
  now += 500;
  assert.equal(state.heartbeatSnapshot().lastApiPollAgeMs, 500);
  assert.equal(state.heartbeatSnapshot().lastApiProductId, "A-1010892076");
});

test("an empty cart after uncertain input stays owned for a fresh purchase attempt", async () => {
  const page = fakePage({ body: "Product", controls: [] });
  page.getByText = () => ({ first: () => ({ count: async () => 0 }) });
  const job = jobFor(page, "direct-buy");
  job.purchaseMode = "add-to-cart";
  job.pendingCartReconciliation = true;
  const state = stateFor({ observe: false });
  state.claimPurchase(job.product.id);
  const result = await reconcilePendingCart(job, state, {
    notify: noWait,
    checkoutPreflight: async () => "empty",
  });
  assert.equal(result, "retry-cart");
  assert.equal(job.cartRetryPending, true);
  assert.equal(job.pendingCartReconciliation, false);
  assert.equal(state.purchaseOwner(), job.product.id);
  assert.equal(state.shouldStop(), false);
});

test("uncertain cart redirect goes straight to checkout preflight", async () => {
  const page = fakePage({
    body: "Press & Hold",
    url: "https://www.target.com/cart",
  });
  page.goto = async (url) => { page.state.url = url; };
  const job = jobFor(page, "direct-buy");
  job.purchaseMode = "add-to-cart";
  job.pendingCartReconciliation = true;
  const state = stateFor({ observe: false });
  state.claimPurchase(job.product.id);
  let preflightPage = null;
  const result = await reconcilePendingCart(job, state, {
    checkoutPreflight: async (_job, _state, options) => {
      preflightPage = await options.openPage();
      return "empty";
    },
    challengeOptions: {
      inspect: async () => {
        throw new Error("The cart challenge must not be inspected.");
      },
    },
    notify: noWait,
  });
  assert.equal(preflightPage, page);
  assert.equal(page.url(), "https://www.target.com/checkout");
  assert.equal(result, "retry-cart");
  assert.equal(state.isPaused(), false);
});

test("single-product cart action transfers its retained preflight tab to checkout", async () => {
  const page = fakePage({ body: "Product" });
  page.waitForTimeout = noWait;
  page.getByText = () => ({ first: () => ({ count: async () => 0 }) });
  const preflight = checkoutPreflightPage();
  let closed = 0;
  preflight.close = async () => { closed += 1; };
  const job = jobFor(page, "direct-buy");
  job.checkoutPage = null;
  job.preflightPage = preflight;
  job.checkoutPages = new Set([preflight]);
  job.context = { newPage: async () => { throw new Error("Preflight tab must be reused."); } };
  const state = stateFor({ observe: false });
  await state.enqueueMutation(() => triggerPurchase(
    job, state, "test", null,
    {
      label: "Add to cart",
      mode: "add-to-cart",
      button: { click: async () => { page.state.body = "Added to cart"; } },
    },
    {
      notify: noWait,
      multiDirectBuy: false,
      cartHandshake: async (_page, click) => {
        await click();
        return {
          mutation: { kind: "mutation", status: 201 },
          reconciliation: { kind: "reconciliation", status: 200 },
          rateLimited: false,
        };
      },
      checkoutRunner: async ({ page: checkoutPage }) => {
        assert.equal(checkoutPage, preflight);
        assert.equal(closed, 0);
        return "confirmed";
      },
    },
  ));
  assert.equal(state.isOrderConfirmed(), true);
  assert.equal(job.preflightPage, null);
  assert.equal(closed, 0);
});

test("empty-cart retry leaves a later cart redirect without inspecting it", async () => {
  const page = fakePage({
    body: "Press & Hold",
    url: "https://www.target.com/cart",
  });
  const job = jobFor(page, "direct-buy");
  job.availabilityRequest = null;
  job.cartRetryPending = true;
  const state = stateFor({ observe: false });
  state.claimPurchase(job.product.id);
  let retried = false;
  await pollAvailability(job, state, {
    retryRunner: async () => { retried = true; },
  });
  assert.equal(retried, true);
  assert.equal(state.isPaused(), false);
});

test("a cart retry releases its owner when the product has no action anymore", async () => {
  const { retryCartPurchase } = require("../target-watch");
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.cartRetryPending = true;
  const state = stateFor({ observe: false });
  state.claimPurchase(job.product.id);
  const calls = [];
  const result = await retryCartPurchase(job, state, {
    inspect: async () => { calls.push("inspect"); return false; },
    navigate: async () => { calls.push("navigate"); return false; },
  });
  assert.equal(result, "unavailable");
  assert.deepEqual(calls, ["inspect", "navigate"]);
  assert.equal(state.purchaseOwner(), null);
  assert.equal(job.cartRetryPending, false);
});

test("failed reconciliation preserves the owner for later cart reconciliation", async () => {
  const page = fakePage({ body: "Product" });
  page.waitForTimeout = noWait;
  const job = jobFor(page, "preorder");
  const state = stateFor({ observe: false });
  await state.enqueueMutation(() => triggerPurchase(
    job,
    state,
    "test",
    null,
    {
      label: "Preorder",
      mode: "preorder",
      button: { hover: noWait, click: noWait },
    },
    {
      notify: noWait,
      cartHandshake: async (_page, click) => {
        await click();
        return {
          mutation: { kind: "mutation", status: 201, retryAfterMs: 0 },
          reconciliation: {
            kind: "reconciliation",
            status: 500,
            retryAfterMs: 0,
          },
          rateLimited: false,
        };
      },
    },
  ));
  assert.equal(state.purchaseOwner(), job.product.id);
  assert.equal(job.pendingCartReconciliation, true);
});

function checkoutPreflightPage({ redirectCount = 0, onClose = () => {} } = {}) {
  let responseHandler = null;
  let route = "/checkout";
  let visits = 0;
  return {
    on: (_event, handler) => { responseHandler = handler; },
    off: () => { responseHandler = null; },
    goto: async (url) => {
      assert.equal(url, "https://www.target.com/checkout");
      visits += 1;
      route = visits <= redirectCount ? "/cart" : "/checkout";
      if (route === "/checkout") {
        responseHandler?.({
          url: () => "https://carts.target.com/web_checkouts/v1/cart_views?key=test",
          status: () => 200,
        });
      }
    },
    url: () => `https://www.target.com${route}`,
    redirectToCart: () => { route = "/cart"; },
    close: async () => { onClose(); },
    visits: () => visits,
  };
}

const matchingCartView = () => ({
  cart_items: [{
    tcin: "1007918679",
    quantity: 1,
    total_cart_item_quantity: 1,
    current_price: 16.39,
    fulfillment: { type: "SHIP" },
  }],
  summary: { items_quantity: 1, grand_total: 16.96 },
});

test("direct-buy preflight adopts one exact checkout item without a product click", async () => {
  const productPage = fakePage({ body: "Product" });
  const job = jobFor(productPage, "direct-buy");
  job.context = {};
  job.checkoutPages = new Set();
  const checkoutPage = checkoutPreflightPage({
    onClose: () => { throw new Error("Matched checkout page must remain open."); },
  });
  const state = stateFor({ observe: false });
  const status = await inspectDirectBuyCheckout(job, state, {
    openPage: async () => checkoutPage,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => matchingCartView(),
    log: () => {},
  });
  assert.equal(status, "matched");
  assert.equal(job.addedToCart, true);
  assert.equal(job.checkoutPage, checkoutPage);
  assert.equal(state.purchaseOwner(), job.product.id);
});

test("a redirected product tab can own checkout without becoming disposable", async () => {
  const page = checkoutPreflightPage();
  const job = jobFor(page, "direct-buy");
  job.context = {};
  job.checkoutPages = new Set();
  const state = stateFor({ observe: false });
  const status = await inspectDirectBuyCheckout(job, state, {
    openPage: async () => page,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => matchingCartView(),
  });
  assert.equal(status, "matched");
  assert.equal(job.checkoutPage, page);
  assert.equal(job.redirectedCartCheckout, true);
  assert.equal(job.checkoutPages.size, 0);
});

test("direct-buy returns from a cart redirect to checkout without using the cart", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.checkoutPages = new Set();
  const checkoutPage = checkoutPreflightPage({ redirectCount: 1 });
  const status = await inspectDirectBuyCheckout(job, stateFor({ observe: false }), {
    openPage: async () => checkoutPage,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => matchingCartView(),
    log: () => {},
  });
  assert.equal(status, "matched");
  assert.equal(checkoutPage.visits(), 2);
});

test("direct-buy returns to checkout if Target redirects during cart-view read", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.checkoutPages = new Set();
  const checkoutPage = checkoutPreflightPage();
  let reads = 0;
  const status = await inspectDirectBuyCheckout(job, stateFor({ observe: false }), {
    openPage: async () => checkoutPage,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => {
      reads += 1;
      if (reads === 1) {
        checkoutPage.redirectToCart();
      }
      return matchingCartView();
    },
    log: () => {},
  });
  assert.equal(status, "matched");
  assert.equal(checkoutPage.visits(), 2);
  assert.equal(new URL(checkoutPage.url()).pathname, "/checkout");
});

test("repeated cart redirects keep returning to checkout without reading the cart", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.checkoutPages = new Set();
  const checkoutPage = checkoutPreflightPage({ redirectCount: 6 });
  const state = stateFor({ observe: false });
  assert.equal(await inspectDirectBuyCheckout(job, state, {
    openPage: async () => checkoutPage,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => matchingCartView(),
    log: () => {},
  }), "matched");
  assert.equal(checkoutPage.visits(), 7);
  assert.equal(state.purchaseOwner(), job.product.id);
});

test("matched direct-buy cart proceeds to checkout before reading the product tab", async () => {
  const productPage = fakePage({ body: "Product" });
  productPage.isClosed = () => {
    throw new Error("Product tab must not block an already matched cart.");
  };
  const job = jobFor(productPage, "direct-buy");
  job.addedToCart = true;
  job.purchaseMode = "add-to-cart";
  const state = stateFor({ observe: false });
  state.claimPurchase(job.product.id);
  let checkoutCalls = 0;
  await pollAvailability(job, state, {
    checkoutRunner: async () => {
      checkoutCalls += 1;
      return "blocked";
    },
  });
  assert.equal(checkoutCalls, 1);
  assert.equal(state.isPaused(), false);
});

test("pending direct-buy cart reconciliation proceeds to guarded checkout from exact checkout view", async () => {
  const productPage = fakePage({ body: "Product" });
  productPage.getByText = () => ({ first: () => ({ count: async () => 0 }) });
  const job = jobFor(productPage, "direct-buy");
  job.purchaseMode = "add-to-cart";
  job.pendingCartReconciliation = true;
  job.context = {};
  job.checkoutPages = new Set();
  const checkoutPage = checkoutPreflightPage({
    onClose: () => { throw new Error("Matched checkout page must remain open."); },
  });
  const state = stateFor({ observe: false });
  state.claimPurchase(job.product.id);
  let checkoutCalls = 0;
  const status = await reconcilePendingCart(job, state, {
    notify: noWait,
    checkoutPreflight: (owner, monitor) => inspectDirectBuyCheckout(owner, monitor, {
      openPage: async () => checkoutPage,
      inspectPage: async () => ({ detected: false }),
      readCartView: async () => matchingCartView(),
      log: () => {},
    }),
    checkoutRunner: async ({ page, expectedProductIds }) => {
      checkoutCalls += 1;
      assert.equal(page, checkoutPage);
      assert.deepEqual(expectedProductIds, [job.product.id]);
      return "confirmed";
    },
  });
  assert.equal(status, "confirmed");
  assert.equal(checkoutCalls, 1);
  assert.equal(job.pendingCartReconciliation, false);
  assert.equal(state.isOrderConfirmed(), true);
});

test("direct-buy preflight refuses an ambiguous checkout view without another purchase", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.context = {};
  job.checkoutPages = new Set();
  let closed = 0;
  const checkoutPage = checkoutPreflightPage({
    onClose: () => { closed += 1; },
  });
  const state = stateFor({ observe: false });
  assert.equal(await inspectDirectBuyCheckout(job, state, {
    openPage: async () => checkoutPage,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => ({
      ...matchingCartView(),
      cart_items: [{
        ...matchingCartView().cart_items[0],
        tcin: "99999999",
      }],
    }),
    log: () => {},
  }), "blocked");
  assert.equal(job.terminal, true);
  assert.equal(state.purchaseOwner(), null);
  assert.equal(closed, 1);
});

test("direct-buy preflight retains one empty checkout tab for the eventual order", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.context = {};
  job.checkoutPage = null;
  job.checkoutPages = new Set();
  let closed = 0;
  const checkoutPage = checkoutPreflightPage({
    onClose: () => { closed += 1; },
  });
  const state = stateFor({ observe: false });
  assert.equal(await inspectDirectBuyCheckout(job, state, {
    openPage: async () => checkoutPage,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => ({
      cart_items: [],
      summary: { items_quantity: 0, grand_total: 0 },
    }),
  }), "empty");
  assert.equal(closed, 0);
  assert.equal(job.checkoutPage, null);
  assert.equal(job.preflightPage, checkoutPage);
  assert.equal(job.checkoutPages.size, 1);
  assert.equal(state.purchaseOwner(), null);
});

test("watchlist reuses one checkout preflight page across empty-cart checks", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.checkoutPages = new Set();
  let created = 0;
  let closed = 0;
  const checkoutPage = checkoutPreflightPage({
    onClose: () => { closed += 1; },
  });
  job.context = {
    newPage: async () => { created += 1; return checkoutPage; },
  };
  const state = stateFor({ observe: false });
  const options = {
    retainPage: true,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => ({
      cart_items: [],
      summary: { items_quantity: 0, grand_total: 0 },
    }),
  };
  assert.equal(await inspectDirectBuyCheckout(job, state, options), "empty");
  assert.equal(await inspectDirectBuyCheckout(job, state, options), "empty");
  assert.equal(created, 1);
  assert.equal(closed, 0);
  assert.equal(job.checkoutPages.size, 1);
});

test("unreadable checkout cart view retains preflight and retries the watch", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.context = {};
  job.checkoutPages = new Set();
  let closed = 0;
  const checkoutPage = checkoutPreflightPage({
    onClose: () => { closed += 1; },
  });
  const state = stateFor({ observe: false });
  const result = await inspectDirectBuyCheckout(job, state, {
    openPage: async () => checkoutPage,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => { throw new Error("transient read failure"); },
  });
  assert.equal(result, "retry");
  assert.equal(job.terminal, false);
  assert.equal(state.shouldStop(), false);
  assert.equal(closed, 0);
  assert.equal(job.preflightPage, checkoutPage);
});

test("checkout preflight cart-view 429 cools the cart lane and keeps the watch", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.context = {};
  job.checkoutPages = new Set();
  const state = stateFor({ observe: false });
  const result = await inspectDirectBuyCheckout(job, state, {
    openPage: async () => checkoutPreflightPage(),
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => {
      const error = new Error("CHECKOUT_CART_VIEW_RATE_LIMITED");
      error.code = "CHECKOUT_CART_VIEW_RATE_LIMITED";
      error.retryAfterMs = 70000;
      throw error;
    },
  });
  assert.equal(result, "retry");
  assert.equal(state.isCartRateLimited(), true);
  assert.equal(state.isPaused(), false);
  assert.equal(job.terminal, false);
});

test("direct-buy checkout preflight retains an unsupported challenge for recovery", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.context = {};
  job.checkoutPages = new Set();
  let closed = 0;
  const checkoutPage = checkoutPreflightPage({
    onClose: () => { closed += 1; },
  });
  const state = stateFor({ observe: false });
  assert.equal(await inspectDirectBuyCheckout(job, state, {
    openPage: async () => checkoutPage,
    inspectPage: async () => ({ detected: true, kind: "generic" }),
    readCartView: async () => { throw new Error("Checkout data must not be read."); },
  }), "retry");
  assert.equal(job.terminal, false);
  assert.equal(job.preflightChallengePending, true);
  assert.equal(job.preflightPage, checkoutPage);
  assert.equal(state.purchaseOwner(), null);
  assert.equal(closed, 0);
});

test("a challenged redirected product tab remains the preflight challenge owner", async () => {
  const page = checkoutPreflightPage();
  const job = jobFor(page, "direct-buy");
  job.checkoutPages = new Set();
  const state = stateFor({ observe: false });
  const result = await inspectDirectBuyCheckout(job, state, {
    openPage: async () => page,
    inspectPage: async () => ({ detected: true, kind: "generic" }),
    retainPage: true,
  });
  assert.equal(result, "retry");
  assert.equal(job.preflightPage, page);
  assert.equal(job.preflightChallengePending, true);
  assert.equal(job.checkoutPages.size, 0);
});

test("unresolved post-click challenge preserves cart ownership", async () => {
  const page = fakePage({ body: "Product" });
  page.waitForTimeout = noWait;
  const job = jobFor(page, "add-to-cart");
  const state = stateFor({ observe: false });
  await state.enqueueMutation(() => triggerPurchase(
    job,
    state,
    "test",
    null,
    {
      label: "Add to cart",
      mode: "add-to-cart",
      button: {
        hover: noWait,
        click: async () => {
          page.state.body = "Quick verification Press & Hold";
        },
      },
    },
    {
      notify: noWait,
      challengeOptions: { solver: null },
      cartHandshake: async (_page, click) => {
        await click();
        return {
          mutation: { kind: "mutation", status: 201, retryAfterMs: 0 },
          reconciliation: null,
          rateLimited: false,
        };
      },
    },
  ));
  assert.equal(state.purchaseOwner(), job.product.id);
  assert.equal(job.pendingCartReconciliation, true);
  assert.equal(state.isPaused(), true);
});

test("checkout rejection after confirmed cart addition keeps the owner", async () => {
  const page = fakePage({ body: "Product" });
  page.waitForTimeout = noWait;
  page.getByText = () => ({ first: () => ({ count: async () => 0 }) });
  const job = jobFor(page, "add-to-cart");
  const state = stateFor({ observe: false });
  await state.enqueueMutation(() => triggerPurchase(
    job,
    state,
    "test",
    null,
    {
      label: "Add to cart",
      mode: "add-to-cart",
      button: {
        hover: noWait,
        click: async () => {
          page.state.body = "Added to cart";
        },
      },
    },
    {
      notify: noWait,
      checkoutRunner: async () => {
        throw new Error("checkout detached");
      },
      cartHandshake: async (_page, click) => {
        await click();
        return {
          mutation: { kind: "mutation", status: 201, retryAfterMs: 0 },
          reconciliation: { kind: "reconciliation", status: 200, retryAfterMs: 0 },
          rateLimited: false,
        };
      },
    },
  ));
  assert.equal(job.addedToCart, true);
  assert.equal(job.terminal, true);
  assert.equal(state.purchaseOwner(), job.product.id);
});

test("pending cart reconciliation completes before another product can act", async () => {
  const ownerPage = fakePage({ body: "Added to cart" });
  ownerPage.waitForTimeout = noWait;
  ownerPage.getByText = () => ({ first: () => ({ count: async () => 0 }) });
  const ownerJob = jobFor(ownerPage, "add-to-cart");
  ownerJob.purchaseMode = "add-to-cart";
  ownerJob.pendingCartReconciliation = true;
  const state = stateFor({ observe: false });
  state.claimPurchase(ownerJob.product.id);
  let checkoutPage;
  await state.enqueueMutation(() => reconcilePendingCart(ownerJob, state, {
    notify: noWait,
    checkoutRunner: async ({ page }) => {
      checkoutPage = page;
      return "confirmed";
    },
  }));
  assert.equal(checkoutPage, ownerJob.checkoutPage);
  assert.equal(ownerJob.pendingCartReconciliation, false);
  assert.equal(state.isOrderConfirmed(), true);
});

test("cart checkout uses a distinct prepared page and buy now uses the PDP", async () => {
  const productPage = fakePage({ body: "Product" });
  const checkoutPage = {};
  const cartJob = jobFor(productPage, "add-to-cart");
  cartJob.purchaseMode = "add-to-cart";
  cartJob.checkoutPage = checkoutPage;
  let cartPage;
  await continueCheckout(cartJob, stateFor({ observe: false }), {
    notify: noWait,
    checkoutRunner: async ({ page }) => {
      cartPage = page;
      return "confirmed";
    },
  });
  assert.equal(cartPage, checkoutPage);
  assert.notEqual(cartPage, productPage);

  const buyJob = jobFor(productPage, "buy-now");
  buyJob.purchaseMode = "buy-now";
  let buyPage;
  await continueCheckout(buyJob, stateFor({ observe: false }), {
    notify: noWait,
    checkoutRunner: async ({ page }) => {
      buyPage = page;
      return "confirmed";
    },
  });
  assert.equal(buyPage, productPage);
});

test("overnight order requires a fresh submit and rearms the product", async () => {
  const page = fakePage({ body: "Product" });
  const job = jobFor(page, "direct-buy");
  job.purchaseMode = "buy-now";
  const state = stateFor({
    observe: false,
    continueAfterOrder: true,
    repeatAfterOrder: true,
  });
  state.claimPurchase(job.product.id);
  const result = await continueCheckout(job, state, {
    notify: noWait,
    checkoutRunner: async ({ log }) => {
      log("PLACE_ORDER_CLICKED");
      return "confirmed";
    },
  });
  assert.equal(result, "confirmed");
  assert.equal(job.completed, false);
  assert.equal(job.needsRearm, true);
  assert.equal(state.purchaseOwner(), null);
  assert.equal(state.calibrationSummary().confirmedOrders.length, 1);
});

test("overnight order stops if confirmation has no new submit", async () => {
  const page = fakePage({ body: "Product" });
  const job = jobFor(page, "direct-buy");
  job.purchaseMode = "buy-now";
  const state = stateFor({
    observe: false,
    continueAfterOrder: true,
    repeatAfterOrder: true,
  });
  state.claimPurchase(job.product.id);
  const result = await continueCheckout(job, state, {
    notify: noWait,
    checkoutRunner: async () => "confirmed",
  });
  assert.equal(result, "blocked");
  assert.equal(job.terminal, true);
  assert.equal(state.shouldStop(), true);
  assert.equal(state.calibrationSummary().confirmedOrders.length, 0);
});

test("rearming clears the prior checkout before a fresh product inspection", async () => {
  const page = fakePage({ body: "Product" });
  const closed = [];
  const checkoutPage = {
    close: async () => { closed.push("checkout"); },
  };
  const job = jobFor(page, "direct-buy");
  job.needsRearm = true;
  job.addedToCart = true;
  job.purchaseMode = "add-to-cart";
  job.pendingCartReconciliation = true;
  job.checkoutPage = checkoutPage;
  const preflightPage = {
    close: async () => { closed.push("preflight"); },
  };
  job.preflightPage = preflightPage;
  job.checkoutPages = new Set([checkoutPage, preflightPage]);
  job.cartViewUrl = "https://carts.target.com/web_checkouts/v1/cart_views?key=old";
  job.submittedThisAttempt = true;
  let navigated = false;
  await rearmConfirmedJob(job, stateFor({ observe: false }), {
    navigate: async () => { navigated = true; },
  });
  assert.equal(navigated, true);
  assert.deepEqual(closed, ["checkout", "preflight"]);
  assert.equal(job.checkoutPages.size, 0);
  assert.equal(job.needsRearm, false);
  assert.equal(job.addedToCart, false);
  assert.equal(job.purchaseMode, null);
  assert.equal(job.pendingCartReconciliation, false);
  assert.equal(job.cartViewUrl, null);
  assert.equal(job.submittedThisAttempt, false);
});

test("a repeat order rearms before reading its old checkout state", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.needsRearm = true;
  job.addedToCart = true;
  job.purchaseMode = "add-to-cart";
  const calls = [];
  await pollAvailability(job, stateFor({ observe: false }), {
    rearmRunner: async () => { calls.push("rearm"); },
    checkoutRunner: async () => { calls.push("old-checkout"); },
  });
  assert.deepEqual(calls, ["rearm"]);
});

test("watchlist leaves an occupied cart untouched and keeps Buy Now monitoring possible", async () => {
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.context = {};
  job.checkoutPages = new Set();
  let closed = 0;
  const checkoutPage = checkoutPreflightPage({
    onClose: () => { closed += 1; },
  });
  const state = stateFor({ observe: false });
  const status = await inspectDirectBuyCheckout(job, state, {
    openPage: async () => checkoutPage,
    inspectPage: async () => ({ detected: false }),
    readCartView: async () => ({
      ...matchingCartView(),
      cart_items: [{ ...matchingCartView().cart_items[0], tcin: "99999999" }],
    }),
    allowOccupiedCart: true,
    log: () => {},
  });
  assert.equal(status, "occupied");
  assert.equal(job.terminal, false);
  assert.equal(state.shouldStop(), false);
  assert.equal(state.purchaseOwner(), null);
  assert.equal(closed, 1);
});

test("watchlist cart fallback skips input after an occupied-cart preflight", async () => {
  const page = fakePage({ body: "Product", controls: [] });
  page.waitForTimeout = noWait;
  const job = jobFor(page, "direct-buy");
  const state = stateFor({ observe: false });
  let clicks = 0;
  await triggerPurchase(job, state, "product page", null, {
    label: "Add to cart",
    mode: "add-to-cart",
    button: {
      hover: noWait,
      click: async () => { clicks += 1; },
    },
  }, {
    multiDirectBuy: true,
    checkoutPreflight: async () => "occupied",
    notify: noWait,
  });
  assert.equal(clicks, 0);
  assert.equal(state.purchaseOwner(), null);
  assert.equal(state.cartFallbackBlocked(), true);
  assert.equal(state.shouldStop(), false);
});

test("direct-buy checkout validates a fresh checkout cart view before submission", async () => {
  const checkoutPage = {
    url: () => "https://www.target.com/checkout",
    evaluate: async () => { throw new Error("Checkout must not use page.evaluate."); },
    context: () => ({
      request: {
        get: async (url) => {
          assert.match(url, /web_checkouts\/v1\/cart_views/);
          return { ok: () => true, json: async () => matchingCartView() };
        },
      },
    }),
  };
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.purchaseMode = "add-to-cart";
  job.addedToCart = true;
  job.checkoutPage = checkoutPage;
  job.cartViewUrl = "https://carts.target.com/web_checkouts/v1/cart_views?key=test";
  const state = stateFor({ observe: false });
  state.claimPurchase(job.product.id);
  await continueCheckout(job, state, {
    notify: noWait,
    checkoutRunner: async ({ page, evidenceReader }) => {
      assert.equal(page, checkoutPage);
      assert.deepEqual(await evidenceReader(page), {
        items: [{
          productId: job.product.id,
          quantity: 1,
          itemPriceCents: 1639,
          fulfillment: "shipping",
        }],
        orderTotalCents: 1696,
      });
      return "confirmed";
    },
  });
  assert.equal(state.isOrderConfirmed(), true);
});

test("checkout cart-view 429 retains the owner for a later checkout retry", async () => {
  const checkoutPage = {
    url: () => "https://www.target.com/checkout",
    context: () => ({
      request: {
        get: async () => ({
          ok: () => false,
          status: () => 429,
          headers: () => ({ "retry-after": "9" }),
        }),
      },
    }),
  };
  const job = jobFor(fakePage({ body: "Product" }), "direct-buy");
  job.purchaseMode = "add-to-cart";
  job.addedToCart = true;
  job.checkoutPage = checkoutPage;
  job.cartViewUrl = "https://carts.target.com/web_checkouts/v1/cart_views?key=test";
  const state = stateFor({ observe: false });
  state.claimPurchase(job.product.id);
  const result = await continueCheckout(job, state, {
    notify: noWait,
    checkoutRunner: async ({ page, evidenceReader }) => {
      await evidenceReader(page);
    },
  });
  assert.equal(result, "retry");
  assert.equal(state.isCartRateLimited(), true);
  assert.equal(state.purchaseOwner(), job.product.id);
  assert.equal(job.terminal, false);
});

test("checkout cart view treats omitted items as empty only with zero quantity", async () => {
  const cartView = async (itemsQuantity) => readCheckoutCartView({
    context: () => ({
      request: {
        get: async () => ({
          ok: () => true,
          json: async () => ({
            summary: { items_quantity: itemsQuantity, grand_total: 0 },
          }),
        }),
      },
    }),
  }, "https://carts.target.com/web_checkouts/v1/cart_views?key=test");
  assert.deepEqual((await cartView(0)).cart_items, []);
  assert.equal((await cartView(1)).cart_items, null);
});

test("checkout cart-view 429 preserves Retry-After for cart-only backoff", async () => {
  const page = {
    context: () => ({
      request: {
        get: async () => ({
          ok: () => false,
          status: () => 429,
          headers: () => ({ "retry-after": "7" }),
        }),
      },
    }),
  };
  await assert.rejects(
    () => readCheckoutCartView(page, "https://carts.target.com/web_checkouts/v1/cart_views?key=test"),
    (error) => error.code === "CHECKOUT_CART_VIEW_RATE_LIMITED" &&
      error.retryAfterMs === 7000,
  );
});

test("cart checkout creates its dedicated page lazily after cart evidence", async () => {
  const productPage = fakePage({ body: "Product" });
  const checkoutPage = {};
  const job = jobFor(productPage, "add-to-cart");
  const state = stateFor({ observe: false });
  job.purchaseMode = "add-to-cart";
  job.checkoutPage = null;
  job.context = { newPage: async () => checkoutPage };
  job.checkoutPages = new Set();
  await continueCheckout(job, state, {
    notify: noWait,
    checkoutRunner: async ({ page }) => {
      assert.equal(page, checkoutPage);
      return "confirmed";
    },
  });
  assert.equal(job.checkoutPage, checkoutPage);
  assert.equal(job.checkoutPages.has(checkoutPage), true);
});

test("cart checkout fails closed if the prepared page is not distinct", async () => {
  const page = fakePage({ body: "Product" });
  const job = jobFor(page, "preorder");
  job.purchaseMode = "preorder";
  job.checkoutPage = page;
  await assert.rejects(
    continueCheckout(job, stateFor({ observe: false }), {
      checkoutRunner: async () => "confirmed",
    }),
    /distinct checkout page/,
  );
});

test("failed resolution retains backoff and bounded attempt count", async () => {
  const state = stateFor();
  let calls = 0;
  const result = await handleChallenge(jobFor(fakePage()), state, "test", {
    solver: async () => { calls += 1; throw new Error("expected failure"); },
    maxAttempts: 2, waitFor: noWait,
  });
  assert.equal(result, "blocked");
  assert.equal(calls, 2);
  assert.equal(state.calibrationSummary().challengeSolvedCount, 0);
  assert.ok(state.remainingPauseMs() > 0);
});

test("Target watch waits for manual sign-in and resumes after the session clears", async () => {
  let inspections = 0;
  let waits = 0;
  const logs = [];
  const result = await waitForTargetSignIn(
    { isClosed: () => false },
    "A-1007918679",
    {
      inspect: async () => {
        inspections += 1;
        return inspections < 3;
      },
      waitFor: async () => { waits += 1; },
      log: (message) => logs.push(message),
    },
  );
  assert.equal(result, "resolved");
  assert.equal(waits, 2);
  assert.deepEqual(logs, [
    "TARGET_SIGN_IN_REQUIRED product=A-1007918679 - waiting for manual completion",
    "TARGET_SIGN_IN_CLEARED product=A-1007918679 - resuming",
  ]);
});

test("failed press-and-hold cycle refreshes once and resumes when refresh clears it", async () => {
  const page = fakePage();
  page.waitForTimeout = noWait;
  let reloads = 0;
  page.reload = async () => {
    reloads += 1;
    page.state.body = "Product";
    page.nodes.forEach((node) => { node.visible = false; });
  };
  const result = await handleChallenge(
    jobFor(page),
    stateFor(),
    "test",
    {
      solver: async () => {},
      maxAttempts: 3,
      settleMs: 0,
      waitFor: noWait,
      refreshAfterCycle: true,
    },
  );
  assert.equal(result, "resolved");
  assert.equal(reloads, 1);
});

test("direct-buy resets Target session after two failed challenge cycles", async () => {
  const page = fakePage();
  page.waitForTimeout = noWait;
  page.reload = async () => {};
  page.evaluate = async () => {};
  const resetContext = {
    cookies: async () => [{
      name: "target-session",
      domain: ".target.com",
      path: "/",
    }],
    clearCookies: async () => {},
    pages: () => [page],
  };
  const job = jobFor(page);
  job.context = resetContext;
  const state = stateFor({ observe: false });
  const options = {
    solver: async () => {},
    maxAttempts: 1,
    settleMs: 0,
    waitFor: noWait,
    refreshAfterCycle: false,
    resetSession: true,
  };
  assert.equal(await handleChallenge(job, state, "test", options), "blocked");
  assert.equal(await handleChallenge(job, state, "test", options), "resolved");
  assert.equal(job.challengeCycles, 0);
});
