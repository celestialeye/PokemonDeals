const path = require("node:path");
const targetProducts = require("../data/target-products.json");
const { normalizeUrl } = require("./deals-core");
const {
  applyStoredSecretsToEnvironment,
} = require("./deals-secrets");
const {
  applyTargetSettingsToEnvironment,
  normalizeExecutionMode,
  normalizeTargetSettings,
  setTargetSetting,
  targetSettingRows,
  targetSettingsDefaults,
  validateTargetSettingsForRun,
} = require("./target-deal-settings");

const executionModes = Object.freeze([
  "observe-only",
  "stop-before-submit",
  "live-purchase",
]);

const knownTargetUrls = new Map();
for (const product of targetProducts) {
  for (const value of [product.url, product.shortUrl]) {
    if (value) {
      knownTargetUrls.set(normalizeUrl(value), product);
    }
  }
}

function targetProductIdFromUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (error) {
    return null;
  }
  const match = url.pathname.match(/\bA-\d{7,}\b/i);
  return match ? match[0].toUpperCase() : null;
}

function isTargetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  if (["howl.link", "goto.target.com"].includes(url.hostname)) {
    return true;
  }
  return (
    ["target.com", "www.target.com"].includes(url.hostname) &&
    Boolean(targetProductIdFromUrl(url.href))
  );
}

function normalizeTargetUrl(value) {
  const normalized = normalizeUrl(value);
  const url = new URL(normalized);
  if (url.hostname === "target.com") {
    url.hostname = "www.target.com";
  }
  return url.href;
}

function targetMetadata(value) {
  const url = normalizeTargetUrl(value);
  const known = knownTargetUrls.get(url);
  const directId = targetProductIdFromUrl(url);
  return {
    retailer: "target",
    normalizedUrl: url,
    resolvedProductId: directId || known?.id || null,
    resolvedUrl: directId ? url : known?.url || null,
  };
}

function targetWorkerMode(mode) {
  const mapped = {
    "buy-now": "buy-now",
    preorder: "preorder",
    buy: "add-to-cart",
  }[mode];
  if (!mapped) {
    throw new Error("Target mode must be Buy Now, Preorder, or Buy.");
  }
  return mapped;
}

function buildTargetRun(items, executionMode, {
  challengeSolver,
  env = process.env,
  rootDir = path.resolve(__dirname, ".."),
  settings = targetSettingsDefaults,
} = {}) {
  const normalizedSettings = normalizeTargetSettings(settings);
  const mode = normalizeExecutionMode(
    executionMode || normalizedSettings.defaultRunMode,
  );
  const configured = applyTargetSettingsToEnvironment(env, settings, {
    executionMode: mode,
    challengeSolver,
  });
  return {
    command: process.execPath,
    args: [
      path.join(rootDir, "target-watch.js"),
      ...items.map((item) => `${targetWorkerMode(item.mode)}=${item.url}`),
    ],
    env: configured.env,
    challengeSolverEnabled: configured.solverEnabled,
  };
}

function validateTargetEnvironment(executionMode, env = process.env) {
  const mode = normalizeExecutionMode(executionMode);
  if (mode === "observe-only") {
    return [];
  }
  return [
    "DISCORD_WEBHOOK_URL",
  ].filter((name) => !String(env[name] || "").trim());
}

function parseJsonSuffix(line, marker) {
  const index = line.indexOf(marker);
  if (index < 0) {
    return null;
  }
  try {
    return JSON.parse(line.slice(index + marker.length).trim());
  } catch (error) {
    return null;
  }
}

