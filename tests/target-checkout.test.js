const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const {
  cartResponseKind,
  classifyCheckoutSnapshot,
  createCheckoutProgress,
  isOrderConfirmed,
  observeCartHandshake,
  paymentSetupPattern,
  parseLabeledCurrencyCents,
  parseRetryAfterMs,
  parseUnambiguousCurrencyCents,
  readPurchaseGuardConfig,
  runTargetCheckout,
  validatePdpIdentity,
  validatePurchaseEvidence,
  validateExpectedCart,
} = require("../target-checkout");

function snapshot(overrides = {}) {
  return {
    verificationVisible: false,
    confirmed: false,
    pinReady: false,
    highDemandReady: false,
    saveContinueReady: false,
    placeOrderReady: false,
    onCartPage: false,
    priceVisible: false,
    ...overrides,
  };
}

test("checkout state priority preserves verification and transition ordering", () => {
  assert.equal(
    classifyCheckoutSnapshot(snapshot({ verificationVisible: true, placeOrderReady: true })),
    "verification",
  );
  assert.equal(classifyCheckoutSnapshot(snapshot({ confirmed: true })), "confirmed");
  assert.equal(
    classifyCheckoutSnapshot(snapshot({ safetyStop: "sign-in-required" })),
    "sign-in-required",
  );
  assert.equal(
    classifyCheckoutSnapshot(snapshot({ pinReady: true, highDemandReady: true })),
    "high-demand",
  );
  assert.equal(
    classifyCheckoutSnapshot(snapshot({ highDemandReady: true, saveContinueReady: true })),
    "high-demand",
  );
  assert.equal(
    classifyCheckoutSnapshot(snapshot({ saveContinueReady: true, pinReady: true })),
    "save-continue",
  );
  assert.equal(classifyCheckoutSnapshot(snapshot({ pinReady: true })), "pin");
  assert.equal(classifyCheckoutSnapshot(snapshot({ placeOrderReady: true })), "place-order");
  assert.equal(classifyCheckoutSnapshot(snapshot({ onCartPage: true })), "go-checkout");
  assert.equal(classifyCheckoutSnapshot(snapshot({ priceVisible: true })), "wait-loaded");
  assert.equal(classifyCheckoutSnapshot(snapshot()), "reload");
});

test("unexpected payment setup copy is recognized without matching a saved method", () => {
  assert.equal(paymentSetupPattern.test("Add a payment method to continue"), true);
  assert.equal(paymentSetupPattern.test("Payment method Visa ending in 1234"), false);
});

test("checkout progress records transitions, stalls, recovery, and submission", () => {
  let now = 0;
  const progress = createCheckoutProgress({
    now: () => now,
    stateTimeoutMs: 1000,
    maximumRecoveries: 1,
  });
  assert.equal(progress.observe("reload").transition, true);
  now = 1000;
  assert.equal(progress.observe("reload").stalled, true);
  assert.equal(progress.markRecovery(), true);
  assert.equal(progress.markRecovery(), false);
  progress.markSubmission();
  assert.equal(progress.snapshot().submissionMayHaveOccurred, true);
  assert.equal(progress.observe("place-order").previousState, "reload");
});

test("order confirmation requires explicit URL or text evidence", () => {
  assert.equal(isOrderConfirmed("https://www.target.com/checkout", "Place your order"), false);
  assert.equal(
    isOrderConfirmed("https://www.target.com/order-confirmation?referenceId=1", "Loading"),
    true,
  );
  assert.equal(isOrderConfirmed("https://www.target.com/checkout", "Thank you for your order"), true);
});

