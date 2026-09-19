(function initializeTargetPurchaseShared(root) {
  const verificationPattern =
    /verify (?:that )?you(?:'re| are) human|security check|press and hold|captcha|not a robot|access denied/i;
  const productFailurePattern =
    /item not added to cart|couldn't add|could not add|out of stock|currently unavailable/i;
  const productSuccessPattern =
    /added to cart|item added|view cart\s*(?:&|and)\s*check out/i;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeProductLabel(value) {
    return normalizeText(value)
      .replace(/&#(\d+);/g, (_, code) =>
        String.fromCodePoint(Number.parseInt(code, 10)),
      )
      .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
        String.fromCodePoint(Number.parseInt(code, 16)),
      )
      .replace(/&apos;|&\#39;/gi, "'")
      .replace(/&trade;/gi, "™")
      .replace(/&amp;/gi, "&")
      .replace(/\s+quantity\s+\d+\s*$/i, "")
      .replace(/\s+:\s+target\s*$/i, "")
      .toLowerCase();
  }

  function getMainProductLabel(documentRef) {
    const heading = documentRef.querySelector("main h1");
    return normalizeProductLabel(heading?.innerText || heading?.textContent);
  }

  function isElementVisible(element) {
    if (!element || element.hidden) {
      return false;
    }
    if (element.getAttribute?.("aria-hidden") === "true") {
      return false;
    }
    let current = element;
    while (current && current.nodeType === 1) {
      if (
        current.hidden ||
        current.inert ||
        current.getAttribute?.("aria-hidden") === "true"
      ) {
        return false;
      }
      const style =
        current.ownerDocument?.defaultView?.getComputedStyle?.(current);
      if (
        style &&
        (style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse")
      ) {
        return false;
      }
      current = current.parentElement;
    }

    const userAgent =
      element.ownerDocument?.defaultView?.navigator?.userAgent || "";
    if (
      !/jsdom/i.test(userAgent) &&
      typeof element.getClientRects === "function" &&
      element.getClientRects().length === 0
    ) {
      return false;
    }
    return true;
  }

  function isElementReady(element) {
    return Boolean(
      element &&
        isElementVisible(element) &&
        !element.disabled &&
        element.getAttribute?.("aria-disabled") !== "true",
    );
  }

  function findMainProductAction(documentRef) {
    const controls = documentRef.querySelectorAll(
      '[data-test="module-product-detail-add-to-cart"] button',
    );
    return (
      Array.from(controls).find(
        (control) =>
          isElementVisible(control) &&
          /^(?:add to cart|pre[\s-]?order(?: now)?|buy now)$/i.test(
            normalizeText(control.innerText || control.textContent),
          ),
      ) || null
    );
  }

  function findProductFailureClose(documentRef) {
    const dialogs = Array.from(documentRef.querySelectorAll('[role="dialog"]'));
    const failureDialog = dialogs.find(
      (dialog) =>
        isElementVisible(dialog) &&
        productFailurePattern.test(
          normalizeText(dialog.innerText || dialog.textContent),
        ),
    );
    if (!failureDialog) {
      return null;
    }
    return (
      Array.from(failureDialog.querySelectorAll("button")).find((button) =>
        /^close$/i.test(normalizeText(button.innerText || button.textContent)),
      ) || null
    );
  }

  function hasVerification(documentRef, url = "") {
    const title = documentRef.title || "";
    const bodyText = documentRef.body?.innerText || documentRef.body?.textContent || "";
    return (
      /captcha|challenge|blocked|verify/i.test(url) ||
      verificationPattern.test(`${title}\n${bodyText}`)
    );
  }

  function snapshotProductPage(documentRef, url = "") {
    const action = findMainProductAction(documentRef);
    const actionLabel = normalizeText(action?.innerText || action?.textContent);
    const statusElements = Array.from(
      documentRef.querySelectorAll(
        '[data-test="module-product-detail-add-to-cart"], [role="dialog"], [data-test*="toast" i], [data-test*="cart" i][role="status"], [data-test*="cart" i][role="alert"]',
      ),
    ).filter(
      (element) =>
        isElementVisible(element) &&
        !element.closest(
          '[data-test*="recommend" i], [aria-label*="recommend" i], [data-test*="sponsored" i]',
        ),
    );
    const statusText = statusElements
      .map((element) =>
        normalizeText(element.innerText || element.textContent),
      )
      .join("\n");
    const failureVisible = productFailurePattern.test(statusText);
    const successVisible =
      !failureVisible &&
      (/\/cart(?:[/?#]|$)/i.test(url) ||
        productSuccessPattern.test(statusText));

    return {
      verificationVisible: hasVerification(documentRef, url),
      successVisible,
      failureVisible,
      actionLabel,
      actionReady: isElementReady(action),
    };
  }

  function parseQuantity(row) {
    const quantityControl = row.querySelector(
      '[data-test*="quantity" i] select, select[aria-label*="quantity" i], [data-test*="quantity" i] input, input[aria-label*="quantity" i]',
    );
    const rawValue =
      quantityControl?.value ||
      quantityControl?.getAttribute?.("value") ||
      row.getAttribute?.("data-quantity");
    const parsed = Number.parseInt(rawValue || "", 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
    const textMatch = sharedQuantityText(row).match(
      /\b(?:qty|quantity)\s*:?\s*(\d+)\b/i,
    );
    return textMatch ? Number.parseInt(textMatch[1], 10) : null;
  }

  function sharedQuantityText(row) {
    return normalizeText(row.innerText || row.textContent);
  }

  function getVisibleCartRows(documentRef) {
    const scope = documentRef.querySelector("main") || documentRef.body;
    if (!scope || !isElementVisible(scope)) {
      return [];
    }
    const selectors = [
      '[data-test="cartItem"]',
      '[data-test="cart-item"]',
      '[data-test^="cart-item-"]',
      '[data-test="order-summary-item"]',
      '[data-test^="order-summary-item-"]',
    ];
    const rowElements = Array.from(
      scope.querySelectorAll(selectors.join(",")),
    ).filter(isElementVisible);
    const rows = rowElements
      .filter(isElementVisible)
      .map((row) => {
        const source = [
          row.getAttribute?.("data-item-id"),
          row.getAttribute?.("data-tcin"),
          ...Array.from(row.querySelectorAll('a[href*="/A-"]')).map((anchor) =>
            anchor.getAttribute("href"),
          ),
          sharedQuantityText(row),
        ].join("\n");
        return {
          productId: source.match(/A-\d{7,}/i)?.[0]?.toUpperCase() || null,
          quantity: parseQuantity(row),
        };
      });

    const capturedIds = new Set(rows.map((row) => row.productId).filter(Boolean));
    const fallbackRowSelector = [
      'article[class*="cart" i]',
      'li[class*="cart" i]',
      '[role="listitem"][aria-label*="item" i]',
      '[data-testid*="cart-item" i]',
    ].join(",");
    const fallbackRows = Array.from(
      scope.querySelectorAll(fallbackRowSelector),
    ).filter(
      (candidate) =>
        isElementVisible(candidate) &&
        !candidate.closest(selectors.join(",")) &&
        !rowElements.some((row) => candidate.contains(row)) &&
        !candidate.closest(
          '[data-test*="recommend" i], [aria-label*="recommend" i], [data-test*="sponsored" i], [data-test^="sfl-" i], [data-test*="saved" i], [aria-label*="saved" i]',
        ),
    );
    for (const row of fallbackRows) {
      const source = [
        row.getAttribute?.("data-item-id"),
        row.getAttribute?.("data-tcin"),
        ...Array.from(row.querySelectorAll('a[href*="/A-"]')).map((anchor) =>
          anchor.getAttribute("href"),
        ),
        sharedQuantityText(row),
      ].join("\n");
      const productId =
        source.match(/A-\d{7,}/i)?.[0]?.toUpperCase() || null;
      if (!productId || !capturedIds.has(productId)) {
        if (productId) {
          capturedIds.add(productId);
        }
        rows.push({
          productId,
          quantity: parseQuantity(row),
        });
      }
    }

    const orphanProductLinks = Array.from(
      scope.querySelectorAll('a[href*="/A-"]'),
    ).filter(
      (anchor) =>
        isElementVisible(anchor) &&
        !anchor.closest(selectors.join(",")) &&
        !anchor.closest(fallbackRowSelector) &&
        !anchor.closest(
          '[data-test*="recommend" i], [aria-label*="recommend" i], [data-test*="sponsored" i], [data-test^="sfl-" i], [data-test*="saved" i], [aria-label*="saved" i]',
        ),
    );
    for (const anchor of orphanProductLinks) {
      const productId = String(anchor.getAttribute("href") || "")
        .match(/A-\d{7,}/i)?.[0]
        ?.toUpperCase();
      if (productId && !capturedIds.has(productId)) {
        capturedIds.add(productId);
        rows.push({
          productId,
          quantity: null,
        });
      }
    }

    const itemImages = Array.from(
      scope.querySelectorAll('img[alt*="quantity" i]'),
    ).filter(
      (image) =>
        isElementVisible(image) &&
        !image.closest(selectors.join(",")) &&
        !image.closest(
          '[data-test*="recommend" i], [aria-label*="recommend" i], [data-test*="sponsored" i]',
        ),
    );
    for (const image of itemImages) {
      const alt = normalizeText(image.getAttribute("alt"));
      const quantityMatch = alt.match(/\bquantity\s+(\d+)\s*$/i);
      const productLabel = normalizeProductLabel(alt);
      if (quantityMatch && productLabel) {
        rows.push({
          productId: null,
          productLabel,
          quantity: Number.parseInt(quantityMatch[1], 10),
        });
      }
    }

    return rows;
  }

  function getVisibleCartItemCount(documentRef) {
    const scope = documentRef.querySelector("main") || documentRef.body;
    if (!scope || !isElementVisible(scope)) {
      return null;
    }
    const text = normalizeText(scope.innerText || scope.textContent);
    if (/\byour cart is empty\b/i.test(text)) {
      return 0;
    }
    const counts = [];
    for (const pattern of [
      /\bcart\b.{0,100}?\b(\d+)\s+items?\b/gi,
      /\bsubtotal\s*\(\s*(\d+)\s+items?\s*\)/gi,
    ]) {
      for (const match of text.matchAll(pattern)) {
        counts.push(Number.parseInt(match[1], 10));
      }
    }
    const distinctCounts = new Set(
      counts.filter((count) => Number.isInteger(count) && count >= 0),
    );
    return distinctCounts.size === 1 ? Array.from(distinctCounts)[0] : null;
  }

  const api = {
    findMainProductAction,
    findProductFailureClose,
    getMainProductLabel,
    getVisibleCartItemCount,
    getVisibleCartRows,
    hasVerification,
    isElementReady,
    isElementVisible,
    normalizeProductLabel,
    normalizeText,
    snapshotProductPage,
  };

  root.TargetPurchaseShared = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
