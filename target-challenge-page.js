/**
 * Shared, read-only browser inspection for the solver and its independent verifier.
 * It does not create tabs/profiles, change page content, or declare monitor success.
 * See TARGET-CHALLENGE-DEVELOPER-GUIDE.md for ownership and timeout boundaries.
 */
const { challengeKind, detectChallenge } = require("./target-challenge");

/**
 * Bound waiting for one operation, not an entire background input routine.
 * Promise.race does NOT cancel a dispatched browser command. On timeout, callers
 * must stop issuing later input and attempt cleanup; a lost connection may still
 * prevent release. Built-in locator timeouts remain important for browser actions.
 *
 * @template T
 * @param {() => Promise<T>} operation Not started if the budget is already exhausted.
 * @param {number} timeoutMs Remaining budget for this individual wait.
 * @param {string} [message] Categorical error; do not include sensitive URLs.
 * @returns {Promise<T>}
 */
async function withTimeout(operation, timeoutMs, message = "CHALLENGE_OPERATION_TIMEOUT") {
  if (timeoutMs <= 0) {
    throw new Error(message);
  }
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the main page and visible frame scopes exactly once each.
 * The observed HUMAN widget placed its actionable iframe inside a closed shadow
 * root. Browser-native frames reach it without modifying that root; CSS iframe
 * enumeration alone depended on driver behavior and missed the live control.
 * Every ancestor must be visible so hidden duplicate widgets are excluded.
 *
 * @param {import("patchright").Page} page Also supports locator-only test adapters.
 * @param {Function} run Caller-owned deadline wrapper: run(() => asyncOperation()).
 * @returns {Promise<Array<import("patchright").Page|import("patchright").Frame|import("patchright").FrameLocator>>}
 *   Query scopes with compatible locator/getByRole/getByText APIs.
 * @throws {Error} Read/detach/deadline failure or frame limit; never return partial
 *   evidence as though an unreadable frame were clean.
 */
async function visibleScopes(page, run) {
  const scopes = [page];
  if (typeof page.frames === "function") {
    const frames = page.frames();
    // Raw frame count includes hidden frames; the stricter 32-scope limit below
    // includes the main page. Both caps bound work on unexpectedly large trees.
    if (frames.length > 64) {
      throw new Error("CHALLENGE_FRAME_LIMIT");
    }
    for (const frame of frames) {
      if (!frame.parentFrame()) {
        continue;
      }
      let visibleAncestors = true;
      for (let parent = frame; parent && parent.parentFrame(); parent = parent.parentFrame()) {
        const ancestor = await run(() => parent.frameElement());
        try {
          if (!(await run(() => ancestor.isVisible()))) {
            visibleAncestors = false;
            break;
          }
        } finally {
          // Dispose only the temporary ElementHandle, never the iframe itself.
          await run(() => ancestor.dispose()).catch(() => {});
        }
      }
      if (visibleAncestors) {
        if (scopes.length >= 32) {
          throw new Error("CHALLENGE_FRAME_LIMIT");
        }
        scopes.push(frame);
      }
    }
    return scopes;
  }
  // Retain a locator-only path for compatible adapters and unit-test fakes.
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index];
    const frames = scope.locator("iframe, frame");
    const count = await run(() => frames.count());
    if (count > 32) {
      throw new Error("CHALLENGE_FRAME_LIMIT");
    }
    for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
      if (!(await run(() => frames.nth(frameIndex).isVisible()))) {
        continue;
      }
      if (scopes.length >= 32) {
        throw new Error("CHALLENGE_FRAME_LIMIT");
      }
      scopes.push(scope.frameLocator("iframe, frame").nth(frameIndex));
    }
  }
  return scopes;
}

/**
 * Re-read the main URL/title and body text from all visible scopes.
 * A blank/closed/unreadable page is "generic + unreadable", NOT proof that a
 * challenge vanished. The monitor refuses input on this initial state and cannot
 * accept it during post-solve verification. A normal generic block is distinct:
 * it has readable challenge evidence but is unsupported by the bundled solver.
 *
 * @param {import("patchright").Page} page
 * @param {{timeoutMs?: number}} [options] One shared read budget (default 5000 ms).
 * @returns {Promise<import("./target-challenge").ChallengeDetection>}
 */
async function inspectChallenge(page, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const run = (operation) => withTimeout(operation, deadline - Date.now());
  const unknown = {
    detected: true,
    kind: challengeKind.generic,
    unreadable: true,
  };
  try {
    if (page.isClosed()) {
      return unknown;
    }
    const url = page.url();
    const title = await run(() => page.title());
    const scopes = await visibleScopes(page, run);
    let readableContent = false;
    let detection = detectChallenge({ url, title });
    for (const scope of scopes) {
      const body = await run(() => scope.locator("body").innerText({
        timeout: Math.max(1, deadline - Date.now()),
      }));
      readableContent ||= Boolean(body.trim());
      const evidence = detectChallenge({ body });
      // Preserve positive evidence across scopes; a later clean frame must not
      // erase it. Specific hold text takes precedence over a generic URL match.
      if (evidence.detected && (!detection.detected || evidence.kind === challengeKind.pressAndHold)) {
        detection = evidence;
      }
    }
    if (detection.detected) {
      return detection;
    }
    // A blank/loading page is not evidence of successful recovery.
    return readableContent && /^(?:https?|file):/i.test(url)
      ? detection
      : unknown;
  } catch (error) {
    return unknown;
  }
}

module.exports = { inspectChallenge, visibleScopes, withTimeout };
