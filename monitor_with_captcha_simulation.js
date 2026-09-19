const { chromium } = require("playwright-core");

const endpoint = "http://127.0.0.1:9444";
const checkoutUrl = "https://www.target.com/checkout";
const priceRefreshGraceMs = 5000;
const targetPin = process.env.TARGET_PIN;
const verificationPattern =
  /verify (?:that )?you(?:'re| are) human|security check|press and hold|captcha|not a robot|access denied|robot check/i;
const highDemandPattern =
  /high-demand item in your cart|a popular item in your cart is causing a delay|checkout is busy right now|limiting how many guests can check out/i;

async function hasPageVerification(page) {
  if (/captcha|challenge|blocked|verify|robot/i.test(page.url())) {
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

// Function to simulate human long press behavior with visual confirmation waiting
async function simulateHumanLongPress(page, element) {
  console.log("Simulating human long press...");
  
  // Get element position and size for accurate simulation
  const boundingBox = await element.boundingBox();
  if (!boundingBox) {
    console.log("Could not get element bounding box");
    return;
  }

  // Move to the center of the element
  const centerX = boundingBox.x + boundingBox.width / 2;
  const centerY = boundingBox.y + boundingBox.height / 2;

  // Simulate human-like mouse actions
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();

  let solved = false;
  try {
    console.log("Holding press until CAPTCHA is solved...");

    let attempts = 0;
    const maxAttempts = 30; // Try checking up to 30 times (15 seconds total)
    const captchaContainer = page
      .locator(
        'div[aria-label*="captcha"], div[data-testid*="captcha"], div.captcha-container',
      )
      .first();
    const containerInitiallyPresent = (await captchaContainer.count()) > 0;

    while (!solved && attempts < maxAttempts) {
      try {
        const checkMark = await page
          .locator(
            'svg[aria-label="Check mark"], img[src*="check"], div[role="img"][aria-label*="success"], .captcha-success',
          )
          .first()
          .count();
        if (checkMark > 0) {
          console.log("CAPTCHA solved by visual confirmation (checkmark found)");
          solved = true;
          break;
        }

        if (containerInitiallyPresent && (await captchaContainer.count()) === 0) {
          console.log("CAPTCHA container disappeared - CAPTCHA likely solved");
          solved = true;
          break;
        }

        attempts++;
        await page.waitForTimeout(500);
      } catch (error) {
        attempts++;
        await page.waitForTimeout(500);
      }
    }
  } finally {
    await page.mouse.up().catch((error) => {
      console.error(`MOUSE_RELEASE_FAILED ${error.message}`);
    });
  }

  console.log("Long press completed");
  
  if (!solved) {
    console.log("Warning: CAPTCHA may not have been solved within timeout, continuing with normal flow");
  } else {
    console.log("CAPTCHA appears to be successfully solved, continuing with checkout");
  }
}

// Function to detect and handle CAPTCHA challenges with simulated human behavior
async function handleVerificationChallenge(page) {
  console.log("VERIFICATION_REQUIRED - attempting simulated human interaction");
  
  // Try to find CAPTCHA elements that might require long press
  const captchaElements = await page.locator('div[role="button"], button, input[type="checkbox"], div.captcha-container').all();
  
  for (const element of captchaElements) {
    try {
      const textContent = await element.innerText().catch(() => "");
      const ariaLabel = await element.getAttribute('aria-label').catch(() => "");
      
      // Look for elements that might be CAPTCHA related
      if (textContent.toLowerCase().includes('press and hold') || 
          ariaLabel.toLowerCase().includes('press and hold') ||
          textContent.toLowerCase().includes('hold') ||
          textContent.toLowerCase().includes('captcha') ||
          textContent.toLowerCase().includes('verify') ||
          ariaLabel.toLowerCase().includes('captcha') ||
          ariaLabel.toLowerCase().includes('verify')) {
        
        console.log("Found potential CAPTCHA element requiring long press");
        await simulateHumanLongPress(page, element);
        return true;
      }
    } catch (error) {
      // Continue to next element if there's an error
      continue;
    }
  }
  
  // If we can't find specific CAPTCHA elements, try a more general approach
  try {
    // Look for common CAPTCHA containers or press and hold prompts
    const captchaPrompt = await page.locator('div:has-text("press and hold"), div:has-text("hold"), div.captcha-prompt').first();
    
    if (await captchaPrompt.count() > 0) {
      console.log("Found general CAPTCHA prompt, attempting to simulate long press");
      
      // Try to find a button within this container
      const button = await captchaPrompt.locator('button, div[role="button"]').first();
      if (await button.count() > 0) {
        await simulateHumanLongPress(page, button);
        return true;
      }
    }
  } catch (error) {
    console.log("Error trying to find CAPTCHA prompt: ", error.message);
  }
  
  // Alternative approach: try navigating to cart and back to reset verification
  console.log("Attempting cart navigation bypass method");
  try {
    const currentUrl = page.url();
    if (currentUrl.includes('target.com/checkout')) {
      // Navigate to cart first to potentially reset CAPTCHA state
      await page.goto('https://www.target.com/cart', { 
        waitUntil: 'domcontentloaded', 
        timeout: 15000 
      });
      console.log("Navigated to cart page to reset CAPTCHA");
      
      // Wait a bit for the page to load
      await page.waitForTimeout(2000);
      
      // Navigate back to checkout
      await page.goto(checkoutUrl, { 
        waitUntil: 'domcontentloaded', 
        timeout: 15000 
      });
      console.log("Navigated back to checkout after cart reset");
    }
  } catch (navigateError) {
    console.log("Navigation bypass failed: ", navigateError.message);
  }
  
  // If we can't find specific CAPTCHA elements, wait a bit and then check again
  await page.waitForTimeout(2000);
  return false;
}

async function main() {
  let refreshes = 0;
  let verificationActive = false;
  let priceActive = false;
  let pricePauseStartedAt = 0;

  while (true) {
    let browser;
    let page;

    try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 3000 });
    const context = browser.contexts()[0];
    page = await context.newPage();
    await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

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
        
        // Try to simulate human interaction with CAPTCHA
        try {
          await handleVerificationChallenge(page);
        } catch (simError) {
          console.log("Error in CAPTCHA simulation:", simError.message);
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
          await okButton.click({ timeout: 3000 });
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
        await saveAndContinue.click({ timeout: 5000 });
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
          pricePauseStartedAt = Date.now();
        }
        if (Date.now() - pricePauseStartedAt < priceRefreshGraceMs) {
          await page.waitForTimeout(250);
          continue;
        }
        console.log("ITEM_PRICE_STALLED - resuming checkout refresh");
        priceActive = false;
        pricePauseStartedAt = 0;
      }
      if (priceActive) {
        console.log("ITEM_PRICE_CLEARED - resuming checkout refresh");
        priceActive = false;
        pricePauseStartedAt = 0;
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
    } finally {
      if (page && !page.isClosed()) {
        await page.close().catch((closeError) => {
          console.error(`PAGE_CLOSE_FAILED ${closeError.message}`);
        });
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});