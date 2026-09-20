/**
 * Optional native-input solver for ONE press-and-hold attempt on the supplied page.
 * It owns discovery, input, cleanup, and bounded completion waiting. The driver
 * owns retries/verification; the monitor owns request queues, backoff, and resume.
 * No fresh Chrome profile is needed. See TARGET-CHALLENGE-DEVELOPER-GUIDE.md.
 */
const { challengeKind } = require("./target-challenge");
const { inspectChallenge, visibleScopes, withTimeout } = require("./target-challenge-page");

const holdName = /^\s*press\s*(?:&|and)\s*hold\b/i;
const holdText = /^\s*press\s*(?:&|and)\s*hold\s*$/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reject malformed timing settings rather than silently accepting unsafe delays. */
function duration(env, name, fallback, minimum, maximum) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

/**
 * Build an attempt function. Production uses the default export below; the
 * factory lets tests supply configuration and a logical clock without networking.
 * Configuration is read at each invocation, before any input is sent.
 *
 * @param {object} [dependencies]
 * @param {Object<string, string|undefined>} [dependencies.env=process.env]
 * @param {() => number} [dependencies.now=Date.now] Millisecond clock for the budget.
 * @param {(ms: number) => Promise<void>} [dependencies.wait] Hold/poll-loop delay.
 * @returns {import("./target-challenge").ChallengeSolver} Ignores product/retry
 *   metadata for input; never recursively retries or refreshes the page itself.
 */
function createSolver({ env = process.env, now = Date.now, wait = sleep } = {}) {
  return async function solveChallenge({ page, kind, log = () => {} } = {}) {
    if (!page || typeof page.isClosed !== "function" || page.isClosed()) {
      throw new Error("CHALLENGE_PAGE_UNAVAILABLE");
    }
    if (kind !== challengeKind.pressAndHold) {
      throw new Error("CHALLENGE_KIND_UNSUPPORTED");
    }
    const timeoutMs = duration(env, "TARGET_CHALLENGE_TIMEOUT_MS", 20000, 1000, 45000);
    const started = now();
    const deadline = started + timeoutMs;
    const remaining = () => deadline - now();
    const run = (operation) => withTimeout(operation, remaining());
    // Reserve a small margin for pointer-down rather than spending the whole
    // attempt searching. The remaining budget is the dynamic hold/completion
    // window; the provider decides when the challenge is complete.
    const discoveryDeadline = deadline - 500;
    let control;
    let handle;
    let releaseRequired = false;
    let failure;

    try {
      while (!control && now() < discoveryDeadline) {
        const candidates = [];
        const scopes = await visibleScopes(page, run);
        // Prefer actionable roles globally; a paragraph with the same text is not a button.
        for (const role of [true, false]) {
          for (const scope of scopes) {
            const matches = role
              ? scope.getByRole("button", { name: holdName })
              : scope.getByText(holdText);
            const count = await run(() => matches.count());
            if (count > 16) {
              throw new Error("CHALLENGE_CONTROL_AMBIGUOUS");
            }
            for (let index = 0; index < count; index += 1) {
              const candidate = matches.nth(index);
              if ((await run(() => candidate.isVisible())) &&
                  (await run(() => candidate.isEnabled()))) {
                candidates.push(candidate);
              }
            }
          }
          if (candidates.length > 0) {
            break;
          }
        }
        // Picking an arbitrary first match could press a duplicate or unrelated
        // control. The visibility checks and uniqueness requirement are intentional.
        if (candidates.length > 1) {
          throw new Error("CHALLENGE_CONTROL_AMBIGUOUS");
        }
        control = candidates[0];
        if (!control) {
          await wait(Math.min(100, Math.max(1, discoveryDeadline - now())));
        }
      }
      if (!control) {
        throw new Error("CHALLENGE_CONTROL_NOT_FOUND");
      }
      // Hover performs browser hit-target/actionability checks, including overlays.
      await run(() => control.hover({ timeout: Math.max(1, remaining()) }));
      handle = await run(() => control.elementHandle({ timeout: Math.max(1, remaining()) }));
      if (!handle) {
        throw new Error("CHALLENGE_CONTROL_DETACHED");
      }
      const box = await run(() => handle.boundingBox());
      if (!box || box.width <= 0 || box.height <= 0) {
        throw new Error("CHALLENGE_CONTROL_NO_GEOMETRY");
      }
      await run(() => page.mouse.move(box.x + box.width / 2, box.y + box.height / 2));
      // Set BEFORE awaiting down: Chrome may receive input even if the protocol
      // acknowledgement fails. The finally block must still attempt mouse-up.
      releaseRequired = true;
      await run(() => page.mouse.down({ button: "left" }));
      log("TARGET_CHALLENGE_HOLD_STARTED");
      while (remaining() > 0) {
        if (page.isClosed()) {
          throw new Error("CHALLENGE_PAGE_UNAVAILABLE");
        }
        // Retain element identity: changing the accessible label during progress
        // must not cause an early release. Detach/navigation is verified by the driver.
        const visible = await run(() => handle.isVisible().catch(() => false));
        if (!visible) {
          break;
        }
        const evidence = await inspectChallenge(page, {
          timeoutMs: Math.min(250, Math.max(1, remaining())),
        });
        if (!evidence.detected && !evidence.unreadable) {
          break;
        }
        if (remaining() > 0) {
          await wait(Math.min(100, remaining()));
        }
      }
    } catch (error) {
      // Browser errors may include sensitive frame/request URLs. Keep logs categorical.
      failure = new Error(/^CHALLENGE_[A-Z_]+$/.test(error.message)
        ? error.message
        : "CHALLENGE_BROWSER_ACTION_FAILED");
    } finally {
      if (releaseRequired) {
        try {
          // Reserve a separate, bounded cleanup window even after the action deadline.
          await withTimeout(() => page.mouse.up({ button: "left" }), 1000, "CHALLENGE_RELEASE_FAILED");
        } catch (error) {
          failure ||= new Error("CHALLENGE_RELEASE_FAILED");
        }
      }
      if (handle) {
        // Disposal releases a local/remote object reference, not page content.
        // Its failure must not replace a more useful action/release error.
        await withTimeout(() => handle.dispose(), 500).catch(() => {});
      }
    }
    if (failure) {
      throw failure;
    }
    // A real widget can replace its label with a processing indicator while the
    // server is still deciding. Label disappearance is not completion. Spend the
    // remaining attempt budget waiting for live clearance; the driver will still
    // independently re-read the page after its own settle interval.
    while (remaining() > 0) {
      if (page.isClosed()) {
        throw new Error("CHALLENGE_PAGE_UNAVAILABLE");
      }
      const evidence = await inspectChallenge(page, {
        timeoutMs: Math.min(1000, remaining()),
      });
      if (!evidence.detected) {
        break;
      }
      if (remaining() > 0) {
        await wait(Math.min(100, remaining()));
      }
    }
    // FINISHED is attempt telemetry, not success. elapsedMs includes discovery,
    // dynamic hold, cleanup, and completion waiting. The driver decides the
    // outcome from its independent verification.
    log(`TARGET_CHALLENGE_HOLD_FINISHED elapsedMs=${now() - started}`);
  };
}

// The loader accepts this function directly. createSolver is only an additional
// construction/testing seam; importing this file does not start browser work.
module.exports = createSolver();
module.exports.createSolver = createSolver;