test("cart endpoint and Retry-After parsing are deterministic", () => {
  assert.equal(
    cartResponseKind("https://carts.target.com/web_checkouts/v1/cart_items"),
    "mutation",
  );
  assert.equal(
    cartResponseKind("https://carts.target.com/web_checkouts/v1/cart?cart_type=REGULAR&client_feature=add_to_cart"),
    "reconciliation",
  );
  assert.equal(
    cartResponseKind("https://carts.target.com/web_checkouts/v1/cart?cart_type=REGULAR"),
    "cart-read",
  );
  assert.equal(cartResponseKind("https://www.target.com/p/example"), null);
  assert.equal(parseRetryAfterMs("12"), 12000);
  assert.equal(
    parseRetryAfterMs("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("2026-01-01T00:00:00Z")),
    10000,
  );
  assert.equal(parseRetryAfterMs("invalid"), 0);
});

test("cart handshake records mutation and reconciliation without blind waiting", async () => {
  const page = new EventEmitter();
  const response = (url, status, headers = {}) => ({
    url: () => url,
    status: () => status,
    headers: () => headers,
  });
  const logs = [];
  const result = await observeCartHandshake(
    page,
    async () => {
      page.emit(
        "response",
        response("https://carts.target.com/web_checkouts/v1/cart_items", 201),
      );
      page.emit(
        "response",
        response("https://carts.target.com/web_checkouts/v1/cart?cart_type=REGULAR&client_feature=add_to_cart", 200),
      );
    },
    { timeoutMs: 100, log: (message) => logs.push(message) },
  );
  assert.equal(result.mutation.status, 201);
  assert.equal(result.reconciliation.status, 200);
  assert.equal(result.rateLimited, false);
  assert.ok(logs.some((message) => message.startsWith("TARGET_CART_HANDSHAKE ")));
});

test("cart handshake surfaces 429 and Retry-After", async () => {
  const page = new EventEmitter();
  const result = await observeCartHandshake(
    page,
    async () => {
      page.emit("response", {
        url: () => "https://carts.target.com/web_checkouts/v1/cart?client_feature=add_to_cart",
        status: () => 429,
        headers: () => ({ "retry-after": "7" }),
      });
    },
    { timeoutMs: 100, log: () => {} },
  );
  assert.equal(result.rateLimited, true);
  assert.equal(result.reconciliation.retryAfterMs, 7000);
});

test("checkout obeys the shared 429 circuit breaker before acting", async () => {
  const logs = [];
  const result = await runTargetCheckout({
    page: {
      url: () => "https://www.target.com/checkout",
      isClosed: () => false,
    },
    shouldPause: () => true,
    log: (message) => logs.push(message),
  });
  assert.equal(result, "blocked");
  assert.deepEqual(logs, ["CHECKOUT_PAUSED_BY_GLOBAL_CIRCUIT_BREAKER"]);
});

test("cart validation accepts only expected products with quantity one", () => {
  assert.equal(
    validateExpectedCart(
      {
        bodyText: "Checkout",
        hrefs: [],
        cartRows: [{ productId: "A-1007918679", quantity: 1 }],
      },
      ["A-1007918679"],
    ),
    true,
  );
  assert.equal(
    validateExpectedCart(
      {
        bodyText: "Checkout",
        hrefs: [],
        cartRows: [{ productId: "A-1007918679", quantity: 2 }],
      },
      ["A-1007918679"],
    ),
    false,
  );
  assert.equal(
    validateExpectedCart(
      {
        bodyText: "Checkout",
        hrefs: [],
        cartRows: [{ productId: "A-9999999999", quantity: 1 }],
      },
      ["A-1007918679"],
    ),
    false,
  );
});

test("purchase guard parsing handles currency and optional limits", () => {
  assert.equal(parseUnambiguousCurrencyCents("$1,234.56"), 123456);
  assert.equal(parseUnambiguousCurrencyCents("$19.99 $29.99"), null);
  assert.equal(
    parseLabeledCurrencyCents(
      "Subtotal $20.00\nOrder total $24.50",
      /order total/i,
    ),
    2450,
  );
  assert.deepEqual(
    readPurchaseGuardConfig({
      TARGET_MAX_ITEM_PRICE: "49.99",
      TARGET_MAX_ORDER_TOTAL: "60",
      TARGET_EXPECTED_FULFILLMENT: "shipping",
    }),
    {
      expectedFulfillment: "shipping",
      maxItemPriceCents: 4999,
      maxOrderTotalCents: 6000,
    },
  );
  assert.deepEqual(
    readPurchaseGuardConfig({}, { required: false }),
    {
      expectedFulfillment: null,
      maxItemPriceCents: null,
      maxOrderTotalCents: null,
    },
  );
  assert.throws(
    () => readPurchaseGuardConfig({ TARGET_MAX_ITEM_PRICE: "49.99" }),
    /TARGET_MAX_ORDER_TOTAL/,
  );
});

test("purchase validation requires one exact guarded item", () => {
  const config = {
    expectedProductId: "A-1007918679",
    expectedFulfillment: "shipping",
    maxItemPriceCents: 5000,
    maxOrderTotalCents: 6000,
  };
  const valid = {
    items: [{
      productId: "A-1007918679",
      quantity: 1,
      fulfillment: "shipping",
      itemPriceCents: 4999,
    }],
    orderTotalCents: 5500,
  };
  assert.equal(validatePurchaseEvidence(valid, config).ok, true);
  assert.equal(
    validatePurchaseEvidence(valid, {
      expectedProductId: "A-1007918679",
      expectedFulfillment: "shipping",
    }).ok,
    true,
  );
  for (const evidence of [
    { ...valid, items: [] },
    { ...valid, items: [valid.items[0], { ...valid.items[0] }] },
    { ...valid, items: [{ ...valid.items[0], productId: null }] },
    { ...valid, items: [{ ...valid.items[0], productId: "A-9999999999" }] },
    { ...valid, items: [{ ...valid.items[0], quantity: 2 }] },
    { ...valid, items: [{ ...valid.items[0], fulfillment: null }] },
    { ...valid, items: [{ ...valid.items[0], fulfillment: "pickup" }] },
    { ...valid, items: [{ ...valid.items[0], itemPriceCents: null }] },
    { ...valid, items: [{ ...valid.items[0], itemPriceCents: 5001 }] },
    { ...valid, orderTotalCents: null },
    { ...valid, orderTotalCents: 6001 },
  ]) {
    assert.equal(validatePurchaseEvidence(evidence, config).ok, false);
  }
  assert.equal(
    validatePdpIdentity(
      "https://www.target.com/p/example/-/A-1007918679",
      "A-1007918679",
    ),
    true,
  );
});

function checkoutPage({
  url = "https://www.target.com/checkout",
  onWait = () => {},
  onReload = () => {},
  isClosed = () => false,
} = {}) {
  return {
    url: () => url,
    isClosed,
    waitForLoadState: async () => {},
    waitForTimeout: async (ms) => onWait(ms),
    goto: async () => {},
    reload: async () => onReload(),
  };
}

function placeOrderSnapshot(click) {
  return {
    state: "place-order",
    controls: { placeOrder: { click } },
  };
}

const validEvidence = {
  items: [{
    productId: "A-1007918679",
    quantity: 1,
    fulfillment: "shipping",
    itemPriceCents: 4999,
  }],
  orderTotalCents: 5500,
};
const guardConfig = {
  expectedFulfillment: "shipping",
  maxItemPriceCents: 5000,
  maxOrderTotalCents: 6000,
};

test("stop-before-submit validates and returns without clicking", async () => {
  let clicks = 0;
  const logs = [];
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    stopBeforeSubmit: true,
    snapshotReader: async () => placeOrderSnapshot(async () => {
      clicks += 1;
    }),
    evidenceReader: async () => validEvidence,
    log: (message) => logs.push(message),
  });
  assert.equal(result, "ready-to-submit");
  assert.equal(clicks, 0);
  assert.ok(logs.some((message) => message.startsWith("TARGET_PURCHASE_VALIDATION ")));
  assert.ok(logs.includes("TARGET_READY_TO_SUBMIT_STOPPED"));
});

