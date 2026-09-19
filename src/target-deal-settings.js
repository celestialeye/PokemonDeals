const targetSettingsDefaults = Object.freeze({
  defaultRunMode: "stop-before-submit",
  maxItemPrice: null,
  maxOrderTotal: null,
  expectedFulfillment: null,
  pollIntervalMs: 5000,
  browserDriver: "patchright",
  solverEnabled: true,
  solveAttempts: 3,
  settleMs: 1500,
  holdMs: 10000,
  timeoutMs: 20000,
  challengeBackoffMs: 300000,
  challengeMaxBackoffMs: 1800000,
  cartRateLimitBackoffMs: 60000,
  maxPolls: 0,
  maxRuntimeMs: 0,
});
const maximumTimerMs = 2147483647;
const maximumPollIntervalMs = Math.floor(maximumTimerMs / 1.1);

const targetSettingDefinitions = Object.freeze([
  ["default-run-mode", "defaultRunMode", "Default run mode"],
  ["max-item-price", "maxItemPrice", "Maximum item price"],
  ["max-order-total", "maxOrderTotal", "Maximum order total"],
  ["expected-fulfillment", "expectedFulfillment", "Expected fulfillment"],
  ["poll-interval-ms", "pollIntervalMs", "Poll interval (ms)"],
  ["browser-driver", "browserDriver", "Browser driver"],
  ["solver-enabled", "solverEnabled", "Challenge solver enabled"],
  ["solve-attempts", "solveAttempts", "Challenge solve attempts"],
  ["settle-ms", "settleMs", "Challenge settle (ms)"],
  ["hold-ms", "holdMs", "Challenge hold (ms)"],
  ["timeout-ms", "timeoutMs", "Challenge timeout (ms)"],
  ["challenge-backoff-ms", "challengeBackoffMs", "Challenge backoff (ms)"],
  [
    "challenge-max-backoff-ms",
    "challengeMaxBackoffMs",
    "Maximum challenge backoff (ms)",
  ],
  [
    "cart-rate-limit-backoff-ms",
    "cartRateLimitBackoffMs",
    "Cart rate-limit backoff (ms)",
  ],
  ["max-polls", "maxPolls", "Maximum API polls (0 = unlimited)"],
  ["max-runtime-ms", "maxRuntimeMs", "Maximum runtime (ms, 0 = unlimited)"],
]);

const settingNames = new Map();
for (const [cliName, property] of targetSettingDefinitions) {
  settingNames.set(cliName, property);
  settingNames.set(property.toLowerCase(), property);
}

function normalizeExecutionMode(value) {
  const normalized = String(value || "stop-before-submit")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  const aliases = {
    observe: "observe-only",
    "observe-only": "observe-only",
    monitor: "observe-only",
    stop: "stop-before-submit",
    "stop-before-submit": "stop-before-submit",
    live: "live-purchase",
    "live-purchase": "live-purchase",
  };
  const mode = aliases[normalized];
  if (!mode) {
    throw new Error(
      "Run mode must be observe, stop-before-submit, or live.",
    );
  }
  return mode;
}

function normalizeSettingKey(value) {
  const input = String(value || "").trim();
  const withoutRetailer = input.toLowerCase().startsWith("target.")
    ? input.slice("target.".length)
    : input;
  const normalized = withoutRetailer
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();
  const property = settingNames.get(normalized) ||
    settingNames.get(normalized.replace(/-/g, ""));
  if (!property) {
    throw new Error(`Unknown Target setting: ${value}`);
  }
  return property;
}

