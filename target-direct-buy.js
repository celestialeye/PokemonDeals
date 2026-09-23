const { spawn } = require("node:child_process");
const path = require("node:path");
const { prepareAdapterRun } = require("./deals");
const { adapterForRetailer } = require("./src/deals-adapters");
const { createCatalogStore } = require("./src/deals-catalog");
const { createSecretStore } = require("./src/deals-secrets");
const { ensureChromeCdp } = require("./src/chrome-cdp");
const {
  normalizeTargetBuyMode,
  parseTargetBuyUrl,
} = require("./src/target-buy-input");
const { normalizeTargetSettings } = require("./src/target-deal-settings");
const {
  createTargetRunLogger,
  sanitizeTargetLogText,
} = require("./src/target-run-log");

const catalogPath = path.join(__dirname, "data", "deals.json");
const secretPath = path.join(__dirname, "data", "deals-secrets.local.json");
const defaultTargetBuyLimit = "10000.00";

function targetBuySettings(settings) {
  const normalized = normalizeTargetSettings(settings);
  return normalizeTargetSettings({
    ...normalized,
    maxItemPrice: normalized.maxItemPrice || defaultTargetBuyLimit,
    maxOrderTotal: normalized.maxOrderTotal || defaultTargetBuyLimit,
    expectedFulfillment: normalized.expectedFulfillment || "shipping",
    timeoutMs: 45000,
  });
}

function prepareTargetBuyRun({
  targetUrl,
  mode = "auto",
  env = process.env,
  secrets,
  settings,
  adapter = adapterForRetailer("target"),
} = {}) {
  if (!adapter) {
    throw new Error("Target adapter is unavailable.");
  }
  const input = parseTargetBuyUrl(targetUrl);
  const requestedMode = normalizeTargetBuyMode(mode);
  const effectiveSettings = targetBuySettings(settings);
  const directEnv = {
    ...env,
    TARGET_DISABLE_DISCORD_ALERTS: "1",
    TARGET_CHALLENGE_REFRESH_AFTER_CYCLE: "1",
    // Preserve the authenticated shared profile during challenge recovery.
    // Clearing Target cookies did not establish recovery in the live run.
    TARGET_SESSION_RESET_ON_STUCK: "0",
  };
  const run = prepareAdapterRun(
    adapter,
    [{ mode: requestedMode, url: input.url }],
    "live-purchase",
    {
      challengeSolver: true,
      env: directEnv,
      secrets,
      settings: effectiveSettings,
    },
  );
  // The one-product buy route keeps the user's one-second poll cadence even
  // when the saved catalog setting still says five seconds.
  run.env.TARGET_MONITOR_POLL_MS = "1000";
  delete run.env.TARGET_BUY_PRODUCT_URL;
  delete run.env.TARGET_BUY_MODE;
  return {
    effectiveSettings,
    input,
    requestedMode,
    run,
  };
}

function forwardChildOutput(child, logger, {
  output = process.stdout,
  errorOutput = process.stderr,
  onLine = () => {},
} = {}) {
  let confirmed = false;
  let terminalStop = false;
  let stdoutPending = "";
  let stderrPending = "";

  const writeLines = (level, text, final = false) => {
    const combined = text;
    if (combined.length > 65536) {
      logger.write("error", ["TARGET_OUTPUT_LINE_TOO_LONG"]);
      (level === "info" ? output : errorOutput).write(
        "TARGET_OUTPUT_LINE_TOO_LONG\n",
      );
      return "";
    }
    const lines = combined.split(/\r?\n/);
    const pending = final ? "" : lines.pop();
    for (const line of lines) {
      if (!line) {
        continue;
      }
      // Buffer a complete line before sanitizing: the filled value in a
      // browser error may arrive across multiple child-process chunks.
      const safeLine = sanitizeTargetLogText(line);
      logger.write(level, [safeLine]);
      (level === "info" ? output : errorOutput).write(`${safeLine}\n`);
      try {
        onLine(level, safeLine);
      } catch (error) {
        // Telemetry must not alter an in-flight checkout.
      }
      if (/^TARGET_ORDER_CONFIRMED\b/.test(safeLine)) {
        confirmed = true;
      }
      if (/^TARGET_TERMINAL_SAFETY_STOP\b/.test(safeLine)) {
        terminalStop = true;
      }
    }
    return pending;
  };

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdoutPending = writeLines("info", `${stdoutPending}${text}`);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrPending = writeLines("error", `${stderrPending}${text}`);
  });

  return {
    flush() {
      stdoutPending = writeLines("info", stdoutPending, true);
      stderrPending = writeLines("error", stderrPending, true);
    },
    confirmed() {
      return confirmed;
    },
    terminalStop() {
      return terminalStop;
    },
  };
}

