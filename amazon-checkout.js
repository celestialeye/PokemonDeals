const { chromium } = require("playwright-core");
const {
  installAmazonRunLogger,
  sanitizeAmazonLogText,
} = require("./src/amazon-run-log");

const endpoint = "http://127.0.0.1:9444";
const checkoutUrl = process.env.AMAZON_CHECKOUT_URL;
const unavailablePattern =
  /make updates to your items|there was a problem with some of the items in your order|the quantity you requested is no longer available|updated your quantity to the maximum available|this item is currently unavailable|item(?:\(s\)|s)? you selected (?:are|is) not available|item .* is no longer available from the seller you selected|not available from your selected seller|items out of stock/i;
const verificationPattern =
  /verify (?:that )?you(?:'re| are) human|captcha|not a robot|robot check|enter the characters you see|two-step verification|one-time password|\botp\b|enter (?:the )?security code/i;
const signInPattern =
  /enter your email or mobile phone number|sign in to continue/i;
const duplicateOrderPattern =
  /potential duplicate order|duplicate order|you(?:'ve| have)? (?:recently|already) (?:purchased|ordered)|you ordered this item recently|this item was (?:recently|already) (?:purchased|ordered)/i;
const duplicateConsentPattern =
  /^(?:yes(?:,.*)?|i (?:still )?want.*order|i understand.*order|place (?:this|the) order anyway|order (?:it )?again)$/i;
const duplicateConfirmationPattern =
  /^(?:yes(?:,.*)?|place (?:your |this )?order(?: anyway)?|confirm(?: and place (?:your )?order)?|continue(?: and place (?:your )?order)?|order anyway|buy it again)$/i;
const confirmationTextPattern =
  /thank you,?\s+your order has been placed|your order has been placed|order placed successfully/i;
const confirmationUrlPattern =
  /\/(?:gp\/buy\/thankyou|checkout\/thankyou|order-confirmation)(?:[/?#]|$)/i;
const postSubmitConfirmationTimeoutMs = 60000;

function isUnavailableCheckoutText(bodyText) {
  return unavailablePattern.test(bodyText);
}

function isAmazonVerificationRequired(pageUrl, bodyText) {
  return (
    verificationPattern.test(bodyText) ||
    /captcha|validatecaptcha|\/ap\/(?:mfa|cvf)(?:[/?#]|$)/i.test(pageUrl)
  );
}

function isAmazonOrderConfirmed(pageUrl, bodyText) {
  return (
    confirmationTextPattern.test(bodyText) ||
    (confirmationUrlPattern.test(pageUrl) && /order number/i.test(bodyText))
  );
}

function isAmazonSignInRequired(pageUrl, bodyText) {
  return /\/ap\/signin(?:[/?#]|$)/i.test(pageUrl) || signInPattern.test(bodyText);
}

function isAmazonDuplicateOrderWarning(bodyText) {
  return duplicateOrderPattern.test(bodyText);
}

async function isReady(locator) {
  return (
    (await locator.count()) > 0 &&
    (await locator.isVisible().catch(() => false)) &&
    (await locator.isEnabled().catch(() => false))
  );
}

async function confirmAmazonDuplicateOrder(
  page,
  bodyText,
  {
    beforeClick = () => {},
    guardsValidated = false,
    submissionAttempted = false,
  } = {},
) {
  if (
    !submissionAttempted ||
    !guardsValidated ||
    !isAmazonDuplicateOrderWarning(bodyText)
  ) {
    return false;
  }

  const warning = page.getByText(duplicateOrderPattern).first();
  if (!(await isReady(warning))) {
    return false;
  }

  const consent = page
    .getByRole("checkbox", { name: duplicateConsentPattern })
    .or(page.getByRole("radio", { name: duplicateConsentPattern }))
    .first();
  if (await isReady(consent)) {
    const checked = await consent.isChecked().catch(() => false);
    if (!checked) {
      await consent.check({ timeout: 5000 });
      await page.waitForTimeout(250);
    }
  }

  const confirmation = page
    .getByRole("button", { name: duplicateConfirmationPattern })
    .first();
  if (!(await isReady(confirmation))) {
    return false;
  }

  beforeClick();
  await confirmation.click({ timeout: 5000 });
  return true;
}

function sanitizeAmazonError(error) {
  return sanitizeAmazonLogText(error?.message || error);
}

async function main() {
  if (!checkoutUrl) {
    throw new Error("AMAZON_CHECKOUT_URL is required.");
  }

  let checkoutAsin = "";
  try {
    checkoutAsin = new URL(checkoutUrl).searchParams.get("asin") || "";
  } catch {}
  installAmazonRunLogger({
    workflow: "amazon-checkout",
    metadata: {
      asin: checkoutAsin,
      quantity: 1,
    },
  });

  let refreshes = 0;
  let submissionAttempted = false;
  let submissionAttemptedAt = 0;
  let verificationActive = false;
  let signInActive = false;

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
        const verificationVisible = isAmazonVerificationRequired(
          page.url(),
          bodyText,
        );

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

        const signInVisible = isAmazonSignInRequired(page.url(), bodyText);
        if (signInVisible) {
          if (!signInActive) {
            console.log("AMAZON_SIGN_IN_REQUIRED - waiting");
            signInActive = true;
          }
          await page.waitForTimeout(1000);
          continue;
        }
        if (signInActive) {
          console.log("AMAZON_SIGN_IN_CLEARED - resuming");
          signInActive = false;
        }

        if (
          submissionAttempted &&
          isAmazonOrderConfirmed(page.url(), bodyText)
        ) {
          console.log("AMAZON_ORDER_CONFIRMED");
          process.exit(0);
        }

        if (submissionAttempted) {
          if (
            Date.now() - submissionAttemptedAt >=
            postSubmitConfirmationTimeoutMs
          ) {
            console.error(
              "AMAZON_ORDER_CONFIRMATION_AMBIGUOUS - stopping to avoid a duplicate submission",
            );
            process.exit(1);
          }
          await page.waitForTimeout(1000);
          continue;
        }

        const unavailable = isUnavailableCheckoutText(bodyText);
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
            submissionAttempted = true;
            submissionAttemptedAt = Date.now();
            await placeOrder.click({ timeout: 5000 });
            console.log("AMAZON_PLACE_ORDER_CLICKED");
            await page.waitForTimeout(1000);
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
      console.error(`AMAZON_RECONNECT ${sanitizeAmazonError(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  confirmAmazonDuplicateOrder,
  isAmazonDuplicateOrderWarning,
  isAmazonOrderConfirmed,
  isAmazonSignInRequired,
  isAmazonVerificationRequired,
  isUnavailableCheckoutText,
  sanitizeAmazonError,
};
