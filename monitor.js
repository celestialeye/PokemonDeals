const { chromium } = require("playwright-core");
const { validateCartContents } = require("./target-products");

const endpoint = "http://127.0.0.1:9444";
const checkoutUrl = "https://www.target.com/checkout";
const targetPin = process.env.TARGET_PIN;
const verificationPattern =
  /verify (?:that )?you(?:'re| are) human|security check|press and hold|captcha|not a robot|access denied/i;
const highDemandPattern =
  /high-demand item in your cart|a popular item in your cart is causing a delay|checkout is busy right now|limiting how many guests can check out/i;

async function hasPageVerification(page) {
  if (/captcha|challenge|blocked|verify/i.test(page.url())) {
    return true;
  }

  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return verificationPattern.test(`${title}\n${bodyText}`);
}

async function hasTargetHighDemand(context) {
  for (const candidate of context.pages()) {
    if (!candidate.url().includes("target.com")) {
      continue;
    }

    const bodyText = await candidate.locator("body").innerText().catch(() => "");
    if (highDemandPattern.test(bodyText)) {
      return true;
    }
  }

  return false;
}

async function hasValidTargetCart(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.href))
    .catch(() => []);
  return validateCartContents({ bodyText, hrefs });
}

function findExistingCheckoutPage(context) {
  return context
    .pages()
    .find((candidate) => /target\.com\/checkout/i.test(candidate.url()));
}

async function waitForOrderResult(page) {
  await page
    .waitForFunction(
      () => {
        const text = document.body?.innerText || "";
        return /high-demand item in your cart|a popular item in your cart is causing a delay|checkout is busy right now|limiting how many guests can check out|confirm your pin|thank you for your order|your order has been placed|we received your order|order number\s*#?/i.test(
          text,
        );
      },
      null,
      { timeout: 5000 },
    )
    .catch(() => {});

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (
    /order-confirmation|thank-you|confirmation/i.test(page.url()) ||
    /thank you for your order|your order has been placed|we received your order|order number\s*#?/i.test(
      bodyText,
    )
  ) {
    return "confirmed";
  }
  if (highDemandPattern.test(bodyText)) {
    return "high-demand";
  }
  if (/confirm your pin/i.test(bodyText)) {
    return "pin";
  }
  return "retry";
}

