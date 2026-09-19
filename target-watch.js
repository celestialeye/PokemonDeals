/**
 * Target product-page monitor: browser-owned API polling plus serialized cart input.
 * Challenge flow: inspect -> one queued recovery cycle -> independent verification
 * -> discard stale state or back off. See TARGET-CHALLENGE-DEVELOPER-GUIDE.md.
 * Importing exposes test seams; only the require.main guard starts the worker.
 */
const path = require("node:path");
const { spawn } = require("node:child_process");
const { GlobalRequestQueue } = require("./global-request-queue");
const {
  isCartSuccess,
  normalizeRequestedPurchaseMode,
  productPurchaseSelector,
  purchaseModeFromLabel,
  selectPurchaseCandidate,
} = require("./target-products");
const {
  calculateBackoffMs,
  isAvailabilityResponseUrl,
  isChallengeResponse,
  replaceEndpointProduct,
  summarizeAvailabilityPayload,
  targetProductFromUrl,
} = require("./target-availability");
const {
  loadChallengeSolver,
  resolutionOutcome,
  resolveChallenge,
} = require("./target-challenge");
const { inspectChallenge } = require("./target-challenge-page");
const {
  cartResponseEvent,
  cartResponseKind,
  observeCartHandshake,
  readPurchaseGuardConfig,
  runTargetCheckout,
  validatePdpIdentity,
} = require("./target-checkout");

/**
 * @typedef {object} MonitorJob State belonging to one configured product/tab.
 * @property {{id: string, tcin: string, url: string}} product
 * @property {import("patchright").Page} page Existing-context page, not a new profile.
 * @property {object|null} availabilityRequest In-memory URL/method/body/header template;
 *   may contain sensitive runtime values and must not be logged or persisted.
 * @property {object|null} lastSummary Most recently parsed availability evidence.
 * @property {string|null} lastFingerprint Suppresses duplicate availability logs.
 * @property {number} pollCount Poll-loop ticks, including ticks that only navigate.
 * @property {string|null} challengeSignal Deferred signal from the response listener.
 * @property {number} nextNavigationAt Earliest product reload when no template exists.
 * @property {boolean} triggered A cart action is already in progress.
 * @property {boolean} addedToCart Confirmed cart evidence for cart-based checkout.
 * @property {string|null} purchaseMode Active transaction path after purchase input.
 * @property {boolean} completed Explicit order confirmation was observed.
 * @property {"preorder"|"add-to-cart"|"buy-now"|"auto"} requestedMode
 * @property {boolean} pendingCartReconciliation Cart input was sent without a final result.
 */

// Reuse the existing Chrome context on CDP. The worker creates product tabs, not
// fresh profiles, and does not set diagnostic user agents or automation flags.
const cdpEndpoint = "http://127.0.0.1:9444";
// Worker options are captured at module load. Configure process.env before
// requiring this module in tests, or before launching the CLI in production.
const browserDriverName = (
  process.env.TARGET_BROWSER_DRIVER || "patchright"
).toLowerCase();
if (!new Set(["patchright", "playwright"]).has(browserDriverName)) {
  throw new Error("TARGET_BROWSER_DRIVER must be patchright or playwright.");
}
const { chromium } = require(
  browserDriverName === "patchright" ? "patchright" : "playwright-core",
);
const maximumJobs = 3;
const requestedMaximumJobs = Number.parseInt(
  process.env.TARGET_MAX_CONCURRENT || "3",
  10,
);
const concurrentJobLimit = Math.max(
  1,
  Math.min(maximumJobs, requestedMaximumJobs || maximumJobs),
);
const globalPollDelayMs = Math.max(
  1500,
  Number.parseInt(process.env.TARGET_MONITOR_POLL_MS || "5000", 10) || 5000,
);
const observeOnly = /^(?:1|true|yes)$/i.test(
  process.env.TARGET_MONITOR_OBSERVE_ONLY || "",
);
const validateChallenges = /^(?:1|true|yes)$/i.test(
  process.env.TARGET_CHALLENGE_VALIDATE || "",
);
const keepDiagnosticPage = observeOnly && /^(?:1|true|yes)$/i.test(
  process.env.TARGET_MONITOR_KEEP_PAGE || "",
);
const maximumRuntimeMs = Math.max(
  0,
  Number.parseInt(process.env.TARGET_MONITOR_MAX_RUNTIME_MS || "0", 10) || 0,
);
const maximumApiPolls = Math.max(
  0,
  Number.parseInt(process.env.TARGET_MONITOR_MAX_POLLS || "0", 10) || 0,
);
const challengeBaseDelayMs = Math.max(
  60000,
  Number.parseInt(process.env.TARGET_CHALLENGE_BACKOFF_MS || "300000", 10) ||
    300000,
);
const challengeMaximumDelayMs = Math.max(
  challengeBaseDelayMs,
  Number.parseInt(
    process.env.TARGET_CHALLENGE_MAX_BACKOFF_MS || "1800000",
    10,
  ) || 1800000,
);
const cartRateLimitBaseDelayMs = Math.max(
  60000,
  Number.parseInt(
    process.env.TARGET_CART_RATE_LIMIT_BACKOFF_MS || "60000",
    10,
  ) || 60000,
);
const domRefreshEvery = Math.max(
  1,
  Number.parseInt(process.env.TARGET_DOM_REFRESH_EVERY || "20", 10) || 20,
);
const discordHelper = path.join(__dirname, "discord-alert.py");
const pythonExecutable = process.env.PYTHON || "python";
const challengeSolver = loadChallengeSolver();
const challengeSolveAttempts = Math.max(
  1,
  Number.parseInt(process.env.TARGET_CHALLENGE_SOLVE_ATTEMPTS || "3", 10) || 3,
);
const challengeSettleMs = Math.max(
  500,
  Number.parseInt(process.env.TARGET_CHALLENGE_SETTLE_MS || "1500", 10) || 1500,
);
const stopBeforeSubmit = /^(?:1|true|yes)$/i.test(
  process.env.TARGET_STOP_BEFORE_SUBMIT || "",
);

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function parseJobArgument(value) {
  const input = String(value || "").trim();
  if (/^https:\/\//i.test(input)) {
    return { requestedMode: "auto", url: input };
  }
  const separator = input.indexOf("=");
  if (separator <= 0) {
    throw new Error(
      "Each Target job must use preorder=url, add-to-cart=url, or buy-now=url.",
    );
  }
  const requestedMode = normalizeRequestedPurchaseMode(
    input.slice(0, separator),
  );
  if (!requestedMode) {
    throw new Error(`Unsupported Target purchase mode: ${input.slice(0, separator)}`);
  }
  const url = input.slice(separator + 1).trim();
  if (!url) {
    throw new Error(`Target ${requestedMode} job is missing its URL.`);
  }
  return { requestedMode, url };
}

