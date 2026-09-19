const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  applyCommand,
  consumeActionAuthorization,
  createStateMutationQueue,
  createInitialState,
  getCommandError,
  isActionAuthorized,
  isValidMessage,
  reconcileStateWithTabs,
  wasActionClaimAccepted,
} = require("../extension/target-purchase/background");

const extensionDirectory = path.join(
  __dirname,
  "..",
  "extension",
  "target-purchase",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionDirectory, "manifest.json"), "utf8"),
);
const backgroundSource = fs.readFileSync(
  path.join(extensionDirectory, "background.js"),
  "utf8",
);

assert.strictEqual(manifest.manifest_version, 3);
assert.strictEqual(manifest.minimum_chrome_version, "116");
assert.strictEqual(manifest.background.service_worker, "background.js");
assert.ok(manifest.host_permissions.includes("https://www.target.com/*"));
assert.ok(
  manifest.content_scripts.some(
    (entry) =>
      entry.js.includes("content/checkout-monitor.js") &&
      entry.matches.includes("https://www.target.com/*"),
  ),
);
assert.match(backgroundSource, /importScripts\("lib\/core\.js"\)/);
assert.match(backgroundSource, /GET_TARGET_CHECKOUT_PIN/);
assert.match(backgroundSource, /SET_TARGET_CHECKOUT_PIN/);
assert.doesNotMatch(backgroundSource, /GET_SESSION_PIN|SET_SESSION_PIN/);

let state = createInitialState();
assert.strictEqual(state.config.intervalMs, 5000);
assert.strictEqual(state.checkoutTabId, null);
assert.deepStrictEqual(state.tabs, {});

assert.strictEqual(isValidMessage(null), false);
assert.strictEqual(isValidMessage({}), false);
assert.strictEqual(isValidMessage({ type: "ARM_PRODUCT" }), true);

state = applyCommand(
  state,
  {
    type: "ARM_PRODUCT",
    url: "https://www.target.com/p/pokemon-box/-/A-1010892065",
  },
  101,
  1000,
);
assert.deepStrictEqual(state.tabs["101"], {
  role: "product",
  phase: "monitoring",
  productId: "A-1010892065",
  url: "https://www.target.com/p/pokemon-box/-/A-1010892065",
  updatedAt: 1000,
});
state = applyCommand(
  state,
  {
    type: "REPORT_PRODUCT_IDENTITY",
    url: "https://www.target.com/p/pokemon-box/-/A-1010892065",
    productLabel: "Pokemon box blue",
  },
  101,
  1500,
);
assert.strictEqual(state.tabs["101"].productLabel, "pokemon box blue");

state = applyCommand(
  state,
  { type: "ARM_CHECKOUT", url: "https://www.target.com/checkout" },
  201,
  2000,
);
assert.strictEqual(state.checkoutTabId, 201);
assert.strictEqual(state.tabs["201"].role, "checkout");

state = applyCommand(
  state,
  { type: "ARM_CHECKOUT", url: "https://www.target.com/checkout" },
  202,
  3000,
);
assert.strictEqual(state.checkoutTabId, 202);
assert.strictEqual(state.tabs["201"].phase, "stopped");
assert.strictEqual(state.tabs["202"].phase, "monitoring");

state = applyCommand(
  state,
  {
    type: "REPORT_STATE",
    phase: "action-pending",
    detail: "Clicked once",
    url: "https://www.target.com/p/pokemon-box/-/A-1010892065",
  },
  101,
  4000,
);
assert.strictEqual(state.tabs["101"].phase, "action-pending");
assert.strictEqual(state.tabs["101"].detail, "Clicked once");

const unchanged = applyCommand(
  state,
  { type: "REPORT_STATE", phase: "malicious-phase" },
  101,
  5000,
);
assert.deepStrictEqual(unchanged, state);

state = applyCommand(
  state,
  { type: "SET_INTERVAL", intervalMs: 1250 },
  null,
  6000,
);
assert.strictEqual(state.config.intervalMs, 3000);

state = applyCommand(state, { type: "STOP_TAB" }, 202, 7000);
assert.strictEqual(state.tabs["202"].phase, "stopped");
assert.strictEqual(state.checkoutTabId, null);

const stoppedCheckoutState = applyCommand(
  state,
  {
    type: "REPORT_STATE",
    phase: "placing",
    url: "https://www.target.com/checkout",
  },
  202,
  7500,
);
assert.strictEqual(stoppedCheckoutState.tabs["202"].phase, "stopped");

