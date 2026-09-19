const assert = require("node:assert/strict");
const test = require("node:test");
const {
  continueCheckout,
  createMonitorState,
  findPurchaseButton,
  handleChallenge,
  parseJobArgument,
  reconcilePendingCart,
  triggerPurchase,
} = require("../target-watch");
const { fakePage } = require("./helpers/target-challenge-fakes");

const noWait = async () => {};
const stateFor = (options = {}) => createMonitorState({
  observe: true, validation: false, maximumPolls: 0, runtimeMs: 0,
  log: () => {}, error: () => {}, notify: noWait, ...options,
});
const jobFor = (page, requestedMode = "add-to-cart") => ({
  page, product: { id: "A-1007918679", tcin: "1007918679", url: page.url() },
  availabilityRequest: { url: "stale" }, challengeSignal: "old", lastSummary: {},
  lastFingerprint: "old", nextNavigationAt: 123, triggered: false,
  addedToCart: false, purchaseMode: null, requestedMode, checkoutPage: {},
  completed: false, terminal: false, pendingCartReconciliation: false,
});

test("Buy now can be selected explicitly while bare URLs retain auto mode", () => {
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
});

test("cart 429 pauses the complete monitor and deduplicates listeners", () => {
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
  assert.equal(state.isPaused(), true);
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
  const firstRemaining = state.remainingPauseMs();
  assert.equal(firstRemaining, 60000);
  state.recordCartResponse(
    { kind: "cart-read", status: 429, retryAfterMs: 0, elapsedMs: 1 },
    {},
    "product-two",
  );
  assert.equal(state.remainingPauseMs(), firstRemaining);
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
  const page = fakePage({ readError: true });
  let calls = 0;
  const result = await handleChallenge(jobFor(page), stateFor(), "read failure", {
    solver: async () => { calls += 1; }, waitFor: noWait,
  });
  assert.equal(result, "blocked");
  assert.equal(calls, 0);
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