async function resolveProductArgs(args) {
  const resolved = [];
  for (const value of args) {
    const configured = parseJobArgument(value);
    const direct = targetProductFromUrl(configured.url);
    if (direct) {
      resolved.push({ ...configured, url: direct.url });
      continue;
    }

    let inputUrl;
    try {
      inputUrl = new URL(configured.url);
    } catch (error) {
      resolved.push(configured);
      continue;
    }
    if (
      inputUrl.protocol !== "https:" ||
      !["howl.link", "goto.target.com"].includes(inputUrl.hostname)
    ) {
      resolved.push(configured);
      continue;
    }

    let currentUrl = inputUrl;
    for (let hop = 0; hop < 6; hop += 1) {
      const product = targetProductFromUrl(currentUrl.href);
      if (product) {
        break;
      }
      const response = await fetch(currentUrl, {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0" },
      });
      const location = response.headers.get("location");
      if (!location) {
        break;
      }
      currentUrl = new URL(location, currentUrl);
    }
    resolved.push({ ...configured, url: currentUrl.href });
    console.log(`TARGET_SHORT_URL_RESOLVED ${inputUrl.href} -> ${currentUrl.href}`);
  }
  return resolved;
}

function parseProducts(args) {
  const configuredJobs = args.map((value) =>
    typeof value === "string" ? parseJobArgument(value) : value,
  );
  if (configuredJobs.length === 0) {
    throw new Error(
      "Pass one to three Target mode=url jobs after the command.",
    );
  }
  if (configuredJobs.length > concurrentJobLimit) {
    throw new Error(
      `Received ${configuredJobs.length} products; the configured maximum is ${concurrentJobLimit}.`,
    );
  }
  const jobs = configuredJobs.map(({ requestedMode, url }) => ({
    requestedMode,
    product: targetProductFromUrl(url),
  }));
  if (jobs.some((job) => !job.product)) {
    throw new Error("Every argument must be a valid https://www.target.com product URL.");
  }

  const unique = new Map();
  for (const job of jobs) {
    const existing = unique.get(job.product.id);
    if (existing) {
      const suffix = existing.requestedMode === job.requestedMode
        ? ""
        : " with conflicting modes";
      throw new Error(`Duplicate Target product URLs are not allowed${suffix}.`);
    }
    unique.set(job.product.id, job);
  }
  return [...unique.values()];
}

