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
  checkoutUrl,
  findProductFulfillmentControl,
  observeCartHandshake,
  parseRetryAfterMs,
  purchaseEvidenceFromCartView,
  readPurchaseGuardConfig,
  runTargetCheckout,
  hasPageSignIn,
  validatePurchaseEvidence,
  validatePdpIdentity,
} = require("./target-checkout");
const { clearTargetContextSession } = require("./src/target-session-reset");

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
 * @property {"preorder"|"add-to-cart"|"buy-now"|"auto"|"direct-buy"} requestedMode
 * @property {boolean} pendingCartReconciliation Cart input was sent without a final result.
 * @property {boolean} redirectedCartCheckout The PDP redirected to /cart, so
 *   that same tab now owns checkout without inspecting the cart page.
 * @property {boolean} needsRearm A distinct order was confirmed; discard its
 *   checkout state and reload the PDP before another purchase attempt.
 * @property {boolean} submittedThisAttempt A new Place-order click completed
 *   in this transaction; an old confirmation page cannot count as a new order.
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
const multiDirectBuyEnabled = /^(?:1|true|yes)$/i.test(
  process.env.TARGET_MULTI_DIRECT_BUY || "",
);
const maximumJobs = multiDirectBuyEnabled ? 8 : 3;
const requestedMaximumJobs = Number.parseInt(
  process.env.TARGET_MAX_CONCURRENT || String(maximumJobs),
  10,
);
const concurrentJobLimit = Math.max(
  1,
  Math.min(maximumJobs, requestedMaximumJobs || maximumJobs),
);
const globalPollDelayMs = Math.max(
  1000,
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
const discordAlertsEnabled = !/^(?:1|true|yes)$/i.test(
  process.env.TARGET_DISABLE_DISCORD_ALERTS || "",
);
const refreshChallengeAfterCycle = /^(?:1|true|yes)$/i.test(
  process.env.TARGET_CHALLENGE_REFRESH_AFTER_CYCLE || "",
);
const resetSessionOnStuck = /^(?:1|true|yes)$/i.test(
  process.env.TARGET_SESSION_RESET_ON_STUCK || "",
);

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function invalidateAvailabilityRequest(job) {
  job.availabilityRequest = null;
  job.challengeSignal = null;
  job.lastSummary = null;
  job.lastFingerprint = null;
  job.nextNavigationAt = 0;
}

async function waitForPausedPages(
  jobs,
  monitorState,
  {
    inspect = inspectChallenge,
    waitFor = wait,
    intervalMs = 1000,
  } = {},
) {
  while (monitorState.isPaused()) {
    if (!monitorState.isChallengePaused()) {
      await waitFor(monitorState.remainingPauseMs());
      return false;
    }

    const pausedProductIds = monitorState.challengePauseProductIds();
    for (const job of jobs) {
      if (job.completed || job.terminal) {
        continue;
      }
      if (
        pausedProductIds.length > 0 &&
        !pausedProductIds.includes(job.product.id)
      ) {
        continue;
      }
      // A matched cart makes the checkout tab the challenge owner. A readable
      // product tab must not clear a verification pause on checkout.
      const challengePage = job.addedToCart && job.checkoutPage
        ? job.checkoutPage
        : (job.preflightChallengePending ||
            (job.requestedMode === "direct-buy" &&
              job.pendingCartReconciliation)) &&
            job.preflightPage
          ? job.preflightPage
          : job.page;
      let detection;
      try {
        detection = await inspect(challengePage);
      } catch (error) {
        detection = null;
      }
      if (
        detection &&
        !detection.detected &&
        !detection.unreadable &&
        await waitForStableChallengeClear(challengePage, {
          inspect,
          waitFor,
          settleMs: intervalMs,
        })
      ) {
        invalidateAvailabilityRequest(job);
        if (!monitorState.releaseChallengeProduct(job.product.id)) {
          continue;
        }
        console.log(`TARGET_CHALLENGE_PAGE_CLEARED product=${job.product.id}`);
        return true;
      }
    }
    await waitFor(Math.min(intervalMs, monitorState.remainingPauseMs()));
  }
  return false;
}

async function waitForStableChallengeClear(
  page,
  {
    inspect = inspectChallenge,
    waitFor = wait,
    settleMs = challengeSettleMs,
    requiredReads = 2,
  } = {},
) {
  for (let read = 0; read < requiredReads; read += 1) {
    const detection = await inspect(page);
    if (detection.detected || detection.unreadable) {
      return false;
    }
    if (read + 1 < requiredReads) {
      await waitFor(settleMs);
    }
  }
  return true;
}

async function waitForTargetSignIn(
  page,
  productId,
  {
    inspect = hasPageSignIn,
    waitFor = wait,
    intervalMs = 1000,
    log = console.log,
  } = {},
) {
  let waiting = false;
  while (!page.isClosed()) {
    let required;
    try {
      required = await inspect(page);
    } catch (error) {
      required = true;
    }
    if (!required) {
      if (waiting) {
        log(`TARGET_SIGN_IN_CLEARED product=${productId} - resuming`);
      }
      return "resolved";
    }
    if (!waiting) {
      log(`TARGET_SIGN_IN_REQUIRED product=${productId} - waiting for manual completion`);
      waiting = true;
    }
    await waitFor(intervalMs);
  }
  return "blocked";
}

function parseJobArgument(value) {
  const input = String(value || "").trim();
  if (/^https:\/\//i.test(input)) {
    return { requestedMode: "auto", url: input };
  }
  const separator = input.indexOf("=");
  if (separator <= 0) {
    throw new Error(
      "Each Target job must use preorder=url, add-to-cart=url, buy-now=url, or direct-buy=url.",
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

function parseProducts(args, {
  jobLimit = concurrentJobLimit,
  requireDirectBuy = multiDirectBuyEnabled,
} = {}) {
  const configuredJobs = args.map((value) =>
    typeof value === "string" ? parseJobArgument(value) : value,
  );
  if (configuredJobs.length === 0) {
    throw new Error(
      "Pass one to three Target mode=url jobs after the command.",
    );
  }
  if (configuredJobs.length > jobLimit) {
    throw new Error(
      `Received ${configuredJobs.length} products; the configured maximum is ${jobLimit}.`,
    );
  }
  if (
    requireDirectBuy &&
    configuredJobs.some((job) => job.requestedMode !== "direct-buy")
  ) {
    throw new Error("Target watchlist mode requires direct-buy for every product.");
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

async function acquireProductPage(
  context,
  product,
  {
    inspect = inspectChallenge,
    reuseClearProductPage = false,
  } = {},
) {
  const matchingPages = context
    .pages()
    .filter((page) => targetProductFromUrl(page.url())?.id === product.id);
  let detectedPage = null;
  for (const page of matchingPages) {
    const detection = await inspect(page).catch(() => null);
    if (detection?.kind === "press_and_hold") {
      return page;
    }
    if (detection?.detected && !detectedPage) {
      detectedPage = page;
    }
  }
  // A restarted watchlist owns the same set of product URLs. Reuse a clear
  // matching tab instead of accumulating one more tab for every product.
  // A single-product direct buy keeps its existing user-tab isolation policy.
  return detectedPage ||
    (reuseClearProductPage ? matchingPages[0] : null) ||
    context.newPage();
}

async function closeNewProductPages(jobs, initiallyOpenPages) {
  // A reused tab belongs to the existing browser session. Close only product
  // tabs this worker created; restart and shutdown must preserve older tabs.
  await Promise.all(
    jobs
      .filter((job) => !initiallyOpenPages.has(job.page))
      .map((job) => job.page.close().catch(() => {})),
  );
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
  if (!discordAlertsEnabled) {
    return;
  }
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
  refreshAfterCycle = refreshChallengeAfterCycle,
  inspect = inspectChallenge,
  resetSession = resetSessionOnStuck,
} = {}) {
  const detection = await inspect(job.page);
  if (!detection.detected) {
    if (!assumeDetected) {
      return "clear";
    }
    invalidateAvailabilityRequest(job);
    monitorState.pauseForChallenge(
      `${reason} (no page-level evidence)`,
      { fixed: true, productId: job.product.id },
    );
    return "blocked";
  }

  if (detection.unreadable) {
    // A readable Press & Hold control on another tab is not evidence that
    // this page supports solver input. Fail closed on this page's own state.
    invalidateAvailabilityRequest(job);
    monitorState.pauseForChallenge(
      `${reason} (unreadable page state)`,
      { fixed: true, productId: job.product.id },
    );
    return "blocked";
  }

  console.error(
    `TARGET_CHALLENGE_DETECTED kind=${detection.kind} product=${job.product.id} reason=${reason}`,
  );
  if (!solver) {
    invalidateAvailabilityRequest(job);
    monitorState.pauseForChallenge(
      `${reason} (${detection.kind}, no solver)`,
      { productId: job.product.id },
    );
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
    verifyCleared: async () =>
      waitForStableChallengeClear(job.page, {
        inspect,
        waitFor: waitFor,
        settleMs,
      }),
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
    job.challengeCycles = 0;
    return "resolved";
  }

  if (refreshAfterCycle && detection.kind === "press_and_hold") {
    const refresh = async () => {
      console.log(
        `TARGET_CHALLENGE_REFRESH_AFTER_ATTEMPTS product=${job.product.id}`,
      );
      try {
        await job.page.reload({
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await job.page.waitForTimeout(750);
      } catch (refreshError) {
        console.error(
          `TARGET_CHALLENGE_REFRESH_FAILED product=${job.product.id}`,
        );
        return false;
      }
      if (await waitForStableChallengeClear(job.page, {
        inspect,
        waitFor,
        settleMs,
      })) {
        invalidateAvailabilityRequest(job);
        monitorState.clearChallengeBackoff(true);
        console.log(
          `TARGET_CHALLENGE_REFRESH_CLEARED product=${job.product.id}`,
        );
        return true;
      }
      return false;
    };
    const refreshed = await (
      mutationOwned ? refresh() : monitorState.enqueueMutation(refresh)
    );
    if (refreshed) {
      job.challengeCycles = 0;
      return "resolved";
    }
  }

  job.challengeCycles = (job.challengeCycles || 0) + 1;
  if (resetSession && job.challengeCycles >= 2 && job.context) {
    const reset = async () => {
      console.error(
        `TARGET_SESSION_RESET_STARTED product=${job.product.id}`,
      );
      try {
        const result = await clearTargetContextSession(job.context);
        invalidateAvailabilityRequest(job);
        job.challengeCycles = 0;
        console.log(
          `TARGET_SESSION_RESET_COMPLETED product=${job.product.id} clearedCookies=${result.clearedCookies}`,
        );
        return true;
      } catch (resetError) {
        console.error(
          `TARGET_SESSION_RESET_FAILED product=${job.product.id}`,
        );
        return false;
      }
    };
    const resetResult = await (
      mutationOwned ? reset() : monitorState.enqueueMutation(reset)
    );
    if (resetResult) {
      monitorState.clearChallengeBackoff(true);
      await job.page
        .reload({ waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => {});
      return "resolved";
    }
  }

  invalidateAvailabilityRequest(job);
  monitorState.pauseForChallenge(
    `${reason} (${detection.kind}, solve ${result.outcome}${result.error ? `: ${result.error}` : ""})`,
    { productId: job.product.id },
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

async function selectProductFulfillment(
  job,
  {
    findControl = findProductFulfillmentControl,
    waitFor = wait,
    log = console.log,
  } = {},
) {
  const expectedFulfillment = job.purchaseGuardConfig?.expectedFulfillment;
  if (!expectedFulfillment) {
    return "not-configured";
  }
  const fulfillment = await findControl(job.page, expectedFulfillment);
  if (fulfillment?.selected) {
    return "selected";
  }
  if (fulfillment?.ambiguous || !fulfillment?.control) {
    log(
      `TARGET_FULFILLMENT_CONTROL_NOT_FOUND product=${job.product.id} expected=${expectedFulfillment}`,
    );
    return "blocked";
  }
  try {
    await fulfillment.control.click({ timeout: 5000 });
  } catch (error) {
    log(
      `TARGET_FULFILLMENT_CONTROL_FAILED product=${job.product.id} expected=${expectedFulfillment}`,
    );
    return "blocked";
  }
  await waitFor(500);
  const confirmed = await findControl(job.page, expectedFulfillment);
  if (!confirmed?.selected || confirmed.ambiguous) {
    log(
      `TARGET_FULFILLMENT_SELECTION_UNCONFIRMED product=${job.product.id} expected=${expectedFulfillment}`,
    );
    return "blocked";
  }
  log(
    `TARGET_FULFILLMENT_SELECTED ${expectedFulfillment} product=${job.product.id} source=product`,
  );
  return "selected";
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
        invalidateAvailabilityRequest(job);
        monitorState.pauseForChallenge(reason, {
          productId: job.product.id,
        });
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
async function navigateProduct(job, monitorState, {
  waitForAction = false,
} = {}) {
  await job.page.goto(job.product.url, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await job.page.waitForTimeout(750);

  if (
    (await waitForTargetSignIn(job.page, job.product.id)) === "blocked"
  ) {
    return false;
  }

  if (
    (await handleChallenge(
      job,
      monitorState,
      `page verification for ${job.product.id}`,
    )) === "blocked"
  ) {
    return false;
  }

  if (waitForAction) {
    return waitForHydratedPurchaseAction(job, monitorState);
  } else {
    return inspectAndTrigger(job, monitorState, "product page", job.lastSummary);
  }
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
  if (!buyNow && monitorState.isCartRateLimited()) {
    return "retry";
  }
  if (!buyNow && !job.checkoutPage) {
    if (!job.context || typeof job.context.newPage !== "function") {
      throw new Error("Dedicated Target checkout page is unavailable.");
    }
    // Transfer this product's empty-cart preflight tab into checkout.
    job.checkoutPage = job.preflightPage || await job.context.newPage();
    job.preflightPage = null;
    job.checkoutPages?.add(job.checkoutPage);
    if (job.requestedMode === "direct-buy") {
      job.stopCartViewMonitor = attachCheckoutCartView(job, job.checkoutPage);
    }
    if (job.monitorState) {
      job.stopCheckoutCartMonitor = attachCartResponseMonitor(
        job.checkoutPage,
        job.monitorState,
        "checkout",
      );
    }
  }
  const checkoutPage = buyNow ? job.page : job.checkoutPage;
  if (!checkoutPage) {
    throw new Error("Dedicated Target checkout page is unavailable.");
  }
  if (!buyNow && checkoutPage === job.page && !job.redirectedCartCheckout) {
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
      // Checkout can collapse item details in the DOM. Re-fetch the page-owned
      // cart view at submission time; a cached preflight snapshot is not proof
      // that the same item, quantity, price, and fulfillment remain selected.
      evidenceReader: job.requestedMode === "direct-buy" && !buyNow
        ? async (page) => {
          if (new URL(page.url()).pathname !== "/checkout" || !job.cartViewUrl) {
            throw new Error("CHECKOUT_CART_VIEW_UNAVAILABLE");
          }
          return purchaseEvidenceFromCartView(
            await readCheckoutCartView(page, job.cartViewUrl),
          );
        }
        : undefined,
      handleVerification: async (page) => {
        const checkoutJob = { ...job, page };
        return handleChallenge(
          checkoutJob,
          monitorState,
          `verification during checkout for ${job.product.id}`,
          { ...challengeOptions, mutationOwned: true },
        );
      },
      handleSignIn: async (page) =>
        waitForTargetSignIn(page, job.product.id),
      log: (message) => {
        if (message === "PLACE_ORDER_CLICKED") {
          job.submittedThisAttempt = true;
        }
        console.log(message);
      },
    });
  } catch (checkoutError) {
    if (checkoutError.code === "CHECKOUT_CART_VIEW_RATE_LIMITED") {
      if (job.submittedThisAttempt) {
        job.terminal = true;
        monitorState.stopForSafety("ambiguous-place-order-outcome", {
          productId: job.product.id,
          requestedMode: job.requestedMode,
        });
        return "ambiguous";
      }
      monitorState.pauseForRateLimit(
        `checkout cart-view 429 for ${job.product.id}`,
        checkoutError.retryAfterMs,
      );
      return "retry";
    }
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

  if (monitorState.repeatOrdersEnabled() && !job.submittedThisAttempt) {
    job.terminal = true;
    monitorState.stopForSafety("confirmation-without-new-submission", {
      productId: job.product.id,
    });
    return "blocked";
  }
  const repeatOrder = monitorState.repeatOrdersEnabled();
  job.completed = !repeatOrder;
  job.needsRearm = repeatOrder;
  monitorState.markOrderConfirmed(job.product.id, job.purchaseMode);
  await notify(
    `✅ **Target order confirmed** via ${job.purchaseMode}\n${job.product.id}\n${job.product.url}`,
  );
  return "confirmed";
}

/**
 * Re-fetch the checkout API URL observed from this page. Its query may carry
 * a transient key, so keep it in memory and return only purchase-guard fields.
 * A fetch/browser error is reduced to a category before it reaches the log.
 */
async function readCheckoutCartView(page, endpointUrl) {
  try {
    // Target can navigate between /checkout and /cart during a page.evaluate
    // fetch, destroying that execution context. The browser context's request
    // client shares its cookies but survives page navigation. Keep the
    // transient endpoint URL and full response only in memory.
    const response = await page.context().request.get(endpointUrl, {
      timeout: 5000,
    });
    if (response.status?.() === 429) {
      const error = new Error("CHECKOUT_CART_VIEW_RATE_LIMITED");
      error.code = "CHECKOUT_CART_VIEW_RATE_LIMITED";
      error.retryAfterMs = parseRetryAfterMs(
        response.headers?.()["retry-after"],
      );
      throw error;
    }
    if (!response.ok()) {
      throw new Error("CHECKOUT_CART_VIEW_UNAVAILABLE");
    }
    const view = await response.json();
    return {
      // Target omits cart_items entirely for an empty cart. A zero summary
      // quantity is required before normalizing that omission to an empty
      // list; a positive or missing quantity remains ambiguous.
      cart_items: Array.isArray(view.cart_items)
        ? view.cart_items.map((item) => ({
          tcin: item.tcin,
          quantity: item.quantity,
          total_cart_item_quantity: item.total_cart_item_quantity,
          current_price: item.current_price,
          fulfillment: { type: item.fulfillment?.type },
        }))
        : Number(view.summary?.items_quantity) === 0
          ? []
          : null,
      summary: {
        items_quantity: view.summary?.items_quantity,
        grand_total: view.summary?.grand_total,
      },
    };
  } catch (error) {
    if (error.code === "CHECKOUT_CART_VIEW_RATE_LIMITED") {
      throw error;
    }
    throw new Error("CHECKOUT_CART_VIEW_UNAVAILABLE");
  }
}

/** Retain the current successful checkout cart-view URL without logging it. */
function attachCheckoutCartView(job, page) {
  const onResponse = (response) => {
    try {
      const url = new URL(response.url());
      if (
        url.hostname === "carts.target.com" &&
        url.pathname === "/web_checkouts/v1/cart_views" &&
        response.status() === 200
      ) {
        job.cartViewUrl = response.url();
      }
    } catch (error) {
      // An unrelated response cannot establish cart identity.
    }
  };
  page.on("response", onResponse);
  return () => page.off("response", onResponse);
}

/**
 * Checkout-only existing-item preflight. Never navigate to or inspect /cart:
 * Target can redirect there between awaited operations, so re-check the URL
 * after page inspection and the cart-view fetch before claiming the purchase.
 * Redirects back to /checkout have no count cap by operator instruction.
 */
async function inspectDirectBuyCheckout(job, monitorState, {
  openPage = () => job.preflightPage && !job.preflightPage.isClosed?.()
    ? job.preflightPage
    : job.context.newPage(),
  inspectPage = inspectChallenge,
  readCartView = readCheckoutCartView,
  allowOccupiedCart = false,
  retainPage = job.requestedMode === "direct-buy",
  mutationOwned = false,
  log = console.log,
} = {}) {
  if (monitorState.isCartRateLimited()) {
    return "retry";
  }
  const page = await openPage();
  if (page !== job.page) {
    job.checkoutPages?.add(page);
  }
  const stopCartViewMonitor = attachCheckoutCartView(job, page);
  const stop = (reason) => {
    if (job.preflightPage === page) {
      job.preflightPage = null;
    }
    job.terminal = true;
    monitorState.stopForSafety(reason, { productId: job.product.id });
    return "blocked";
  };
  const retry = () => {
    if (retainPage && page !== job.page) {
      job.preflightPage = page;
    }
    return "retry";
  };
  try {
    while (true) {
      job.cartViewUrl = null;
      await page.goto(checkoutUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      const pathname = new URL(page.url()).pathname;
      if (pathname === "/cart") {
        log("TARGET_CHECKOUT_CART_REDIRECT");
        continue;
      }
      if (pathname !== "/checkout") {
        return stop("checkout-preflight-unexpected-page");
      }
      const detection = await inspectPage(page);
      if (new URL(page.url()).pathname === "/cart") {
        log("TARGET_CHECKOUT_CART_REDIRECT");
        continue;
      }
      if (detection.detected) {
        const result = await handleChallenge(
          { ...job, page },
          monitorState,
          `checkout preflight verification for ${job.product.id}`,
          { mutationOwned },
        );
        if (result === "resolved") {
          job.preflightChallengePending = false;
          continue;
        }
        // Recovery remains active in the monitor; a preflight challenge has
        // not sent a cart or Place-order input and must not end the watch.
        job.preflightChallengePending = retainPage;
        if (retainPage && page === job.page) {
          job.preflightPage = page;
        }
        return retry();
      }
      job.preflightChallengePending = false;
      for (let tick = 0; tick < 100 && !job.cartViewUrl; tick += 1) {
        if (new URL(page.url()).pathname === "/cart") {
          break;
        }
        await wait(100);
      }
      if (new URL(page.url()).pathname === "/cart") {
        log("TARGET_CHECKOUT_CART_REDIRECT");
        continue;
      }
      if (!job.cartViewUrl) {
        return retry();
      }
      let cartView;
      try {
        cartView = await readCartView(page, job.cartViewUrl);
      } catch (error) {
        if (error.code === "CHECKOUT_CART_VIEW_RATE_LIMITED") {
          monitorState.pauseForRateLimit(
            `checkout cart-view 429 for ${job.product.id}`,
            error.retryAfterMs,
          );
        }
        // A transient read failure says nothing about the cart contents.
        // Keep the watch alive and recheck from /checkout on the next tick.
        log(`TARGET_CHECKOUT_CART_VIEW_RETRY product=${job.product.id}`);
        return retry();
      }
      if (new URL(page.url()).pathname === "/cart") {
        log("TARGET_CHECKOUT_CART_REDIRECT");
        continue;
      }
      if (new URL(page.url()).pathname !== "/checkout") {
        return stop("checkout-preflight-unexpected-page");
      }
      const evidence = purchaseEvidenceFromCartView(cartView);
      if (
        Array.isArray(cartView?.cart_items) &&
        cartView.cart_items.length === 0 &&
        Number(cartView?.summary?.items_quantity) === 0
      ) {
        if (retainPage && page !== job.page) {
          job.preflightPage = page;
        }
        return "empty";
      }
      const validation = validatePurchaseEvidence(evidence, {
        expectedProductId: job.product.id,
        ...job.purchaseGuardConfig,
      });
      if (
        allowOccupiedCart &&
        evidence.items.length > 0 &&
        (
          evidence.items.length !== 1 ||
          evidence.items[0].productId !== job.product.id ||
          evidence.items[0].quantity !== 1
        )
      ) {
        if (job.preflightPage === page) {
          job.preflightPage = null;
        }
        return "occupied";
      }
      // Only explicit zero-item evidence permits a new product action.
      // Unknown or mismatched checkout data cannot be treated as empty.
      if (!validation.ok || !monitorState.claimPurchase(job.product.id)) {
        return stop("checkout-preflight-mismatch-or-unreadable");
      }
      job.checkoutPage = page;
      job.preflightPage = null;
      job.redirectedCartCheckout ||= page === job.page;
      job.stopCartViewMonitor = stopCartViewMonitor;
      job.pendingCartReconciliation = false;
      job.addedToCart = true;
      job.purchaseMode ||= "add-to-cart";
      if (job.monitorState) {
        job.stopCheckoutCartMonitor = attachCartResponseMonitor(
          page,
          job.monitorState,
          "checkout",
        );
      }
      log(`TARGET_CHECKOUT_PREFLIGHT_MATCH product=${job.product.id} quantity=1`);
      return "matched";
    }
  } finally {
    if (job.checkoutPage !== page) {
      stopCartViewMonitor();
      if (job.preflightPage !== page && page !== job.page) {
        job.checkoutPages?.delete(page);
        await page.close();
      }
    }
  }
}

async function reconcilePendingCart(job, monitorState, {
  notify = sendDiscordAlert,
  challengeOptions = {},
  checkoutRunner = runTargetCheckout,
  checkoutPreflight = inspectDirectBuyCheckout,
} = {}) {
  if (job.completed || job.terminal || monitorState.isPaused()) {
    return;
  }
  const redirectedToCart = new URL(job.page.url()).pathname === "/cart";
  if (redirectedToCart) {
    // A cart mutation can redirect after a 429 or uncertain response. Never
    // inspect the cart challenge. Reuse this tab for /checkout reconciliation.
    await closePreflightPage(job);
    job.redirectedCartCheckout = true;
    await job.page.goto(checkoutUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    }).catch(() => {});
    if (new URL(job.page.url()).pathname === "/cart") {
      return "pending";
    }
  }
  if (job.requestedMode === "direct-buy") {
    if (monitorState.isCartRateLimited()) {
      return "pending";
    }
    // A cart mutation may succeed while the PDP shows verification. The
    // checkout cart view is the authority for the already-owned transaction.
    const status = await checkoutPreflight(job, monitorState, {
      ...(redirectedToCart
        ? { openPage: async () => job.page }
        : {}),
      mutationOwned: true,
    });
    if (status === "matched") {
      return continueCheckout(job, monitorState, {
        notify,
        challengeOptions,
        checkoutRunner,
      });
    }
    if (status === "empty") {
      job.pendingCartReconciliation = false;
      job.purchaseMode = null;
      job.cartRetryPending = true;
      return "retry-cart";
    }
    return status;
  }
  if (!redirectedToCart) {
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
  }
  if (monitorState.isCartRateLimited()) {
    return "pending";
  }

  if (!redirectedToCart && await closeNotAddedDialog(job.page)) {
    console.log(`${job.product.id} ITEM_NOT_ADDED_TO_CART`);
    job.pendingCartReconciliation = false;
    job.purchaseMode = null;
    monitorState.releasePurchase(job.product.id);
    await notify(
      `⚠️ Target showed **Item not added to cart** for ${job.product.id}. Monitoring continues.\n${job.product.url}`,
    );
    return "not-added";
  }

  const body = redirectedToCart
    ? ""
    : await job.page.locator("body").innerText().catch(() => "");
  if (redirectedToCart || !isCartSuccess(job.page.url(), body)) {
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
  checkoutPreflight = inspectDirectBuyCheckout,
  cartHandshake = observeCartHandshake,
  multiDirectBuy = multiDirectBuyEnabled,
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
    const automaticallySelected = ["auto", "direct-buy"].includes(
      job.requestedMode,
    );
    if (
      !candidateMode ||
      (!automaticallySelected && candidateMode !== job.requestedMode) ||
      (job.requestedMode === "auto" && candidateMode === "buy-now")
    ) {
      throw new Error("PURCHASE_MODE_MISMATCH");
    }
    if (!validatePdpIdentity(job.page.url(), job.product.id)) {
      throw new Error("PDP_IDENTITY_VALIDATION_FAILED");
    }
    if (candidateMode !== "buy-now" && monitorState.isCartRateLimited()) {
      return;
    }
    if (!monitorState.claimPurchase(job.product.id, job.requestedMode)) {
      return;
    }
    ownerClaimed = true;
    if (multiDirectBuy && candidateMode !== "buy-now") {
      if (monitorState.cartFallbackBlocked()) {
        monitorState.releasePurchase(job.product.id);
        ownerClaimed = false;
        return;
      }
      const cartStatus = await checkoutPreflight(job, monitorState, {
        allowOccupiedCart: true,
        retainPage: multiDirectBuy,
        mutationOwned: true,
      });
      if (cartStatus === "occupied") {
        monitorState.blockCartFallback();
        monitorState.releasePurchase(job.product.id);
        ownerClaimed = false;
        return;
      }
      if (cartStatus === "matched") {
        await continueCheckout(job, monitorState, {
          notify,
          challengeOptions,
          checkoutRunner,
        });
        return;
      }
      if (cartStatus !== "empty") {
        if (cartStatus === "retry" && !job.cartRetryPending) {
          monitorState.releasePurchase(job.product.id);
        }
        return;
      }
    }
    alertPromise = notify(
      availabilityMessage(job, source, candidate.label, summary),
    );
    inputMayHaveBeenSent = true;
    job.cartRetryPending = false;
    if (candidateMode === "buy-now") {
      job.purchaseMode = "buy-now";
    } else {
      job.purchaseMode = candidateMode;
      job.pendingCartReconciliation = true;
    }
    let handshake = null;
    if (candidateMode === "buy-now") {
      await candidate.button.click({ timeout: 5000 });
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

    if (candidateMode !== "buy-now" &&
        new URL(job.page.url()).pathname === "/cart") {
      // Target may redirect after Add to cart. The checkout runner moves this
      // tab straight to /checkout before reading it, avoiding the cart
      // verification page and another tab.
      job.pendingCartReconciliation = false;
      job.addedToCart = true;
      await closePreflightPage(job);
      job.checkoutPage = job.page;
      job.redirectedCartCheckout = true;
      job.stopCartViewMonitor = attachCheckoutCartView(job, job.page);
      console.log(`${job.product.id} PURCHASE_ADDED_TO_CART`);
      await continueCheckout(job, monitorState, {
        notify,
        challengeOptions,
        checkoutRunner,
      });
      return;
    }

    if (candidateMode === "buy-now") {
      // Checkout already polls for the side panel and handles verification.
      // A fixed page wait and a second challenge inspection delay that path.
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

    if (job.requestedMode === "direct-buy") {
      const cartStatus = await checkoutPreflight(job, monitorState, {
        retainPage: true,
        mutationOwned: true,
      });
      if (cartStatus === "matched") {
        await continueCheckout(job, monitorState, {
          notify,
          challengeOptions,
          checkoutRunner,
        });
      }
      // An empty immediate read can precede a delayed cart update. Keep
      // ownership and recheck checkout on the next tick before another click.
      return;
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
  // Unavailable PDPs have no purchase action and often no Shipping selector.
  // Inspect fulfillment only when there is an actionable purchase candidate.
  if (!await findPurchaseButton(job.page, job.requestedMode)) {
    return false;
  }
  const fulfillment = await selectProductFulfillment(job, {
    log: console.log,
  });
  if (fulfillment === "blocked") {
    return false;
  }
  // Choosing Shipping can rerender the action module. Reacquire the button
  // after that change so the purchase mutation uses a current visible control.
  const candidate = await findPurchaseButton(job.page, job.requestedMode);
  if (!candidate) {
    return false;
  }
  if (
    multiDirectBuyEnabled &&
    candidate.mode !== "buy-now" &&
    monitorState.cartFallbackBlocked()
  ) {
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

/** Inspect the hydrated PDP after a positive API signal before reloading it. */
async function waitForHydratedPurchaseAction(job, monitorState, {
  inspect = inspectAndTrigger,
  waitFor = wait,
  attempts = 20,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await inspect(job, monitorState, "product page", job.lastSummary)) {
      return true;
    }
    if (monitorState?.isPaused?.() || monitorState?.shouldStop?.()) {
      return false;
    }
    if (attempt + 1 < attempts) {
      await waitFor(250);
    }
  }
  return false;
}

/** Use an already actionable PDP before paying for another page navigation. */
async function actOnAvailabilityCandidate(job, monitorState, {
  inspect = inspectAndTrigger,
  navigate = navigateProduct,
} = {}) {
  if (await inspect(job, monitorState, "product page", job.lastSummary)) {
    return true;
  }
  return Boolean(await navigate(job, monitorState, { waitForAction: true }));
}

/** Resolve an uncertain cart click before admitting another product. */
async function retryCartPurchase(job, monitorState, {
  inspect = inspectAndTrigger,
  navigate = navigateProduct,
} = {}) {
  if (monitorState.isCartRateLimited()) {
    return "waiting";
  }
  let attempted = false;
  if (validatePdpIdentity(job.page.url(), job.product.id)) {
    attempted = await inspect(job, monitorState, "cart retry", job.lastSummary);
  }
  if (!attempted && !monitorState.isPaused()) {
    attempted = await navigate(job, monitorState, { waitForAction: true });
  }
  if (attempted || monitorState.isPaused()) {
    return attempted ? "attempted" : "waiting";
  }
  // Stock and the visible control are gone. Release the lease so the
  // watchlist can pursue another product, then revisit this one normally.
  job.cartRetryPending = false;
  monitorState.releasePurchase(job.product.id);
  return "unavailable";
}

async function closePreflightPage(job) {
  const page = job.preflightPage;
  job.preflightPage = null;
  job.preflightChallengePending = false;
  if (page && page !== job.page && page !== job.checkoutPage) {
    job.checkoutPages?.delete(page);
    await page.close().catch(() => {});
  }
}

/** Drop old checkout and response state before another order for this TCIN. */
async function rearmConfirmedJob(job, monitorState, {
  navigate = navigateProduct,
} = {}) {
  job.stopCheckoutCartMonitor?.();
  job.stopCartViewMonitor?.();
  job.stopCheckoutCartMonitor = null;
  job.stopCartViewMonitor = null;
  const oldCheckoutPage = job.checkoutPage;
  job.checkoutPage = null;
  job.checkoutPages?.delete(oldCheckoutPage);
  if (oldCheckoutPage && oldCheckoutPage !== job.page) {
    await oldCheckoutPage.close().catch(() => {});
  }
  await closePreflightPage(job);
  job.addedToCart = false;
  job.purchaseMode = null;
  job.pendingCartReconciliation = false;
  job.cartRetryPending = false;
  job.redirectedCartCheckout = false;
  job.cartViewUrl = null;
  job.submittedThisAttempt = false;
  job.pollCount = 0;
  job.needsRearm = false;
  invalidateAvailabilityRequest(job);
  await navigate(job, monitorState);
}

/**
 * One tick, normally invoked through enqueueGlobalPoll. An established
 * transaction goes to checkout before product-page challenge inspection:
 * after exact-cart preflight the checkout tab, not the PDP, owns the next
 * action. A new product job then handles deferred challenges, request-template
 * discovery, one page-owned API fetch, and stock inspection in that order.
 */
async function pollAvailability(job, monitorState, {
  checkoutRunner = continueCheckout,
  rearmRunner = rearmConfirmedJob,
  reconcileRunner = reconcilePendingCart,
  retryRunner = retryCartPurchase,
} = {}) {
  if (
    job.completed ||
    job.terminal ||
    monitorState.isPaused() ||
    !monitorState.canAttemptPurchase(job.product.id)
  ) {
    return;
  }

  if (job.needsRearm) {
    await rearmRunner(job, monitorState);
    return;
  }

  if (job.preflightChallengePending && job.preflightPage) {
    if (job.preflightPage.isClosed?.()) {
      job.checkoutPages?.delete(job.preflightPage);
      job.preflightPage = null;
      job.preflightChallengePending = false;
      return;
    }
    const result = await handleChallenge(
      { ...job, page: job.preflightPage },
      monitorState,
      `checkout preflight verification for ${job.product.id}`,
    );
    if (result !== "blocked") {
      job.preflightChallengePending = false;
      if (job.preflightPage === job.page) {
        job.preflightPage = null;
      }
      invalidateAvailabilityRequest(job);
    }
    return;
  }

  if (job.addedToCart || job.purchaseMode === "buy-now") {
    const outcome = await monitorState.enqueueMutation(() =>
      checkoutRunner(job, monitorState),
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

  if (job.pendingCartReconciliation &&
      (job.requestedMode === "direct-buy" ||
        new URL(job.page.url()).pathname === "/cart")) {
    await monitorState.enqueueMutation(() =>
      reconcileRunner(job, monitorState),
    );
    return;
  }
  if (job.cartRetryPending &&
      new URL(job.page.url()).pathname === "/cart") {
    await retryRunner(job, monitorState);
    return;
  }

  const pageChallenge = await handleChallenge(
    job,
    monitorState,
    `page verification during poll for ${job.product.id}`,
  );
  if (pageChallenge === "blocked") {
    return;
  }
  if (pageChallenge === "resolved") {
    return;
  }

  if (job.pendingCartReconciliation) {
    await monitorState.enqueueMutation(() =>
      reconcileRunner(job, monitorState),
    );
    return;
  }
  if (job.cartRetryPending) {
    await retryRunner(job, monitorState);
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
    await actOnAvailabilityCandidate(job, monitorState);
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
 * @param {boolean} [options.continueAfterOrder] Keep the explicit multi-product
 *   watchlist polling after a confirmed order, excluding that product.
 * @param {boolean} [options.repeatAfterOrder] Rearm confirmed products for
 *   a fresh quantity-one transaction in the explicit overnight watchlist.
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
  continueAfterOrder = multiDirectBuyEnabled,
  repeatAfterOrder = multiDirectBuyEnabled &&
    /^(?:1|true|yes)$/i.test(process.env.TARGET_REPEAT_CONFIRMED_ORDERS || ""),
  maximumPolls = maximumApiPolls,
  runtimeMs = maximumRuntimeMs,
  now = Date.now,
  notify = sendDiscordAlert,
  log = console.log,
  error = console.error,
} = {}) {
  let challengeAttempt = 0;
  let pausedUntil = 0;
  let pauseKind = null;
  let pausedProductIds = new Set();
  let cartRateLimitedUntil = 0;
  let cartRateLimitAttempt = 0;
  let mutationQueue = Promise.resolve();
  let calibrationStopped = false;
  let challengePending = false;
  let purchaseOwner = null;
  let cartFallbackBlocked = false;
  let confirmedOrder = null;
  const confirmedOrders = [];
  const confirmedProductIds = new Set();
  let terminalStop = null;
  const startedAt = now();
  const apiPolls = [];
  const lastApiPollByProduct = new Map();
  let lastApiPoll = null;
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
        (!confirmedOrder || continueAfterOrder) &&
        (repeatAfterOrder || !confirmedProductIds.has(productId)) &&
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
    cartFallbackBlocked() {
      return cartFallbackBlocked;
    },
    blockCartFallback() {
      cartFallbackBlocked = true;
      log("TARGET_CART_FALLBACK_DISABLED existing-cart-items");
    },
    releasePurchase(productId) {
      if ((!confirmedOrder || continueAfterOrder) && purchaseOwner === productId) {
        purchaseOwner = null;
      }
    },
    markOrderConfirmed(productId, mode) {
      if (purchaseOwner && purchaseOwner !== productId) {
        throw new Error("Order confirmation does not match the purchase owner.");
      }
      if (confirmedProductIds.has(productId) && !repeatAfterOrder) {
        throw new Error("The watchlist already confirmed this product.");
      }
      purchaseOwner = continueAfterOrder ? null : productId;
      if (continueAfterOrder) {
        // Another item's fallback gets a fresh cart preflight after this
        // checkout. A prior occupied-cart observation is no longer current.
        cartFallbackBlocked = false;
      }
      confirmedOrder = { productId, mode, at: new Date().toISOString() };
      confirmedOrders.push(confirmedOrder);
      confirmedProductIds.add(productId);
      log(`TARGET_ORDER_CONFIRMED ${JSON.stringify(confirmedOrder)}`);
    },
    isOrderConfirmed() {
      return Boolean(confirmedOrder) && !continueAfterOrder;
    },
    repeatOrdersEnabled() {
      return continueAfterOrder && repeatAfterOrder;
    },
    isPaused() {
      return now() < pausedUntil;
    },
    isChallengePaused() {
      return pauseKind === "challenge" && now() < pausedUntil;
    },
    challengePauseProductIds() {
      return [...pausedProductIds];
    },
    remainingPauseMs() {
      return Math.max(0, pausedUntil - now());
    },
    isCartRateLimited() {
      return now() < cartRateLimitedUntil;
    },
    remainingCartRateLimitMs() {
      return Math.max(0, cartRateLimitedUntil - now());
    },
    heartbeatSnapshot() {
      return {
        purchaseOwner,
        challengePaused: state.isChallengePaused(),
        cartRateLimitMs: state.remainingCartRateLimitMs(),
        lastApiPollAgeMs: lastApiPoll ? Math.max(0, now() - lastApiPoll.atMs) : null,
        lastApiProductId: lastApiPoll?.productId || null,
        confirmedOrders: confirmedOrders.length,
      };
    },
    remainingRuntimeMs() {
      return runtimeMs > 0 ? Math.max(0, startedAt + runtimeMs - now()) : Infinity;
    },
    pauseForChallenge(reason, { fixed = false, productId = null } = {}) {
      if (now() < pausedUntil) {
        if (pauseKind === "challenge" && productId) {
          pausedProductIds.add(productId);
        }
        return;
      }
      const delay = fixed
        ? challengeBaseDelayMs
        : calculateBackoffMs(
          challengeAttempt,
          challengeBaseDelayMs,
          challengeMaximumDelayMs,
        );
      challengeAttempt += 1;
      pausedUntil = now() + delay;
      pauseKind = "challenge";
      pausedProductIds = productId ? new Set([productId]) : new Set();
      calibrationStopped ||= observe;
      error(`TARGET_CHALLENGE_BACKOFF ${delay}ms ${reason}`);
      if (!observe) {
        void notify(
          `🛑 **Target monitoring paused for ${Math.ceil(delay / 60000)} minute(s)**\nReason: ${reason}`,
        );
      }
    },
    pauseForRateLimit(reason, retryAfterMs = 0) {
      // A cart-service 429 does not establish that availability reads were
      // throttled. Cool only cart reads/mutations, retaining the transaction
      // owner until its cart state can be reconciled.
      if (state.isCartRateLimited()) {
        if (retryAfterMs > state.remainingCartRateLimitMs()) {
          cartRateLimitedUntil = now() + retryAfterMs;
          error(`TARGET_RATE_LIMIT_EXTENDED ${retryAfterMs}ms ${reason}`);
        }
        return;
      }
      const backoff = calculateBackoffMs(
        cartRateLimitAttempt,
        cartRateLimitBaseDelayMs,
        challengeMaximumDelayMs,
      );
      const delay = Math.max(backoff, retryAfterMs || 0);
      cartRateLimitAttempt += 1;
      cartRateLimitedUntil = Math.max(cartRateLimitedUntil, now() + delay);
      calibrationStopped ||= observe;
      error(`TARGET_RATE_LIMIT_BACKOFF ${delay}ms ${reason}`);
      if (!observe) {
        void notify(
          `🛑 **Target cart traffic paused for ${Math.ceil(delay / 60000)} minute(s)**\nReason: ${reason}`,
        );
      }
    },
    clearChallengeBackoff(force = false) {
      if (pausedUntil > 0 && (force || now() >= pausedUntil)) {
        pausedUntil = 0;
        pauseKind = null;
        pausedProductIds = new Set();
        if (force) {
          challengeAttempt = 0;
          challengePending = false;
        }
      }
    },
    releaseChallengeProduct(productId) {
      if (pauseKind !== "challenge") {
        return true;
      }
      if (pausedProductIds.size === 0) {
        this.clearChallengeBackoff(true);
        return true;
      }
      pausedProductIds.delete(productId);
      if (pausedProductIds.size === 0) {
        this.clearChallengeBackoff(true);
        return true;
      }
      return false;
    },
    recordChallengeSolved(kind, attempts, productId = null) {
      if (productId && pausedProductIds.size > 0) {
        pausedProductIds.delete(productId);
        if (pausedProductIds.size === 0) {
          challengeAttempt = 0;
          pausedUntil = 0;
          pauseKind = null;
          challengePending = false;
        }
      } else {
        challengeAttempt = 0;
        pausedUntil = 0;
        pauseKind = null;
        pausedProductIds = new Set();
        challengePending = false;
      }
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
      } else if (
        result.kind === "mutation" &&
        result.status >= 200 &&
        result.status < 300
      ) {
        cartRateLimitAttempt = 0;
        cartRateLimitedUntil = 0;
      }
    },
    recordApiPoll(result) {
      const atMs = now();
      const previousAt = lastApiPollByProduct.get(result.productId);
      const event = {
        at: new Date(atMs).toISOString(),
        ...result,
        pollGapMs: previousAt === undefined ? null : Math.max(0, atMs - previousAt),
      };
      if (result.productId) {
        lastApiPollByProduct.set(result.productId, atMs);
      }
      lastApiPoll = { atMs, productId: result.productId };
      apiPolls.push(event);
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
        confirmedOrders,
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
    required: false,
  });
  if (!observeOnly && discordAlertsEnabled) {
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
  const heartbeatTimer = setInterval(() => {
    console.log(
      `TARGET_MONITOR_HEARTBEAT ${JSON.stringify(monitorState.heartbeatSnapshot())}`,
    );
  }, 30000);
  heartbeatTimer.unref();
  const jobs = [];
  const checkoutPages = new Set();
  const initiallyOpenPages = new Set(context.pages());
  try {
    for (const configured of configuredJobs) {
      if (multiDirectBuyEnabled && monitorState.isPaused()) {
        // Opening another PDP during a shared challenge/429 pause would
        // create fresh background traffic before the first tab recovers.
        console.log(`TARGET_MONITOR_SETUP_PAUSED ${monitorState.remainingPauseMs()}ms`);
        await waitForPausedPages(jobs, monitorState);
        monitorState.clearChallengeBackoff();
      }
      if (monitorState.shouldStop() || monitorState.isOrderConfirmed()) {
        break;
      }
      const job = {
        product: configured.product,
        requestedMode: configured.requestedMode,
        page: await acquireProductPage(context, configured.product, {
          reuseClearProductPage: multiDirectBuyEnabled,
        }),
        availabilityRequest: null,
        lastSummary: null,
        lastFingerprint: null,
        pollCount: 0,
        challengeSignal: null,
        nextNavigationAt: 0,
        triggered: false,
        addedToCart: false,
        purchaseMode: null,
        checkoutPage: null,
        preflightPage: null,
        preflightChallengePending: false,
        cartRetryPending: false,
        checkoutPages,
        context,
        monitorState,
        stopCheckoutCartMonitor: null,
        completed: false,
        terminal: false,
        pendingCartReconciliation: false,
        redirectedCartCheckout: false,
        needsRearm: false,
        submittedThisAttempt: false,
        purchaseGuardConfig,
      };
      await attachResponseMonitor(job, monitorState);
      jobs.push(job);
      const cartStatus = job.requestedMode === "direct-buy" && !multiDirectBuyEnabled
        ? await inspectDirectBuyCheckout(job, monitorState)
        : "empty";
      if (cartStatus === "empty") {
        await navigateProduct(job, monitorState);
      }
      await wait(multiDirectBuyEnabled ? globalPollDelayMs : 1500);
    }

    console.log(
      `TARGET_MONITOR_STARTED products=${configuredJobs.length} globalPollMs=${globalPollDelayMs} repeatConfirmedOrders=${monitorState.repeatOrdersEnabled()} observeOnly=${observeOnly} maxApiPolls=${maximumApiPolls} driver=${browserDriverName}`,
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
        if (monitorState.isChallengePaused()) {
          await waitForPausedPages(jobs, monitorState);
        } else {
          await wait(delay);
        }
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
    clearInterval(heartbeatTimer);
    for (const job of jobs) {
      job.stopCheckoutCartMonitor?.();
      job.stopCartViewMonitor?.();
    }
    console.log(
      `TARGET_CALIBRATION_SUMMARY ${JSON.stringify({
        ...monitorState.calibrationSummary(),
        products: configuredJobs.length,
      })}`,
    );
    if (keepDiagnosticPage) {
      console.log(`TARGET_DIAGNOSTIC_PAGES_PRESERVED count=${jobs.length}`);
    } else {
      await closeNewProductPages(jobs, initiallyOpenPages);
      await Promise.all(
        [...checkoutPages].map((page) => page.close().catch(() => {})),
      );
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
  actOnAvailabilityCandidate,
  attachCartResponseMonitor,
  attachResponseMonitor,
  acquireProductPage,
  closeNewProductPages,
  continueCheckout,
  createMonitorState,
  findPurchaseButton,
  handleChallenge,
  inspectAndTrigger,
  inspectDirectBuyCheckout,
  navigateProduct,
  parseJobArgument,
  parseProducts,
  pollAvailability,
  readCheckoutCartView,
  rearmConfirmedJob,
  reconcilePendingCart,
  retryCartPurchase,
  resolveProductArgs,
  selectProductFulfillment,
  triggerPurchase,
  waitForPausedPages,
  waitForHydratedPurchaseAction,
  waitForStableChallengeClear,
  waitForTargetSignIn,
};