async function main() {
  let refreshes = 0;
  let verificationActive = false;
  let priceActive = false;

  while (true) {
    let browser;
    let page;

    try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 3000 });
    const context = browser.contexts()[0];
    page = findExistingCheckoutPage(context) || (await context.newPage());
    if (!/target\.com\/checkout/i.test(page.url())) {
      await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    }

    while (!page.isClosed()) {
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page
        .waitForFunction(
          () => {
            const text = document.body?.innerText || "";
            const hasPlaceOrder = [...document.querySelectorAll("button")].some((button) =>
              /place(?: your)? order/i.test(button.innerText || button.textContent || ""),
            );
            const hasSaveAndContinue = [...document.querySelectorAll("button")].some(
              (button) =>
                /save and continue/i.test(button.innerText || button.textContent || ""),
            );
            return (
              hasPlaceOrder ||
              hasSaveAndContinue ||
              /\$\s*\d+(?:,\d{3})*\.\d{2}\b/.test(text) ||
              /high-demand item in your cart|a popular item in your cart is causing a delay|checkout is busy right now|limiting how many guests can check out/i.test(
                text,
              )
            );
          },
          null,
          { timeout: 1000 },
        )
        .catch(() => {});

      const verificationVisible = await hasPageVerification(page);
      if (verificationVisible) {
        if (!verificationActive) {
          console.log("VERIFICATION_REQUIRED - waiting for manual completion");
          verificationActive = true;
        }
        await page.waitForTimeout(1000);
        continue;
      }
      if (verificationActive) {
        console.log("VERIFICATION_CLEARED - resuming");
        verificationActive = false;
      }

      const pinDialog = page.getByText(/^confirm your pin$/i).first();
      const pinDialogVisible =
        (await pinDialog.count()) > 0 &&
        (await pinDialog.isVisible().catch(() => false));
      if (pinDialogVisible) {
        if (!targetPin) {
          throw new Error("TARGET_PIN is required for the PIN confirmation dialog.");
        }

        const pinInput = page.getByLabel(/enter pin/i).first();
        const confirmPin = page.getByRole("button", { name: /^confirm$/i }).first();
        await pinInput.fill(targetPin);
        await confirmPin.click({ timeout: 5000 });
        console.log("PIN_CONFIRMED");
        await page.waitForTimeout(500);
        continue;
      }

      if (new URL(page.url()).pathname === "/cart") {
        console.log("CART_REDIRECT - returning to checkout");
        await page.goto(checkoutUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        }).catch(() => {});
        continue;
      }

      const highDemand = page
        .getByText(highDemandPattern)
        .first();
      const highDemandVisible =
        (await highDemand.count()) > 0 &&
        (await highDemand.isVisible().catch(() => false));
      if (highDemandVisible) {
        const dialog = page.getByRole("dialog").filter({ hasText: highDemandPattern }).first();
        const dialogOk = dialog.getByRole("button", { name: /^ok$/i }).first();
        const pageOk = page.getByRole("button", { name: /^ok$/i }).first();
        const okButton = (await dialogOk.count()) > 0 ? dialogOk : pageOk;

        if (
          (await okButton.count()) > 0 &&
          (await okButton.isVisible().catch(() => false))
        ) {
          await okButton.click({ timeout: 3000 }).catch(() => {});
          console.log("HIGH_DEMAND_OK_CLICKED");
          await page.waitForTimeout(500);
          continue;
        }
      }

      const saveAndContinue = page
        .getByRole("button", { name: /save and continue/i })
        .first();
      const saveAndContinueReady =
        (await saveAndContinue.count()) > 0 &&
        (await saveAndContinue.isVisible().catch(() => false)) &&
        (await saveAndContinue.isEnabled().catch(() => false));
      if (saveAndContinueReady) {
        await saveAndContinue.click({ timeout: 5000 }).catch(() => {});
        console.log("SAVE_AND_CONTINUE_CLICKED");
        await page.waitForTimeout(1000);
        continue;
      }

      const placeOrder = page
        .getByRole("button", { name: /place(?: your)? order/i })
        .first();
      const placeOrderReady =
        (await placeOrder.count()) > 0 &&
        (await placeOrder.isVisible().catch(() => false)) &&
        (await placeOrder.isEnabled().catch(() => false));

      if (placeOrderReady) {
        if (!(await hasValidTargetCart(page))) {
          console.error("CART_VALIDATION_FAILED - refusing to place order");
          await page.close().catch(() => {});
          process.exit(2);
        }

        console.log(`PLACE_ORDER_FOUND after ${refreshes} refreshes`);
        await placeOrder.click({ timeout: 5000 });
        console.log("PLACE_ORDER_CLICKED");
        const result = await waitForOrderResult(page);
        if (result === "confirmed") {
          console.log("ORDER_CONFIRMED");
          process.exit(0);
        }
        console.log(`PLACE_ORDER_${result.toUpperCase()} - retrying`);
        continue;
      }

      const bodyText = await page.locator("body").innerText().catch(() => "");
      const itemPriceVisible = /\$\s*\d+(?:,\d{3})*\.\d{2}\b/.test(bodyText);
      if (!highDemandVisible && itemPriceVisible) {
        if (!priceActive) {
          console.log("ITEM_PRICE_FOUND - pausing checkout refresh");
          priceActive = true;
        }
        await page.waitForTimeout(250);
        continue;
      }
      if (priceActive) {
        console.log("ITEM_PRICE_CLEARED - resuming checkout refresh");
        priceActive = false;
      }

      refreshes += 1;
      if (refreshes === 1 || refreshes % 10 === 0) {
        console.log(`REFRESH ${refreshes}`);
      }

      await page.waitForTimeout(1000);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    }
    } catch (error) {
    console.error(`RECONNECT ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