function runDiscordHelper(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [discordHelper], {
      cwd: __dirname,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Discord helper timed out"));
    }, 20000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `Discord helper exited ${code}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function sendDiscordAlert(content) {
  try {
    await runDiscordHelper({
      username: "Target availability monitor",
      content,
    });
  } catch (error) {
    console.error(`DISCORD_ALERT_FAILED ${error.message}`);
  }
}

async function verifyDiscordConfiguration() {
  if (!/^https:\/\/(?:discord(?:app)?\.com|discord\.com)\/api\/webhooks\//i.test(
    process.env.DISCORD_WEBHOOK_URL || "",
  )) {
    throw new Error(
      "Set DISCORD_WEBHOOK_URL to the Discord webhook before starting the monitor.",
    );
  }

  await new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [discordHelper, "--check"], {
      cwd: __dirname,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            stderr.trim() ||
              "Discord Python package unavailable; run npm run discord:install.",
          ),
        );
      }
    });
  });
}

/**
 * Single entry point for every challenge signal. Returns:
 *   "clear"    - no challenge visible, caller may continue
 *   "resolved" - a challenge was detected and the injected solver cleared it
 *   "blocked"  - a challenge remains; the monitor is now in backoff
 *
 * The solver result is never trusted directly: the page is re-inspected after
 * each normally completed attempt; thrown attempts are retried, never trusted.
 * A network challenge with no readable page evidence still blocks; it does not
 * authorize the solver to invent an interaction. A cleared result is not cart
 * success and does not override unrelated run-stop conditions.
 *
 * @param {MonitorJob} job
 * @param {ReturnType<typeof createMonitorState>} monitorState
 * @param {string} reason Non-sensitive trigger description for diagnostics.
 * @param {object} [options] Solver/timing overrides support isolated tests.
 * @param {boolean} [options.assumeDetected=false] A network challenge was reported;
 *   a clean-looking page alone must not dismiss that report.
 * @param {boolean} [options.mutationOwned=false] Only true when the caller is
 *   already inside enqueueMutation; never use it to bypass serialization.
 * @param {import("./target-challenge").ChallengeSolver|null} [options.solver]
 * @param {number} [options.maxAttempts]
 * @param {number} [options.settleMs]
 * @param {(ms: number) => Promise<void>} [options.waitFor]
 * @returns {Promise<"clear"|"resolved"|"blocked">}
 */
async function handleChallenge(job, monitorState, reason, {
  assumeDetected = false,
  mutationOwned = false,
  solver = challengeSolver,
  maxAttempts = challengeSolveAttempts,
  settleMs = challengeSettleMs,
  waitFor = wait,
} = {}) {
  const detection = await inspectChallenge(job.page);
  if (!detection.detected) {
    if (!assumeDetected) {
      return "clear";
    }
    monitorState.pauseForChallenge(`${reason} (no page-level evidence)`);
    return "blocked";
  }

  if (detection.unreadable) {
    monitorState.pauseForChallenge(`${reason} (unreadable page state)`);
    return "blocked";
  }

  console.error(
    `TARGET_CHALLENGE_DETECTED kind=${detection.kind} product=${job.product.id} reason=${reason}`,
  );
  if (!solver) {
    monitorState.pauseForChallenge(`${reason} (${detection.kind}, no solver)`);
    return "blocked";
  }

  const resolve = () => resolveChallenge({
    solver,
    page: job.page,
    product: job.product,
    kind: detection.kind,
    reason,
    maxAttempts,
    settleMs,
    wait: waitFor,
    log: (message) => console.log(message),
    verifyCleared: async () => !(await inspectChallenge(job.page)).detected,
  });
  // Post-click handling already owns this queue. Re-enqueueing and awaiting
  // itself would deadlock; external challenge entry points still serialize.
  const result = await (mutationOwned ? resolve() : monitorState.enqueueMutation(resolve));

  if (result.outcome === resolutionOutcome.cleared) {
    // Recovery can change session/request state. Relearn the page-owned request
    // instead of replaying pre-challenge data or acting on an old stock signal.
    job.availabilityRequest = null;
    job.challengeSignal = null;
    job.lastSummary = null;
    job.lastFingerprint = null;
    job.nextNavigationAt = 0;
    monitorState.recordChallengeSolved(
      detection.kind,
      result.attempts,
      job.product.id,
    );
    return "resolved";
  }

  monitorState.pauseForChallenge(
    `${reason} (${detection.kind}, solve ${result.outcome}${result.error ? `: ${result.error}` : ""})`,
  );
  return "blocked";
}

async function findPurchaseButton(page, requestedMode) {
  const buttons = page.locator(productPurchaseSelector);
  const candidates = [];
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const button = buttons.nth(index);
    const label = await button.innerText().catch(() => "");
    if (
      purchaseModeFromLabel(label) &&
      (await button.isVisible().catch(() => false)) &&
      (await button.isEnabled().catch(() => false))
    ) {
      candidates.push({
        button,
        label: label.replace(/\s+/g, " ").trim(),
      });
    }
  }
  return selectPurchaseCandidate(candidates, requestedMode);
}

async function closeNotAddedDialog(page) {
  const failure = page.getByText(/^item not added to cart$/i).first();
  if (
    (await failure.count()) === 0 ||
    !(await failure.isVisible().catch(() => false))
  ) {
    return false;
  }

  const dialog = failure.locator('xpath=ancestor::*[@role="dialog"][1]');
  const closeButton = dialog.getByRole("button", { name: /close/i }).first();
  if (
    (await closeButton.count()) > 0 &&
    (await closeButton.isVisible().catch(() => false))
  ) {
    await closeButton.click({ timeout: 3000 }).catch(() => {});
  }
  return true;
}

function availabilityMessage(job, source, label, summary) {
  const evidence = summary?.positiveEvidence?.[0];
  const evidenceText = evidence
    ? `\nSignal: \`${evidence.path}=${evidence.value}\``
    : "";
  return [
    `🚨 **Target ${label} available**`,
    `Product: **${job.product.id}**`,
    `Source: ${source}`,
    job.product.url,
    evidenceText,
  ]
    .filter(Boolean)
    .join("\n");
}

function attachCartResponseMonitor(page, monitorState, source) {
  const onResponse = (response) => {
    if (!cartResponseKind(response.url())) {
      return;
    }
    monitorState.recordCartResponse(
      cartResponseEvent(response),
      response,
      source,
    );
  };
  page.on("response", onResponse);
  return () => page.off("response", onResponse);
}

/**
 * Observe page-owned fulfillment responses; this listener sends no requests.
 * Browser events can arrive during another action, so challenge input is deferred
 * to the poll loop rather than starting a concurrent solve from this callback.
 * Keep captured request data in memory; log classifications, not headers/tokens.
 *
 * @param {MonitorJob} job
 * @param {ReturnType<typeof createMonitorState>} monitorState
 */
async function attachResponseMonitor(job, monitorState) {
  job.page.on("response", async (response) => {
    if (cartResponseKind(response.url())) {
      monitorState.recordCartResponse(
        cartResponseEvent(response),
        response,
        job.product.id,
      );
      return;
    }
    if (!isAvailabilityResponseUrl(response.url())) {
      return;
    }

    const body = await response.text().catch(() => "");
    const contentType = response.headers()["content-type"] || "";
    if (
      isChallengeResponse({
        status: response.status(),
        contentType,
        body,
      })
    ) {
      const reason = `availability response ${response.status()} for ${job.product.id}`;
      if (challengeSolver) {
        // Defer to the poll loop so the solve runs in a controlled, serialized step.
        job.challengeSignal = reason;
      } else {
        monitorState.pauseForChallenge(reason);
      }
      return;
    }

    if (
      /cdui_orchestrations/i.test(response.url()) &&
      !/ProductDetailWebDatasourceFulfillmentAndVariations/i.test(body)
    ) {
      return;
    }

    const request = response.request();
    job.availabilityRequest = {
      url: response.url(),
      method: request.method(),
      postData: request.postData(),
      headers: {
        accept: request.headers().accept || "application/json",
        "content-type": request.headers()["content-type"] || "application/json",
      },
    };
    try {
      const summary = summarizeAvailabilityPayload(
        JSON.parse(body),
        job.product,
      );
      if (summary) {
        job.lastSummary = summary;
      }
    } catch (error) {
      // Target occasionally returns partial responses while navigating.
    }
  });
}

