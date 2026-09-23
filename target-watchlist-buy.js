const fs = require("node:fs");
const path = require("node:path");
const { createCatalogStore } = require("./src/deals-catalog");
const { createSecretStore } = require("./src/deals-secrets");
const { ensureChromeCdp } = require("./src/chrome-cdp");
const { createTargetRunLogger } = require("./src/target-run-log");
const {
  prepareWatchlistRun,
  resolveWatchlistEntries,
} = require("./src/target-watchlist");
const {
  confirmTargetOrder,
  readTargetOrderHistory,
} = require("./src/target-order-history");
const { executeTargetBuyWorker } = require("./target-direct-buy");

const watchlistPath = path.join(__dirname, "data", "target-watchlist.json");
const catalogPath = path.join(__dirname, "data", "deals.json");
const secretPath = path.join(__dirname, "data", "deals-secrets.local.json");

function createWatchlistOutcomeTracker({
  now = () => new Date().toISOString(),
} = {}) {
  let productId = null;
  let submittedAt = null;
  let ambiguous = false;
  return {
    onLine(_level, line) {
      // PLACE_ORDER_FOUND is emitted before input. Treat a worker crash
      // anywhere after it as an uncertain submission until Orders resolves it.
      if (line.startsWith("PLACE_ORDER_FOUND ") || line === "PLACE_ORDER_CLICKED") {
        submittedAt = now();
      }
      if (line.startsWith("TARGET_ORDER_CONFIRMED ")) {
        // The next Place-order event belongs to a new transaction.
        submittedAt = null;
        ambiguous = false;
        productId = null;
      }
      if (line.startsWith("TARGET_CALIBRATION_SUMMARY ")) {
        try {
          const summary = JSON.parse(
            line.slice("TARGET_CALIBRATION_SUMMARY ".length),
          );
          productId = /^A-\d{7,}$/.test(summary.purchaseOwner || "")
            ? summary.purchaseOwner
            : null;
        } catch (error) {
          // Incomplete telemetry cannot supply a purchase identity.
        }
      }
      if (line.startsWith("TARGET_TERMINAL_SAFETY_STOP ")) {
        try {
          const stop = JSON.parse(
            line.slice("TARGET_TERMINAL_SAFETY_STOP ".length),
          );
          ambiguous = stop.reason === "ambiguous-place-order-outcome";
        } catch (error) {
          // A malformed stop record cannot authorize another submission.
        }
      }
    },
    snapshot() {
      return { productId, submittedAt, ambiguous };
    },
  };
}

async function recoverAmbiguousWatchlistOrder(snapshot, {
  confirm,
} = {}) {
  if (
    !snapshot?.ambiguous ||
    !/^A-\d{7,}$/.test(snapshot.productId || "") ||
    !Number.isFinite(Date.parse(snapshot.submittedAt))
  ) {
    return "unknown";
  }
  return confirm({
    productId: snapshot.productId,
    submittedAt: snapshot.submittedAt,
  });
}

async function main() {
  const config = JSON.parse(fs.readFileSync(watchlistPath, "utf8"));
  const entries = await resolveWatchlistEntries(config.products);
  const catalog = await createCatalogStore(catalogPath).read();
  const secrets = await createSecretStore(secretPath).getAll();
  const prepared = prepareWatchlistRun({
    entries,
    settings: catalog.settings.target,
    secrets,
  });
  const logger = createTargetRunLogger({
    workflow: "target-watchlist-buy",
    metadata: { productCount: entries.length, quantity: 1 },
  });
  console.log(`TARGET_LOG_FILE ${logger.fileUrl}`);
  logger.write("info", ["TARGET_WATCHLIST_INPUT_ACCEPTED"], "TARGET_WATCHLIST_INPUT_ACCEPTED");
  console.log(`TARGET_WATCHLIST_INPUT_ACCEPTED products=${entries.length}`);

  const cdp = await ensureChromeCdp();
  logger.write("info", [cdp.started ? "TARGET_CDP_READY" : "TARGET_CDP_REUSED"]);
  console.log(cdp.started ? "TARGET_CDP_READY" : "TARGET_CDP_REUSED");
  const started =
    `TARGET_WATCHLIST_STARTED products=${entries.length} repeatConfirmedOrders=true maxItemPrice=${prepared.effectiveSettings.maxItemPrice} maxOrderTotal=${prepared.effectiveSettings.maxOrderTotal}`;
  logger.write("info", [started], "TARGET_WATCHLIST_STARTED");
  console.log(started);

  let failedCycles = 0;
  while (true) {
    const tracker = createWatchlistOutcomeTracker();
    try {
      await executeTargetBuyWorker(prepared.run, logger, {
        onLine: tracker.onLine,
      });
      failedCycles = 0;
    } catch (workerError) {
      const snapshot = tracker.snapshot();
      if (snapshot.submittedAt) {
        if (!snapshot.productId) {
          throw new Error("TARGET_WATCHLIST_OUTCOME_UNCONFIRMED");
        }
        // A crash or stop after PLACE_ORDER_FOUND may follow a real click.
        // Check Orders for this exact product before admitting another worker.
        const driver = prepared.run.env.TARGET_BROWSER_DRIVER === "playwright"
          ? "playwright-core"
          : "patchright";
        const { chromium } = require(driver);
        const browser = await chromium.connectOverCDP(
          "http://127.0.0.1:9444",
          { timeout: 5000 },
        );
        let outcome;
        try {
          const context = browser.contexts()[0];
          if (!context) {
            throw new Error("Target order verification has no Chrome context.");
          }
          outcome = await recoverAmbiguousWatchlistOrder(
            { ...snapshot, ambiguous: true },
            {
              confirm: (input) => confirmTargetOrder({
                ...input,
                readHistory: () => readTargetOrderHistory(context),
              }),
            },
          );
        } finally {
          await browser.close().catch(() => {});
        }
        if (outcome !== "confirmed") {
          const status = outcome === "ambiguous"
            ? "TARGET_WATCHLIST_HISTORY_AMBIGUOUS"
            : "TARGET_WATCHLIST_OUTCOME_UNCONFIRMED";
          logger.write("error", [status], status);
          throw new Error(status);
        }
        const confirmed = `TARGET_ORDER_CONFIRMED_HISTORY product=${snapshot.productId} quantity=1`;
        logger.write("info", [confirmed], "TARGET_ORDER_CONFIRMED_HISTORY");
        console.log(confirmed);
        failedCycles = 0;
      } else {
        // No Place-order input was pending. Retain the same purchase mutex
        // and retry the worker after backoff; checkout may have been transient.
        failedCycles += 1;
      }
    }
    const delayMs = failedCycles
      ? Math.min(60000, 15000 * 2 ** Math.min(failedCycles - 1, 2))
      : 5000;
    const retry = `TARGET_WATCHLIST_RESTARTING delayMs=${delayMs} failedCycles=${failedCycles}`;
    logger.write("info", [retry], "TARGET_WATCHLIST_RESTARTING");
    console.log(retry);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await ensureChromeCdp();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createWatchlistOutcomeTracker,
  main,
  recoverAmbiguousWatchlistOrder,
};