function parseTargetOutput(line) {
  const value = String(line || "").trim();
  if (!value) {
    return null;
  }

  let match = value.match(/^TARGET_SHORT_URL_RESOLVED (\S+) -> (\S+)$/);
  if (match) {
    return {
      sourceUrl: normalizeUrl(match[1]),
      resolvedUrl: normalizeUrl(match[2]),
      productId: targetProductIdFromUrl(match[2]),
      status: "URL resolved",
    };
  }

  const confirmed = parseJsonSuffix(value, "TARGET_ORDER_CONFIRMED ");
  if (confirmed) {
    return {
      productId: confirmed.productId || null,
      status: "Order confirmed",
      terminalOutcome: "confirmed",
    };
  }

  const safetyStop = parseJsonSuffix(value, "TARGET_TERMINAL_SAFETY_STOP ");
  if (safetyStop) {
    return {
      productId: safetyStop.productId || null,
      status: `Safety stop: ${safetyStop.reason || "unknown"}`,
      terminalOutcome: safetyStop.reason || "safety-stop",
      important: true,
    };
  }

  const apiPoll = parseJsonSuffix(value, "TARGET_API_POLL ");
  if (apiPoll) {
    const status = apiPoll.outcome === "response" &&
      apiPoll.status >= 200 &&
      apiPoll.status < 300
      ? `Monitoring (HTTP ${apiPoll.status})`
      : `Poll ${apiPoll.outcome || "error"} (HTTP ${apiPoll.status})`;
    return {
      productId: apiPoll.productId || null,
      status,
      important: apiPoll.outcome !== "response" || apiPoll.status >= 300,
    };
  }

  match = value.match(
    /^(A-\d{7,}) (AVAILABILITY|OBSERVE_ONLY_ACTION_AVAILABLE|ITEM_NOT_ADDED_TO_CART|PURCHASE_RESULT_UNCONFIRMED|PURCHASE_ADDED_TO_CART|BUY_NOW_PANEL_OPENED|PURCHASE_ACTION_FAILED|CHECKOUT_RUNNER_FAILED|AVAILABILITY_FETCH_FAILED|AVAILABILITY_RESPONSE_NOT_JSON|CART_HANDSHAKE_FAILED)\b(.*)$/i,
  );
  if (match) {
    const event = match[2].toUpperCase();
    const rest = match[3].trim();
    const statuses = {
      AVAILABILITY: "Availability checked",
      OBSERVE_ONLY_ACTION_AVAILABLE: "Action available",
      ITEM_NOT_ADDED_TO_CART: "Item not added; monitoring",
      PURCHASE_RESULT_UNCONFIRMED: "Purchase result unconfirmed",
      PURCHASE_ADDED_TO_CART: "Added to cart; checkout started",
      BUY_NOW_PANEL_OPENED: "Buy Now checkout opened",
      PURCHASE_ACTION_FAILED: "Purchase action failed",
      CHECKOUT_RUNNER_FAILED: "Checkout runner failed",
      AVAILABILITY_FETCH_FAILED: "Availability fetch failed",
      AVAILABILITY_RESPONSE_NOT_JSON: "Availability response invalid",
      CART_HANDSHAKE_FAILED: "Cart handshake failed",
    };
    if (event === "AVAILABILITY" && rest.startsWith("{")) {
      try {
        const summary = JSON.parse(rest);
        statuses.AVAILABILITY = summary.available
          ? "Available"
          : "Unavailable";
      } catch (error) {
        // Preserve the generic checked status for malformed worker output.
      }
    }
    return {
      productId: match[1].toUpperCase(),
      status: statuses[event],
      important: /FAILED|INVALID|UNCONFIRMED/.test(event),
    };
  }

  match = value.match(/^TARGET_CHALLENGE_DETECTED\b.*\bproduct=(A-\d{7,})\b/i);
  if (match) {
    return {
      productId: match[1].toUpperCase(),
      status: "Verification detected",
      important: true,
    };
  }

  const challengeSolved = parseJsonSuffix(value, "TARGET_CHALLENGE_SOLVED ");
  if (challengeSolved) {
    return {
      ...(challengeSolved.productId
        ? { productId: challengeSolved.productId }
        : { scope: "active" }),
      status: `Verification solved after ${challengeSolved.attempts || "unknown"} attempt(s)`,
    };
  }

  if (/^TARGET_CHALLENGE_BACKOFF\b/i.test(value)) {
    const productMatch = value.match(/\bA-\d{7,}\b/i);
    return {
      ...(productMatch
        ? { productId: productMatch[0].toUpperCase() }
        : { scope: "all" }),
      status: "Verification backoff",
      important: true,
    };
  }

  const globalEvents = {
    TARGET_PURCHASE_COMPLETE: {
      status: "Purchase complete",
      terminalOutcome: "confirmed",
    },
    TARGET_MONITOR_STOP_LIMIT_OR_ERROR: {
      status: "Monitor stopped",
      terminalOutcome: "stopped",
      important: true,
    },
    ALL_TARGET_PRODUCTS_COMPLETED: {
      status: "Worker completed",
      terminalOutcome: "completed",
    },
  };
  if (globalEvents[value]) {
    return {
      scope: value === "TARGET_PURCHASE_COMPLETE" ? "active" : "all",
      ...globalEvents[value],
    };
  }
  if (/^TARGET_RATE_LIMIT_BACKOFF\b/.test(value)) {
    return {
      scope: "all",
      status: "Rate-limit backoff",
      important: true,
    };
  }
  return null;
}

