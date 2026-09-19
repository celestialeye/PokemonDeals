/**
 * Local browser integration, not a live Target/HUMAN acceptance test.
 * Each case gets a separate context; isolated() fulfills or aborts network traffic.
 * Real-looking Target URLs exercise URL parsing/response hooks without a retailer
 * request. Never attach this routing harness to the user's authenticated context.
 * See TARGET-CHALLENGE-DEVELOPER-GUIDE.md for the test/evidence layers.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// This process is isolated from operational workers. Every HTTPS request in
// these tests is fulfilled or aborted locally; no real retailer is contacted.
// Set environment options BEFORE requiring target-watch: it captures them at load.
process.env.TARGET_MONITOR_OBSERVE_ONLY = "1";
process.env.TARGET_CHALLENGE_VALIDATE = "1";
process.env.TARGET_CHALLENGE_SOLVER = require.resolve("../target-challenge-solver");
process.env.TARGET_CHALLENGE_SOLVE_ATTEMPTS = "2";
process.env.TARGET_CHALLENGE_SETTLE_MS = "500";
process.env.TARGET_CHALLENGE_HOLD_MS = "1200";
process.env.TARGET_CHALLENGE_TIMEOUT_MS = "4000";
process.env.TARGET_MONITOR_POLL_MS = "2000";

const { createSolver } = require("../target-challenge-solver");
const { inspectChallenge } = require("../target-challenge-page");
const { resolveChallenge } = require("../target-challenge");
const {
  attachResponseMonitor, createMonitorState, handleChallenge,
  navigateProduct, pollAvailability, triggerPurchase,
} = require("../target-watch");
const driver = process.env.TARGET_BROWSER_DRIVER === "playwright" ? "playwright-core" : "patchright";
const { chromium } = require(driver);
let browser;
let variants;
const product = { id: "A-1007918679", tcin: "1007918679", url: "https://www.target.com/p/-/A-1007918679" };
const endpoint = "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1?tcin=1007918679";
const payload = JSON.stringify({ data: { product: { fulfillment: { shipping_options: { availability_status: "OUT_OF_STOCK" } } } } });
const productHtml = `<title>Pokemon product</title><h1>Pokemon product</h1><button onclick="document.documentElement.dataset.purchaseClicks++">Add to cart</button><script>document.documentElement.dataset.purchaseClicks = '0'; fetch(${JSON.stringify(endpoint)}).then(r => r.text());</script>`;
// Page-script globals are not shared with Patchright's isolated evaluation world.
// DOM attributes let both drivers read the same fixture evidence without injecting
// synthetic events or treating an action call as proof the widget received input.
async function inputEvidence(scope) {
  const html = scope.locator("html");
  return {
    down: Number(await html.getAttribute("data-down")),
    up: Number(await html.getAttribute("data-up")),
    trusted: (await html.getAttribute("data-trusted")) === "true",
  };
}

function jobFor(page) {
  return { page, product, availabilityRequest: null, lastSummary: null, lastFingerprint: null,
    pollCount: 0, challengeSignal: null, nextNavigationAt: 0, triggered: false,
    completed: false, terminal: false, requestedMode: "auto" };
}
function stateFor(logs = []) {
  return createMonitorState({ observe: true, validation: true, maximumPolls: 10, runtimeMs: 30000,
    log: (line) => logs.push(line), error: (line) => logs.push(line) });
}
function localSolver(holdMs = 1200, timeoutMs = 4000) {
  return createSolver({ env: {
    TARGET_CHALLENGE_HOLD_MS: String(holdMs), TARGET_CHALLENGE_TIMEOUT_MS: String(timeoutMs),
  } });
}
/** Exercise the production retry contract, including an independent final read. */
async function resolve(page, solve = localSolver(), attempts = 1) {
  const detected = await inspectChallenge(page);
  assert.equal(detected.kind, "press_and_hold");
  return resolveChallenge({ page, kind: detected.kind, solver: solve, maxAttempts: attempts, settleMs: 100,
    verifyCleared: async () => !(await inspectChallenge(page)).detected });
}
// Wait for async Node response-listener state, not a browser DOM condition.
async function eventually(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("LOCAL_TEST_CONDITION_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
/**
 * Create one disposable context. A fixture handler returns HTML or a fulfill()
 * response; undefined aborts the request. Only file:// fixtures can continue to
 * their real resource. Teardown is registered before navigation so failures do
 * not leave a test context behind. This function must never use CDP.
 */
async function isolated(t, handler) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "file:") {
      await route.continue();
      return;
    }
    const response = await handler(url, route.request());
    if (response !== undefined) {
      await route.fulfill(typeof response === "string"
        ? { status: 200, contentType: "text/html", body: response }
        : response);
    } else {
      await route.abort();
    }
  });
  return context.newPage();
}