test("place-order click is attempted once and a repeated control is ambiguous", async () => {
  let clicks = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    snapshotReader: async () => placeOrderSnapshot(async () => {
      clicks += 1;
    }),
    evidenceReader: async () => validEvidence,
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "ambiguous");
  assert.equal(clicks, 1);
});

test("place-order click errors stop as ambiguous without retry", async () => {
  let attempts = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    snapshotReader: async () => placeOrderSnapshot(async () => {
      attempts += 1;
      throw new Error("navigation interrupted");
    }),
    evidenceReader: async () => validEvidence,
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "ambiguous");
  assert.equal(attempts, 1);
});

test("page closure immediately after Place order is ambiguous", async () => {
  let closed = false;
  let clicks = 0;
  const result = await runTargetCheckout({
    page: checkoutPage({ isClosed: () => closed }),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    snapshotReader: async () => placeOrderSnapshot(async () => {
      clicks += 1;
      closed = true;
    }),
    evidenceReader: async () => validEvidence,
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "ambiguous");
  assert.equal(clicks, 1);
});

test("snapshot failure immediately after Place order is ambiguous", async () => {
  let clicks = 0;
  let reads = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    snapshotReader: async () => {
      reads += 1;
      if (reads > 1) {
        throw new Error("page detached");
      }
      return placeOrderSnapshot(async () => {
        clicks += 1;
      });
    },
    evidenceReader: async () => validEvidence,
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "ambiguous");
  assert.equal(clicks, 1);
});