const targetAdapter = Object.freeze({
  id: "target",
  displayName: "Target",
  maximumArmed: 3,
  defaultExecutionMode: "stop-before-submit",
  normalizeExecutionMode,
  supportedModes: new Set(["buy-now", "preorder", "buy"]),
  matchesUrl: isTargetUrl,
  metadata: targetMetadata,
  buildRun: buildTargetRun,
  validateEnvironment: validateTargetEnvironment,
  parseOutput: parseTargetOutput,
  applySecrets: applyStoredSecretsToEnvironment,
  settings: Object.freeze({
    defaults: targetSettingsDefaults,
    normalize: normalizeTargetSettings,
    set: setTargetSetting,
    rows: targetSettingRows,
    validateRun: validateTargetSettingsForRun,
  }),
  runOptionPrompts(settings) {
    return [
      {
        key: "challengeSolver",
        label: "Use bundled Target Press & Hold recovery?",
        defaultValue: settings.solverEnabled,
      },
    ];
  },
});

const adapters = Object.freeze([targetAdapter]);

function adapterForUrl(value) {
  const url = normalizeUrl(value);
  return adapters.find((adapter) => adapter.matchesUrl(url)) || null;
}

function adapterForRetailer(retailer) {
  return adapters.find((adapter) => adapter.id === retailer) || null;
}

function productMetadata(value) {
  const url = normalizeUrl(value);
  const adapter = adapterForUrl(url);
  return adapter
    ? adapter.metadata(url)
    : {
      retailer: "unsupported",
      normalizedUrl: url,
      resolvedProductId: null,
      resolvedUrl: null,
    };
}

function defaultRetailerSettings() {
  return Object.fromEntries(
    adapters.map((adapter) => [
      adapter.id,
      adapter.settings
        ? adapter.settings.normalize(adapter.settings.defaults)
        : {},
    ]),
  );
}

function normalizeRetailerSettings(settings = {}) {
  return Object.fromEntries(
    adapters.map((adapter) => [
      adapter.id,
      adapter.settings
        ? adapter.settings.normalize(settings[adapter.id] || {})
        : {},
    ]),
  );
}

module.exports = {
  adapterForRetailer,
  adapterForUrl,
  adapters,
  buildTargetRun,
  defaultRetailerSettings,
  executionModes,
  normalizeExecutionMode,
  normalizeRetailerSettings,
  parseTargetOutput,
  productMetadata,
  normalizeTargetUrl,
  targetWorkerMode,
  validateTargetEnvironment,
  validateTargetSettingsForRun,
};
