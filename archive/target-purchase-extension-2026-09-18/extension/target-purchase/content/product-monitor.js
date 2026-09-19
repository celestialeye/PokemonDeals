(function initializeTargetProductMonitor(root) {
  const core =
    root.TargetPurchaseCore ||
    (typeof require === "function" ? require("../lib/core") : null);
  const shared =
    root.TargetPurchaseShared ||
    (typeof require === "function" ? require("./shared") : null);

  async function executeProductDecision(decision, actions) {
    switch (decision.type) {
      case "click-product": {
        const token = await actions.claim();
        if (
          !token ||
          !(await actions.authorize(token)) ||
          (actions.finalValidate && !actions.finalValidate(decision.label))
        ) {
          return;
        }
        await (actions.getAction?.() || actions.action)?.click();
        return;
      }
      case "refresh":
        await actions.report("monitoring", "Unavailable; refreshing.");
        actions.refresh();
        return;
      case "verification":
        await actions.report(
          "verification",
          "Verification requires manual completion.",
        );
        return;
      case "pause-buy-now":
        await actions.report(
          "buy-now",
          "Buy Now is not used in shared-cart mode.",
        );
        return;
      case "wait-action-ready":
        await actions.report(
          "monitoring",
          `${decision.label} is visible; waiting for it to become enabled.`,
        );
        return;
      case "cooldown":
        await actions.dismissFailure?.();
        await actions.report(
          "cooldown",
          "Add failed; waiting before the next refresh.",
          decision.until,
        );
        return;
      case "dismiss-failure-refresh":
        await actions.dismissFailure?.();
        await actions.report("monitoring", "Retrying after add failure.");
        actions.refresh();
        return;
      case "added":
        await actions.report("added", "Added to cart.");
        return;
      default:
        return;
    }
  }

  function isProductStateForUrl(tabState, url) {
    return Boolean(
      tabState?.productId &&
        core.getProductId(url) === tabState.productId &&
        core.isSameProductUrl(tabState.url, url),
    );
  }

  const api = {
    executeProductDecision,
    isProductStateForUrl,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (
    !root.chrome?.runtime?.id ||
    !root.document ||
    root.__targetPurchaseProductMonitor
  ) {
    return;
  }
  root.__targetPurchaseProductMonitor = true;

  let handling = false;
  let mutationTimer = null;

  async function report(phase, detail, cooldownUntil = 0) {
    await chrome.runtime.sendMessage({
      type: "REPORT_STATE",
      phase,
      detail,
      cooldownUntil,
      url: location.href,
    });
  }

  async function evaluate({ allowRefresh }) {
    if (handling) {
      return;
    }
    handling = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
      const tabState = response?.tab;
      if (
        !response?.ok ||
        tabState?.role !== "product" ||
        tabState.phase === "stopped"
      ) {
        return;
      }
      if (!isProductStateForUrl(tabState, location.href)) {
        await chrome.runtime.sendMessage({ type: "STOP_TAB" });
        return;
      }

      const productLabel = shared.getMainProductLabel(document);
      if (productLabel && productLabel !== tabState.productLabel) {
        await chrome.runtime.sendMessage({
          type: "REPORT_PRODUCT_IDENTITY",
          productLabel,
          url: location.href,
        });
      }

      const snapshot = shared.snapshotProductPage(document, location.href);
      const decision = core.classifyProductPage(snapshot, tabState, Date.now());
      if (!allowRefresh && decision.type === "refresh") {
        return;
      }

      await executeProductDecision(decision, {
        action: shared.findMainProductAction(document),
        getAction: () => shared.findMainProductAction(document),
        claim: async () => {
          const token =
            root.crypto?.randomUUID?.() ||
            `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const claim = await chrome.runtime.sendMessage({
            type: "CLAIM_PRODUCT_ACTION",
            token,
            url: location.href,
          });
          return claim?.claimed === true ? token : null;
        },
        authorize: async (token) => {
          const authorization = await chrome.runtime.sendMessage({
            type: "AUTHORIZE_PRODUCT_ACTION",
            token,
            url: location.href,
          });
          return authorization?.authorized === true;
        },
        finalValidate: (expectedLabel) => {
          if (!isProductStateForUrl(tabState, location.href)) {
            return false;
          }
          const freshSnapshot = shared.snapshotProductPage(
            document,
            location.href,
          );
          return (
            !freshSnapshot.verificationVisible &&
            freshSnapshot.actionReady &&
            freshSnapshot.actionLabel === expectedLabel
          );
        },
        dismissFailure: async () => {
          await shared.findProductFailureClose(document)?.click();
        },
        refresh: () => location.reload(),
        report,
      });
    } finally {
      handling = false;
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "TARGET_PURCHASE_TICK") {
      evaluate({ allowRefresh: true });
    }
  });

  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      evaluate({ allowRefresh: false });
    }, 100);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
  });
})(globalThis);