function parseBoolean(value, name) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function parseInteger(value, name, minimum, maximum = Infinity) {
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be an integer.`);
  }
  const number = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    const range = Number.isFinite(maximum)
      ? `${minimum}-${maximum}`
      : `${minimum} or greater`;
    throw new Error(`${name} must be ${range}.`);
  }
  return number;
}

function parseOptionalCurrency(value, name) {
  if (
    value === null ||
    value === undefined ||
    /^(?:|none|unset|null)$/i.test(String(value).trim())
  ) {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`${name} must be a positive decimal amount or unset.`);
  }
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error(`${name} must be a positive decimal amount or unset.`);
  }
  return (cents / 100).toFixed(2);
}

function parseOptionalFulfillment(value) {
  if (
    value === null ||
    value === undefined ||
    /^(?:|none|unset|null)$/i.test(String(value).trim())
  ) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, "-");
  if (!["shipping", "delivery", "pickup", "drive-up"].includes(normalized)) {
    throw new Error(
      "Expected fulfillment must be shipping, delivery, pickup, drive-up, or unset.",
    );
  }
  return normalized;
}

function parseTargetSetting(property, value) {
  if (property === "defaultRunMode") {
    return {
      "observe-only": "observe",
      "stop-before-submit": "stop-before-submit",
      "live-purchase": "live",
    }[normalizeExecutionMode(value)];
  }
  if (property === "maxItemPrice") {
    return parseOptionalCurrency(value, "Maximum item price");
  }
  if (property === "maxOrderTotal") {
    return parseOptionalCurrency(value, "Maximum order total");
  }
  if (property === "expectedFulfillment") {
    return parseOptionalFulfillment(value);
  }
  if (property === "browserDriver") {
    const normalized = String(value || "").trim().toLowerCase();
    if (!["patchright", "playwright"].includes(normalized)) {
      throw new Error("Browser driver must be patchright or playwright.");
    }
    return normalized;
  }
  if (property === "solverEnabled") {
    return parseBoolean(value, "Solver enabled");
  }
  const integerRules = {
    pollIntervalMs: [
      "Poll interval",
      1500,
      maximumPollIntervalMs,
    ],
    solveAttempts: ["Solve attempts", 1, Infinity],
    settleMs: ["Settle interval", 500, maximumTimerMs],
    holdMs: ["Hold interval", 100, 15000],
    timeoutMs: ["Challenge timeout", 1000, 45000],
    challengeBackoffMs: ["Challenge backoff", 60000, maximumTimerMs],
    challengeMaxBackoffMs: [
      "Maximum challenge backoff",
      60000,
      maximumTimerMs,
    ],
    cartRateLimitBackoffMs: [
      "Cart rate-limit backoff",
      60000,
      maximumTimerMs,
    ],
    maxPolls: ["Maximum polls", 0, Infinity],
    maxRuntimeMs: ["Maximum runtime", 0, maximumTimerMs],
  };
  const [name, minimum, maximum] = integerRules[property];
  return parseInteger(value, name, minimum, maximum);
}

function validateRelationships(settings) {
  if (settings.timeoutMs < settings.holdMs + 1000) {
    throw new Error(
      "Challenge timeout must be at least hold-ms plus 1000.",
    );
  }
  if (settings.challengeMaxBackoffMs < settings.challengeBackoffMs) {
    throw new Error(
      "Maximum challenge backoff must be at least challenge-backoff-ms.",
    );
  }
  if (settings.challengeMaxBackoffMs < settings.cartRateLimitBackoffMs) {
    throw new Error(
      "Maximum challenge backoff must be at least cart-rate-limit-backoff-ms.",
    );
  }
  return settings;
}

function normalizeTargetSettings(input = {}) {
  const settings = { ...targetSettingsDefaults };
  for (const property of Object.keys(targetSettingsDefaults)) {
    if (Object.prototype.hasOwnProperty.call(input, property)) {
      settings[property] = parseTargetSetting(property, input[property]);
    }
  }
  return validateRelationships(settings);
}

function setTargetSetting(settings, key, value) {
  const normalized = normalizeTargetSettings(settings);
  const property = normalizeSettingKey(key);
  normalized[property] = parseTargetSetting(property, value);
  return validateRelationships(normalized);
}

function targetSettingRows(settings) {
  const normalized = normalizeTargetSettings(settings);
  return targetSettingDefinitions.map(([key, property, label]) => ({
    key: `target.${key}`,
    label,
    value: normalized[property] === null
      ? "unset"
      : String(normalized[property]),
  }));
}

function setEnvironmentValue(env, name, value) {
  if (value === null || value === undefined || value === "") {
    delete env[name];
  } else {
    env[name] = String(value);
  }
}

function setChallengeDefault(env, name, value) {
  if (!String(env[name] || "").trim()) {
    env[name] = String(value);
  }
}

function validateEffectiveChallengeSettings(env, settings) {
  return validateRelationships({
    ...settings,
    solveAttempts: parseTargetSetting(
      "solveAttempts",
      env.TARGET_CHALLENGE_SOLVE_ATTEMPTS,
    ),
    settleMs: parseTargetSetting(
      "settleMs",
      env.TARGET_CHALLENGE_SETTLE_MS,
    ),
    holdMs: parseTargetSetting("holdMs", env.TARGET_CHALLENGE_HOLD_MS),
    timeoutMs: parseTargetSetting(
      "timeoutMs",
      env.TARGET_CHALLENGE_TIMEOUT_MS,
    ),
    challengeBackoffMs: parseTargetSetting(
      "challengeBackoffMs",
      env.TARGET_CHALLENGE_BACKOFF_MS,
    ),
    challengeMaxBackoffMs: parseTargetSetting(
      "challengeMaxBackoffMs",
      env.TARGET_CHALLENGE_MAX_BACKOFF_MS,
    ),
  });
}

function applyTargetSettingsToEnvironment(
  inputEnv,
  settings,
  { executionMode, challengeSolver } = {},
) {
  const normalized = normalizeTargetSettings(settings);
  const env = { ...inputEnv };
  const solverEnabled = challengeSolver ?? normalized.solverEnabled;

  setEnvironmentValue(env, "TARGET_MAX_ITEM_PRICE", normalized.maxItemPrice);
  setEnvironmentValue(env, "TARGET_MAX_ORDER_TOTAL", normalized.maxOrderTotal);
  setEnvironmentValue(
    env,
    "TARGET_EXPECTED_FULFILLMENT",
    normalized.expectedFulfillment,
  );
  setEnvironmentValue(env, "TARGET_MONITOR_POLL_MS", normalized.pollIntervalMs);
  setEnvironmentValue(env, "TARGET_BROWSER_DRIVER", normalized.browserDriver);
  setEnvironmentValue(
    env,
    "TARGET_CART_RATE_LIMIT_BACKOFF_MS",
    normalized.cartRateLimitBackoffMs,
  );
  setEnvironmentValue(env, "TARGET_MONITOR_MAX_POLLS", normalized.maxPolls);
  setEnvironmentValue(
    env,
    "TARGET_MONITOR_MAX_RUNTIME_MS",
    normalized.maxRuntimeMs,
  );

  setChallengeDefault(
    env,
    "TARGET_CHALLENGE_SOLVE_ATTEMPTS",
    normalized.solveAttempts,
  );
  setChallengeDefault(env, "TARGET_CHALLENGE_SETTLE_MS", normalized.settleMs);
  setChallengeDefault(env, "TARGET_CHALLENGE_HOLD_MS", normalized.holdMs);
  setChallengeDefault(env, "TARGET_CHALLENGE_TIMEOUT_MS", normalized.timeoutMs);
  setChallengeDefault(
    env,
    "TARGET_CHALLENGE_BACKOFF_MS",
    normalized.challengeBackoffMs,
  );
  setChallengeDefault(
    env,
    "TARGET_CHALLENGE_MAX_BACKOFF_MS",
    normalized.challengeMaxBackoffMs,
  );
  validateEffectiveChallengeSettings(env, normalized);

  delete env.TARGET_MONITOR_OBSERVE_ONLY;
  delete env.TARGET_STOP_BEFORE_SUBMIT;
  delete env.TARGET_CHALLENGE_SOLVER;
  delete env.TARGET_CHALLENGE_VALIDATE;
  if (solverEnabled) {
    env.TARGET_CHALLENGE_SOLVER = "./target-challenge-solver.js";
    if (executionMode === "observe-only") {
      env.TARGET_CHALLENGE_VALIDATE = "1";
    }
  }
  if (executionMode === "observe-only") {
    env.TARGET_MONITOR_OBSERVE_ONLY = "1";
  } else if (executionMode === "stop-before-submit") {
    env.TARGET_STOP_BEFORE_SUBMIT = "1";
  }
  return { env, solverEnabled, settings: normalized };
}

function validateTargetSettingsForRun(executionMode, settings) {
  const normalized = normalizeTargetSettings(settings);
  if (executionMode === "observe-only") {
    return [];
  }
  const missing = [];
  if (!normalized.maxItemPrice) {
    missing.push("target.max-item-price");
  }
  if (!normalized.maxOrderTotal) {
    missing.push("target.max-order-total");
  }
  return missing;
}

module.exports = {
  applyTargetSettingsToEnvironment,
  maximumPollIntervalMs,
  maximumTimerMs,
  normalizeExecutionMode,
  normalizeSettingKey,
  normalizeTargetSettings,
  setTargetSetting,
  targetSettingRows,
  targetSettingsDefaults,
  validateTargetSettingsForRun,
};
