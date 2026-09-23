const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createWatchlistOutcomeTracker,
  recoverAmbiguousWatchlistOrder,
} = require("../target-watchlist-buy");

test("watchlist tracks only the winning product and one submission time", () => {
  const tracker = createWatchlistOutcomeTracker({
    now: () => "2026-09-23T06:29:24.000Z",
  });
  tracker.onLine("info", "PLACE_ORDER_CLICKED");
  tracker.onLine("info", 'TARGET_CALIBRATION_SUMMARY {"purchaseOwner":"A-90172677"}');
  tracker.onLine("error", 'TARGET_TERMINAL_SAFETY_STOP {"reason":"ambiguous-place-order-outcome"}');
  assert.deepEqual(tracker.snapshot(), {
    productId: "A-90172677",
    submittedAt: "2026-09-23T06:29:24.000Z",
    ambiguous: true,
  });
});

test("watchlist history recovery never runs before a Place-order click", async () => {
  const tracker = createWatchlistOutcomeTracker();
  tracker.onLine("info", 'TARGET_CALIBRATION_SUMMARY {"purchaseOwner":"A-90172677"}');
  tracker.onLine("error", 'TARGET_TERMINAL_SAFETY_STOP {"reason":"ambiguous-place-order-outcome"}');
  let checks = 0;
  const result = await recoverAmbiguousWatchlistOrder(tracker.snapshot(), {
    confirm: async () => { checks += 1; return "confirmed"; },
  });
  assert.equal(result, "unknown");
  assert.equal(checks, 0);
});

test("watchlist history recovery checks exact winner after an ambiguous click", async () => {
  const tracker = createWatchlistOutcomeTracker({
    now: () => "2026-09-23T06:29:24.000Z",
  });
  tracker.onLine("info", "PLACE_ORDER_CLICKED");
  tracker.onLine("info", 'TARGET_CALIBRATION_SUMMARY {"purchaseOwner":"A-90172677"}');
  tracker.onLine("error", 'TARGET_TERMINAL_SAFETY_STOP {"reason":"ambiguous-place-order-outcome"}');
  const result = await recoverAmbiguousWatchlistOrder(tracker.snapshot(), {
    confirm: async ({ productId, submittedAt }) => {
      assert.equal(productId, "A-90172677");
      assert.equal(submittedAt, "2026-09-23T06:29:24.000Z");
      return "confirmed";
    },
  });
  assert.equal(result, "confirmed");
});

test("confirmed order clears the pending submission before another order cycle", () => {
  const tracker = createWatchlistOutcomeTracker({
    now: () => "2026-09-23T08:30:00.000Z",
  });
  tracker.onLine("info", "PLACE_ORDER_FOUND after 0 refreshes");
  assert.equal(tracker.snapshot().submittedAt, "2026-09-23T08:30:00.000Z");
  tracker.onLine(
    "info",
    'TARGET_ORDER_CONFIRMED {"productId":"A-1010892076","mode":"buy-now"}',
  );
  assert.equal(tracker.snapshot().submittedAt, null);
  tracker.onLine("info", "PLACE_ORDER_FOUND after 0 refreshes");
  assert.equal(tracker.snapshot().submittedAt, "2026-09-23T08:30:00.000Z");
});
