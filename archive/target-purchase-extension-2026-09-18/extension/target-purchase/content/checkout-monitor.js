(function initializeTargetCheckoutMonitor(root) {
  const core =
    root.TargetPurchaseCore ||
    (typeof require === "function" ? require("../lib/core") : null);
  const shared =
    root.TargetPurchaseShared ||
    (typeof require === "function" ? require("./shared") : null);
  const confirmationPattern =
    /thank you for your order|your order has been placed|we received your order|order number\s*#?/i;
  const highDemandPattern =
    /high-demand item in your cart|a popular item in your cart is causing a delay|checkout is busy right now|limiting how many guests can check out/i;
  const transientBusyPattern =
    /temporary issue|something went wrong|please try again|checkout is busy/i;

  function findReadyButton(documentRef, pattern, scope = documentRef) {
    return (
      Array.from(scope.querySelectorAll("button")).find(
        (button) =>
          pattern.test(
            shared.normalizeText(button.innerText || button.textContent),
          ) && shared.isElementReady(button),
      ) || null
    );
  }

  function getCheckoutControls(documentRef) {
    const dialogs = Array.from(documentRef.querySelectorAll('[role="dialog"]'));
    const highDemandDialog =
      dialogs.find((dialog) =>
        highDemandPattern.test(
          shared.normalizeText(dialog.innerText || dialog.textContent),
        ),
      ) || null;
    const pinDialog =
      dialogs.find((dialog) =>
        Array.from(
          dialog.querySelectorAll(
            'h1, h2, h3, [role="heading"], [aria-label]',
          ),
        ).some(
          (element) =>
            shared.normalizeText(
              element.getAttribute?.("aria-label") ||
                element.innerText ||
                element.textContent,
            ).toLowerCase() === "confirm your pin",
        ),
      ) || null;

    return {
      highDemandOk: highDemandDialog
        ? findReadyButton(documentRef, /^ok$/i, highDemandDialog)
        : null,
      saveContinue: findReadyButton(documentRef, /^save and continue$/i),
      pinInput:
        pinDialog?.querySelector(
          'input[name*="pin" i], input[id*="pin" i], input[aria-label*="pin" i]',
        ) || null,
      pinConfirm: pinDialog
        ? findReadyButton(documentRef, /^confirm$/i, pinDialog)
        : null,
      placeOrder: findReadyButton(
        documentRef,
        /^place(?: your)? order$/i,
      ),
    };
  }

  function snapshotCheckoutPage(documentRef, url = "") {
    const bodyText = shared.normalizeText(
      documentRef.body?.innerText || documentRef.body?.textContent,
    );
    const controls = getCheckoutControls(documentRef);
    return {
      verificationVisible: shared.hasVerification(documentRef, url),
      confirmationVisible:
        /\/(?:co-thankyou|order-confirmation|thank-you)(?:[/?#]|$)/i.test(
          url,
        ) || confirmationPattern.test(bodyText),
      cartRows: shared.getVisibleCartRows(documentRef),
      cartItemCount: shared.getVisibleCartItemCount(documentRef),
      onCartPage: /\/cart(?:[/?#]|$)/i.test(url),
      highDemandReady: Boolean(controls.highDemandOk),
      saveContinueReady: Boolean(controls.saveContinue),
      pinReady: Boolean(controls.pinInput && controls.pinConfirm),
      placeOrderReady: Boolean(controls.placeOrder),
      transientBusy: transientBusyPattern.test(bodyText),
    };
  }

  function getArmedProductIds(tabs) {
    return Object.values(tabs || {})
      .filter(
        (tab) =>
          tab.role === "product" &&
          tab.phase !== "stopped" &&
          Boolean(tab.productId),
      )
      .map((tab) => tab.productId);
  }

  function getArmedProductLabels(tabs) {
    return Object.values(tabs || {})
      .filter(
        (tab) =>
          tab.role === "product" &&
          tab.phase !== "stopped" &&
          Boolean(tab.productLabel),
      )
      .map((tab) => tab.productLabel);
  }

  function shouldRunCheckoutAction(
    pendingAction,
    decisionType,
  ) {
    return Boolean(
      !pendingAction ||
        pendingAction.type !== decisionType,
    );
  }

  async function executeCheckoutDecision(decision, actions) {
    const claimAndAuthorize = async () => {
      const token = await actions.claim(decision.type);
      if (!token || !(await actions.authorize(token, decision.type))) {
        return false;
      }
      return actions.finalValidate
        ? actions.finalValidate(decision.type)
        : true;
    };
    const getControls = () => actions.getControls?.() || actions.controls;

    switch (decision.type) {
      case "verification":
        await actions.report(
          "verification",
          "Verification requires manual completion.",
        );
        return;
      case "confirmed":
        await actions.report("confirmed", "Order confirmed.");
        return;
      case "blocked-cart":
        await actions.report(
          "blocked",
          "Cart is empty or contains a product that was not armed.",
        );
        return;
      case "dismiss-high-demand":
        if (!(await claimAndAuthorize())) {
          return;
        }
        actions.markPending?.(decision.type);
        await getControls().highDemandOk?.click();
        return;
      case "save-continue":
        if (!(await claimAndAuthorize())) {
          return;
        }
        actions.markPending?.(decision.type);
        await getControls().saveContinue?.click();
        return;
      case "confirm-pin": {
        const pin = await actions.getPin();
        if (!pin) {
          await actions.report("blocked", "Target checkout PIN is required.");
          return;
        }
        if (!(await claimAndAuthorize())) {
          return;
        }
        actions.markPending?.(decision.type);
        const controls = getControls();
        const input = controls.pinInput;
        if (input) {
          input.value = pin;
          const EventConstructor =
            input.ownerDocument?.defaultView?.Event || root.Event;
          if (EventConstructor) {
            input.dispatchEvent(
              new EventConstructor("input", { bubbles: true }),
            );
            input.dispatchEvent(
              new EventConstructor("change", { bubbles: true }),
            );
          }
        }
        await controls.pinConfirm?.click();
        return;
      }
      case "go-checkout":
        await actions.report("monitoring", "Cart ready; opening checkout.");
        actions.navigate("https://www.target.com/checkout");
        return;
      case "place-order":
        if (!(await claimAndAuthorize())) {
          return;
        }
        await getControls().placeOrder?.click();
        return;
      case "refresh":
        await actions.report("monitoring", "Retrying transient checkout state.");
        actions.refresh();
        return;
      default:
        return;
    }
  }

  const api = {
    executeCheckoutDecision,
    getArmedProductIds,
    getArmedProductLabels,
    getCheckoutControls,
    shouldRunCheckoutAction,
    snapshotCheckoutPage,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (
    !root.chrome?.runtime?.id ||
    !root.document ||
    root.__targetPurchaseCheckoutMonitor
  ) {
    return;
  }
  root.__targetPurchaseCheckoutMonitor = true;

  let handling = false;
  let mutationTimer = null;
  let pendingAction = null;

  async function report(phase, detail) {
    await chrome.runtime.sendMessage({
      type: "REPORT_STATE",
      phase,
      detail,
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
        tabState?.role !== "checkout" ||
        tabState.phase === "stopped" ||
        tabState.phase === "confirmed"
      ) {
        return;
      }

      const armedProductIds = getArmedProductIds(response.state.tabs);
      const armedProductLabels = getArmedProductLabels(response.state.tabs);
      const snapshot = snapshotCheckoutPage(document, location.href);
      const decision = core.classifyCheckoutPage(snapshot, {
        phase: tabState.phase,
        armedProductIds,
        armedProductLabels,
      });
      if (!allowRefresh && decision.type === "refresh") {
        return;
      }
      if (
        ["dismiss-high-demand", "save-continue", "confirm-pin"].includes(
          decision.type,
        ) &&
        !shouldRunCheckoutAction(pendingAction, decision.type)
      ) {
        return;
      }

      const controls = getCheckoutControls(document);
      await executeCheckoutDecision(decision, {
        controls,
        getControls: () => getCheckoutControls(document),
        claim: async (actionType) => {
          const token =
            root.crypto?.randomUUID?.() ||
            `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const claim = await chrome.runtime.sendMessage({
            type: "CLAIM_CHECKOUT_ACTION",
            actionType,
            token,
            url: location.href,
          });
          return claim?.claimed === true ? token : null;
        },
        authorize: async (token, actionType) => {
          const authorization = await chrome.runtime.sendMessage({
            type: "AUTHORIZE_CHECKOUT_ACTION",
            actionType,
            token,
            url: location.href,
          });
          return authorization?.authorized === true;
        },
        finalValidate: (actionType) => {
          const freshSnapshot = snapshotCheckoutPage(document, location.href);
          const freshCartAllowed = core.validateCheckoutCart(
            freshSnapshot.cartRows,
            armedProductIds,
            freshSnapshot.cartItemCount,
            armedProductLabels,
          );
          if (freshSnapshot.verificationVisible) {
            return false;
          }
          if (actionType === "dismiss-high-demand") {
            return freshSnapshot.highDemandReady;
          }
          if (actionType === "save-continue") {
            return freshSnapshot.saveContinueReady;
          }
          if (actionType === "confirm-pin") {
            return (
              freshSnapshot.pinReady &&
              (freshCartAllowed || Number(tabState.orderSubmittedAt || 0) > 0)
            );
          }
          return actionType === "place-order"
            ? freshSnapshot.placeOrderReady && freshCartAllowed
            : false;
        },
        getPin: async () => {
          const pinResponse = await chrome.runtime.sendMessage({
            type: "GET_TARGET_CHECKOUT_PIN",
          });
          return pinResponse?.pin || "";
        },
        markPending: (type) => {
          pendingAction = {
            type,
            at: Date.now(),
          };
        },
        navigate: (url) => location.assign(url),
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