const duplicateProductState = applyCommand(
  state,
  {
    type: "ARM_PRODUCT",
    url: "https://www.target.com/p/duplicate/-/A-1010892065",
  },
  102,
  7600,
);
assert.strictEqual(duplicateProductState.tabs["102"], undefined);
assert.match(
  getCommandError(
    state,
    {
      type: "ARM_PRODUCT",
      url: "https://www.target.com/p/duplicate/-/A-1010892065",
    },
    102,
  ),
  /already armed/i,
);

const mismatchedReportState = applyCommand(
  state,
  {
    type: "REPORT_STATE",
    phase: "added",
    url: "https://www.target.com/p/other/-/A-1010892068",
  },
  101,
  7700,
);
assert.strictEqual(mismatchedReportState.tabs["101"].phase, "action-pending");

const productClaimToken = "product-claim";
state = applyCommand(
  state,
  {
    type: "REPORT_STATE",
    phase: "monitoring",
    url: "https://www.target.com/p/pokemon-box/-/A-1010892065",
  },
  101,
  7750,
);
state = applyCommand(
  state,
  {
    type: "CLAIM_PRODUCT_ACTION",
    url: "https://www.target.com/p/pokemon-box/-/A-1010892065",
    token: productClaimToken,
  },
  101,
  7800,
);
assert.strictEqual(state.tabs["101"].phase, "action-pending");
assert.strictEqual(state.tabs["101"].actionToken, productClaimToken);
assert.strictEqual(
  isActionAuthorized(
    state,
    101,
    "product",
    productClaimToken,
    "https://www.target.com/p/pokemon-box/-/A-1010892065",
  ),
  true,
);
const reconciled = reconcileStateWithTabs(state, [
  {
    id: 101,
    url: "https://www.target.com/p/changed/-/A-1010892068",
  },
  {
    id: 202,
    url: "https://www.target.com/p/not-checkout/-/A-1010892065",
  },
]);
assert.strictEqual(reconciled.tabs["101"].phase, "stopped");
assert.strictEqual(reconciled.tabs["202"].phase, "stopped");
assert.strictEqual(reconciled.checkoutTabId, null);
const sameIdDifferentUrl = reconcileStateWithTabs(state, [
  {
    id: 101,
    url: "https://www.target.com/p/different/-/A-1010892065",
  },
  {
    id: 202,
    url: "https://www.target.com/checkout",
  },
]);
assert.strictEqual(sameIdDifferentUrl.tabs["101"].phase, "stopped");
assert.strictEqual(
  isActionAuthorized(
    state,
    101,
    "product",
    "wrong-token",
    "https://www.target.com/p/pokemon-box/-/A-1010892065",
  ),
  false,
);
assert.strictEqual(
  isActionAuthorized(
    state,
    101,
    "product",
    productClaimToken,
    "https://www.target.com/p/different/-/A-1010892065",
  ),
  false,
);

const stoppedProductState = applyCommand(state, { type: "STOP_TAB" }, 101, 7900);
const rejectedClaimState = applyCommand(
  stoppedProductState,
  {
    type: "CLAIM_PRODUCT_ACTION",
    url: "https://www.target.com/p/pokemon-box/-/A-1010892065",
    token: "late-claim",
  },
  101,
  8000,
);
assert.strictEqual(rejectedClaimState.tabs["101"].phase, "stopped");
assert.notStrictEqual(rejectedClaimState.tabs["101"].actionToken, "late-claim");

