const { chromium } = require("playwright-core");

const endpoint = "http://127.0.0.1:9444";
const checkoutUrl = process.env.AMAZON_CHECKOUT_URL;
const unavailablePattern =
  /make updates to your items|there was a problem with some of the items in your order|the quantity you requested is no longer available|updated your quantity to the maximum available/i;
const verificationPattern =
  /verify (?:that )?you(?:'re| are) human|captcha|not a robot|robot check|enter the characters you see/i;

async function main() {
  if (!checkoutUrl) {
    throw new Error("AMAZON_CHECKOUT_URL is required.");
  }

  let refreshes = 0;
  let verificationActive = false;

  while (true) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 3000 });
      const context = browser.contexts()[0];
      const page = await context.newPage();
      await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

      while (!page.isClosed()) {
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);

        const bodyText = await page.locator("body").innerText().catch(() => "");
        const verificationVisible =
          verificationPattern.test(bodyText) ||
          /captcha|validatecaptcha/i.test(page.url());

        if (verificationVisible) {
          if (!verificationActive) {
            console.log("AMAZON_VERIFICATION_REQUIRED - waiting");
            verificationActive = true;
          }
          await page.waitForTimeout(1000);
          continue;
        }
        if (verificationActive) {
          console.log("AMAZON_VERIFICATION_CLEARED - resuming");
          verificationActive = false;
        }

        const unavailable = unavailablePattern.test(bodyText);
        if (!unavailable && page.url().includes("amazon.com/checkout")) {
          const placeOrder = page
            .getByRole("button", { name: /place (?:your )?order/i })
            .first();
          const placeOrderReady =
            (await placeOrder.count()) > 0 &&
            (await placeOrder.isVisible().catch(() => false)) &&
            (await placeOrder.isEnabled().catch(() => false));

          if (placeOrderReady) {
            console.log(`AMAZON_PLACE_ORDER_FOUND after ${refreshes} refreshes`);
            await placeOrder.click({ timeout: 5000 });
            console.log("AMAZON_PLACE_ORDER_CLICKED");
            await page
              .waitForFunction(
                () =>
                  /thank you,? your order has been placed|order placed|order number/i.test(
                    document.body?.innerText || "",
                  ),
                null,
                { timeout: 10000 },
              )
              .catch(() => {});

            const confirmationText = await page
              .locator("body")
              .innerText()
              .catch(() => "");
            if (
              /thank you,? your order has been placed|order placed|order number/i.test(
                confirmationText,
              )
            ) {
              console.log("AMAZON_ORDER_CONFIRMED");
              process.exit(0);
            }
            console.log("AMAZON_ORDER_NOT_CONFIRMED - retrying");
            continue;
          }

          const continueButton = page
            .getByRole("button", { name: /^continue$/i })
            .first();
          const continueReady =
            (await continueButton.count()) > 0 &&
            (await continueButton.isVisible().catch(() => false)) &&
            (await continueButton.isEnabled().catch(() => false));
          if (continueReady) {
            await continueButton.click({ timeout: 5000 }).catch(() => {});
            console.log("AMAZON_CONTINUE_CLICKED");
            await page.waitForTimeout(1000);
            continue;
          }

          await page.waitForTimeout(500);
          continue;
        }

        refreshes += 1;
        if (refreshes === 1 || refreshes % 10 === 0) {
          console.log(`AMAZON_REFRESH ${refreshes}`);
        }

        await page.goto(checkoutUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        }).catch(() => {});
      }
    } catch (error) {
      console.error(`AMAZON_RECONNECT ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
