const { chromium } = require("playwright-core");
const {
  isPurchaseAction,
  isTemporaryRestriction,
  normalizeProducts,
  pokemonCenterTabPolicy,
  productIdFromUrl,
  selectProducts,
  validatePokemonCenterCart,
} = require("./pokemoncenter-products");

const endpoint = "http://127.0.0.1:9444";
const cartUrl = "https://www.pokemoncenter.com/cart";
const products = selectProducts(
  normalizeProducts(),
  process.env.POKEMONCENTER_PRODUCT_FILTER || "",
);
const verificationPattern =
  /captcha|verify (?:that )?you(?:'re| are) human|security check|press and hold|not a robot|robot check|access denied/i;
const confirmationPattern =
  /thank you|order confirmation|order number|order placed|successfully placed/i;
const retryDelayMs = Math.max(
  5000,
  Number.parseInt(process.env.POKEMONCENTER_RETRY_DELAY_MS || "10000", 10) ||
    10000,
);
const restrictionPauseMs = Math.max(
  300000,
  Number.parseInt(
    process.env.POKEMONCENTER_RESTRICTION_PAUSE_MS ||
      String(5 * 60 * 60 * 1000),
    10,
  ) || 5 * 60 * 60 * 1000,
);
const staggerMs = Math.max(
  1500,
  Number.parseInt(process.env.POKEMONCENTER_PRODUCT_STAGGER_MS || "3000", 10) ||
    3000,
);

function createAbortError() {
  const error = new Error("POKEMONCENTER_BATCH_ABORTED");
  error.code = "POKEMONCENTER_BATCH_ABORTED";
  return error;
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw createAbortError();
  }
}

function waitWithAbort(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }

    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };

    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function log(product, message) {
  console.log(`[${product.label}] ${message}`);
}

async function readBody(page) {
  return page.locator("body").innerText().catch(() => "");
}

async function isReady(locator) {
  return (
    (await locator.count()) > 0 &&
    (await locator.isVisible().catch(() => false)) &&
    (await locator.isEnabled().catch(() => false))
  );
}

async function hasVerification(page) {
  if (/captcha|challenge|blocked|verify|robot/i.test(page.url())) {
    return true;
  }
  return verificationPattern.test(await readBody(page));
}

async function hasTemporaryRestriction(page) {
  return isTemporaryRestriction(await readBody(page));
}

// hCaptcha checkbox selectors (found by inspecting the live challenge DOM).
// The clickable element is #checkbox[role=checkbox] in the #frame=checkbox
// cross-origin frame.

// Locate the visible hCaptcha checkbox iframe on-screen coordinates. hCaptcha
// frames are nested inside Pokémon Center's Incapsula wrapper iframe (which is
// DOM-readable) even though the hCaptcha frames themselves are cross-origin.
async function locateCaptchaCheckbox(page) {
  const mainIframe = page
    .frames()
    .find((f) => /_Incapsula_Resource|main-iframe/.test(f.url() || ""));
  if (!mainIframe) {
    return null;
  }

  const result = await Promise.race([
    mainIframe
      .evaluate(() => {
        const frame = [...document.querySelectorAll("iframe")].find(
          (x) =>
            x.getBoundingClientRect().width > 0 &&
            x.getBoundingClientRect().y > -500 &&
          /hcaptcha|captcha/.test(x.src || ""),
        );
        if (!frame) {
          return null;
        }
        const r = frame.getBoundingClientRect();
        return {
          x: Math.round(r.x + 15),
          y: Math.round(r.y + 15),
          // hCaptcha checkbox iframe is roughly 302x76
          w: r.width,
          h: r.height,
        };
      })
      .catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
  ]);

  return result && result.w > 0 ? { x: result.x, y: result.y } : null;
}

