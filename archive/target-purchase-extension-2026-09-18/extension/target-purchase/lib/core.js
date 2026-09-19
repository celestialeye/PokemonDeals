(function initializeTargetPurchaseCore(root) {
  const defaultIntervalMs = 5000;
  const minimumIntervalMs = 3000;
  const maximumIntervalMs = 300000;
  const productFailureCooldownMs = 10000;
  const schedulerToken = "pd-6f42d9a7a5c14f748906b7682e70a31d";

  function normalizeInterval(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return defaultIntervalMs;
    }
    return Math.min(
      maximumIntervalMs,
      Math.max(minimumIntervalMs, Math.round(parsed)),
    );
  }

  function getProductId(url) {
    return String(url || "").match(/\/(A-\d{8,10})(?:[/?#]|$)/i)?.[1] || null;
  }

  function normalizeProductUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (
        url.protocol !== "https:" ||
        url.hostname.toLowerCase() !== "www.target.com" ||
        !getProductId(url.href)
      ) {
        return null;
      }
      return `${url.origin}${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }

  function isSameProductUrl(left, right) {
    const normalizedLeft = normalizeProductUrl(left);
    return Boolean(
      normalizedLeft &&
        normalizedLeft === normalizeProductUrl(right) &&
        getProductId(left) === getProductId(right),
    );
  }

  function classifyProductPage(snapshot, state, now = Date.now()) {
    if (snapshot.verificationVisible) {
      return { type: "verification" };
    }
    if (
      state.phase === "cooldown" &&
      Number(state.cooldownUntil || 0) > now
    ) {
      return { type: "wait" };
    }
    if (state.phase === "cooldown" && snapshot.failureVisible) {
      return { type: "dismiss-failure-refresh" };
    }
    if (snapshot.failureVisible) {
      return { type: "cooldown", until: now + productFailureCooldownMs };
    }
    if (snapshot.successVisible) {
      return { type: "added" };
    }
    if (state.phase === "added" || state.phase === "stopped") {
      return { type: "wait" };
    }
    if (state.phase === "action-pending") {
      return { type: "wait" };
    }
    if (/^buy now$/i.test(snapshot.actionLabel || "")) {
      return { type: "pause-buy-now" };
    }
    if (
      !snapshot.actionReady &&
      /^(?:add to cart|pre[\s-]?order(?: now)?)$/i.test(
        snapshot.actionLabel || "",
      )
    ) {
      return {
        type: "refresh",
        label: snapshot.actionLabel,
      };
    }
    if (
      snapshot.actionReady &&
      /^(?:add to cart|pre[\s-]?order(?: now)?)$/i.test(
        snapshot.actionLabel || "",
      )
    ) {
      return {
        type: "click-product",
        label: snapshot.actionLabel,
      };
    }
    return { type: "refresh" };
  }

  function validateCheckoutProducts(visibleIds, armedIds) {
    const uniqueIds = Array.from(new Set(visibleIds || []));
    return validateCheckoutCart(
      uniqueIds.map((productId) => ({
        productId,
        quantity: 1,
      })),
      armedIds,
      uniqueIds.length,
    );
  }

  function validateCheckoutCart(
    rows,
    armedIds,
    visibleItemCount,
    armedProductLabels = [],
  ) {
    const cartRows = Array.isArray(rows) ? rows : [];
    const allowed = new Set(armedIds || []);
    const allowedLabels = new Set(
      (armedProductLabels || []).map((label) =>
        String(label || "").trim().toLowerCase(),
      ),
    );
    const seen = new Set();
    if (
      cartRows.length === 0 ||
      !Number.isInteger(visibleItemCount) ||
      visibleItemCount <= 0 ||
      cartRows.length !== visibleItemCount
    ) {
      return false;
    }
    for (const row of cartRows) {
      const normalizedLabel = String(row?.productLabel || "")
        .trim()
        .toLowerCase();
      const identity = row?.productId
        ? `id:${row.productId}`
        : normalizedLabel
          ? `label:${normalizedLabel}`
          : null;
      if (
        !identity ||
        !(
          (typeof row?.productId === "string" &&
            allowed.has(row.productId)) ||
          (normalizedLabel && allowedLabels.has(normalizedLabel))
        ) ||
        Number(row.quantity) !== 1 ||
        seen.has(identity)
      ) {
        return false;
      }
      seen.add(identity);
    }
    return true;
  }

  function classifyCheckoutPage(snapshot, state) {
    if (snapshot.verificationVisible) {
      return { type: "verification" };
    }
    if (snapshot.confirmationVisible) {
      return { type: "confirmed" };
    }
    const visibleTransitionAction = snapshot.highDemandReady
      ? "dismiss-high-demand"
      : snapshot.saveContinueReady
        ? "save-continue"
        : snapshot.pinReady
          ? "confirm-pin"
          : null;
    if (
      state.phase === "transitioning" &&
      state.pendingAction === visibleTransitionAction
    ) {
      return { type: "wait" };
    }
    if (snapshot.highDemandReady) {
      return { type: "dismiss-high-demand" };
    }
    if (snapshot.saveContinueReady) {
      return { type: "save-continue" };
    }

    const cartAllowed = validateCheckoutCart(
      snapshot.cartRows,
      state.armedProductIds,
      snapshot.cartItemCount,
      state.armedProductLabels,
    );
    const cartIsEmpty =
      snapshot.cartRows.length === 0 && snapshot.cartItemCount === 0;
    if (
      snapshot.pinReady &&
      !cartAllowed &&
      Number(state.orderSubmittedAt || 0) === 0
    ) {
      return { type: "blocked-cart" };
    }
    if (snapshot.pinReady) {
      return { type: "confirm-pin" };
    }
    const canPlaceAfterPin =
      state.phase === "placing" &&
      Number(state.orderSubmittedAt || 0) > 0 &&
      Number(state.pinConfirmedAt || 0) >
        Number(state.orderSubmittedAt || 0) &&
      Number(state.finalPlaceOrderAt || 0) === 0;
    if (state.phase === "placing" && !canPlaceAfterPin) {
      return { type: "wait" };
    }
    if (cartIsEmpty) {
      return { type: "refresh" };
    }
    if (
      (snapshot.placeOrderReady || snapshot.onCartPage) &&
      !cartAllowed
    ) {
      if (cartIsEmpty) {
        return { type: "refresh" };
      }
      return { type: "blocked-cart" };
    }
    if (snapshot.onCartPage && cartAllowed) {
      return { type: "go-checkout" };
    }
    if (snapshot.placeOrderReady && cartAllowed) {
      return { type: "place-order" };
    }
    if (snapshot.transientBusy) {
      return { type: "refresh" };
    }
    return { type: "wait" };
  }

  const api = {
    classifyCheckoutPage,
    classifyProductPage,
    defaultIntervalMs,
    getProductId,
    isSameProductUrl,
    maximumIntervalMs,
    minimumIntervalMs,
    normalizeInterval,
    productFailureCooldownMs,
    schedulerToken,
    validateCheckoutCart,
    validateCheckoutProducts,
  };

  root.TargetPurchaseCore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
