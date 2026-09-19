if (
  typeof importScripts === "function" &&
  !globalThis.TargetPurchaseCore
) {
  importScripts("lib/core.js");
}

(function initializeTargetPurchaseBackground(root) {
  const core =
    root.TargetPurchaseCore ||
    (typeof require === "function" ? require("./lib/core") : null);
  const stateStorageKey = "targetPurchaseState";
  const targetCheckoutPinKey = "targetCheckoutPin";
  const schedulerUrl =
    `ws://127.0.0.1:18765/?token=${core.schedulerToken}`;
  const reconnectAlarmName = "target-purchase-scheduler-reconnect";
  const allowedPhases = new Set([
    "monitoring",
    "action-pending",
    "added",
    "cooldown",
    "verification",
    "buy-now",
    "idle",
    "placing",
    "transitioning",
    "confirmed",
    "blocked",
    "stopped",
  ]);

  function createInitialState() {
    return {
      config: {
        intervalMs: core.normalizeInterval(),
      },
      checkoutTabId: null,
      scheduler: {
        connected: false,
        lastTickAt: null,
      },
      tabs: {},
    };
  }

  function cloneState(state) {
    return JSON.parse(JSON.stringify(state || createInitialState()));
  }

  function normalizeState(state) {
    const normalized = {
      ...createInitialState(),
      ...(state || {}),
      config: {
        ...createInitialState().config,
        ...(state?.config || {}),
      },
      scheduler: {
        ...createInitialState().scheduler,
        ...(state?.scheduler || {}),
      },
      tabs: {
        ...(state?.tabs || {}),
      },
    };
    normalized.config.intervalMs = core.normalizeInterval(
      normalized.config.intervalMs,
    );
    return normalized;
  }

  function isValidMessage(message) {
    return Boolean(
      message &&
        typeof message === "object" &&
        typeof message.type === "string" &&
        message.type.length > 0,
    );
  }

  function isCheckoutUrl(url) {
    return /^https:\/\/www\.target\.com\/(?:cart|checkout|co-thankyou|order-confirmation|thank-you)(?:[/?#]|$)/i.test(
      url || "",
    );
  }

  function getCommandError(stateInput, message, senderTabId) {
    const state = normalizeState(stateInput);
    const tabKey =
      Number.isInteger(senderTabId) && senderTabId >= 0
        ? String(senderTabId)
        : null;

    if (message?.type === "ARM_PRODUCT") {
      const productId = core.getProductId(message.url);
      if (!tabKey || !productId) {
        return "Open a supported Target product page before arming it.";
      }
      const duplicate = Object.entries(state.tabs).find(
        ([key, tab]) =>
          key !== tabKey &&
          tab.role === "product" &&
          tab.phase !== "stopped" &&
          tab.productId === productId,
      );
      if (duplicate) {
        return `${productId} is already armed in tab ${duplicate[0]}.`;
      }
    }

    if (
      message?.type === "ARM_CHECKOUT" &&
      (!tabKey || !isCheckoutUrl(message.url))
    ) {
      return "Open a supported Target cart or checkout page before arming it.";
    }

    return null;
  }

  function applyCommand(stateInput, message, senderTabId, now = Date.now()) {
    const state = normalizeState(cloneState(stateInput));
    if (!isValidMessage(message)) {
      return state;
    }
    if (getCommandError(state, message, senderTabId)) {
      return state;
    }

    const tabKey =
      Number.isInteger(senderTabId) && senderTabId >= 0
        ? String(senderTabId)
        : null;

    switch (message.type) {
      case "ARM_PRODUCT": {
        const productId = core.getProductId(message.url);
        if (state.checkoutTabId === senderTabId) {
          state.checkoutTabId = null;
        }
        state.tabs[tabKey] = {
          role: "product",
          phase: "monitoring",
          productId,
          url: message.url,
          updatedAt: now,
        };
        return state;
      }

      case "ARM_CHECKOUT": {
        if (
          Number.isInteger(state.checkoutTabId) &&
          state.checkoutTabId !== senderTabId
        ) {
          const previousKey = String(state.checkoutTabId);
          if (state.tabs[previousKey]) {
            state.tabs[previousKey] = {
              ...state.tabs[previousKey],
              phase: "stopped",
              detail: "Another checkout tab was armed.",
              updatedAt: now,
            };
          }
        }
        state.checkoutTabId = senderTabId;
        state.tabs[tabKey] = {
          role: "checkout",
          phase: "monitoring",
          productId: null,
          url: message.url,
          updatedAt: now,
        };
        return state;
      }

      case "REPORT_STATE": {
        const currentTab = tabKey ? state.tabs[tabKey] : null;
        if (
          !tabKey ||
          !currentTab ||
          currentTab.phase === "stopped" ||
          currentTab.phase === "confirmed" ||
          !allowedPhases.has(message.phase)
        ) {
          return state;
        }
        if (
          currentTab.role === "product" &&
          (!core.isSameProductUrl(message.url, currentTab.url) ||
            core.getProductId(message.url) !== currentTab.productId)
        ) {
          return state;
        }
        if (
          currentTab.role === "checkout" &&
          (state.checkoutTabId !== senderTabId ||
            !isCheckoutUrl(message.url))
        ) {
          return state;
        }
        if (
          currentTab.role === "checkout" &&
          Number(currentTab.orderSubmittedAt || 0) > 0 &&
          message.phase === "blocked" &&
          /^Cart is empty or contains a product that was not armed\./.test(
            String(message.detail || ""),
          )
        ) {
          return state;
        }
        state.tabs[tabKey] = {
          ...currentTab,
          phase: message.phase,
          detail:
            typeof message.detail === "string"
              ? message.detail.slice(0, 300)
              : "",
          cooldownUntil: Number(message.cooldownUntil || 0),
          updatedAt: now,
        };
        return state;
      }

      case "REPORT_PRODUCT_IDENTITY": {
        const currentTab = tabKey ? state.tabs[tabKey] : null;
        const productLabel = String(message.productLabel || "")
          .trim()
          .toLowerCase()
          .slice(0, 300);
        if (
          !currentTab ||
          currentTab.role !== "product" ||
          currentTab.phase === "stopped" ||
          !core.isSameProductUrl(message.url, currentTab.url) ||
          !productLabel
        ) {
          return state;
        }
        state.tabs[tabKey] = {
          ...currentTab,
          productLabel,
          updatedAt: now,
        };
        return state;
      }

      case "CLAIM_PRODUCT_ACTION": {
        const currentTab = tabKey ? state.tabs[tabKey] : null;
        if (
          !currentTab ||
          currentTab.role !== "product" ||
          currentTab.phase === "stopped" ||
          currentTab.phase === "confirmed" ||
          (currentTab.phase !== "monitoring" &&
            !(
              currentTab.phase === "cooldown" &&
              Number(currentTab.cooldownUntil || 0) <= now
            )) ||
          !core.isSameProductUrl(message.url, currentTab.url) ||
          core.getProductId(message.url) !== currentTab.productId ||
          typeof message.token !== "string" ||
          message.token.length < 8
        ) {
          return state;
        }
        state.tabs[tabKey] = {
          ...currentTab,
          phase: "action-pending",
          actionToken: message.token,
          detail: "Product action authorized.",
          updatedAt: now,
        };
        return state;
      }

      case "CLAIM_CHECKOUT_ACTION": {
        const currentTab = tabKey ? state.tabs[tabKey] : null;
        const actionType = String(message.actionType || "");
        const allowedActionTypes = new Set([
          "dismiss-high-demand",
          "save-continue",
          "confirm-pin",
          "place-order",
        ]);
        const hasSubmitted =
          Number(currentTab?.orderSubmittedAt || 0) > 0;
        const canPlaceAfterPin =
          hasSubmitted &&
          Number(currentTab?.pinConfirmedAt || 0) >
            Number(currentTab?.orderSubmittedAt || 0) &&
          Number(currentTab?.finalPlaceOrderAt || 0) === 0;
        if (
          !currentTab ||
          currentTab.role !== "checkout" ||
          currentTab.phase === "stopped" ||
          currentTab.phase === "confirmed" ||
          !(
            ["monitoring", "blocked", "transitioning"].includes(
              currentTab.phase,
            ) ||
            (currentTab.phase === "placing" &&
              (["confirm-pin", "dismiss-high-demand"].includes(actionType) ||
                (actionType === "place-order" && canPlaceAfterPin)))
          ) ||
          !allowedActionTypes.has(actionType) ||
          currentTab.actionToken === message.token ||
          currentTab.pendingAction === actionType ||
          (actionType === "place-order" &&
            hasSubmitted &&
            !canPlaceAfterPin) ||
          state.checkoutTabId !== senderTabId ||
          !isCheckoutUrl(message.url) ||
          typeof message.token !== "string" ||
          message.token.length < 8
        ) {
          return state;
        }
        state.tabs[tabKey] = {
          ...currentTab,
          phase:
            actionType === "place-order" || hasSubmitted
              ? "placing"
              : "transitioning",
          actionToken: message.token,
          pendingAction: actionType,
          orderSubmittedAt:
            actionType === "place-order" && !hasSubmitted
              ? now
              : currentTab.orderSubmittedAt,
          ...(actionType === "confirm-pin" && hasSubmitted
            ? { pinConfirmedAt: now }
            : {}),
          ...(actionType === "place-order" && hasSubmitted
            ? { finalPlaceOrderAt: now }
            : {}),
          detail: "Checkout action authorized.",
          updatedAt: now,
        };
        return state;
      }

      case "SET_INTERVAL": {
        state.config.intervalMs = core.normalizeInterval(message.intervalMs);
        return state;
      }

      case "STOP_TAB": {
        if (!tabKey || !state.tabs[tabKey]) {
          return state;
        }
        state.tabs[tabKey] = {
          ...state.tabs[tabKey],
          phase: "stopped",
          detail: "Stopped by user.",
          updatedAt: now,
        };
        if (state.checkoutTabId === senderTabId) {
          state.checkoutTabId = null;
        }
        return state;
      }

      case "STOP_ALL": {
        for (const [key, tab] of Object.entries(state.tabs)) {
          state.tabs[key] = {
            ...tab,
            phase: "stopped",
            detail: "Stopped by user.",
            updatedAt: now,
          };
        }
        state.checkoutTabId = null;
        return state;
      }

      default:
        return state;
    }
  }

  function createStateMutationQueue(loadState, saveState) {
    let queue = Promise.resolve();
    return function mutateState(mutator) {
      const operation = queue.then(async () => {
        const current = await loadState();
        const next = await mutator(current);
        await saveState(next);
        return next;
      });
      queue = operation.catch(() => {});
      return operation;
    };
  }

  function reconcileStateWithTabs(stateInput, openTabs) {
    const state = normalizeState(cloneState(stateInput));
    const tabsById = new Map(
      (openTabs || [])
        .filter((tab) => Number.isInteger(tab.id))
        .map((tab) => [String(tab.id), tab]),
    );

    for (const [tabId, tabState] of Object.entries(state.tabs)) {
      const openTab = tabsById.get(tabId);
      const valid =
        openTab &&
        (tabState.role === "product"
          ? core.getProductId(openTab.url) === tabState.productId &&
            core.isSameProductUrl(openTab.url, tabState.url)
          : tabState.role === "checkout" && isCheckoutUrl(openTab.url));
      if (!valid) {
        state.tabs[tabId] = {
          ...tabState,
          phase: "stopped",
          detail: "Tab URL changed or the tab no longer exists.",
        };
        if (state.checkoutTabId === Number(tabId)) {
          state.checkoutTabId = null;
        }
      }
    }
    return state;
  }

  function isActionAuthorized(
    stateInput,
    tabId,
    role,
    token,
    url,
    actionType = null,
  ) {
    const state = normalizeState(stateInput);
    const tab = state.tabs[String(tabId)];
    if (
      !tab ||
      tab.role !== role ||
      tab.actionToken !== token ||
      tab.phase === "stopped" ||
      tab.phase === "confirmed"
    ) {
      return false;
    }
    if (role === "product") {
      return (
        tab.phase === "action-pending" &&
        core.isSameProductUrl(url, tab.url) &&
        core.getProductId(url) === tab.productId
      );
    }
    const expectedCheckoutPhase =
      actionType === "place-order" || Number(tab.orderSubmittedAt || 0) > 0
        ? "placing"
        : "transitioning";
    return (
      role === "checkout" &&
      tab.phase === expectedCheckoutPhase &&
      tab.pendingAction === actionType &&
      state.checkoutTabId === tabId &&
      /^https:\/\/www\.target\.com\/(?:cart|checkout|co-thankyou|order-confirmation|thank-you)(?:[/?#]|$)/i.test(
        url || "",
      )
    );
  }

  function wasActionClaimAccepted(
    previousStateInput,
    nextStateInput,
    message,
    senderTabId,
  ) {
    if (
      message?.type !== "CLAIM_PRODUCT_ACTION" &&
      message?.type !== "CLAIM_CHECKOUT_ACTION"
    ) {
      return false;
    }
    const previousTab =
      normalizeState(previousStateInput).tabs[String(senderTabId)];
    const nextTab = normalizeState(nextStateInput).tabs[String(senderTabId)];
    if (
      !nextTab ||
      nextTab.actionToken !== message.token ||
      previousTab?.actionToken === message.token
    ) {
      return false;
    }
    if (message.type === "CLAIM_PRODUCT_ACTION") {
      return nextTab.role === "product" && nextTab.phase === "action-pending";
    }
    return (
      nextTab.role === "checkout" &&
      nextTab.pendingAction === message.actionType &&
      nextTab.phase ===
        (message.actionType === "place-order" ||
        Number(nextTab.orderSubmittedAt || 0) > 0
          ? "placing"
          : "transitioning")
    );
  }

  function consumeActionAuthorization(
    stateInput,
    tabId,
    role,
    token,
    url,
    actionType = null,
    now = Date.now(),
  ) {
    const state = normalizeState(cloneState(stateInput));
    if (!isActionAuthorized(state, tabId, role, token, url, actionType)) {
      return { state, authorized: false };
    }
    const tabKey = String(tabId);
    const tab = state.tabs[tabKey];
    delete tab.actionToken;
    tab.actionAuthorizedAt = now;
    return { state, authorized: true };
  }

  const api = {
    allowedPhases,
    applyCommand,
    consumeActionAuthorization,
    createInitialState,
    createStateMutationQueue,
    getCommandError,
    isActionAuthorized,
    isValidMessage,
    normalizeState,
    reconcileStateWithTabs,
    wasActionClaimAccepted,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (!root.chrome?.runtime?.id) {
    return;
  }

  let schedulerSocket = null;

  async function loadState() {
    const stored = await chrome.storage.local.get(stateStorageKey);
    return normalizeState(stored[stateStorageKey]);
  }

  async function saveState(state) {
    await chrome.storage.local.set({
      [stateStorageKey]: normalizeState(state),
    });
  }

  const mutateState = createStateMutationQueue(loadState, saveState);

  async function updateSchedulerStatus(connected, lastTickAt = null) {
    await mutateState((state) => {
      state.scheduler.connected = connected;
      if (lastTickAt !== null) {
        state.scheduler.lastTickAt = lastTickAt;
      }
      return state;
    });
  }

  async function broadcastTick(at = Date.now()) {
    const openTabs = await chrome.tabs.query({});
    const state = await mutateState((current) => {
      current = reconcileStateWithTabs(current, openTabs);
      current.scheduler.lastTickAt = at;
      return current;
    });
    const deliveries = Object.entries(state.tabs)
      .filter(([, tab]) => tab.phase !== "stopped")
      .map(([tabId]) =>
        chrome.tabs
          .sendMessage(Number(tabId), {
            type: "TARGET_PURCHASE_TICK",
            at,
          })
          .catch(() => {}),
      );
    await Promise.all(deliveries);
  }

  async function connectScheduler() {
    if (
      schedulerSocket &&
      (schedulerSocket.readyState === WebSocket.OPEN ||
        schedulerSocket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      schedulerSocket = new WebSocket(schedulerUrl);
      schedulerSocket.addEventListener("open", async () => {
        await updateSchedulerStatus(true);
        const state = await loadState();
        schedulerSocket.send(
          JSON.stringify({
            type: "configure",
            intervalMs: state.config.intervalMs,
          }),
        );
      });
      schedulerSocket.addEventListener("message", async (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "tick") {
          await broadcastTick(Number(message.at) || Date.now());
        } else if (message.type === "heartbeat") {
          await updateSchedulerStatus(true);
        }
      });
      schedulerSocket.addEventListener("close", async () => {
        schedulerSocket = null;
        await updateSchedulerStatus(false);
        await chrome.alarms.create(reconnectAlarmName, {
          delayInMinutes: 0.5,
        });
      });
      schedulerSocket.addEventListener("error", () => {});
    } catch {
      schedulerSocket = null;
      await updateSchedulerStatus(false);
      await chrome.alarms.create(reconnectAlarmName, {
        delayInMinutes: 0.5,
      });
    }
  }

  chrome.runtime.onInstalled.addListener(async () => {
    const openTabs = await chrome.tabs.query({});
    await mutateState((state) => reconcileStateWithTabs(state, openTabs));
    await connectScheduler();
  });

  chrome.runtime.onStartup.addListener(async () => {
    const openTabs = await chrome.tabs.query({});
    await mutateState((state) => reconcileStateWithTabs(state, openTabs));
    await connectScheduler();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === reconnectAlarmName) {
      connectScheduler();
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    await mutateState((state) => {
      delete state.tabs[String(tabId)];
      if (state.checkoutTabId === tabId) {
        state.checkoutTabId = null;
      }
      return state;
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (!isValidMessage(message)) {
        sendResponse({ ok: false, error: "Invalid message." });
        return;
      }

      const senderTabId =
        Number.isInteger(message.tabId) && message.tabId >= 0
          ? message.tabId
          : sender.tab?.id;

      if (message.type === "GET_STATUS") {
        const state = await loadState();
        sendResponse({
          ok: true,
          state,
          tab: Number.isInteger(senderTabId)
            ? state.tabs[String(senderTabId)] || null
            : null,
        });
        return;
      }

      if (message.type === "GET_TARGET_CHECKOUT_PIN") {
        const stored = await chrome.storage.session.get(targetCheckoutPinKey);
        sendResponse({
          ok: true,
          pin: stored[targetCheckoutPinKey] || "",
        });
        return;
      }

      if (message.type === "SET_TARGET_CHECKOUT_PIN") {
        const pin =
          typeof message.pin === "string" ? message.pin.trim().slice(0, 12) : "";
        if (pin) {
          await chrome.storage.session.set({ [targetCheckoutPinKey]: pin });
        } else {
          await chrome.storage.session.remove(targetCheckoutPinKey);
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "RUN_TICK_NOW") {
        await broadcastTick();
        sendResponse({ ok: true });
        return;
      }

      if (
        message.type === "AUTHORIZE_PRODUCT_ACTION" ||
        message.type === "AUTHORIZE_CHECKOUT_ACTION"
      ) {
        let authorized = false;
        const state = await mutateState((current) => {
          const result = consumeActionAuthorization(
            current,
            senderTabId,
            message.type === "AUTHORIZE_PRODUCT_ACTION"
              ? "product"
              : "checkout",
            message.token,
            message.url,
            message.actionType,
          );
          authorized = result.authorized;
          return result.state;
        });
        sendResponse({
          ok: true,
          authorized,
          state,
        });
        return;
      }

      let commandError = null;
      let previousState = null;
      const next = await mutateState((current) => {
        previousState = current;
        commandError = getCommandError(current, message, senderTabId);
        return applyCommand(current, message, senderTabId);
      });
      if (commandError) {
        sendResponse({
          ok: false,
          error: commandError,
          state: next,
          tab: Number.isInteger(senderTabId)
            ? next.tabs[String(senderTabId)] || null
            : null,
        });
        return;
      }
      if (message.type === "SET_INTERVAL") {
        if (schedulerSocket?.readyState === WebSocket.OPEN) {
          schedulerSocket.send(
            JSON.stringify({
              type: "configure",
              intervalMs: next.config.intervalMs,
            }),
          );
        }
      }
      sendResponse({
        ok: true,
        claimed: wasActionClaimAccepted(
          previousState,
          next,
          message,
          senderTabId,
        ),
        state: next,
        tab: Number.isInteger(senderTabId)
          ? next.tabs[String(senderTabId)] || null
          : null,
      });
    })().catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  });

  connectScheduler();
})(globalThis);