test("shared pause after the post-submit snapshot is ambiguous", async () => {
  let clicks = 0;
  let submitted = false;
  let postSubmitChecks = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    shouldPause: () => {
      if (!submitted) {
        return false;
      }
      postSubmitChecks += 1;
      return postSubmitChecks === 2;
    },
    snapshotReader: async () => placeOrderSnapshot(async () => {
      clicks += 1;
      submitted = true;
    }),
    evidenceReader: async () => validEvidence,
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "ambiguous");
  assert.equal(clicks, 1);
});

test("reappearing post-submit verification becomes ambiguous", async () => {
  let clicks = 0;
  let reads = 0;
  let verificationCalls = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    handleVerification: async () => {
      verificationCalls += 1;
      return "resolved";
    },
    snapshotReader: async () => {
      reads += 1;
      return reads === 1
        ? placeOrderSnapshot(async () => { clicks += 1; })
        : { state: "verification", controls: {} };
    },
    evidenceReader: async () => validEvidence,
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "ambiguous");
  assert.equal(clicks, 1);
  assert.equal(verificationCalls, 7);
});

test("post-submit verification exception becomes ambiguous", async () => {
  let clicks = 0;
  let reads = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    handleVerification: async () => {
      throw new Error("verification detached");
    },
    snapshotReader: async () => {
      reads += 1;
      return reads === 1
        ? placeOrderSnapshot(async () => { clicks += 1; })
        : { state: "verification", controls: {} };
    },
    evidenceReader: async () => validEvidence,
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "ambiguous");
  assert.equal(clicks, 1);
});

test("post-snapshot wait failure after Place order is ambiguous", async () => {
  let clicks = 0;
  let reads = 0;
  let waits = 0;
  const result = await runTargetCheckout({
    page: checkoutPage({
      onWait: () => {
        waits += 1;
        if (waits === 2) {
          throw new Error("page wait failed");
        }
      },
    }),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    snapshotReader: async () => {
      reads += 1;
      return reads === 1
        ? placeOrderSnapshot(async () => { clicks += 1; })
        : { state: "wait-loaded", controls: {} };
    },
    evidenceReader: async () => validEvidence,
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "ambiguous");
  assert.equal(clicks, 1);
});

for (const scenario of [
  {
    name: "repeated PIN",
    buyNow: false,
    targetPin: "0000",
    state: "pin",
    controls: {
      pinInput: { fill: async () => {} },
      pinConfirm: { click: async () => {} },
    },
  },
  {
    name: "repeated high-demand",
    buyNow: false,
    state: "high-demand",
    controls: { highDemandOk: { click: async () => {} } },
  },
  {
    name: "repeated Save and continue",
    buyNow: false,
    state: "save-continue",
    controls: { saveContinue: { click: async () => {} } },
  },
  {
    name: "Buy-now cart redirect",
    buyNow: true,
    state: "go-checkout",
    controls: {},
  },
]) {
  test(`post-submit ${scenario.name} blocked result normalizes to ambiguous`, async () => {
    let clicks = 0;
    let reads = 0;
    const result = await runTargetCheckout({
      page: checkoutPage(),
      expectedProductIds: ["A-1007918679"],
      purchaseGuardConfig: guardConfig,
      buyNow: scenario.buyNow,
      targetPin: scenario.targetPin,
      snapshotReader: async () => {
        reads += 1;
        return reads === 1
          ? placeOrderSnapshot(async () => { clicks += 1; })
          : { state: scenario.state, controls: scenario.controls };
      },
      evidenceReader: async () => validEvidence,
      log: () => {},
      error: () => {},
    });
    assert.equal(result, "ambiguous");
    assert.equal(clicks, 1);
  });
}

test("explicit confirmation after one submission completes without a second click", async () => {
  let clicks = 0;
  let reads = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    snapshotReader: async () => {
      reads += 1;
      return reads === 1
        ? placeOrderSnapshot(async () => {
          clicks += 1;
        })
        : { state: "confirmed", controls: {} };
    },
    evidenceReader: async () => validEvidence,
    log: () => {},
  });
  assert.equal(result, "confirmed");
  assert.equal(clicks, 1);
});