/** Load the product page, handle verification first, then inspect purchase controls. */
async function navigateProduct(job, monitorState) {
  await job.page.goto(job.product.url, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await job.page.waitForTimeout(750);

  if (
    (await handleChallenge(
      job,
      monitorState,
      `page verification for ${job.product.id}`,
    )) === "blocked"
  ) {
    return;
  }

  await inspectAndTrigger(job, monitorState, "product page", job.lastSummary);
}

/** Continue the single winning transaction until confirmation or shared backoff. */
async function continueCheckout(job, monitorState, {
  notify = sendDiscordAlert,
  challengeOptions = {},
  checkoutRunner = runTargetCheckout,
  error = console.error,
} = {}) {
  if (job.completed || job.terminal || monitorState.isPaused()) {
    return;
  }
  const buyNow = job.purchaseMode === "buy-now";
  const checkoutPage = buyNow ? job.page : job.checkoutPage;
  if (!checkoutPage) {
    throw new Error("Dedicated Target checkout page is unavailable.");
  }
  if (!buyNow && checkoutPage === job.page) {
    throw new Error("Cart-based Target checkout must use a distinct checkout page.");
  }

  let result;
  try {
    result = await checkoutRunner({
      page: checkoutPage,
      expectedProductIds: [job.product.id],
      purchaseGuardConfig: job.purchaseGuardConfig,
      buyNow,
      stopBeforeSubmit,
      shouldPause: () => monitorState.isPaused(),
      handleVerification: async (page) => {
        const checkoutJob = { ...job, page };
        return handleChallenge(
          checkoutJob,
          monitorState,
          `verification during checkout for ${job.product.id}`,
          { ...challengeOptions, mutationOwned: true },
        );
      },
    });
  } catch (checkoutError) {
    error(`${job.product.id} CHECKOUT_RUNNER_FAILED ${checkoutError.message}`);
    job.terminal = true;
    monitorState.stopForSafety("checkout-runner-failed", {
      productId: job.product.id,
      requestedMode: job.requestedMode,
    });
    return "blocked";
  }
  if (result === "ready-to-submit") {
    job.terminal = true;
    monitorState.stopForSafety("ready-to-submit", {
      productId: job.product.id,
      requestedMode: job.requestedMode,
    });
    return result;
  }
  if (result === "ambiguous") {
    job.terminal = true;
    monitorState.stopForSafety("ambiguous-place-order-outcome", {
      productId: job.product.id,
      requestedMode: job.requestedMode,
    });
    return result;
  }
  if (result !== "confirmed") {
    if (result === "blocked" && !monitorState.isPaused()) {
      job.terminal = true;
      monitorState.stopForSafety("checkout-blocked", {
        productId: job.product.id,
        requestedMode: job.requestedMode,
      });
    }
    return result;
  }

  job.completed = true;
  monitorState.markOrderConfirmed(job.product.id, job.purchaseMode);
  await notify(
    `✅ **Target order confirmed** via ${job.purchaseMode}\n${job.product.id}\n${job.product.url}`,
  );
  return "confirmed";
}

async function reconcilePendingCart(job, monitorState, {
  notify = sendDiscordAlert,
  challengeOptions = {},
  checkoutRunner = runTargetCheckout,
} = {}) {
  if (job.completed || job.terminal || monitorState.isPaused()) {
    return;
  }
  const challengeResult = await handleChallenge(
    job,
    monitorState,
    `verification after ${job.purchaseMode} for ${job.product.id}`,
    { ...challengeOptions, mutationOwned: true },
  );
  if (challengeResult === "blocked") {
    return;
  }
  if (challengeResult === "resolved") {
    await job.page.waitForTimeout(1000);
  }

  if (await closeNotAddedDialog(job.page)) {
    console.log(`${job.product.id} ITEM_NOT_ADDED_TO_CART`);
    job.pendingCartReconciliation = false;
    job.purchaseMode = null;
    monitorState.releasePurchase(job.product.id);
    await notify(
      `⚠️ Target showed **Item not added to cart** for ${job.product.id}. Monitoring continues.\n${job.product.url}`,
    );
    return "not-added";
  }

  const body = await job.page.locator("body").innerText().catch(() => "");
  if (!isCartSuccess(job.page.url(), body)) {
    console.log(`${job.product.id} PURCHASE_RESULT_UNCONFIRMED`);
    return "pending";
  }

  job.pendingCartReconciliation = false;
  job.addedToCart = true;
  console.log(`${job.product.id} PURCHASE_ADDED_TO_CART`);
  await notify(
    `✅ **Added to Target cart** via ${job.purchaseMode}; checkout started immediately.\n${job.product.id}\n${job.product.url}`,
  );
  return continueCheckout(job, monitorState, {
    notify,
    challengeOptions,
    checkoutRunner,
  });
}

/**
 * Purchase mutation; caller owns enqueueMutation. Add/Preorder retries until cart
 * evidence exists, then the dedicated checkout tab takes over immediately. Buy
 * now stays on the PDP and drives its order side panel through the same checkout
 * state machine. Only one product may own the shared Target transaction.
 */
async function triggerPurchase(job, monitorState, source, summary, candidate, {
  notify = sendDiscordAlert,
  challengeOptions = {},
  checkoutRunner = runTargetCheckout,
  cartHandshake = observeCartHandshake,
} = {}) {
  if (
    job.triggered ||
    job.completed ||
    monitorState.isPaused() ||
    !monitorState.canAttemptPurchase(job.product.id)
  ) {
    return;
  }
  job.triggered = true;
  let alertPromise = Promise.resolve();
  let inputMayHaveBeenSent = false;
  let ownerClaimed = false;
  const candidateMode =
    candidate.mode || purchaseModeFromLabel(candidate.label);

  try {
    if (
      !candidateMode ||
      (job.requestedMode !== "auto" && candidateMode !== job.requestedMode) ||
      (job.requestedMode === "auto" && candidateMode === "buy-now")
    ) {
      throw new Error("PURCHASE_MODE_MISMATCH");
    }
    if (!validatePdpIdentity(job.page.url(), job.product.id)) {
      throw new Error("PDP_IDENTITY_VALIDATION_FAILED");
    }
    if (!monitorState.claimPurchase(job.product.id, job.requestedMode)) {
      return;
    }
    ownerClaimed = true;
    alertPromise = notify(
      availabilityMessage(job, source, candidate.label, summary),
    );
    await candidate.button.hover({ timeout: 3000 }).catch(() => {});
    await job.page.waitForTimeout(150 + Math.floor(Math.random() * 251));
    inputMayHaveBeenSent = true;
    if (candidateMode === "buy-now") {
      job.purchaseMode = "buy-now";
    } else {
      job.purchaseMode = candidateMode;
      job.pendingCartReconciliation = true;
    }
    let handshake = null;
    if (candidateMode === "buy-now") {
      await candidate.button.click({ timeout: 5000 });
      await job.page.waitForTimeout(5000);
    } else {
      handshake = await cartHandshake(
        job.page,
        () => candidate.button.click({ timeout: 5000 }),
      );
      if (handshake.rateLimited) {
        if (!monitorState.isPaused()) {
          const event = handshake.mutation?.status === 429
            ? handshake.mutation
            : handshake.reconciliation;
          monitorState.pauseForRateLimit(
            `cart handshake 429 for ${job.product.id}`,
            event?.retryAfterMs || 0,
          );
        }
        return;
      }
      const failedEvent = [handshake.mutation, handshake.reconciliation].find(
        (event) => event && (event.status < 200 || event.status >= 300),
      );
      if (failedEvent) {
        console.error(
          `${job.product.id} CART_HANDSHAKE_FAILED ${JSON.stringify(failedEvent)}`,
        );
        return;
      }
    }

    const postClick = await handleChallenge(
      job,
      monitorState,
      `verification after ${candidate.label} for ${job.product.id}`,
      { ...challengeOptions, mutationOwned: true },
    );
    if (postClick === "blocked") {
      return;
    }
    if (postClick === "resolved") {
      await job.page.waitForTimeout(1000);
    }

    if (candidateMode === "buy-now") {
      console.log(`${job.product.id} BUY_NOW_PANEL_OPENED`);
      const outcome = await continueCheckout(job, monitorState, {
        notify,
        challengeOptions,
        checkoutRunner,
      });
      if (outcome === "retry") {
        if (validatePdpIdentity(job.page.url(), job.product.id)) {
          job.purchaseMode = null;
          monitorState.releasePurchase(job.product.id);
        } else {
          job.terminal = true;
          monitorState.stopForSafety("buy-now-panel-outcome-unclear", {
            productId: job.product.id,
            requestedMode: job.requestedMode,
          });
        }
      }
      return;
    }

    if (await closeNotAddedDialog(job.page)) {
      console.log(`${job.product.id} ITEM_NOT_ADDED_TO_CART`);
      job.pendingCartReconciliation = false;
      job.purchaseMode = null;
      monitorState.releasePurchase(job.product.id);
      await notify(
        `⚠️ Target showed **Item not added to cart** for ${job.product.id}. Monitoring continues.\n${job.product.url}`,
      );
      return;
    }

    const body = await job.page.locator("body").innerText().catch(() => "");
    if (isCartSuccess(job.page.url(), body)) {
      job.pendingCartReconciliation = false;
      job.addedToCart = true;
      console.log(`${job.product.id} PURCHASE_ADDED_TO_CART`);
      await notify(
        `✅ **Added to Target cart** via ${candidate.label}; checkout started immediately.\n${job.product.id}\n${job.product.url}`,
      );
      await continueCheckout(job, monitorState, {
        notify,
        challengeOptions,
        checkoutRunner,
      });
      return;
    }
    console.log(`${job.product.id} PURCHASE_RESULT_UNCONFIRMED`);
    console.log(`${job.product.id} PURCHASE_RESULT_UNCONFIRMED`);
  } catch (error) {
    console.error(`${job.product.id} PURCHASE_ACTION_FAILED ${error.message}`);
    if (ownerClaimed && candidateMode === "buy-now" && inputMayHaveBeenSent) {
      job.terminal = true;
      monitorState.stopForSafety("buy-now-action-outcome-unclear", {
        productId: job.product.id,
        requestedMode: job.requestedMode,
      });
    } else if (ownerClaimed && !inputMayHaveBeenSent) {
      monitorState.releasePurchase(job.product.id);
    }
  } finally {
    job.triggered = false;
    await alertPromise;
  }
}

async function inspectAndTrigger(job, monitorState, source, summary) {
  const candidate = await findPurchaseButton(job.page, job.requestedMode);
  if (!candidate) {
    return false;
  }

  if (observeOnly) {
    console.log(
      `${job.product.id} OBSERVE_ONLY_ACTION_AVAILABLE source=${JSON.stringify(source)} label=${JSON.stringify(candidate.label)}`,
    );
    return true;
  }

  await monitorState.enqueueMutation(() =>
    triggerPurchase(job, monitorState, source, summary, candidate),
  );
  return true;
}

/**
 * One tick, normally invoked through enqueueGlobalPoll. Priority is deferred
 * challenge -> obtain/refresh a template -> replay one request -> inspect stock.
 * evaluate(fetch) deliberately uses this page's cookie jar, not a bare HTTP client.
 */
async function pollAvailability(job, monitorState) {
  if (
    job.completed ||
    job.terminal ||
    monitorState.isPaused() ||
    !monitorState.canAttemptPurchase(job.product.id)
  ) {
    return;
  }

  if (job.pendingCartReconciliation) {
    await monitorState.enqueueMutation(() =>
      reconcilePendingCart(job, monitorState),
    );
    return;
  }

  if (job.addedToCart || job.purchaseMode === "buy-now") {
    const outcome = await monitorState.enqueueMutation(() =>
      continueCheckout(job, monitorState),
    );
    if (outcome === "retry" && job.purchaseMode === "buy-now") {
      if (validatePdpIdentity(job.page.url(), job.product.id)) {
        job.purchaseMode = null;
        monitorState.releasePurchase(job.product.id);
      } else {
        job.terminal = true;
        monitorState.stopForSafety("buy-now-panel-outcome-unclear", {
          productId: job.product.id,
          requestedMode: job.requestedMode,
        });
      }
    }
    return;
  }

  job.pollCount += 1;
  if (job.challengeSignal) {
    const reason = job.challengeSignal;
    job.challengeSignal = null;
    await job.page
      .goto(job.product.url, { waitUntil: "domcontentloaded", timeout: 20000 })
      .catch(() => {});
    await job.page.waitForTimeout(750);
    if (
      (await handleChallenge(job, monitorState, reason, { assumeDetected: true })) ===
      "blocked"
    ) {
      return;
    }
    job.availabilityRequest = null;
    job.nextNavigationAt = 0;
    return;
  }
  if (!job.availabilityRequest) {
    if (Date.now() >= job.nextNavigationAt) {
      job.nextNavigationAt = Date.now() + 60000;
      await navigateProduct(job, monitorState);
    } else {
      await inspectAndTrigger(job, monitorState, "product page", job.lastSummary);
    }
    return;
  }
  if (job.pollCount % domRefreshEvery === 0) {
    await navigateProduct(job, monitorState);
    return;
  }

  const endpointUrl =
    replaceEndpointProduct(job.availabilityRequest.url, job.product.tcin) ||
    job.availabilityRequest.url;
  const requestTemplate = {
    ...job.availabilityRequest,
    url: endpointUrl,
  };
  let result;
  const requestStartedAt = Date.now();
  try {
    result = await job.page.evaluate(async (request) => {
      const response = await fetch(request.url, {
        method: request.method,
        body: request.postData || undefined,
        credentials: "include",
        cache: "no-store",
        headers: request.headers,
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        body: await response.text(),
      };
    }, requestTemplate);
  } catch (error) {
    monitorState.recordApiPoll({
      productId: job.product.id,
      status: 0,
      latencyMs: Date.now() - requestStartedAt,
      outcome: "fetch_error",
    });
    console.error(`${job.product.id} AVAILABILITY_FETCH_FAILED ${error.message}`);
    job.availabilityRequest = null;
    job.nextNavigationAt = Date.now() + 60000;
    return;
  }

  const challenged = isChallengeResponse(result);
  // Record transport evidence before parsing. A logged HTTP 200 alone is not
  // sufficient acceptance evidence: JSON parsing/availability validation follows.
  monitorState.recordApiPoll({
    productId: job.product.id,
    status: result.status,
    latencyMs: Date.now() - requestStartedAt,
    outcome: challenged ? "challenge" : "response",
  });

  if (challenged) {
    const reason = `availability challenge ${result.status} for ${job.product.id}`;
    // Load the PDP so an interstitial renders where the solver can act on it.
    await job.page
      .goto(job.product.url, { waitUntil: "domcontentloaded", timeout: 20000 })
      .catch(() => {});
    await job.page.waitForTimeout(750);
    const handled = await handleChallenge(job, monitorState, reason, {
      assumeDetected: true,
    });
    if (handled === "blocked") {
      return;
    }
    // The replayed request template may be stale after an interstitial.
    job.availabilityRequest = null;
    job.nextNavigationAt = 0;
    return;
  }

  let summary;
  try {
    summary = summarizeAvailabilityPayload(JSON.parse(result.body), job.product);
  } catch (error) {
    monitorState.stopCalibration(`non-JSON availability response for ${job.product.id}`);
    console.error(`${job.product.id} AVAILABILITY_RESPONSE_NOT_JSON`);
    return;
  }

  job.lastSummary = summary;
  const fingerprint = JSON.stringify(summary);
  if (fingerprint !== job.lastFingerprint) {
    job.lastFingerprint = fingerprint;
    console.log(`${job.product.id} AVAILABILITY ${fingerprint}`);
  }

  if (summary?.available) {
    await navigateProduct(job, monitorState);
  } else {
    await inspectAndTrigger(job, monitorState, "product page", summary);
  }
}

/**
 * Shared coordinator for all product jobs in this worker.
 * - Mutation queue: only one cart/challenge action; deliberately non-reentrant.
 * - Request queue: serialized poll ticks plus cooldown between completed ticks.
 * - pausedUntil: temporary shared backoff after challenge or cart throttling.
 * - calibrationStopped: terminal observe-only error; a later solve never clears it.
 * - challengePending: validation-mode barrier until the current poll resolves/stops.
 *
 * Overrides isolate clock, logging, and alerts in tests. runtimeMs is checked
 * between operations; it does not cancel an already running navigation/solve.
 * @param {object} [options]
 * @param {boolean} [options.observe] Disable alerts/enable diagnostic stop rules.
 * @param {boolean} [options.validation] Permit verified API-challenge recovery.
 * @param {number} [options.maximumPolls] Recorded API-poll limit; zero is unlimited.
 * @param {number} [options.runtimeMs] Run limit checked between operations; zero disables.
 * @param {() => number} [options.now] Millisecond clock for pause/runtime decisions.
 * @param {(message: string) => Promise<void>} [options.notify] Alert transport.
 * @param {(message: string) => void} [options.log] Normal state/poll log sink.
 * @param {(message: string) => void} [options.error] Pause/stop log sink.
 * @returns Shared monitor methods; the solver never receives this object.
 */
function createMonitorState({
  observe = observeOnly,
  validation = validateChallenges,
  maximumPolls = maximumApiPolls,
  runtimeMs = maximumRuntimeMs,
  now = Date.now,
  notify = sendDiscordAlert,
  log = console.log,
  error = console.error,
} = {}) {
  let challengeAttempt = 0;
  let pausedUntil = 0;
  let mutationQueue = Promise.resolve();
  let calibrationStopped = false;
  let challengePending = false;
  let purchaseOwner = null;
  let confirmedOrder = null;
  let terminalStop = null;
  const startedAt = now();
  const apiPolls = [];
  const cartResponses = [];
  const observedCartResponses = new WeakSet();
  const challengeSolves = [];
  const requestQueue = new GlobalRequestQueue({
    cooldownMs: globalPollDelayMs,
    jitterRatio: 0.1,
    wait,
  });

  const state = {
    canAttemptPurchase(productId) {
      return (
        !confirmedOrder &&
        !terminalStop &&
        (!purchaseOwner || purchaseOwner === productId)
      );
    },
    claimPurchase(productId) {
      if (!state.canAttemptPurchase(productId)) {
        return false;
      }
      purchaseOwner = productId;
      return true;
    },
    purchaseOwner() {
      return purchaseOwner;
    },
    releasePurchase(productId) {
      if (!confirmedOrder && purchaseOwner === productId) {
        purchaseOwner = null;
      }
    },
    markOrderConfirmed(productId, mode) {
      if (purchaseOwner && purchaseOwner !== productId) {
        throw new Error("Order confirmation does not match the purchase owner.");
      }
      purchaseOwner = productId;
      confirmedOrder = { productId, mode, at: new Date().toISOString() };
      log(`TARGET_ORDER_CONFIRMED ${JSON.stringify(confirmedOrder)}`);
    },
    isOrderConfirmed() {
      return Boolean(confirmedOrder);
    },
    isPaused() {
      return now() < pausedUntil;
    },
    remainingPauseMs() {
      return Math.max(0, pausedUntil - now());
    },
    remainingRuntimeMs() {
      return runtimeMs > 0 ? Math.max(0, startedAt + runtimeMs - now()) : Infinity;
    },
    pauseForChallenge(reason) {
      if (now() < pausedUntil) {
        return;
      }
      const delay = calculateBackoffMs(
        challengeAttempt,
        challengeBaseDelayMs,
        challengeMaximumDelayMs,
      );
      challengeAttempt += 1;
      pausedUntil = now() + delay;
      calibrationStopped ||= observe;
      error(`TARGET_CHALLENGE_BACKOFF ${delay}ms ${reason}`);
      if (!observe) {
        void notify(
          `🛑 **Target monitoring paused for ${Math.ceil(delay / 60000)} minute(s)**\nReason: ${reason}`,
        );
      }
    },
    pauseForRateLimit(reason, retryAfterMs = 0) {
      if (now() < pausedUntil) {
        if (retryAfterMs > state.remainingPauseMs()) {
          pausedUntil = now() + retryAfterMs;
          error(`TARGET_RATE_LIMIT_EXTENDED ${retryAfterMs}ms ${reason}`);
        }
        return;
      }
      const backoff = calculateBackoffMs(
        challengeAttempt,
        cartRateLimitBaseDelayMs,
        challengeMaximumDelayMs,
      );
      const delay = Math.max(backoff, retryAfterMs || 0);
      challengeAttempt += 1;
      pausedUntil = now() + delay;
      calibrationStopped ||= observe;
      error(`TARGET_RATE_LIMIT_BACKOFF ${delay}ms ${reason}`);
      if (!observe) {
        void notify(
          `🛑 **Target cart traffic paused for ${Math.ceil(delay / 60000)} minute(s)**\nReason: ${reason}`,
        );
      }
    },
    clearChallengeBackoff() {
      if (pausedUntil > 0 && now() >= pausedUntil) {
        pausedUntil = 0;
      }
    },
    recordChallengeSolved(kind, attempts, productId = null) {
      challengeAttempt = 0;
      pausedUntil = 0;
      challengePending = false;
      // Never clear calibrationStopped: unrelated errors and normal observe-only
      // stop-on-challenge behavior remain terminal, even if a solver later succeeds.
      challengeSolves.push({
        at: new Date().toISOString(),
        kind,
        attempts,
        ...(productId ? { productId } : {}),
      });
      log(`TARGET_CHALLENGE_SOLVED ${JSON.stringify(challengeSolves.at(-1))}`);
      if (!observe) {
        void notify(
          `🧩 Target **${kind}** challenge solved after ${attempts} attempt(s); monitoring resumed.`,
        );
      }
    },
    stopForSafety(reason, fields = {}) {
      if (!terminalStop) {
        terminalStop = {
          reason,
          at: new Date().toISOString(),
          ...fields,
        };
        error(`TARGET_TERMINAL_SAFETY_STOP ${JSON.stringify(terminalStop)}`);
      }
    },
    enqueueMutation(action) {
      // Absorb rejection only in the stored tail so later actions can proceed.
      // The caller still receives the original rejecting promise for its action.
      const result = mutationQueue.then(action, action);
      mutationQueue = result.catch(() => {});
      return result;
    },
    enqueueGlobalPoll(action) {
      return requestQueue.enqueue(async () => {
        if (!state.isPaused() && !state.shouldStop() && !challengePending) {
          return action();
        }
      });
    },
    recordCartResponse(result, identity = null, source = null) {
      if (identity && typeof identity === "object") {
        if (observedCartResponses.has(identity)) {
          return;
        }
        observedCartResponses.add(identity);
      }
      const event = {
        at: new Date().toISOString(),
        source,
        ...result,
      };
      cartResponses.push(event);
      log(`TARGET_CART_TRAFFIC ${JSON.stringify(event)}`);
      if (result.status === 429) {
        state.pauseForRateLimit(
          `cart ${result.kind} 429${source ? ` on ${source}` : ""}`,
          result.retryAfterMs,
        );
      }
    },
    recordApiPoll(result) {
      apiPolls.push({ at: new Date().toISOString(), ...result });
      if (observe && validation && result.outcome === "challenge") {
        // The current poll must resolve or stop before another request is allowed.
        challengePending = true;
      } else if (
        observe &&
        (result.outcome !== "response" || result.status < 200 || result.status >= 300)
      ) {
        calibrationStopped = true;
      }
      log(`TARGET_API_POLL ${JSON.stringify(apiPolls.at(-1))}`);
    },
    stopCalibration(reason) {
      if (observe) {
        calibrationStopped = true;
        error(`TARGET_CALIBRATION_STOPPED ${reason}`);
      }
    },
    shouldStop() {
      return (
        calibrationStopped ||
        Boolean(terminalStop) ||
        state.remainingRuntimeMs() <= 0 ||
        (maximumPolls > 0 && apiPolls.length >= maximumPolls)
      );
    },
    calibrationSummary() {
      const statusCounts = {};
      for (const poll of apiPolls) {
        const key = String(poll.status);
        statusCounts[key] = (statusCounts[key] || 0) + 1;
      }
      const latencies = apiPolls.map((poll) => poll.latencyMs).sort((a, b) => a - b);
      const percentile = (ratio) =>
        latencies.length > 0
          ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * ratio))]
          : null;
      return {
        observeOnly: observe,
        challengeValidation: validation,
        challengePending,
        maximumRuntimeMs: runtimeMs,
        configuredCooldownMs: globalPollDelayMs,
        products: concurrentJobLimit,
        apiPolls: apiPolls.length,
        statusCounts,
        // This counts challenged API polls, not every DOM-only interstitial.
        // A page-level solve can therefore coexist with challengeCount === 0.
        challengeCount: apiPolls.filter((poll) => poll.outcome === "challenge").length,
        challengeSolvedCount: challengeSolves.length,
        challengeSolverConfigured: Boolean(challengeSolver),
        purchaseOwner,
        confirmedOrder,
        terminalStop,
        fetchErrorCount: apiPolls.filter((poll) => poll.outcome === "fetch_error").length,
        cartResponses: cartResponses.length,
        cartRateLimitCount: cartResponses.filter((event) => event.status === 429).length,
        cartStatusCounts: cartResponses.reduce((counts, event) => {
          const key = String(event.status);
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}),
        latencyP50Ms: percentile(0.5),
        latencyP95Ms: percentile(0.95),
        queue: requestQueue.snapshot(),
      };
    },
  };

  return state;
}

