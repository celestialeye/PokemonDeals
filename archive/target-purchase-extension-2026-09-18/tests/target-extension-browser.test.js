const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");
const {
  createSchedulerServer,
} = require("../scripts/target-extension-scheduler");

const repositoryRoot = path.join(__dirname, "..");
const sourceExtensionPath = path.join(
  repositoryRoot,
  "extension",
  "target-purchase",
);
const fixturesPath = path.join(__dirname, "fixtures");

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesPath, name), "utf8");
}

async function waitForExtensionServiceWorker(context) {
  const existing = context.serviceWorkers()[0];
  return existing || context.waitForEvent("serviceworker", { timeout: 15000 });
}

async function waitForCondition(check, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}. Last value: ${JSON.stringify(lastValue)}`);
}

(async () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pokemon-deals-extension-test-"),
  );
  const userDataDirectory = path.join(temporaryDirectory, "profile");
  const extensionPath = path.join(temporaryDirectory, "extension");
  const scheduler = createSchedulerServer({
    port: 0,
    intervalMs: 5000,
    autoTick: false,
  });
  await scheduler.ready;
  fs.mkdirSync(userDataDirectory);
  fs.cpSync(sourceExtensionPath, extensionPath, { recursive: true });
  for (const relativePath of ["background.js", "manifest.json"]) {
    const filePath = path.join(extensionPath, relativePath);
    const source = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(
      filePath,
      source.replaceAll("18765", String(scheduler.port)),
    );
  }
  let context;

  try {
    context = await chromium.launchPersistentContext(userDataDirectory, {
      executablePath: chromium.executablePath(),
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-position=-32000,-32000",
      ],
    });

    let productAvailable = false;
    let productRequests = 0;
    let disabledRequests = 0;
    let failureRequests = 0;
    let verificationRequests = 0;

    await context.route("https://www.target.com/**", async (route) => {
      const url = new URL(route.request().url());
      let fixtureName;
      if (url.pathname.includes("A-1010892065")) {
        productRequests += 1;
        fixtureName = productAvailable
          ? "target-product-available.html"
          : "target-product-unavailable.html";
      } else if (url.pathname.includes("A-1010892067")) {
        failureRequests += 1;
        fixtureName = "target-product-failure.html";
      } else if (url.pathname.includes("A-1010892070")) {
        disabledRequests += 1;
        fixtureName = "target-product-disabled.html";
      } else if (url.pathname.includes("A-1010892068")) {
        verificationRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>Security check</title><body>Verify you are human</body>",
        });
        return;
      } else if (url.pathname === "/checkout" && url.searchParams.has("safety")) {
        fixtureName = "target-checkout-blocked.html";
      } else if (url.pathname === "/checkout") {
        fixtureName = "target-checkout.html";
      } else if (url.pathname === "/co-thankyou") {
        fixtureName = "target-confirmation.html";
      } else {
        fixtureName = "target-product-unavailable.html";
      }

      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: readFixture(fixtureName),
      });
    });

    const worker = await waitForExtensionServiceWorker(context);
    const extensionId = new URL(worker.url()).host;
    const controlPage = await context.newPage();
    await controlPage.goto(
      `chrome-extension://${extensionId}/popup/popup.html`,
    );

    async function send(message) {
      return controlPage.evaluate(
        (payload) => chrome.runtime.sendMessage(payload),
        message,
      );
    }

    async function getTabId(url) {
      return controlPage.evaluate(async (expectedUrl) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => tab.url === expectedUrl)?.id || null;
      }, url);
    }

    async function getTabState(tabId) {
      const response = await send({ type: "GET_STATUS", tabId });
      return response.state.tabs[String(tabId)] || null;
    }

    async function runTick() {
      const response = await send({ type: "RUN_TICK_NOW" });
      assert.strictEqual(response.ok, true);
    }

    await waitForCondition(async () => {
      const response = await send({ type: "GET_STATUS" });
      return response.state.scheduler.connected;
    }, "Scheduler did not connect");

    const productUrl =
      "https://www.target.com/p/simulated-product/-/A-1010892065";
    const productPage = await context.newPage();
    await productPage.goto(productUrl);
    const productTabId = await getTabId(productUrl);
    assert.ok(Number.isInteger(productTabId));

    await send({
      type: "ARM_PRODUCT",
      tabId: productTabId,
      url: productUrl,
    });
    await runTick();
    await waitForCondition(
      () => productRequests >= 2,
      "Unavailable product tab did not reload",
    );

    productAvailable = true;
    await runTick();
    await waitForCondition(
      () => productRequests >= 3,
      "Product tab did not load the available fixture",
    );
    await productPage.waitForSelector("#purchase");

    await runTick();
    await waitForCondition(
      () => productPage.evaluate(() => window.__purchaseClicks === 1),
      "Available product was not clicked",
    );
    await waitForCondition(
      async () => (await getTabState(productTabId))?.phase === "added",
      "Product tab did not enter added state",
    );

    const requestsAfterSuccess = productRequests;
    await runTick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(
      await productPage.evaluate(() => window.__purchaseClicks),
      1,
    );
    assert.strictEqual(productRequests, requestsAfterSuccess);

    const checkoutUrl = "https://www.target.com/checkout";
    const checkoutPage = await context.newPage();
    await checkoutPage.goto(checkoutUrl);
    const checkoutTabId = await getTabId(checkoutUrl);
    await send({
      type: "ARM_CHECKOUT",
      tabId: checkoutTabId,
      url: checkoutUrl,
    });
    await runTick();
    await checkoutPage.waitForURL("**/co-thankyou?order=SIMULATED");
    assert.strictEqual(
      await checkoutPage.evaluate(
        () => Number(localStorage.getItem("placeOrderClicks")),
      ),
      1,
    );
    await runTick();
    await waitForCondition(
      async () => (await getTabState(checkoutTabId))?.phase === "confirmed",
      "Checkout did not detect confirmation after a full-page redirect",
    );
    await runTick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(
      await checkoutPage.evaluate(
        () => Number(localStorage.getItem("placeOrderClicks")),
      ),
      1,
    );

    const blockedUrl = "https://www.target.com/checkout?safety=1";
    const blockedPage = await context.newPage();
    await blockedPage.goto(blockedUrl);
    const blockedTabId = await getTabId(blockedUrl);
    assert.ok(Number.isInteger(blockedTabId));
    await send({
      type: "ARM_CHECKOUT",
      tabId: blockedTabId,
      url: blockedUrl,
    });
    await runTick();
    await waitForCondition(
      async () => (await getTabState(blockedTabId))?.phase === "blocked",
      "Unrecognized checkout cart was not blocked",
    );
    assert.strictEqual(
      await blockedPage.evaluate(() => window.__placeOrderClicks),
      0,
    );

    const failureUrl = "https://www.target.com/p/failure/-/A-1010892067";
    const failurePage = await context.newPage();
    await failurePage.goto(failureUrl);
    const failureTabId = await getTabId(failureUrl);
    await send({
      type: "ARM_PRODUCT",
      tabId: failureTabId,
      url: failureUrl,
    });
    await runTick();
    await waitForCondition(
      async () => (await getTabState(failureTabId))?.phase === "cooldown",
      "Failed add did not enter cooldown",
    );
    assert.strictEqual(
      await failurePage.evaluate(() => window.__purchaseClicks),
      1,
    );
    await runTick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(
      await failurePage.evaluate(() => window.__purchaseClicks),
      1,
    );
    assert.strictEqual(failureRequests, 1);

    const disabledUrl = "https://www.target.com/p/disabled/-/A-1010892070";
    const disabledPage = await context.newPage();
    await disabledPage.goto(disabledUrl);
    const disabledTabId = await getTabId(disabledUrl);
    await send({
      type: "ARM_PRODUCT",
      tabId: disabledTabId,
      url: disabledUrl,
    });
    await runTick();
    await waitForCondition(
      () => disabledRequests >= 2,
      "Visible disabled purchase control did not refresh",
    );
    assert.strictEqual(
      await disabledPage.evaluate(() => window.__purchaseClicks),
      0,
    );
    assert.ok(disabledRequests >= 2);

    const changedProductUrl =
      "https://www.target.com/p/changed/-/A-1010892071";
    await disabledPage.goto(changedProductUrl);
    await runTick();
    await waitForCondition(
      async () => (await getTabState(disabledTabId))?.phase === "stopped",
      "Navigating an armed tab to another product did not stop it",
    );

    const verificationUrl =
      "https://www.target.com/p/verification/-/A-1010892068";
    const verificationPage = await context.newPage();
    await verificationPage.goto(verificationUrl);
    const verificationTabId = await getTabId(verificationUrl);
    await send({
      type: "ARM_PRODUCT",
      tabId: verificationTabId,
      url: verificationUrl,
    });
    await runTick();
    await waitForCondition(
      async () => (await getTabState(verificationTabId))?.phase === "verification",
      "Verification page did not pause",
    );
    await runTick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(verificationRequests, 1);
    assert.strictEqual(productPage.isClosed(), false);
    assert.strictEqual(checkoutPage.isClosed(), false);
    assert.strictEqual(failurePage.isClosed(), false);
    assert.strictEqual(disabledPage.isClosed(), false);
    assert.strictEqual(verificationPage.isClosed(), false);

    console.log(
      `target-extension-browser tests passed extensionId=${extensionId}`,
    );
  } finally {
    await context?.close().catch(() => {});
    await scheduler.close().catch(() => {});
    const resolvedTemp = path.resolve(temporaryDirectory);
    const resolvedBase = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${resolvedBase}${path.sep}`)) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