test("invalid purchase evidence blocks submission", async () => {
  let clicks = 0;
  await assert.rejects(
    runTargetCheckout({
      page: checkoutPage(),
      expectedProductIds: ["A-1007918679"],
      purchaseGuardConfig: guardConfig,
      snapshotReader: async () => placeOrderSnapshot(async () => {
        clicks += 1;
      }),
      evidenceReader: async () => ({
        ...validEvidence,
        items: [{ ...validEvidence.items[0], quantity: 2 }],
      }),
      log: () => {},
    }),
    /PURCHASE_VALIDATION_FAILED quantity/,
  );
  assert.equal(clicks, 0);
});

test("buy-now panel opening is bounded and returns a safe retry before submission", async () => {
  let now = 0;
  const result = await runTargetCheckout({
    page: checkoutPage({ onWait: (ms) => { now += ms; } }),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    buyNow: true,
    now: () => now,
    stateTimeoutMs: 500,
    snapshotReader: async () => ({ state: "reload", controls: {} }),
    log: () => {},
  });
  assert.equal(result, "retry");
});

test("a buy-now panel that disappears stops instead of replaying Buy now", async () => {
  let now = 0;
  let reads = 0;
  const result = await runTargetCheckout({
    page: checkoutPage({ onWait: (ms) => { now += ms; } }),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    buyNow: true,
    now: () => now,
    stateTimeoutMs: 500,
    snapshotReader: async () => {
      reads += 1;
      return reads === 1
        ? {
          state: "wait-loaded",
          buyNowPanelVisible: true,
          controls: {},
        }
        : { state: "reload", buyNowPanelVisible: false, controls: {} };
    },
    log: () => {},
  });
  assert.equal(result, "blocked");
});

test("replaced non-submit controls are reacquired on the next snapshot", async () => {
  let reads = 0;
  let attempts = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    snapshotReader: async () => {
      reads += 1;
      if (reads <= 2) {
        return {
          state: "high-demand",
          controls: {
            highDemandOk: {
              click: async () => {
                attempts += 1;
                if (attempts === 1) {
                  throw new Error("detached");
                }
              },
            },
          },
        };
      }
      return { state: "confirmed", controls: {} };
    },
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "confirmed");
  assert.equal(attempts, 2);
});

test("account, payment, unavailable, and empty-cart states stop without acting", async () => {
  for (const state of [
    "sign-in-required",
    "payment-setup-required",
    "item-unavailable",
    "empty-cart",
  ]) {
    const result = await runTargetCheckout({
      page: checkoutPage(),
      expectedProductIds: ["A-1007918679"],
      purchaseGuardConfig: guardConfig,
      snapshotReader: async () => ({ state, controls: {} }),
      log: () => {},
    });
    assert.equal(result, "blocked");
  }
});