test.before(async () => {
  console.log(`TARGET_CHALLENGE_E2E_SCOPE=LOCAL_FIXTURES_NO_RETAILER_NETWORK driver=${driver}`);
  variants = await fs.readFile(path.join(__dirname, "fixtures", "target-press-and-hold-variants.html"), "utf8");
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
test.after(async () => { if (browser) await browser.close(); });

test("existing file fixture: native 800ms hold and independent verification", { timeout: 15000 }, async (t) => {
  const page = await isolated(t, () => undefined);
  await page.goto(pathToFileURL(path.join(__dirname, "fixtures", "target-press-and-hold.html")).href);
  assert.equal((await resolve(page)).outcome, "cleared");
  assert.equal(await page.title(), "Target product page");
});

test("cross-origin nested iframe, delayed control, changing label, and trusted input", { timeout: 15000 }, async (t) => {
  const page = await isolated(t, (url) => {
    if (url.hostname === "outer.invalid") return '<title>Target</title><iframe src="https://middle.invalid/"></iframe>';
    if (url.hostname === "middle.invalid") return '<iframe src="https://widget.invalid/?delay=200&label=1"></iframe>';
    return variants;
  });
  await page.goto("https://outer.invalid/");
  assert.equal((await resolve(page)).outcome, "cleared");
  const evidence = await inputEvidence(page.frames().find((frame) => frame.url().includes("widget.invalid")));
  assert.equal(evidence.down, 1);
  assert.equal(evidence.up, 1);
  assert.equal(evidence.trusted, true);
});

test("closed-shadow widget selects only the visible frame and independently verifies recovery", { timeout: 15000 }, async (t) => {
  const page = await isolated(t, (url) => {
    if (url.hostname === "outer.invalid") {
      return `<title>Target</title><h1>Product</h1><div id="widget"></div><script>
        const root = document.querySelector('#widget').attachShadow({ mode: 'closed' });
        root.innerHTML = '<iframe title="Human verification challenge" src="https://widget.invalid/?label=1"></iframe><iframe style="display:none" title="Human verification challenge" src="https://hidden.invalid/?never=1"></iframe>';
      </script>`;
    }
    return variants;
  });
  await page.goto("https://outer.invalid/");
  // Patchright and Playwright differ in CSS visibility into closed roots.
  // Discovery must work without depending on either driver's CSS behavior.
  assert.equal(page.frames().filter((frame) => /(?:widget|hidden)\.invalid/.test(frame.url())).length, 2);
  assert.equal((await resolve(page)).outcome, "cleared");
  const active = page.frames().find((frame) => frame.url().includes("widget.invalid"));
  const hidden = page.frames().find((frame) => frame.url().includes("hidden.invalid"));
  assert.equal((await inputEvidence(active)).down, 1);
  assert.equal((await inputEvidence(active)).up, 1);
  assert.equal((await inputEvidence(hidden)).down, 0);
});

test("navigation and disappearing frame recover without requiring one completion mechanism", { timeout: 20000 }, async (t) => {
  for (const mode of ["navigate", "detach"]) {
    const page = await isolated(t, (url) => {
      if (url.pathname === "/product") return "<title>Product</title><h1>Pokemon product</h1>";
      if (url.hostname === "outer.invalid") return `<title>Target</title><iframe src="https://widget.invalid/?${mode}=1"></iframe><script>addEventListener('message', (e) => { if(e.data === 'fixture-complete') document.body.innerHTML = '<h1>Pokemon product</h1>'; });</script>`;
      return variants;
    });
    await page.goto(mode === "detach" ? "https://outer.invalid/" : "https://widget.invalid/?navigate=1");
    assert.equal((await resolve(page)).outcome, "cleared");
  }
});

test("provider-style processing beyond settle time is awaited before returning", { timeout: 12000 }, async (t) => {
  const page = await isolated(t, () => variants);
  await page.goto("https://widget.invalid/?processing=2500");
  const started = Date.now();
  const result = await resolve(page, localSolver(1200, 6000));
  assert.equal(result.outcome, "cleared");
  assert.ok(Date.now() - started >= 3000);
  assert.equal((await inputEvidence(page)).down, 1);
  assert.equal((await inputEvidence(page)).up, 1);
});

test("one-second and ten-second fixture holds complete with native input", { timeout: 25000 }, async (t) => {
  for (const duration of [1000, 10000]) {
    const page = await isolated(t, () => variants);
    await page.goto(`https://widget.invalid/?duration=${duration}&label=1`);
    assert.equal((await resolve(page, localSolver(duration, duration + 3000))).outcome, "cleared");
    const evidence = await inputEvidence(page);
    assert.equal(evidence.down, 1);
    assert.equal(evidence.up, 1);
    assert.equal(evidence.trusted, true);
  }
});

test("early release resets fixture, stays blocked, and leaves no held pointer", { timeout: 12000 }, async (t) => {
  const page = await isolated(t, () => variants);
  await page.goto("https://widget.invalid/");
  assert.equal((await resolve(page, localSolver(100, 1500))).outcome, "unresolved");
  const evidence = await inputEvidence(page);
  assert.equal(evidence.down, evidence.up);
  assert.equal(await page.locator("#status").innerText(), "Hold longer");
  assert.equal((await inspectChallenge(page)).detected, true);
});

test("persistent real-browser fixture exhausts attempts with cleanup on each", { timeout: 15000 }, async (t) => {
  const page = await isolated(t, () => variants);
  await page.goto("https://widget.invalid/?never=1");
  const result = await resolve(page, localSolver(200, 2000), 2);
  assert.equal(result.outcome, "unresolved");
  const evidence = await inputEvidence(page);
  assert.equal(evidence.down, 2);
  assert.equal(evidence.up, 2);
});

test("disabled and ambiguous controls fail without pointer input", { timeout: 12000 }, async (t) => {
  for (const mode of ["disabled", "duplicate"]) {
    const page = await isolated(t, () => variants);
    await page.goto(`https://widget.invalid/?${mode}=1`);
    assert.equal((await resolve(page, localSolver(100, 1500))).outcome, "failed");
    assert.equal((await inputEvidence(page)).down, 0);
  }
});

test("monitor E2E: API block, render, solve, fresh template, resumed 200 poll, no purchase", { timeout: 30000 }, async (t) => {
  let challenged = false;
  let apiRequests = 0;
  const page = await isolated(t, (url) => {
    if (url.hostname === "redsky.target.com") {
      apiRequests += 1;
      if (apiRequests === 2) {
        challenged = true;
        return { status: 403, contentType: "text/html", body: "Quick verification Press & Hold" };
      }
      return { status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "https://www.target.com", "access-control-allow-credentials": "true" }, body: payload };
    }
    if (url.pathname === "/fixture-solved") {
      challenged = false;
      return "ok";
    }
    if (url.hostname === "widget.invalid") return variants;
    if (url.hostname === "www.target.com") {
      // Same-origin signal lets the local fixture tell this intercepted origin it cleared.
      return challenged ? variants.replace('options.has("signal")', "true") : productHtml;
    }
  });
  const logs = [];
  const state = stateFor(logs);
  const job = jobFor(page);
  job.requestedMode = "add-to-cart";
  await attachResponseMonitor(job, state);
  await navigateProduct(job, state);
  await eventually(() => job.availabilityRequest !== null);
  await state.enqueueGlobalPoll(() => pollAvailability(job, state));
  assert.equal(state.calibrationSummary().challengeSolvedCount, 1);
  assert.equal(job.availabilityRequest, null);
  assert.equal(state.shouldStop(), false);
  await state.enqueueGlobalPoll(() => pollAvailability(job, state));
  await eventually(() => job.availabilityRequest !== null);
  await state.enqueueGlobalPoll(() => pollAvailability(job, state));
  const solvedIndex = logs.findIndex((line) => line.startsWith("TARGET_CHALLENGE_SOLVED"));
  assert.ok(solvedIndex >= 0);
  assert.ok(logs.slice(solvedIndex + 1).some((line) => line.startsWith("TARGET_API_POLL") && line.includes('"status":200')));
  assert.equal(state.calibrationSummary().queue.maximumActive, 1);
  assert.equal(state.calibrationSummary().challengePending, false);
  assert.equal(await page.locator("html").getAttribute("data-purchase-clicks"), "0");
});

test("monitor E2E: passive challenge signal renders and recovers on the next poll", { timeout: 15000 }, async (t) => {
  let solved = false;
  const page = await isolated(t, (url) => {
    if (url.hostname === "redsky.target.com") return { status: 403, contentType: "text/html", body: "Press & Hold" };
    if (url.pathname === "/fixture-solved") { solved = true; return "ok"; }
    if (url.pathname === "/start") return productHtml;
    return solved ? "<h1>Pokemon product</h1>" : variants.replace('options.has("signal")', "true");
  });
  const job = jobFor(page);
  const state = stateFor();
  await attachResponseMonitor(job, state);
  await page.goto("https://www.target.com/start");
  await eventually(() => Boolean(job.challengeSignal));
  await state.enqueueGlobalPoll(() => pollAvailability(job, state));
  assert.equal(state.calibrationSummary().challengeSolvedCount, 1);
  assert.equal(job.challengeSignal, null);
});

test("monitor E2E: challenge during initial navigation and post-click never deadlocks", { timeout: 25000 }, async (t) => {
  const page = await isolated(t, (url) => {
    if (url.searchParams.has("start")) return '<title>Product</title><h1>Pokemon product</h1><button onclick="location.href=\'/p/-/A-1007918679\'">Add to cart</button>';
    return variants;
  });
  const state = stateFor();
  const job = jobFor(page);
  job.requestedMode = "add-to-cart";
  await navigateProduct(job, state);
  assert.equal(state.calibrationSummary().challengeSolvedCount, 1);
  await page.goto(`${product.url}?start=1`);
  await state.enqueueMutation(() => triggerPurchase(job, state, "local fixture", null, {
    label: "Add to cart", button: page.getByRole("button", { name: "Add to cart" }),
  }, { notify: async () => {} }));
  assert.equal(state.calibrationSummary().challengeSolvedCount, 2);
  assert.equal(job.triggered, false);
  assert.equal(job.completed, false); // solving a challenge never implies cart success
  await state.enqueueMutation(async () => {});
});

test("monitor E2E: a lying solver cannot clear a persistent browser challenge", { timeout: 10000 }, async (t) => {
  const page = await isolated(t, () => variants);
  await page.goto("https://widget.invalid/?never=1");
  const state = stateFor();
  assert.equal(await handleChallenge(jobFor(page), state, "local fixture", {
    solver: async () => true, maxAttempts: 1, settleMs: 0,
  }), "blocked");
  assert.equal(state.calibrationSummary().challengeSolvedCount, 0);
  assert.ok(state.isPaused());
});