// Dispatch a genuine mouse click at screen coordinates through CDP input. This
// routes a real browser input event instead of Playwright's frame-locator click,
// which hCaptcha's cross-origin frames block.
async function clickAtCoordinates(session, x, y) {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

// True when an hCaptcha challenge frame is actively presenting a tile task that
// requires vision to answer.
async function hasTileChallenge(page) {
  const challenge = page
    .frames()
    .find((f) => /#frame=challenge/.test(f.url() || ""));
  if (!challenge) {
    return false;
  }
  const height = await Promise.race([
    challenge
      .evaluate(() => {
        const c = document.querySelector(".challenge-container");
        return c ? Math.round(c.getBoundingClientRect().height) : 0;
      })
      .catch(() => 0),
    new Promise((resolve) => setTimeout(() => resolve(0), 1500)),
  ]);
  return height > 100;
}

async function solveVerification(page, product, verificationState) {
  if (!verificationState.active) {
    log(product, "PC_VERIFICATION_REQUIRED - attempting automatic solve");
    verificationState.active = true;
  }

  const frameNotes = [];
  const frames = page.frames();
  for (const frame of frames) {
    const frameUrl = frame.url() || "";
    if (/#frame=checkbox/.test(frameUrl)) {
      frameNotes.push("hcaptcha-checkbox");
    } else if (/#frame=challenge/.test(frameUrl)) {
      frameNotes.push("hcaptcha-challenge");
    } else if (/hcaptcha|captcha-delivery|distil|imperva/i.test(frameUrl)) {
      frameNotes.push("captcha-wrapper");
    }
  }
  if (frameNotes.length) {
    log(product, `PC_CAPTCHA_DETECTED frames: ${[...new Set(frameNotes)].join(", ")}`);
  }

  // A tile challenge requires vision and cannot be auto-solved here; report it.
  if (await hasTileChallenge(page)) {
    log(
      product,
      "PC_CAPTCHA_TILE_CHALLENGE - cannot auto-solve image tiles; requires manual or vision-based solve",
    );
    return;
  }

  // Otherwise click the hCaptcha checkbox with a genuine CDP input event.
  const checkbox = await locateCaptchaCheckbox(page);
  if (!checkbox) {
    log(product, "PC_CAPTCHA_CHECKBOX_NOT_FOUND");
    return;
  }

  const session = await page.context().newCDPSession(page).catch(() => null);
  if (session) {
    try {
      await clickAtCoordinates(session, checkbox.x, checkbox.y);
      log(product, `PC_CAPTCHA_CHECKBOX_CLICKED at ${checkbox.x},${checkbox.y}`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log(product, `PC_CAPTCHA_CLICK_ERROR: ${message}`);
    } finally {
      session.detach().catch(() => {});
    }
  } else {
    log(product, "PC_CAPTCHA_NO_CDP_SESSION");
  }
}

async function waitForVerificationClear(
  page,
  product,
  verificationState,
  signal,
) {
  while (true) {
    throwIfAborted(signal);
    if (await hasTemporaryRestriction(page)) {
      if (!verificationState.restrictionActive) {
        log(
          product,
          `PC_ACCESS_RESTRICTED - pausing ${Math.round(restrictionPauseMs / 60000)} minutes without refresh`,
        );
        verificationState.restrictionActive = true;
      }
      await waitWithAbort(restrictionPauseMs, signal);
      continue;
    }

    if (!(await hasVerification(page))) {
      break;
    }

    if (!verificationState.active) {
      log(product, "PC_VERIFICATION_REQUIRED - waiting for manual completion");
      verificationState.active = true;
    }
    await waitWithAbort(1000, signal);
  }

  if (verificationState.active) {
    log(product, "PC_VERIFICATION_CLEARED - resuming");
    verificationState.active = false;
  }
  if (verificationState.restrictionActive) {
    log(product, "PC_ACCESS_RESTRICTION_CLEARED - resuming");
    verificationState.restrictionActive = false;
  }
}

function isAddSuccess(url, bodyText) {
  return (
    /\/cart(?:[/?#]|$)/i.test(url) ||
    /added to cart|item added|view cart/i.test(bodyText)
  );
}

function parseOrderTotal(bodyText) {
  const match = String(bodyText || "")
    .replace(/\s+/g, " ")
    .match(/\b(?:order total|total)\b\s*:?\s*\$([\d,]+(?:\.\d{2})?)/i);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

async function getPurchaseButton(page) {
  const productRoot = page.locator("#product").first();
  const scope = (await productRoot.count()) > 0 ? productRoot : page;
  const button = scope
    .getByRole("button", {
      name: /^(?:add to cart|pre[\s-]?order(?: now)?)$/i,
    })
    .first();
  return (await isReady(button)) ? button : null;
}

async function getCheckoutControl(page) {
  const button = page
    .getByRole("button", { name: /(?:proceed to )?checkout|check out/i })
    .first();
  if (await isReady(button)) {
    return button;
  }

  const link = page
    .getByRole("link", { name: /(?:proceed to )?checkout|check out/i })
    .first();
  return (await isReady(link)) ? link : null;
}

async function getPlaceOrderButton(page) {
  const button = page
    .getByRole("button", {
      name: /place (?:your )?order|submit order|complete order|pay now/i,
    })
    .first();
  return (await isReady(button)) ? button : null;
}

async function validateCart(page, product) {
  const hrefs = await page
    .locator("main a[href], [role=\"main\"] a[href], a[href*=\"/product/\"]")
    .evaluateAll((links) => links.map((link) => link.href))
    .catch(() => []);
  return validatePokemonCenterCart({
    bodyText: await readBody(page),
    hrefs,
    product,
  });
}

async function acquireProductPage(context, product, activePages) {
  const matchingPages = context
    .pages()
    .filter((page) => productIdFromUrl(page.url()) === product.sku);
  const page = matchingPages.shift() || (await context.newPage());

  await Promise.all(
    matchingPages.map(async (duplicate) => {
      await duplicate.close().catch(() => {});
    }),
  );
  activePages.add(page);
  return page;
}

async function closeProductTabs(context) {
  const skus = new Set(products.map((product) => product.sku));
  await Promise.all(
    context.pages().map(async (page) => {
      if (!skus.has(productIdFromUrl(page.url()))) {
        return;
      }
      await page.close().catch(() => {});
    }),
  );
}

async function closeDuplicateProductTabs(context) {
  const pagesBySku = new Map();
  for (const page of context.pages()) {
    const sku = productIdFromUrl(page.url());
    if (!sku || !products.some((product) => product.sku === sku)) {
      continue;
    }
    const pages = pagesBySku.get(sku) || [];
    pages.push(page);
    pagesBySku.set(sku, pages);
  }

  await Promise.all(
    [...pagesBySku.values()].flatMap((pages) =>
      pages.slice(1).map(async (duplicate) => {
        await duplicate.close().catch(() => {});
      }),
    ),
  );
}

async function waitForConfirmation(page, product, signal) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    throwIfAborted(signal);
    const bodyText = await readBody(page);
    if (confirmationPattern.test(`${page.url()}\n${bodyText}`)) {
      log(product, "PC_ORDER_CONFIRMED");
      return true;
    }
    await waitWithAbort(1000, signal);
  }

  return false;
}

async function completeOrder(page, product, state, signal) {
  await page.goto(cartUrl, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });

  for (;;) {
    throwIfAborted(signal);
    await page
      .waitForLoadState("domcontentloaded", { timeout: 15000 })
      .catch(() => {});
    await waitForVerificationClear(
      page,
      product,
      state.verificationState,
      signal,
    );

    const bodyText = await readBody(page);
    if (confirmationPattern.test(`${page.url()}\n${bodyText}`)) {
      log(product, "PC_ORDER_CONFIRMED");
      return true;
    }

    if (!(await validateCart(page, product))) {
      log(product, "PC_CART_PRODUCT_MISMATCH - refusing checkout");
      return false;
    }

    const placeOrder = await getPlaceOrderButton(page);
    if (placeOrder) {
      const orderTotal = parseOrderTotal(bodyText);
      if (orderTotal === null) {
        log(product, "PC_ORDER_BLOCKED - visible order total not detected");
        await waitWithAbort(1000, signal);
        continue;
      }

      log(product, `PC_PLACE_ORDER_FOUND - visible total $${orderTotal.toFixed(2)}`);
      await placeOrder.click({ timeout: 5000 });
      log(product, "PC_PLACE_ORDER_CLICKED");
      if (await waitForConfirmation(page, product, signal)) {
        return true;
      }

      log(product, "PC_ORDER_UNCONFIRMED - stopping to avoid duplicate submission");
      state.shuttingDown = true;
      state.abortController?.abort();
      return false;
    }

    const checkout = await getCheckoutControl(page);
    if (checkout) {
      await checkout.click({ timeout: 5000 }).catch(() => {});
      log(product, "PC_CHECKOUT_CLICKED");
      await waitWithAbort(1000, signal);
      continue;
    }

    if (/\/(?:login|sign-in|signin)\b/i.test(page.url())) {
      log(product, "PC_LOGIN_REQUIRED - waiting for manual sign-in");
      await waitWithAbort(1000, signal);
      continue;
    }

    await waitWithAbort(retryDelayMs, signal);
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  }
}

async function monitorProduct(
  context,
  product,
  index,
  activePages,
  state,
  signal,
) {
  await waitWithAbort(index * staggerMs, signal);
  const page = await acquireProductPage(context, product, activePages);
  const verificationState = { active: false };
  let attempts = 0;

  try {
    await page.goto(product.url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    while (!state.shuttingDown && !page.isClosed()) {
      throwIfAborted(signal);
      await waitForVerificationClear(page, product, verificationState, signal);

      if (state.actionSku && state.actionSku !== product.sku) {
        await waitWithAbort(500, signal);
        continue;
      }

      const purchaseButton = await getPurchaseButton(page);
      if (purchaseButton) {
        state.actionSku = product.sku;
        try {
          log(product, "PC_PURCHASE_ACTION_FOUND");
          await purchaseButton.click({ timeout: 5000 });
          await waitWithAbort(1000, signal);
          await waitForVerificationClear(
            page,
            product,
            verificationState,
            signal,
          );

          const bodyText = await readBody(page);
          if (!isAddSuccess(page.url(), bodyText)) {
            log(product, "PC_ADD_NOT_CONFIRMED - returning to product page");
            await page.goto(product.url, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            });
            continue;
          }

          if (await completeOrder(page, product, state, signal)) {
            state.completedSkus.add(product.sku);
            state.shuttingDown = true;
            state.abortController?.abort();
            return;
          }
        } finally {
          if (state.actionSku === product.sku) {
            state.actionSku = null;
          }
        }
      }

      attempts += 1;
      if (attempts === 1 || attempts % 10 === 0) {
        log(product, `PC_PRODUCT_REFRESH ${attempts}`);
      }
      await waitWithAbort(retryDelayMs, signal);
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    }
  } finally {
    activePages.delete(page);
    await page.close().catch(() => {});
  }
}

async function monitorBatch(context, state) {
  const controller = new AbortController();
  state.abortController = controller;
  const activePages = new Set();
  const pending = products.filter(
    (product) => !state.completedSkus.has(product.sku),
  );
  const tasks = pending.map((product, index) =>
    (async () => {
      try {
        await monitorProduct(
          context,
          product,
          index,
          activePages,
          state,
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        throw error;
      }
    })(),
  );

  try {
    await closeDuplicateProductTabs(context);
    await Promise.all(tasks);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(tasks);
    throw error;
  } finally {
    controller.abort();
    await Promise.all(
      [...activePages].map(async (page) => {
        await page.close().catch(() => {});
      }),
    );
    activePages.clear();
    await closeProductTabs(context);
  }
}

async function main() {
  if (pokemonCenterTabPolicy !== "one-per-product") {
    throw new Error("Pokémon Center monitor must use one reusable tab per product.");
  }

  const state = {
    actionSku: null,
    abortController: null,
    completedSkus: new Set(),
    shuttingDown: false,
  };

  while (!state.shuttingDown && state.completedSkus.size < products.length) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("No authenticated Chrome context is available.");
      }
      await monitorBatch(context, state);
    } catch (error) {
      if (!state.shuttingDown && error.code !== "POKEMONCENTER_BATCH_ABORTED") {
        console.error(`PC_RECONNECT ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
