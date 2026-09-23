/**
 * Challenge contract and retry driver; no browser input or monitor state lives here.
 * DOM inspection: target-challenge-page.js. Input: target-challenge-solver.js.
 * Start with TARGET-CHALLENGE-DEVELOPER-GUIDE.md for the full recovery flow.
 */
const path = require("node:path");

/**
 * @typedef {object} ChallengeDetection
 * @property {boolean} detected Whether evidence requires stopping normal actions.
 * @property {"press_and_hold"|"generic"|"none"} kind
 * @property {boolean} [unreadable] Inspector could not establish a readable state.
 */

/**
 * @typedef {object} ChallengeContext
 * @property {import("patchright").Page} page Existing page; Playwright-compatible API.
 * @property {{id: string, tcin: string, url: string}|null} product
 * @property {"press_and_hold"|"generic"} kind
 * @property {string} reason Trigger description; keep credentials/URLs out of it.
 * @property {number} attempt One-based index within this recovery cycle.
 * @property {number} maxAttempts Cycle limit, not a lifetime attempt counter.
 * @property {(message: string) => void} log Sanitized diagnostic output.
 */

/**
 * @callback ChallengeSolver
 * @param {ChallengeContext} context
 * @returns {Promise<unknown>} Ignored; only subsequent page inspection can clear.
 */

/**
 * @typedef {object} ChallengeResolution
 * @property {"cleared"|"unresolved"|"unsupported"|"failed"} outcome
 * @property {number} attempts Attempts consumed by this cycle (zero if unsupported).
 * @property {string|null} [error] Last solver exception when the cycle did not clear.
 */

const challengeTextPattern =
  /press\s*(?:&|and)\s*hold|perimeterx|captcha|quick verification|verify (?:that )?you(?:'re| are) (?:a )?human|not a robot|access denied/i;
const challengeUrlPattern = /captcha|challenge|blocked|verify/i;
const pressAndHoldPattern = /press\s*(?:&|and)\s*hold|quick verification/i;

const challengeKind = {
  pressAndHold: "press_and_hold",
  generic: "generic",
  none: "none",
};

const resolutionOutcome = {
  cleared: "cleared",
  unresolved: "unresolved",
  unsupported: "unsupported",
  failed: "failed",
};

/**
 * Classifies observable page evidence into a challenge kind.
 * Pure function so the monitor and tests share one detection contract.
 * This classifies supplied evidence only; it neither reads DOM nor proves that
 * the page is readable. inspectChallenge() owns those additional checks.
 *
 * @param {{url?: string, title?: string, body?: string}} [evidence]
 * @returns {ChallengeDetection}
 */
function detectChallenge({ url = "", title = "", body = "" } = {}) {
  const text = `${title}\n${body}`;
  const textMatch = challengeTextPattern.test(text);
  const urlMatch = challengeUrlPattern.test(String(url));
  if (!textMatch && !urlMatch) {
    return { detected: false, kind: challengeKind.none };
  }
  return {
    detected: true,
    kind: pressAndHoldPattern.test(text)
      ? challengeKind.pressAndHold
      : challengeKind.generic,
  };
}

/**
 * Loads the pluggable solver. The solver is intentionally external: this module
 * only defines the seam, the retry policy, and the post-solve verification.
 *
 * Contract for the module named by TARGET_CHALLENGE_SOLVER:
 *   module.exports = async function solveChallenge(context) -> void
 *   context = { page, product, kind, reason, attempt, maxAttempts, log }
 * Return values are ignored. The caller re-verifies live page evidence after
 * each normally completed attempt; throwing skips verification for that attempt.
 * Relative paths resolve from the process working directory, not this file.
 * require() executes the configured module: use only trusted local modules/packages.
 *
 * @param {string} [specifier] Module path/name; an empty value disables recovery.
 * @returns {ChallengeSolver|null}
 * @throws {Error} Loading or export validation failed (normally a startup error).
 */
function loadChallengeSolver(specifier = process.env.TARGET_CHALLENGE_SOLVER) {
  const value = String(specifier || "").trim();
  if (!value) {
    return null;
  }
  const resolved = value.startsWith(".")
    ? path.resolve(process.cwd(), value)
    : value;
  const loaded = require(resolved);
  const solver =
    typeof loaded === "function" ? loaded : loaded && loaded.solveChallenge;
  if (typeof solver !== "function") {
    throw new Error(
      `TARGET_CHALLENGE_SOLVER "${value}" must export a function or { solveChallenge }.`,
    );
  }
  return solver;
}

/**
 * Drives the injected solver with a bounded retry loop and independent
 * verification. `verifyCleared` must re-read live page state, never the value
 * returned by the solver, so a lying or partial solver cannot resume the run.
 * This loop does not reload the page or apply the monitor's backoff ladder.
 * The solver must bound its own operations; this driver bounds attempt count only.
 *
 * @param {object} [options]
 * @param {ChallengeSolver|null} [options.solver]
 * @param {import("patchright").Page} [options.page]
 * @param {{id: string, tcin: string, url: string}|null} [options.product=null]
 * @param {"press_and_hold"|"generic"} [options.kind="generic"]
 * @param {string} [options.reason=""]
 * @param {number} [options.maxAttempts=3] Caller supplies a finite positive integer.
 * @param {number} [options.settleMs=1500] Delay after a normally returned attempt.
 * @param {(ms: number) => Promise<void>} [options.wait] Injectable for unit tests.
 * @param {() => Promise<boolean>} options.verifyCleared Required live verification.
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<ChallengeResolution>}
 */
async function resolveChallenge({
  solver,
  page,
  product = null,
  kind = challengeKind.generic,
  reason = "",
  maxAttempts = 3,
  settleMs = 1500,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  verifyCleared,
  log = () => {},
} = {}) {
  if (typeof solver !== "function") {
    return { outcome: resolutionOutcome.unsupported, attempts: 0 };
  }
  if (typeof verifyCleared !== "function") {
    throw new Error("resolveChallenge requires a verifyCleared callback.");
  }

  const attemptLimit = Math.max(1, maxAttempts);
  let lastError = null;
  let attempted = 0;

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    attempted = attempt;
    log(`TARGET_CHALLENGE_SOLVE_ATTEMPT ${attempt}/${attemptLimit} ${reason}`);
    try {
      await solver({
        page,
        product,
        kind,
        reason,
        attempt,
        maxAttempts: attemptLimit,
        log,
      });
    } catch (error) {
      lastError = error;
      log(`TARGET_CHALLENGE_SOLVE_ERROR ${error.message}`);
      // Retrying the same unsupported kind immediately cannot change the
      // widget. The monitor will re-inspect it during a later recovery cycle.
      if (error.message === "CHALLENGE_KIND_UNSUPPORTED") {
        break;
      }
      continue;
    }

    await wait(settleMs);
    if (await verifyCleared()) {
      log(`TARGET_CHALLENGE_CLEARED after=${attempt}`);
      return { outcome: resolutionOutcome.cleared, attempts: attempt };
    }
  }

  // An earlier exception is retained even if a later attempt returned normally
  // but stayed blocked. A later verified clearance would already have returned.
  return {
    outcome: lastError ? resolutionOutcome.failed : resolutionOutcome.unresolved,
    attempts: attempted,
    error: lastError ? lastError.message : null,
  };
}

module.exports = {
  challengeKind,
  detectChallenge,
  loadChallengeSolver,
  resolutionOutcome,
  resolveChallenge,
};