async function main() {
  const resolvedArgs = await resolveProductArgs(process.argv.slice(2));
  const configuredJobs = parseProducts(resolvedArgs);
  if (validateChallenges && (!observeOnly || !challengeSolver)) {
    throw new Error("TARGET_CHALLENGE_VALIDATE requires observe-only mode and a configured solver.");
  }
  const purchaseGuardConfig = readPurchaseGuardConfig(process.env, {
    required: !observeOnly,
  });
  if (!observeOnly) {
    await verifyDiscordConfiguration();
  }

  const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 5000 });
  // The first context retains the user's existing authentication/cart state.
  // Never replace it with browser.newContext() to make operational tests "clean".
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("Authenticated Chrome has no browser context.");
  }

  const monitorState = createMonitorState();
  const jobs = [];
  const checkoutPage = observeOnly ? null : await context.newPage();
  const stopCheckoutCartMonitor = checkoutPage
    ? attachCartResponseMonitor(checkoutPage, monitorState, "checkout")
    : () => {};
  try {
    for (const configured of configuredJobs) {
      if (monitorState.shouldStop() || monitorState.isOrderConfirmed()) {
        break;
      }
      const job = {
        product: configured.product,
        requestedMode: configured.requestedMode,
        page: await context.newPage(),
        availabilityRequest: null,
        lastSummary: null,
        lastFingerprint: null,
        pollCount: 0,
        challengeSignal: null,
        nextNavigationAt: 0,
        triggered: false,
        addedToCart: false,
        purchaseMode: null,
        checkoutPage,
        completed: false,
        terminal: false,
        pendingCartReconciliation: false,
        purchaseGuardConfig,
      };
      await attachResponseMonitor(job, monitorState);
      jobs.push(job);
      await navigateProduct(job, monitorState);
      await wait(1500);
    }

    console.log(
      `TARGET_MONITOR_STARTED products=${configuredJobs.length} globalPollMs=${globalPollDelayMs} observeOnly=${observeOnly} maxApiPolls=${maximumApiPolls} driver=${browserDriverName}`,
    );

    while (
      jobs.some((job) => !job.completed) &&
      !monitorState.shouldStop() &&
      !monitorState.isOrderConfirmed()
    ) {
      if (monitorState.isPaused()) {
        const delay = Math.min(
          monitorState.remainingPauseMs(),
          monitorState.remainingRuntimeMs(),
        );
        console.log(`TARGET_MONITOR_PAUSED ${delay}ms`);
        await wait(delay);
        monitorState.clearChallengeBackoff();
        continue;
      }

      for (const job of jobs) {
        if (job.completed || job.terminal) {
          continue;
        }
        await monitorState.enqueueGlobalPoll(() =>
          pollAvailability(job, monitorState),
        );
        if (monitorState.isPaused()) {
          break;
        }
      }
    }

    if (monitorState.isOrderConfirmed()) {
      console.log("TARGET_PURCHASE_COMPLETE");
    } else if (monitorState.shouldStop()) {
      console.log("TARGET_MONITOR_STOP_LIMIT_OR_ERROR");
    } else {
      console.log("ALL_TARGET_PRODUCTS_COMPLETED");
    }
  } finally {
    stopCheckoutCartMonitor();
    console.log(
      `TARGET_CALIBRATION_SUMMARY ${JSON.stringify({
        ...monitorState.calibrationSummary(),
        products: configuredJobs.length,
      })}`,
    );
    if (keepDiagnosticPage) {
      console.log(`TARGET_DIAGNOSTIC_PAGES_PRESERVED count=${jobs.length}`);
    } else {
      await Promise.all(jobs.map((job) => job.page.close().catch(() => {})));
      await checkoutPage?.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  attachCartResponseMonitor,
  attachResponseMonitor,
  continueCheckout,
  createMonitorState,
  findPurchaseButton,
  handleChallenge,
  inspectAndTrigger,
  navigateProduct,
  parseJobArgument,
  parseProducts,
  pollAvailability,
  reconcilePendingCart,
  resolveProductArgs,
  triggerPurchase,
};
