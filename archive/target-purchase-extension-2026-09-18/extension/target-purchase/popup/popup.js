(function initializePopup() {
  const core = globalThis.TargetPurchaseCore;
  const elements = {
    schedulerState: document.getElementById("scheduler-state"),
    currentTab: document.getElementById("current-tab"),
    armProduct: document.getElementById("arm-product"),
    armCheckout: document.getElementById("arm-checkout"),
    stopTab: document.getElementById("stop-tab"),
    stopAll: document.getElementById("stop-all"),
    interval: document.getElementById("interval-ms"),
    pin: document.getElementById("target-checkout-pin"),
    saveSettings: document.getElementById("save-settings"),
    runNow: document.getElementById("run-now"),
    tabStatusList: document.getElementById("tab-status-list"),
    message: document.getElementById("message"),
  };

  let activeTab = null;

  function showMessage(message, warning = false) {
    elements.message.textContent = message;
    elements.message.classList.toggle("warning", warning);
  }

  async function send(message) {
    return chrome.runtime.sendMessage({
      ...message,
      tabId: activeTab?.id,
    });
  }

  function renderStatus(response) {
    const state = response.state;
    const currentState = activeTab ? state.tabs[String(activeTab.id)] : null;
    const schedulerConnected = Boolean(state.scheduler.connected);

    elements.schedulerState.textContent = schedulerConnected
      ? "Scheduler connected"
      : "Scheduler offline";
    elements.schedulerState.classList.toggle("connected", schedulerConnected);
    elements.schedulerState.classList.toggle("warning", !schedulerConnected);
    elements.interval.value = String(state.config.intervalMs);

    const productId = core.getProductId(activeTab?.url);
    const checkoutPage = /^https:\/\/www\.target\.com\/(?:cart|checkout)/i.test(
      activeTab?.url || "",
    );
    elements.armProduct.disabled = !productId;
    elements.armCheckout.disabled = !checkoutPage;
    elements.stopTab.disabled = !currentState;

    elements.currentTab.textContent = currentState
      ? `${currentState.role}: ${currentState.phase}${currentState.productId ? ` · ${currentState.productId}` : ""}`
      : productId
        ? `Target product · ${productId} · unarmed`
        : checkoutPage
          ? "Target checkout · unarmed"
          : "This tab is not a supported Target page.";

    const activeEntries = Object.entries(state.tabs).filter(
      ([, tab]) => tab.phase !== "stopped",
    );
    elements.tabStatusList.replaceChildren();
    if (activeEntries.length === 0) {
      const item = document.createElement("li");
      item.className = "empty";
      item.textContent = "No tabs armed.";
      elements.tabStatusList.append(item);
      return;
    }

    for (const [tabId, tab] of activeEntries) {
      const item = document.createElement("li");
      item.className = tab.role;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent =
        tab.role === "checkout"
          ? `Checkout tab ${tabId}`
          : `${tab.productId} · tab ${tabId}`;
      const detail = document.createElement("span");
      detail.textContent = `${tab.phase}${tab.detail ? ` · ${tab.detail}` : ""}`;
      item.append(name, detail);
      elements.tabStatusList.append(item);
    }
  }

  async function refresh() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    activeTab = tab || null;
    const response = await send({ type: "GET_STATUS" });
    if (!response?.ok) {
      showMessage(response?.error || "Unable to read extension state.", true);
      return;
    }
    renderStatus(response);
  }

  elements.armProduct.addEventListener("click", async () => {
    const response = await send({
      type: "ARM_PRODUCT",
      url: activeTab.url,
    });
    showMessage(response.ok ? "Product tab armed." : response.error, !response.ok);
    await refresh();
    await send({ type: "RUN_TICK_NOW" });
  });

  elements.armCheckout.addEventListener("click", async () => {
    const response = await send({
      type: "ARM_CHECKOUT",
      url: activeTab.url,
    });
    showMessage(
      response.ok ? "Checkout tab armed." : response.error,
      !response.ok,
    );
    await refresh();
    await send({ type: "RUN_TICK_NOW" });
  });

  elements.stopTab.addEventListener("click", async () => {
    const response = await send({ type: "STOP_TAB" });
    showMessage(response.ok ? "This tab is stopped." : response.error, !response.ok);
    await refresh();
  });

  elements.stopAll.addEventListener("click", async () => {
    const response = await send({ type: "STOP_ALL" });
    showMessage(response.ok ? "All tabs are stopped." : response.error, !response.ok);
    await refresh();
  });

  elements.saveSettings.addEventListener("click", async () => {
    const intervalMs = core.normalizeInterval(elements.interval.value);
    const intervalResponse = await send({
      type: "SET_INTERVAL",
      intervalMs,
    });
    const pinResponse = await send({
      type: "SET_TARGET_CHECKOUT_PIN",
      pin: elements.pin.value,
    });
    const ok = intervalResponse?.ok && pinResponse?.ok;
    showMessage(
      ok ? `Settings saved. Refresh interval: ${intervalMs} ms.` : "Settings were not saved.",
      !ok,
    );
    await refresh();
  });

  elements.runNow.addEventListener("click", async () => {
    const response = await send({ type: "RUN_TICK_NOW" });
    showMessage(response.ok ? "Tick sent." : response.error, !response.ok);
  });

  refresh().catch((error) => {
    showMessage(error.message, true);
  });
})();