function executeTargetBuyWorker(run, logger, {
  spawnImpl = spawn,
  output = process.stdout,
  errorOutput = process.stderr,
  onLine = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(run.command, run.args, {
      cwd: __dirname,
      env: run.env,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    const forwarded = forwardChildOutput(child, logger, {
      output,
      errorOutput,
      onLine,
    });

    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code, signal) => {
      forwarded.flush();
      if (code !== 0) {
        reject(
          new Error(
            `Target watch worker exited with code ${code ?? signal ?? "unknown"}.`,
          ),
        );
        return;
      }
      if (forwarded.terminalStop()) {
        reject(new Error("TARGET_TERMINAL_SAFETY_STOP: Target watch stopped before completing the run."));
        return;
      }
      if (!forwarded.confirmed()) {
        // Order history can later confirm a real purchase that the worker did
        // not observe. Keep this run unconfirmed and require independent
        // verification before any new submission attempt.
        reject(
          new Error(
            "TARGET_BUY_OUTCOME_UNCONFIRMED: Target watch exited without explicit order confirmation.",
          ),
        );
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const targetUrl = process.env.TARGET_BUY_PRODUCT_URL;
  const mode = process.env.TARGET_BUY_MODE || "auto";
  const input = parseTargetBuyUrl(targetUrl);
  const requestedMode = normalizeTargetBuyMode(mode);
  const logger = createTargetRunLogger({
    workflow: "target-direct-buy",
    metadata: {
      productId: input.product?.id || "short-link",
      requestedMode,
      quantity: 1,
    },
  });
  logger.write("info", ["TARGET_RUN_STARTED"], "TARGET_RUN_STARTED");
  console.log(`TARGET_LOG_FILE ${logger.fileUrl}`);

  try {
    const store = createCatalogStore(catalogPath);
    const secretStore = createSecretStore(secretPath);
    const catalog = await store.read();
    const secrets = await secretStore.getAll();
    const prepared = prepareTargetBuyRun({
      targetUrl,
      mode,
      secrets,
      settings: catalog.settings.target,
    });
    logger.write(
      "info",
      [
        `TARGET_BUY_INPUT_ACCEPTED type=${prepared.input.type} product=${prepared.input.product?.id || "short-link"} mode=${prepared.requestedMode}`,
      ],
      "TARGET_BUY_INPUT_ACCEPTED",
    );
    console.log(
      `TARGET_BUY_INPUT_ACCEPTED type=${prepared.input.type} product=${prepared.input.product?.id || "short-link"} mode=${prepared.requestedMode}`,
    );

    const cdp = await ensureChromeCdp();
    logger.write(
      "info",
      [cdp.started ? "TARGET_CDP_READY" : "TARGET_CDP_REUSED"],
    );
    console.log(cdp.started ? "TARGET_CDP_READY" : "TARGET_CDP_REUSED");
    logger.write(
      "info",
      [
        `TARGET_BUY_STARTED mode=${prepared.requestedMode} maxItemPrice=${prepared.effectiveSettings.maxItemPrice} maxOrderTotal=${prepared.effectiveSettings.maxOrderTotal}`,
      ],
      "TARGET_BUY_STARTED",
    );
    console.log(
      `TARGET_BUY_STARTED mode=${prepared.requestedMode} maxItemPrice=${prepared.effectiveSettings.maxItemPrice} maxOrderTotal=${prepared.effectiveSettings.maxOrderTotal}`,
    );
    await executeTargetBuyWorker(prepared.run, logger);
    logger.write("info", ["TARGET_BUY_COMPLETED"], "TARGET_BUY_COMPLETED");
  } catch (error) {
    logger.write("error", [error.message]);
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  defaultTargetBuyLimit,
  executeTargetBuyWorker,
  forwardChildOutput,
  prepareTargetBuyRun,
  targetBuySettings,
};