state = applyCommand(
  state,
  {
    type: "ARM_CHECKOUT",
    url: "https://www.target.com/checkout",
  },
  202,
  8050,
);
const checkoutClaimToken = "checkout-claim";
const placeOrderClaim = {
  type: "CLAIM_CHECKOUT_ACTION",
  actionType: "place-order",
  url: "https://www.target.com/checkout",
  token: checkoutClaimToken,
};
const stateBeforePlaceOrder = state;
state = applyCommand(
  state,
  placeOrderClaim,
  202,
  8100,
);
assert.strictEqual(
  wasActionClaimAccepted(
    stateBeforePlaceOrder,
    state,
    placeOrderClaim,
    202,
  ),
  true,
);
assert.strictEqual(state.tabs["202"].phase, "placing");
assert.strictEqual(state.tabs["202"].actionToken, checkoutClaimToken);
assert.strictEqual(state.tabs["202"].orderSubmittedAt, 8100);
assert.strictEqual(
  isActionAuthorized(
    state,
    202,
    "checkout",
    checkoutClaimToken,
    "https://www.target.com/checkout",
    "place-order",
  ),
  true,
);
const firstAuthorization = consumeActionAuthorization(
  state,
  202,
  "checkout",
  checkoutClaimToken,
  "https://www.target.com/checkout",
  "place-order",
);
assert.strictEqual(firstAuthorization.authorized, true);
assert.strictEqual(firstAuthorization.state.tabs["202"].actionToken, undefined);
const repeatedAuthorization = consumeActionAuthorization(
  firstAuthorization.state,
  202,
  "checkout",
  checkoutClaimToken,
  "https://www.target.com/checkout",
  "place-order",
);
assert.strictEqual(repeatedAuthorization.authorized, false);
assert.strictEqual(
  isActionAuthorized(
    state,
    202,
    "checkout",
    checkoutClaimToken,
    "https://www.target.com/p/not-checkout/-/A-1010892065",
    "place-order",
  ),
  false,
);

const replayedCheckoutClaim = applyCommand(
  state,
  placeOrderClaim,
  202,
  8200,
);
assert.deepStrictEqual(replayedCheckoutClaim, state);
assert.strictEqual(
  wasActionClaimAccepted(state, replayedCheckoutClaim, placeOrderClaim, 202),
  false,
);

state = applyCommand(
  state,
  {
    type: "CLAIM_CHECKOUT_ACTION",
    actionType: "dismiss-high-demand",
    url: "https://www.target.com/checkout",
    token: "dismiss-after-submit",
  },
  202,
  8300,
);
assert.strictEqual(state.tabs["202"].phase, "placing");
assert.strictEqual(state.tabs["202"].orderSubmittedAt, 8100);

const secondPlaceOrderClaim = applyCommand(
  state,
  {
    type: "CLAIM_CHECKOUT_ACTION",
    actionType: "place-order",
    url: "https://www.target.com/checkout",
    token: "second-place-order",
  },
  202,
  8400,
);
assert.deepStrictEqual(secondPlaceOrderClaim, state);

state = applyCommand(
  state,
  {
    type: "REPORT_STATE",
    phase: "blocked",
    detail: "Cart is empty or contains a product that was not armed.",
    url: "https://www.target.com/checkout",
  },
  202,
  8450,
);
assert.strictEqual(state.tabs["202"].phase, "placing");
state = applyCommand(
  state,
  {
    type: "CLAIM_CHECKOUT_ACTION",
    actionType: "confirm-pin",
    url: "https://www.target.com/checkout",
    token: "pin-after-submit",
  },
  202,
  8500,
);
assert.strictEqual(state.tabs["202"].phase, "placing");
assert.strictEqual(state.tabs["202"].pinConfirmedAt, 8500);
state = applyCommand(
  state,
  {
    type: "CLAIM_CHECKOUT_ACTION",
    actionType: "place-order",
    url: "https://www.target.com/checkout",
    token: "final-place-order",
  },
  202,
  8600,
);
assert.strictEqual(state.tabs["202"].finalPlaceOrderAt, 8600);
const thirdPlaceOrderClaim = applyCommand(
  state,
  {
    type: "CLAIM_CHECKOUT_ACTION",
    actionType: "place-order",
    url: "https://www.target.com/checkout",
    token: "third-place-order",
  },
  202,
  8700,
);
assert.deepStrictEqual(thirdPlaceOrderClaim, state);

state = applyCommand(state, { type: "STOP_ALL" }, null, 8000);
assert.ok(Object.values(state.tabs).every((tab) => tab.phase === "stopped"));

(async () => {
  let storedState = createInitialState();
  const mutate = createStateMutationQueue(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return storedState;
    },
    async (next) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      storedState = next;
    },
  );

  await Promise.all([
    mutate((current) =>
      applyCommand(
        current,
        {
          type: "ARM_PRODUCT",
          url: "https://www.target.com/p/one/-/A-1010892065",
        },
        301,
        9000,
      ),
    ),
    mutate((current) =>
      applyCommand(
        current,
        {
          type: "ARM_PRODUCT",
          url: "https://www.target.com/p/two/-/A-1010892068",
        },
        302,
        9001,
      ),
    ),
  ]);

  assert.strictEqual(storedState.tabs["301"].productId, "A-1010892065");
  assert.strictEqual(storedState.tabs["302"].productId, "A-1010892068");
  console.log("target-extension-background tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