test("reappearing shipping and PIN states remain bounded and preserve ordering", async () => {
  const states = ["save-continue", "save-continue", "pin", "place-order"];
  let saveClicks = 0;
  let pinFills = 0;
  let pinClicks = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    targetPin: "0000",
    stopBeforeSubmit: true,
    snapshotReader: async () => {
      const state = states.shift();
      if (state === "save-continue") {
        return {
          state,
          controls: {
            saveContinue: { click: async () => { saveClicks += 1; } },
          },
        };
      }
      if (state === "pin") {
        return {
          state,
          controls: {
            pinInput: { fill: async () => { pinFills += 1; } },
            pinConfirm: { click: async () => { pinClicks += 1; } },
          },
        };
      }
      return placeOrderSnapshot(async () => {
        throw new Error("must not click");
      });
    },
    evidenceReader: async () => validEvidence,
    log: () => {},
  });
  assert.equal(result, "ready-to-submit");
  assert.equal(saveClicks, 2);
  assert.equal(pinFills, 1);
  assert.equal(pinClicks, 1);
});

test("an unchanged actionable state stops after its bounded retry count", async () => {
  let clicks = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    snapshotReader: async () => ({
      state: "high-demand",
      controls: {
        highDemandOk: {
          click: async () => {
            clicks += 1;
          },
        },
      },
    }),
    log: () => {},
  });
  assert.equal(result, "blocked");
  assert.equal(clicks, 3);
});

test("verification resumes the exact pre-submission checkout sequence", async () => {
  const states = [
    "verification",
    "high-demand",
    "verification",
    "save-continue",
    "verification",
    "pin",
    "verification",
    "place-order",
  ];
  let verifications = 0;
  let highDemandClicks = 0;
  let saveClicks = 0;
  let pinClicks = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    targetPin: "0000",
    stopBeforeSubmit: true,
    handleVerification: async () => {
      verifications += 1;
      return "resolved";
    },
    snapshotReader: async () => {
      const state = states.shift();
      if (state === "high-demand") {
        return {
          state,
          controls: {
            highDemandOk: {
              click: async () => { highDemandClicks += 1; },
            },
          },
        };
      }
      if (state === "save-continue") {
        return {
          state,
          controls: {
            saveContinue: { click: async () => { saveClicks += 1; } },
          },
        };
      }
      if (state === "pin") {
        return {
          state,
          controls: {
            pinInput: { fill: async () => {} },
            pinConfirm: { click: async () => { pinClicks += 1; } },
          },
        };
      }
      if (state === "place-order") {
        return placeOrderSnapshot(async () => {
          throw new Error("must not click");
        });
      }
      return { state, controls: {} };
    },
    evidenceReader: async () => validEvidence,
    log: () => {},
  });
  assert.equal(result, "ready-to-submit");
  assert.equal(verifications, 4);
  assert.equal(highDemandClicks, 1);
  assert.equal(saveClicks, 1);
  assert.equal(pinClicks, 1);
});

test("post-submit verification can resolve but cannot cause a second order click", async () => {
  const states = ["place-order", "verification", "confirmed"];
  let clicks = 0;
  let verifications = 0;
  const result = await runTargetCheckout({
    page: checkoutPage(),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    handleVerification: async () => {
      verifications += 1;
      return "resolved";
    },
    snapshotReader: async () => {
      const state = states.shift();
      return state === "place-order"
        ? placeOrderSnapshot(async () => { clicks += 1; })
        : { state, controls: {} };
    },
    evidenceReader: async () => validEvidence,
    log: () => {},
  });
  assert.equal(result, "confirmed");
  assert.equal(clicks, 1);
  assert.equal(verifications, 1);
});

test("unchanged loaded checkout performs bounded recovery then stops", async () => {
  let now = 0;
  let reloads = 0;
  const result = await runTargetCheckout({
    page: checkoutPage({
      onWait: (ms) => { now += ms; },
      onReload: () => { reloads += 1; },
    }),
    expectedProductIds: ["A-1007918679"],
    purchaseGuardConfig: guardConfig,
    now: () => now,
    stateTimeoutMs: 500,
    maximumRecoveries: 1,
    snapshotReader: async () => ({ state: "wait-loaded", controls: {} }),
    log: () => {},
    error: () => {},
  });
  assert.equal(result, "blocked");
  assert.equal(reloads, 1);
});
