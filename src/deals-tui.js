const { modeLabel, normalizeMode, parseGroupedList } = require("./deals-core");
const { adapterForRetailer } = require("./deals-adapters");
const { secretRows } = require("./deals-secrets");

const minimumTerminalSize = Object.freeze({
  width: 90,
  height: 28,
});

const palette = Object.freeze({
  background: "#071019",
  panel: "#0d1b29",
  panelAlt: "#102536",
  focus: "#185566",
  gold: "#f2c94c",
  cyan: "#56d6e7",
  text: "#d9e6ee",
  muted: "#7691a3",
  green: "#54d17a",
  red: "#ff667a",
  orange: "#ffad5c",
});

function selectionStyle(focused) {
  return {
    bg: focused ? palette.focus : palette.panelAlt,
    fg: focused ? palette.text : palette.gold,
    bold: true,
  };
}

const navigationItems = Object.freeze([
  { id: "products", label: "Products" },
  { id: "import", label: "Import" },
  { id: "add", label: "Add Product" },
  { id: "run-setup", label: "Run Engine" },
  { id: "run-stats", label: "Run Stats" },
  { id: "settings", label: "Settings" },
  { id: "secrets", label: "Secrets" },
  { id: "help", label: "Help" },
]);

const executionModeOptions = Object.freeze([
  { id: "observe-only", label: "Observe", detail: "No purchase input" },
  {
    id: "stop-before-submit",
    label: "Stop before submit",
    detail: "Cart and checkout actions; never submits",
  },
  {
    id: "live-purchase",
    label: "Live purchase",
    detail: "May submit a real order",
  },
]);

function truncateText(value, width) {
  const text = String(value ?? "");
  if (width <= 3) {
    return text.slice(0, Math.max(0, width));
  }
  return text.length <= width ? text : `${text.slice(0, width - 3)}...`;
}

function retailerLabel(retailer) {
  return adapterForRetailer(retailer)?.displayName || "Unsupported";
}

function formatLastChecked(timestamp) {
  return timestamp
    ? String(timestamp).replace("T", " ").replace(/\.\d{3}Z$/, "Z")
    : "-";
}

function statusColor(item) {
  const value = `${item.lastStatus || ""} ${item.terminalOutcome || ""}`.toLowerCase();
  if (/failed|error|unconfirmed|safety stop|worker-error/.test(value)) {
    return palette.red;
  }
  if (/confirmed|completed/.test(value)) {
    return palette.green;
  }
  if (/verification|backoff|rate-limit|interrupted|stopped|ready-to-submit/.test(value)) {
    return palette.orange;
  }
  if (/unavailable|not run/.test(value)) {
    return palette.muted;
  }
  if (/available|monitoring|starting|url resolved/.test(value)) {
    return palette.cyan;
  }
  return palette.muted;
}

function productColumnWidths(width) {
  if (width >= 125) {
    return [3, 9, 11, 30, 20, 30, 20];
  }
  if (width >= 95) {
    return [3, 9, 10, 22, 14, 22, 16];
  }
  return [3, 7, 6, 10, 6, 10, 11];
}

function formatProductCells(cells, widths) {
  return cells.map((cell, index) =>
    truncateText(cell, widths[index]).padEnd(widths[index]),
  ).join("  ");
}

function productTableHeader(width) {
  return formatProductCells(
    ["RUN", "MODE", "STORE", "NAME", "GROUP", "STATUS", "CHECKED"],
    productColumnWidths(width),
  );
}

function productRows(items, { width = 120 } = {}) {
  const widths = productColumnWidths(width);
  return items.map((item) => {
    const status = item.terminalOutcome
      ? `${item.lastStatus} [${item.terminalOutcome}]`
      : item.lastStatus;
    const cells = [
      item.armed ? "[x]" : "[ ]",
      modeLabel(item.mode),
      retailerLabel(item.retailer),
      item.name,
      item.group || "-",
      status,
      formatLastChecked(item.lastStatusAt),
    ];
    return {
      id: item.id,
      armed: item.armed,
      status: item.lastStatus,
      terminalOutcome: item.terminalOutcome,
      color: statusColor(item),
      cells,
      text: formatProductCells(cells, widths),
    };
  });
}

function productDetail(item) {
  if (!item) {
    return null;
  }
  return {
    id: item.id,
    name: item.name,
    group: item.group || "-",
    rawUrl: item.url,
    resolvedProductId: item.resolvedProductId || "-",
    resolvedUrl: item.resolvedUrl || "-",
    status: item.lastStatus,
    lastChecked: formatLastChecked(item.lastStatusAt),
    terminalOutcome: item.terminalOutcome || "-",
  };
}

function normalizeKeyName(key) {
  if (typeof key === "string") {
    return key.toLowerCase();
  }
  return String(key?.full || key?.name || "").toLowerCase();
}

function actionForKey(key) {
  const name = normalizeKeyName(key);
  const actions = {
    up: "previous",
    k: "previous",
    down: "next",
    j: "next",
    enter: "activate",
    return: "activate",
    space: "toggle-armed",
    a: "add",
    e: "edit",
    i: "import",
    d: "delete",
    r: "run",
    t: "run-stats",
    s: "settings",
    q: "quit",
    escape: "back",
    left: "focus-navigation",
    right: "focus-content",
    tab: "toggle-focus",
    v: "reveal-secret",
    c: "clear-secret",
    "c-c": "stop-run",
  };
  return actions[name] || null;
}

function runSetupDefaults(items, settings = {}) {
  const configuredMode = {
    observe: "observe-only",
    "observe-only": "observe-only",
    "stop-before-submit": "stop-before-submit",
    live: "live-purchase",
    "live-purchase": "live-purchase",
  }[settings.defaultRunMode] || "stop-before-submit";
  return {
    products: items.filter(
      (item) => item.armed && item.terminalOutcome !== "confirmed",
    ),
    executionMode: configuredMode,
    challengeSolver: settings.solverEnabled !== false,
  };
}

function createRunProjection() {
  return {
    statuses: {},
    logs: [],
    recentEvents: [],
    productStats: {},
    workers: {},
    eventCount: 0,
    pollCount: 0,
    availableCount: 0,
    unavailableCount: 0,
    actionCount: 0,
    verificationCount: 0,
    errorCount: 0,
    terminalCount: 0,
    startedAt: null,
    endedAt: null,
    outcome: null,
    lastEventAt: null,
    lastStatus: null,
    backoffUntil: null,
  };
}

function cloneRunProjection(state = {}) {
  const defaults = createRunProjection();
  return {
    ...defaults,
    ...state,
    statuses: { ...(state.statuses || {}) },
    logs: [...(state.logs || [])],
    recentEvents: [...(state.recentEvents || [])],
    productStats: { ...(state.productStats || {}) },
    workers: { ...(state.workers || {}) },
  };
}

function classifyRunStatus(status, terminalOutcome = null) {
  const value = String(status || "").toLowerCase();
  const categories = {
    poll: /^(monitoring|poll|availability|available|unavailable)\b/.test(value),
    available: /^available\b/.test(value) && !/^unavailable\b/.test(value),
    unavailable: /^unavailable\b/.test(value),
    action: /action available|added to cart|checkout|purchase|order|cart/.test(value),
    verification: /verification/.test(value),
    error: /failed|error|invalid|unconfirmed|safety stop|worker-error/.test(value),
    terminal: Boolean(terminalOutcome),
  };
  return categories;
}

function projectRunLifecycle(state, lifecycle = {}) {
  const next = cloneRunProjection(state);
  const at = lifecycle.at || new Date().toISOString();
  const retailer = lifecycle.retailer || "worker";
  const existing = next.workers[retailer] || {};
  next.lastEventAt = at;
  if (lifecycle.type === "starting") {
    next.startedAt = next.startedAt || at;
    next.endedAt = null;
    next.outcome = null;
    next.workers[retailer] = {
      ...existing,
      retailer,
      status: "running",
      mode: lifecycle.mode || existing.mode || "-",
      itemIds: [...(lifecycle.itemIds || existing.itemIds || [])],
      startedAt: existing.startedAt || at,
      endedAt: null,
      code: null,
      signal: null,
      interrupted: false,
    };
  } else if (lifecycle.type === "closed") {
    next.endedAt = at;
    next.workers[retailer] = {
      ...existing,
      retailer,
      status: lifecycle.interrupted
        ? "interrupted"
        : lifecycle.code === 0
          ? "completed"
          : "failed",
      mode: lifecycle.mode || existing.mode || "-",
      itemIds: [...(lifecycle.itemIds || existing.itemIds || [])],
      endedAt: at,
      code: lifecycle.code ?? null,
      signal: lifecycle.signal || null,
      interrupted: Boolean(lifecycle.interrupted),
    };
  }
  return next;
}

function formatRunElapsed(startedAt, endedAt = null, now = Date.now()) {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) {
    return "00:00";
  }
  const end = endedAt ? Date.parse(endedAt) : Number(now);
  const elapsed = Math.max(0, (Number.isFinite(end) ? end : Number(now)) - start);
  const totalSeconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatBackoffRemaining(backoffUntil, now = Date.now()) {
  const end = Date.parse(backoffUntil || "");
  if (!Number.isFinite(end)) {
    return null;
  }
  const remainingSeconds = Math.max(0, Math.ceil((end - now) / 1000));
  if (remainingSeconds === 0) {
    return null;
  }
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function runEventTime(timestamp) {
  if (!timestamp) {
    return "--:--:--";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toISOString().slice(11, 19);
}

function terminalSizeState(width, height) {
  const currentWidth = Number(width) || 0;
  const currentHeight = Number(height) || 0;
  const tooSmall = currentWidth < minimumTerminalSize.width ||
    currentHeight < minimumTerminalSize.height;
  return {
    width: currentWidth,
    height: currentHeight,
    tooSmall,
    message: tooSmall
      ? `PokemonDeals needs at least ${minimumTerminalSize.width}x${minimumTerminalSize.height}. Current terminal: ${currentWidth}x${currentHeight}.`
      : null,
  };
}

function safeLogLine(value, maximumLength = 500) {
  return truncateText(
    String(value ?? "")
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""),
    maximumLength,
  );
}

function appendProjectedLog(logs, value, maximumEntries = 250) {
  const next = [...logs, safeLogLine(value)].slice(-maximumEntries);
  return next;
}

function projectRunEvent(state, notification) {
  const next = cloneRunProjection(state);
  const event = notification?.event;
  if (!event || typeof event.status !== "string") {
    return next;
  }
  const at = notification.at || new Date().toISOString();
  const categories = classifyRunStatus(event.status, event.terminalOutcome);
  const itemIds = [...(notification.itemIds || [])];
  next.eventCount += 1;
  next.pollCount += categories.poll ? 1 : 0;
  next.availableCount += categories.available ? 1 : 0;
  next.unavailableCount += categories.unavailable ? 1 : 0;
  next.actionCount += categories.action ? 1 : 0;
  next.verificationCount += categories.verification ? 1 : 0;
  next.errorCount += categories.error ? 1 : 0;
  next.terminalCount += categories.terminal ? 1 : 0;
  next.lastEventAt = at;
  next.lastStatus = event.status;
  if (Number.isFinite(event.backoffMs) && event.backoffMs > 0) {
    next.backoffUntil = new Date(
      Date.parse(at) + event.backoffMs,
    ).toISOString();
  } else if (!/backoff/i.test(event.status)) {
    next.backoffUntil = null;
  }
  next.recentEvents = [
    ...next.recentEvents,
    {
      at,
      retailer: notification.retailer || "worker",
      itemIds,
      status: event.status,
      terminalOutcome: event.terminalOutcome || null,
      important: Boolean(event.important),
    },
  ].slice(-80);
  for (const id of itemIds) {
    const previous = next.productStats[id] || {
      events: 0,
      polls: 0,
      available: 0,
      unavailable: 0,
      actions: 0,
      verifications: 0,
      errors: 0,
      terminal: 0,
      lastStatus: null,
      lastAt: null,
      terminalOutcome: null,
    };
    next.productStats[id] = {
      ...previous,
      events: previous.events + 1,
      polls: previous.polls + (categories.poll ? 1 : 0),
      available: previous.available + (categories.available ? 1 : 0),
      unavailable: previous.unavailable + (categories.unavailable ? 1 : 0),
      actions: previous.actions + (categories.action ? 1 : 0),
      verifications: previous.verifications + (categories.verification ? 1 : 0),
      errors: previous.errors + (categories.error ? 1 : 0),
      terminal: previous.terminal + (categories.terminal ? 1 : 0),
      lastStatus: event.status,
      lastAt: at,
      terminalOutcome: event.terminalOutcome || previous.terminalOutcome || null,
    };
    next.statuses[id] = {
      status: event.status,
      terminalOutcome: event.terminalOutcome || null,
      at,
      important: Boolean(event.important),
    };
  }
  next.logs = appendProjectedLog(
    next.logs,
    `${notification.retailer || "worker"}: ${event.status}`,
  );
  return next;
}

function createImportController(store) {
  const state = {
    step: "paste",
    text: "",
    parsed: null,
    mode: null,
    armed: true,
    error: null,
  };
  return {
    state,
    preview(text) {
      state.text = String(text || "");
      state.parsed = parseGroupedList(state.text);
      if (state.parsed.errors.length > 0) {
        state.error = state.parsed.errors.join("\n");
        state.step = "paste";
        return false;
      }
      state.error = null;
      state.step = "preview";
      return true;
    },
    selectMode(mode) {
      state.mode = normalizeMode(mode);
      state.error = null;
      return state.mode;
    },
    toggleArmed() {
      state.armed = !state.armed;
      return state.armed;
    },
    async confirm() {
      if (state.step !== "preview" || !state.parsed) {
        throw new Error("Preview the grouped list before importing.");
      }
      if (!state.mode) {
        state.error = "Select Buy Now, Preorder, or Buy before importing.";
        throw new Error(state.error);
      }
      const added = await store.addMany(
        state.parsed.items.map((item) => ({
          ...item,
          mode: state.mode,
          armed: state.armed,
        })),
      );
      state.step = "complete";
      state.error = null;
      return added;
    },
  };
}

function createChunkLogSink(onLine, prefix = "") {
  let pending = "";
  return {
    write(chunk) {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        onLine(`${prefix}${safeLogLine(line)}`);
      }
      return true;
    },
    flush() {
      if (pending) {
        onLine(`${prefix}${safeLogLine(pending)}`);
        pending = "";
      }
    },
  };
}

function createDealsTui({
  store,
  secretStore,
  runEngine,
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  autoStart = true,
  autoRestartDelayMs = 5000,
  blessed = require("neo-blessed"),
} = {}) {
  if (!store || !secretStore || typeof runEngine !== "function") {
    throw new Error("The TUI requires catalog, secret, and run-engine services.");
  }

  const screen = blessed.screen({
    input,
    output,
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    title: "PokemonDeals",
    warnings: false,
  });
  screen.program.hideCursor();

  const state = {
    view: "products",
    focus: "content",
    items: [],
    settings: {},
    secrets: null,
    selectedProductId: null,
    selectedIndex: 0,
    settingsIndex: 0,
    secretsIndex: 0,
    runSetupIndex: 0,
    runSetup: null,
    running: false,
    autoRunEnabled: true,
    runProjection: createRunProjection(),
    notice: "Ready",
    modal: null,
    closed: false,
  };
  let renderedView = state.view;

  let closeResolve;
  const closed = new Promise((resolve) => {
    closeResolve = resolve;
  });
  let automaticRestartTimer = null;
  let runStatsTimer = null;
  let backoffWasVisible = false;

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    tags: true,
    padding: { left: 2, right: 2 },
    style: {
      bg: palette.panelAlt,
      fg: palette.text,
    },
  });
  const navigation = blessed.list({
    parent: screen,
    name: "navigation",
    top: 3,
    left: 0,
    width: 20,
    bottom: 3,
    tags: true,
    items: navigationItems.map((item) => item.label),
    padding: { top: 1, left: 1, right: 1 },
    border: { type: "line" },
    style: {
      bg: palette.panel,
      fg: palette.muted,
      border: { fg: palette.panelAlt },
      selected: selectionStyle(state.focus === "navigation"),
      item: { fg: palette.text },
    },
  });
  const main = blessed.box({
    parent: screen,
    top: 3,
    left: 20,
    right: 0,
    bottom: 3,
    tags: true,
    border: { type: "line" },
    style: {
      bg: palette.background,
      fg: palette.text,
      border: { fg: palette.cyan },
    },
  });
  const footer = blessed.box({
    parent: screen,
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    tags: true,
    padding: { left: 1, right: 1 },
    style: {
      bg: palette.panelAlt,
      fg: palette.muted,
    },
  });
  const smallTerminal = blessed.box({
    parent: screen,
    hidden: true,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    align: "center",
    valign: "middle",
    tags: true,
    style: {
      bg: palette.background,
      fg: palette.gold,
      bold: true,
    },
  });

  function clearMain() {
    for (const child of [...main.children]) {
      child.destroy();
    }
  }

  function currentItem() {
    return state.items[state.selectedIndex] || null;
  }

  function clearAutomaticRestart() {
    if (automaticRestartTimer) {
      clearTimeout(automaticRestartTimer);
      automaticRestartTimer = null;
    }
  }

  function hasTerminalRunOutcome() {
    return Object.values(state.runProjection.statuses || {}).some(
      (status) => status?.terminalOutcome,
    );
  }

  function scheduleAutomaticRestart() {
    if (
      !state.autoRunEnabled ||
      state.closed ||
      state.running ||
      automaticRestartTimer ||
      hasTerminalRunOutcome()
    ) {
      return;
    }
    const delay = Math.max(0, Number(autoRestartDelayMs) || 0);
    state.notice = delay > 0
      ? `Worker stopped; retrying in ${Math.ceil(delay / 1000)}s.`
      : "Worker stopped; retrying.";
    render();
    automaticRestartTimer = setTimeout(() => {
      automaticRestartTimer = null;
      if (!state.autoRunEnabled || state.closed || state.running) {
        return;
      }
      startConfiguredRun({ automatic: true }).catch((error) => {
        state.notice = `Automatic run failed: ${error.message}`;
        render();
      });
    }, delay);
  }

  function retainSelection() {
    const retainedIndex = state.items.findIndex(
      (item) => item.id === state.selectedProductId,
    );
    if (retainedIndex >= 0) {
      state.selectedIndex = retainedIndex;
    } else {
      state.selectedIndex = Math.min(
        state.selectedIndex,
        Math.max(0, state.items.length - 1),
      );
    }
    state.selectedProductId = currentItem()?.id || null;
  }

  function titleBox(title, subtitle = "") {
    blessed.text({
      parent: main,
      top: 0,
      left: 2,
      right: 2,
      height: 2,
      tags: true,
      content: `{bold}{${palette.gold}-fg}${title}{/${palette.gold}-fg}{/bold}` +
        (subtitle ? `  {${palette.muted}-fg}${subtitle}{/${palette.muted}-fg}` : ""),
      style: { bg: palette.background, fg: palette.text },
    });
  }

  function updateChrome() {
    const selected = state.items.filter((item) => item.armed).length;
    const solver = state.runSetup?.challengeSolver ??
      state.settings.solverEnabled !== false;
    const mode = state.running
      ? state.runSetup?.executionMode || "running"
      : "idle";
    header.setContent(
      `{bold}{${palette.gold}-fg}PokemonDeals{/${palette.gold}-fg}{/bold}` +
      `  {${palette.cyan}-fg}${state.items.length} products{/${palette.cyan}-fg}` +
      `  ${selected} selected  Mode: ${mode}  Solver: ${solver ? "on" : "off"}\n` +
      `{${palette.muted}-fg}${state.notice}{/${palette.muted}-fg}`,
    );
    const base = "arrows/j/k move  Enter open  Space include  a add  e edit  i import  d delete  r run  t stats  s settings";
    const suffix = state.running
      ? "  Ctrl+C stop"
      : "  Esc back  q quit";
    footer.setContent(`${base}\n${suffix}`);
  }

  function renderProducts() {
    clearMain();
    titleBox("PRODUCTS", state.items.length
      ? "Select a product to inspect or modify"
      : "Your purchasing catalog is empty");
    if (state.items.length === 0) {
      blessed.box({
        parent: main,
        top: "center",
        left: "center",
        width: "76%",
        height: 9,
        align: "center",
        valign: "middle",
        tags: true,
        border: { type: "line" },
        content:
          `{bold}{${palette.gold}-fg}No products yet{/${palette.gold}-fg}{/bold}\n\n` +
          "Press {bold}a{/bold} to add one product or {bold}i{/bold} to paste a grouped list.\n" +
          `{${palette.muted}-fg}Only included products are considered when a run starts.{/${palette.muted}-fg}`,
        style: {
          bg: palette.panel,
          fg: palette.text,
          border: { fg: palette.gold },
        },
      });
      return;
    }

    const tableWidth = screen.width - 26;
    const rows = productRows(state.items, { width: tableWidth });
    blessed.text({
      parent: main,
      top: 2,
      left: 2,
      right: 2,
      height: 1,
      content: productTableHeader(tableWidth),
      style: { bg: palette.panelAlt, fg: palette.cyan, bold: true },
    });
    const table = blessed.list({
      parent: main,
      name: "product-table",
      top: 3,
      left: 2,
      right: 2,
      bottom: 12,
      items: rows.map((row) =>
        `{${row.color}-fg}${row.text.replace(/[{}]/g, "")}{/${row.color}-fg}`,
      ),
      keys: false,
      tags: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        track: { bg: palette.panelAlt },
        style: { bg: palette.gold },
      },
      style: {
        bg: palette.background,
        fg: palette.text,
        selected: selectionStyle(state.focus === "content"),
      },
    });
    table.select(state.selectedIndex);
    table.on("select item", (_, index) => {
      state.selectedIndex = index;
      state.selectedProductId = state.items[index]?.id || null;
      render();
    });

    const detail = productDetail(currentItem());
    blessed.box({
      parent: main,
      name: "product-detail",
      left: 2,
      right: 2,
      bottom: 1,
      height: 10,
      tags: false,
      scrollable: true,
      alwaysScroll: true,
      border: { type: "line" },
      label: " Selected detail ",
      padding: { left: 1, right: 1 },
      content: [
        `${detail.name}  |  Group: ${detail.group}`,
        `Raw URL: ${detail.rawUrl}`,
        `Resolved ID: ${detail.resolvedProductId}`,
        `Resolved URL: ${detail.resolvedUrl}`,
        `Status: ${detail.status}`,
        `Last checked: ${detail.lastChecked}  |  Terminal outcome: ${detail.terminalOutcome}`,
      ].join("\n"),
      style: {
        bg: palette.panel,
        fg: palette.text,
        border: { fg: palette.gold },
        label: { fg: palette.gold },
      },
    });
  }

  function renderSettings() {
    clearMain();
    const adapter = adapterForRetailer("target");
    const rows = adapter.settings.rows(state.settings);
    state.settingsIndex = Math.min(
      state.settingsIndex,
      Math.max(0, rows.length - 1),
    );
    titleBox("TARGET SETTINGS", "Enter edits the selected validated setting");
    const list = blessed.list({
      parent: main,
      name: "settings-list",
      top: 3,
      left: 2,
      right: 2,
      bottom: 2,
      tags: false,
      items: rows.map((row) =>
        `${row.label.padEnd(38)} ${row.value.padStart(18)}  ${row.key}`,
      ),
      style: {
        bg: palette.background,
        fg: palette.text,
        selected: selectionStyle(state.focus === "content"),
      },
      scrollbar: { ch: " ", style: { bg: palette.gold } },
    });
    list.select(state.settingsIndex);
  }

  function renderSecrets() {
    clearMain();
    const rows = secretRows(state.secrets, env);
    state.secretsIndex = Math.min(
      state.secretsIndex,
      Math.max(0, rows.length - 1),
    );
    titleBox("LOCAL SECRETS", "Masked by default; Enter set, c clear, v reveal");
    const list = blessed.list({
      parent: main,
      name: "secrets-list",
      top: 3,
      left: 2,
      right: 2,
      height: rows.length + 2,
      tags: false,
      items: rows.map((row) =>
        `${row.key.padEnd(28)} ${row.storedValue.padEnd(12)} environment: ` +
        `${row.environmentOverridePresent ? "present" : "missing"}  ${row.requirement}`,
      ),
      style: {
        bg: palette.background,
        fg: palette.text,
        selected: selectionStyle(state.focus === "content"),
      },
    });
    list.select(state.secretsIndex);
    blessed.box({
      parent: main,
      top: rows.length + 7,
      left: 3,
      right: 3,
      height: 7,
      tags: true,
      border: { type: "line" },
      content:
        `{${palette.orange}-fg}Stored values are plaintext and protected only by your Windows account.{/${palette.orange}-fg}\n\n` +
        "Environment values override stored values for a run. Reveal opens a temporary modal and never changes storage.",
      padding: { left: 1, right: 1 },
      style: {
        bg: palette.panel,
        fg: palette.text,
        border: { fg: palette.orange },
      },
    });
  }

  function renderHelp() {
    clearMain();
    titleBox("KEYBOARD HELP", "Every primary operation is keyboard accessible");
    blessed.box({
      parent: main,
      top: 3,
      left: 3,
      right: 3,
      bottom: 2,
      tags: true,
      scrollable: true,
      content: [
        `{${palette.gold}-fg}Navigation{/${palette.gold}-fg}`,
        "  arrows / j / k   Move selection",
        "  Left / Right     Move between navigation and content",
        "  Enter            Open or confirm selected action",
        "  Esc              Close modal or return to Products",
        "",
        `{${palette.gold}-fg}Products{/${palette.gold}-fg}`,
        "  Space include/exclude   a add   e edit   i import   d delete",
        "  Add only asks for URL and mode; name/group metadata is generated automatically.",
        "  Included products are monitored when a run starts; inclusion alone does not place an order.",
        "",
        `{${palette.gold}-fg}Control plane{/${palette.gold}-fg}`,
        "  r run setup   t live stats   s settings   q quit   Ctrl+C stop active worker",
        "",
        `{${palette.cyan}-fg}Run modes{/${palette.cyan}-fg}`,
        "  Observe: no purchase input.",
        "  Stop before submit: may mutate cart/checkout, but never submits.",
        "  Live purchase: may submit a real order after a typed confirmation.",
      ].join("\n"),
      style: { bg: palette.background, fg: palette.text },
    });
  }

  function renderRunSetup() {
    clearMain();
    const setup = state.runSetup;
    titleBox("RUN SETUP", "Review included products and choose execution behavior");
    const productSummary = setup.products.length
      ? setup.products.map((item) =>
        `${item.mode.padEnd(9)} ${retailerLabel(item.retailer).padEnd(10)} ${item.name}`,
      ).join("\n")
      : "No products are included. Return to Products and press Space.";
    blessed.box({
      parent: main,
      top: 3,
      left: 3,
      right: 3,
      height: Math.min(9, Math.max(4, setup.products.length + 2)),
      label: " Included products ",
      border: { type: "line" },
      padding: { left: 1, right: 1 },
      content: productSummary,
      style: {
        bg: palette.panel,
        fg: setup.products.length ? palette.text : palette.orange,
        border: { fg: palette.gold },
        label: { fg: palette.gold },
      },
    });
    const top = Math.min(13, Math.max(8, setup.products.length + 7));
    const choices = [
      ...executionModeOptions.map((option) =>
        `${setup.executionMode === option.id ? "(*)" : "( )"} ${option.label.padEnd(20)} ${option.detail}`,
      ),
      `[${setup.challengeSolver ? "x" : " "}] Bundled challenge solver`,
      "START RUN",
    ];
    const list = blessed.list({
      parent: main,
      name: "run-setup-list",
      top,
      left: 3,
      right: 3,
      height: choices.length + 2,
      items: choices,
      border: { type: "line" },
      label: " Execution ",
      style: {
        bg: palette.background,
        fg: palette.text,
        border: { fg: palette.cyan },
        label: { fg: palette.cyan },
        selected: selectionStyle(state.focus === "content"),
      },
    });
    list.select(state.runSetupIndex);
  }

  function renderRunView() {
    clearMain();
    const backoffRemaining = formatBackoffRemaining(
      state.runProjection.backoffUntil,
    );
    titleBox("RUN ENGINE", state.running
      ? backoffRemaining
        ? `Verification backoff - next refresh in ${backoffRemaining}`
        : "Worker active - Ctrl+C stops the child safely"
      : automaticRestartTimer
        ? "Worker unavailable - retrying automatically"
        : "Run complete - Esc returns to Products");
    const rows = state.runSetup.products.map((item) => {
      const projected = state.runProjection.statuses[item.id];
      const status = projected?.status || item.lastStatus;
      const outcome = projected
        ? projected.terminalOutcome || "-"
        : item.terminalOutcome || "-";
      const displayStatus = backoffRemaining &&
        /verification backoff/i.test(status || "")
        ? `${status} (${backoffRemaining})`
        : status;
      return `${modeLabel(item.mode).padEnd(10)} ${item.name.padEnd(32)} ` +
        `${truncateText(displayStatus, 35).padEnd(35)} ${outcome}`;
    });
    blessed.list({
      parent: main,
      top: 3,
      left: 2,
      right: 2,
      height: Math.min(10, Math.max(4, rows.length + 2)),
      border: { type: "line" },
      label: " Product status ",
      items: rows,
      style: {
        bg: palette.panel,
        fg: palette.text,
        border: { fg: palette.gold },
        label: { fg: palette.gold },
      },
    });
    const logTop = Math.min(13, Math.max(8, rows.length + 7));
    const log = blessed.log({
      parent: main,
      name: "run-log",
      top: logTop,
      left: 2,
      right: 2,
      bottom: 1,
      border: { type: "line" },
      label: " Event log ",
      tags: false,
      content: state.runProjection.logs.join("\n"),
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", style: { bg: palette.cyan } },
      style: {
        bg: palette.background,
        fg: palette.text,
        border: { fg: palette.cyan },
        label: { fg: palette.cyan },
      },
    });
    log.setScrollPerc(100);
  }

  function renderRunStats() {
    clearMain();
    const projection = state.runProjection;
    const products = state.runSetup?.products || [];
    const terminalProducts = products.filter((item) => {
      const projected = projection.statuses[item.id];
      return projected
        ? Boolean(projected.terminalOutcome)
        : Boolean(item.terminalOutcome);
    }).length;
    const outcome = projection.outcome;
    const runStatus = state.running
      ? "LIVE"
      : outcome === "failed"
        ? "FAILED"
        : outcome === "stopped"
          ? "STOPPED"
          : outcome === "completed"
            ? "COMPLETE"
            : "IDLE";
    const statusColorValue = state.running
      ? palette.cyan
      : outcome === "failed"
        ? palette.red
        : outcome === "stopped"
          ? palette.orange
          : outcome === "completed"
            ? palette.green
            : palette.muted;
    titleBox(
      "RUN STATS",
      state.running
        ? formatBackoffRemaining(projection.backoffUntil)
          ? `Verification backoff - next refresh in ${formatBackoffRemaining(projection.backoffUntil)}`
          : "Live projection from structured worker events"
        : "Latest run summary; press t while a worker is active to follow it",
    );

    const contentWidth = Math.max(50, screen.width - 26);
    const cardGap = 1;
    const cardWidth = Math.max(
      12,
      Math.floor((contentWidth - cardGap * 3) / 4),
    );
    const cards = [
      {
        label: "STATUS",
        value: runStatus,
        detail: state.runSetup?.executionMode || "No run configured",
        color: statusColorValue,
      },
      {
        label: "ELAPSED",
        value: formatRunElapsed(
          projection.startedAt,
          projection.endedAt,
          Date.now(),
        ),
        detail: projection.lastEventAt
          ? `last ${runEventTime(projection.lastEventAt)}`
          : "waiting for worker",
        color: palette.cyan,
      },
      {
        label: "PRODUCTS",
        value: `${terminalProducts}/${products.length}`,
        detail: "terminal outcomes",
        color: palette.gold,
      },
      {
        label: "EVENTS",
        value: String(projection.eventCount),
        detail: `${projection.pollCount} polls`,
        color: palette.green,
      },
    ];
    cards.forEach((card, index) => {
      const left = 2 + index * (cardWidth + cardGap);
      const box = blessed.box({
        parent: main,
        top: 2,
        left,
        width: cardWidth,
        height: 4,
        border: { type: "line" },
        label: ` ${card.label} `,
        content: `${card.value}\n${card.detail}`,
        padding: { left: 1, right: 1 },
        style: {
          bg: palette.panel,
          fg: card.color,
          border: { fg: card.color },
          label: { fg: card.color },
          bold: true,
        },
      });
      box.name = `run-stat-card-${card.label.toLowerCase()}`;
    });

    const mainHeight = Math.max(1, screen.height - 6);
    const feedTop = Math.max(15, mainHeight - 7);
    const activityWidth = Math.max(28, Math.floor((contentWidth - 1) * 0.62));
    const eventWidth = Math.max(20, contentWidth - activityWidth - 1);
    const panelTop = 8;
    const panelBottom = feedTop - 1;
    const activityRows = products.map((item) => {
      const stats = projection.productStats[item.id] || {};
      const projected = projection.statuses[item.id];
      const status = projected?.status || item.lastStatus || "Waiting";
      const nameWidth = Math.max(10, Math.floor(activityWidth * 0.32));
      const statusWidth = Math.max(
        12,
        activityWidth - nameWidth - 16,
      );
      return `${truncateText(item.name, nameWidth).padEnd(nameWidth)} ` +
        `${truncateText(status, statusWidth).padEnd(statusWidth)} ` +
        `${String(stats.polls || 0).padStart(2)}p ` +
        `${String(stats.errors || 0).padStart(2)}e`;
    });
    blessed.list({
      parent: main,
      name: "run-stats-activity",
      top: panelTop,
      left: 2,
      width: activityWidth,
      bottom: 7,
      border: { type: "line" },
      label: " Product activity ",
      items: activityRows.length ? activityRows : ["No products in the current run."],
      tags: false,
      style: {
        bg: palette.panel,
        fg: palette.text,
        border: { fg: palette.gold },
        label: { fg: palette.gold },
        selected: { bg: palette.panel, fg: palette.text },
      },
      scrollbar: { ch: " ", style: { bg: palette.gold } },
    });

    const workerStates = Object.values(projection.workers || {})
      .map((worker) => `${worker.retailer}: ${worker.status}`)
      .join(", ") || "not started";
    const eventSummary = [
      `Polls          ${projection.pollCount}`,
      `Available      ${projection.availableCount}`,
      `Unavailable    ${projection.unavailableCount}`,
      `Actions        ${projection.actionCount}`,
      `Verification   ${projection.verificationCount}`,
      `Alerts         ${projection.errorCount}`,
      `Terminal       ${projection.terminalCount}`,
      "",
      `Workers: ${workerStates}`,
    ].join("\n");
    blessed.box({
      parent: main,
      name: "run-stats-events",
      top: panelTop,
      left: 2 + activityWidth + 1,
      width: eventWidth,
      bottom: 7,
      border: { type: "line" },
      label: " Event breakdown ",
      content: eventSummary,
      padding: { left: 1, right: 1 },
      tags: false,
      style: {
        bg: palette.panel,
        fg: palette.text,
        border: { fg: palette.cyan },
        label: { fg: palette.cyan },
      },
    });

    const feedWidth = Math.max(20, contentWidth - 2);
    const feedLines = projection.recentEvents
      .slice(-Math.max(2, feedTop - 10))
      .map((event) => {
        const marker = event.important ? "!" : ">";
        const retailer = String(event.retailer || "worker").toUpperCase();
        return `${runEventTime(event.at)} ${marker} ${retailer.padEnd(8)} ` +
          truncateText(event.status, feedWidth - 19);
      });
    const feed = blessed.log({
      parent: main,
      name: "run-stats-feed",
      top: feedTop,
      left: 2,
      right: 2,
      bottom: 1,
      border: { type: "line" },
      label: " Live event feed ",
      content: feedLines.join("\n") || "Waiting for structured worker events...",
      tags: false,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", style: { bg: palette.cyan } },
      style: {
        bg: palette.background,
        fg: palette.text,
        border: { fg: palette.cyan },
        label: { fg: palette.cyan },
      },
    });
    feed.setScrollPerc(100);
  }

  function render() {
    const size = terminalSizeState(screen.width, screen.height);
    smallTerminal.hidden = !size.tooSmall;
    header.hidden = size.tooSmall;
    navigation.hidden = size.tooSmall;
    main.hidden = size.tooSmall;
    footer.hidden = size.tooSmall;
    if (size.tooSmall) {
      smallTerminal.setContent(`${size.message}\n\nResize the Windows Terminal window to continue.`);
      smallTerminal.setFront();
      screen.render();
      return;
    }

    if (state.view === "products") {
      renderProducts();
    } else if (state.view === "settings") {
      renderSettings();
    } else if (state.view === "secrets") {
      renderSecrets();
    } else if (state.view === "help") {
      renderHelp();
    } else if (state.view === "run-setup") {
      renderRunSetup();
    } else if (state.view === "run") {
      renderRunView();
    } else if (state.view === "run-stats") {
      renderRunStats();
    }
    Object.assign(
      navigation.style.selected,
      selectionStyle(state.focus === "navigation"),
    );
    const navigationView = state.view === "run" ? "run-setup" : state.view;
    const navIndex = navigationItems.findIndex((item) => item.id === navigationView);
    if (navIndex >= 0 && renderedView !== state.view) {
      navigation.select(navIndex);
    }
    renderedView = state.view;
    updateChrome();
    if (state.modal) {
      state.modal.setFront();
    }
    screen.render();
  }

  async function refreshData() {
    const [items, settings, secrets] = await Promise.all([
      store.list(),
      store.getSettings("target"),
      secretStore.getAll(),
    ]);
    state.items = items;
    state.settings = settings;
    state.secrets = secrets;
    retainSelection();
    if (!state.running) {
      state.runSetup = runSetupDefaults(items, settings);
    }
  }

  function isActiveModal(modal) {
    return state.modal === modal && !modal.destroyed;
  }

  function closeModal(modal = state.modal) {
    if (!modal || !isActiveModal(modal) || modal.submissionPending) {
      return false;
    }
    modal.destroy();
    state.modal = null;
    screen.restoreFocus();
    render();
    return true;
  }

  function focusModalOffset(modal, offset, currentElement = modal.screen.focused) {
    modal._refresh?.();
    const focusable = (modal._children || []).filter(
      (child) => !child.detached && child.visible,
    );
    if (focusable.length === 0) {
      modal.focus();
      return;
    }
    const current = focusable.indexOf(currentElement);
    const start = current >= 0 ? current : offset > 0 ? -1 : 0;
    const next = focusable[
      (start + offset + focusable.length) % focusable.length
    ];
    modal._selected = next;
    next.focus();
  }

  function bindModalAction(modal, keys, handler) {
    for (const key of keys) {
      modal.modalActions.set(key.toLowerCase(), handler);
    }
  }

  function dispatchModalAction(modal, element, key) {
    if (
      key?.dealsModalHandled ||
      !isActiveModal(modal) ||
      modal.submissionPending
    ) {
      return false;
    }
    const action = modal.modalActions.get(normalizeKeyName(key));
    if (!action) {
      return false;
    }
    key.dealsModalHandled = true;
    action(element, key);
    return true;
  }

  function bindFocusedModalActions(modal, widget, keys) {
    widget.key(keys, (_, key) => {
      dispatchModalAction(modal, widget, key);
    });
  }

  async function submitModal(
    modal,
    errorWidget,
    operation,
    onSuccess,
    afterRefresh = null,
  ) {
    if (!isActiveModal(modal) || modal.submissionPending) {
      return false;
    }
    modal.submissionPending = true;
    try {
      const result = await operation();
      if (!isActiveModal(modal)) {
        return false;
      }
      onSuccess(result);
      modal.submissionPending = false;
      closeModal(modal);
      let refreshSucceeded = true;
      try {
        await refreshData();
        render();
      } catch (refreshError) {
        refreshSucceeded = false;
        state.notice = `Catalog refresh failed: ${refreshError.message}`;
        render();
      }
      if (refreshSucceeded && typeof afterRefresh === "function") {
        try {
          await afterRefresh(result);
        } catch (followUpError) {
          state.notice = `Automatic run failed: ${followUpError.message}`;
          render();
        }
      }
      return true;
    } catch (submissionError) {
      if (!isActiveModal(modal)) {
        return false;
      }
      modal.submissionPending = false;
      if (!errorWidget.destroyed) {
        errorWidget.setContent(submissionError.message);
        screen.render();
      }
      return false;
    }
  }

  function modalBox(title, { width = 72, height = 18 } = {}) {
    if (state.modal) {
      state.modal.destroy();
    }
    const modal = blessed.form({
      parent: screen,
      name: "modal",
      top: "center",
      left: "center",
      width,
      height,
      keys: true,
      tags: true,
      border: { type: "line" },
      label: ` ${title} `,
      padding: { left: 2, right: 2 },
      style: {
        bg: palette.panel,
        fg: palette.text,
        border: { fg: palette.gold },
        label: { fg: palette.gold, bold: true },
      },
    });
    modal.modalActions = new Map();
    modal.submissionPending = false;
    modal.removeAllListeners("element keypress");
    modal.on("element keypress", (element, _, key) => {
      if (key?.name === "tab") {
        if (element.type === "textbox" || element.type === "textarea") {
          if (!key.shift) {
            element.emit("keypress", null, { name: "backspace" });
          }
          element.cancel?.();
          if (element._reading) {
            element.emit("blur", modal);
          }
        }
        focusModalOffset(modal, key.shift ? -1 : 1, element);
        key.dealsModalHandled = true;
        return;
      }
      dispatchModalAction(modal, element, key);
    });
    state.modal = modal;
    bindModalAction(modal, ["escape"], () => closeModal(modal));
    return modal;
  }

  function modalError(modal, top) {
    return blessed.text({
      parent: modal,
      name: "modal-error",
      ...(Number.isInteger(top) ? { top } : { bottom: 2 }),
      left: 1,
      right: 1,
      height: 2,
      tags: false,
      style: { bg: palette.panel, fg: palette.red, bold: true },
    });
  }

  function formInput(parent, label, top, value = "", { secret = false } = {}) {
    blessed.text({
      parent,
      top,
      left: 1,
      width: 16,
      height: 1,
      content: label,
      style: { bg: palette.panel, fg: palette.cyan },
    });
    return blessed.textbox({
      parent,
      top,
      left: 18,
      right: 1,
      height: 3,
      value,
      censor: secret,
      keys: true,
      inputOnFocus: true,
      border: { type: "line" },
      style: {
        bg: palette.background,
        fg: palette.text,
        border: { fg: palette.muted },
        focus: { border: { fg: palette.cyan } },
      },
    });
  }

  function openProductForm(item = null) {
    const modal = modalBox(item ? "Edit product" : "Add product", {
      width: 78,
      height: item ? 24 : 20,
    });
    const name = item
      ? formInput(modal, "Name override", 1, item.name || "")
      : null;
    const group = item
      ? formInput(modal, "Group override", 4, item.group || "")
      : null;
    const url = formInput(modal, "URL", item ? 7 : 1, item?.url || "");
    blessed.text({
      parent: modal,
      top: item ? 11 : 5,
      left: 1,
      width: 16,
      content: "Mode",
      style: { bg: palette.panel, fg: palette.cyan },
    });
    const modes = blessed.list({
      parent: modal,
      top: item ? 10 : 4,
      left: 18,
      width: 35,
      height: 5,
      items: ["Buy Now", "Preorder", "Buy"],
      keys: true,
      border: { type: "line" },
      style: {
        bg: palette.background,
        fg: palette.text,
        border: { fg: palette.muted },
        selected: { bg: palette.gold, fg: palette.background },
        focus: { border: { fg: palette.cyan } },
      },
    });
    const modeIds = ["buy-now", "preorder", "buy"];
    modes.select(Math.max(0, modeIds.indexOf(item?.mode || "buy")));
    if (item) {
      const included = blessed.checkbox({
        parent: modal,
        top: 15,
        left: 18,
        width: 40,
        height: 1,
        text: "Include in next run",
        checked: Boolean(item.armed),
        keys: true,
        style: { bg: palette.panel, fg: palette.text, focus: { fg: palette.gold } },
      });
      blessed.text({
        parent: modal,
        top: 16,
        left: 18,
        right: 1,
        content: "Name and group are optional overrides.",
        style: { bg: palette.panel, fg: palette.muted },
      });
      modal.inclusionControl = included;
    } else {
      blessed.text({
        parent: modal,
        top: 10,
        left: 18,
        right: 1,
        content: "Name and group are generated from the URL.",
        style: { bg: palette.panel, fg: palette.muted },
      });
      blessed.text({
        parent: modal,
        top: 11,
        left: 18,
        right: 1,
        content: "This product will be included automatically.\n" +
          "The configured run starts after saving.",
        style: { bg: palette.panel, fg: palette.muted },
      });
    }
    const error = modalError(modal, item ? 19 : 13);
    blessed.text({
      parent: modal,
      bottom: 0,
      left: 1,
      right: 1,
      content: item
        ? "Tab move  Space toggle  Enter/Ctrl+S save  Esc cancel"
        : "Tab move  Enter/Ctrl+S save + start  Esc cancel",
      style: { bg: palette.panel, fg: palette.muted },
    });
    const saveProduct = () => {
      const input = {
        name: name?.getValue() || "",
        group: group?.getValue() || "",
        url: url.getValue(),
        mode: modeIds[modes.selected],
        armed: item ? modal.inclusionControl.checked : true,
      };
      return submitModal(
        modal,
        error,
        () => item ? store.update(item.id, input) : store.add(input),
        (saved) => {
          state.selectedProductId = saved.id;
          state.notice = `${item ? "Updated" : "Added"} ${saved.name}.`;
          state.view = "products";
        },
        item ? null : async () => {
          await startConfiguredRun({ automatic: true });
        },
      );
    };
    bindModalAction(modal, ["enter", "C-s"], saveProduct);
    (item ? name : url).focus();
    screen.render();
  }

  function openDeleteModal(item) {
    const modal = modalBox("Delete product", { width: 62, height: 11 });
    blessed.text({
      parent: modal,
      top: 1,
      left: 1,
      right: 1,
      height: 4,
      content: `Delete "${item.name}"?\n\nThis removes the catalog entry and cannot be undone.`,
      style: { bg: palette.panel, fg: palette.text },
    });
    const error = modalError(modal, 6);
    bindModalAction(modal, ["enter"], () =>
      submitModal(
        modal,
        error,
        () => store.remove(item.id),
        () => {
          state.notice = `Deleted ${item.name}.`;
        },
      ));
    blessed.text({
      parent: modal,
      bottom: 0,
      left: 1,
      content: "Enter delete  Esc cancel",
      style: { bg: palette.panel, fg: palette.red, bold: true },
    });
    modal.focus();
    screen.render();
  }

  function openImportModal() {
    const controller = createImportController(store);

    function renderPaste() {
      const modal = modalBox("Import grouped list", { width: "84%", height: "82%" });
      blessed.text({
        parent: modal,
        top: 0,
        left: 1,
        right: 1,
        height: 2,
        content: 'Optional headings organize products; paste products as "Name: URL".',
        style: { bg: palette.panel, fg: palette.cyan },
      });
      const textarea = blessed.textarea({
        parent: modal,
        top: 2,
        left: 1,
        right: 1,
        bottom: 5,
        value: controller.state.text,
        keys: true,
        inputOnFocus: true,
        scrollable: true,
        border: { type: "line" },
        style: {
          bg: palette.background,
          fg: palette.text,
          border: { fg: palette.cyan },
          focus: { border: { fg: palette.gold } },
        },
      });
      const error = modalError(modal, "100%-5");
      blessed.text({
        parent: modal,
        bottom: 0,
        left: 1,
        right: 1,
        content: "F2 preview  Esc cancel",
        style: { bg: palette.panel, fg: palette.muted },
      });
      bindModalAction(modal, ["f2"], () => {
        if (controller.preview(textarea.getValue())) {
          renderPreview();
        } else {
          error.setContent(controller.state.error);
          screen.render();
        }
      });
      bindFocusedModalActions(modal, textarea, ["f2", "escape"]);
      textarea.focus();
      screen.render();
    }

    function renderPreview() {
      const modal = modalBox("Confirm import", { width: "84%", height: "82%" });
      const parsed = controller.state.parsed;
      blessed.box({
        parent: modal,
        top: 1,
        left: 1,
        right: 1,
        height: "50%",
        scrollable: true,
        alwaysScroll: true,
        border: { type: "line" },
        label: ` Preview: ${parsed.items.length} products `,
        content: parsed.items.map((item) =>
          `${item.group ? `[${item.group}] ` : ""}` +
          `${item.name || "Name from URL"}\n  ${item.url}`,
        ).join("\n"),
        style: {
          bg: palette.background,
          fg: palette.text,
          border: { fg: palette.cyan },
          label: { fg: palette.cyan },
        },
      });
      const modes = blessed.list({
        parent: modal,
        top: "54%",
        left: 1,
        width: 34,
        height: 5,
        keys: true,
        border: { type: "line" },
        label: " Required mode ",
        items: ["Buy Now", "Preorder", "Buy"],
        style: {
          bg: palette.background,
          fg: palette.text,
          border: { fg: palette.gold },
          label: { fg: palette.gold },
          selected: { bg: palette.gold, fg: palette.background },
        },
      });
      const modeIds = ["buy-now", "preorder", "buy"];
      const selectedMode = controller.state.mode || "buy-now";
      modes.select(Math.max(0, modeIds.indexOf(selectedMode)));
      controller.selectMode(selectedMode);
      blessed.text({
      parent: modal,
      top: "56%",
      left: 39,
      right: 1,
      content: "Products will be included automatically.",
      style: { bg: palette.panel, fg: palette.muted },
      });
      const error = modalError(modal, "100%-5");
      blessed.text({
        parent: modal,
        bottom: 0,
        left: 1,
        right: 1,
        content: "arrows select mode  Enter import  F2 edit paste  Esc cancel",
        style: { bg: palette.panel, fg: palette.muted },
      });
      modes.on("select item", (_, index) => {
        controller.selectMode(modeIds[index]);
      });
      bindModalAction(modal, ["1", "2", "3"], (_, key) => {
        const index = Number.parseInt(key.full, 10) - 1;
        modes.select(index);
        controller.selectMode(modeIds[index]);
        screen.render();
      });
      bindModalAction(modal, ["f2"], renderPaste);
      bindModalAction(modal, ["enter"], () => {
        return submitModal(
          modal,
          error,
          () => controller.confirm(),
          (added) => {
            state.selectedProductId = added[0]?.id || null;
            state.notice = `Imported ${added.length} product(s).`;
            state.view = "products";
          },
        );
      });
      bindFocusedModalActions(
        modal,
        modes,
        ["1", "2", "3", "f2", "enter", "escape"],
      );
      modes.focus();
      screen.render();
    }

    renderPaste();
  }

  function openSettingModal() {
    const adapter = adapterForRetailer("target");
    const rows = adapter.settings.rows(state.settings);
    const row = rows[state.settingsIndex];
    if (!row) {
      return;
    }
    const property = row.key.slice("target.".length);
    const options = adapter.settings.options?.(property) || [];
    const modal = modalBox(`Edit ${row.label}`, {
      width: options.length > 0 ? "94%" : 70,
      height: options.length > 0
        ? Math.max(12, options.length + 9)
        : 12,
    });
    const error = modalError(
      modal,
      options.length > 0 ? options.length + 4 : 6,
    );
    let choiceList;
    let inputBox;
    if (options.length > 0) {
      blessed.text({
        parent: modal,
        top: 0,
        left: 1,
        right: 1,
        content: "Choose a value. Each option explains what it changes.",
        style: { bg: palette.panel, fg: palette.cyan },
      });
      choiceList = blessed.list({
        parent: modal,
        top: 2,
        left: 1,
        right: 1,
        height: options.length + 2,
        keys: true,
        border: { type: "line" },
        label: " Options ",
        items: options.map((option) =>
          `${option.label.padEnd(24)} ${option.description}`,
        ),
        style: {
          bg: palette.background,
          fg: palette.text,
          border: { fg: palette.gold },
          label: { fg: palette.gold },
          selected: { bg: palette.gold, fg: palette.background },
          focus: { border: { fg: palette.cyan } },
        },
      });
      const selected = options.findIndex((option) =>
        String(option.value === null ? "unset" : option.value) === row.value,
      );
      choiceList.select(selected >= 0 ? selected : 0);
    } else {
      inputBox = formInput(
        modal,
        "Value",
        2,
        row.value === "unset" ? "" : row.value,
      );
    }
    blessed.text({
      parent: modal,
      bottom: 0,
      left: 1,
      content: options.length > 0
        ? `${row.key}  |  arrows choose  Enter save  Esc cancel`
        : `${row.key}  |  Enter save  Esc cancel`,
      style: { bg: palette.panel, fg: palette.muted },
    });
    bindModalAction(modal, ["enter"], () =>
      submitModal(
        modal,
        error,
        () => store.setSetting(
          "target",
          property,
          options.length > 0
            ? options[choiceList.selected]?.value
            : inputBox.getValue(),
        ),
        () => {
          state.notice = `Updated ${row.key}.`;
        },
      ));
    if (choiceList) {
      bindFocusedModalActions(modal, choiceList, ["enter", "escape"]);
      choiceList.focus();
    } else {
      inputBox.focus();
    }
    screen.render();
  }

  function selectedSecretRow(reveal = false) {
    return secretRows(state.secrets, env, { reveal })[state.secretsIndex] || null;
  }

  function openSecretSetModal() {
    const row = selectedSecretRow();
    if (!row) {
      return;
    }
    const modal = modalBox(`Set ${row.key}`, { width: 72, height: 12 });
    const inputBox = formInput(modal, "Secret", 2, "", { secret: true });
    const error = modalError(modal, 6);
    blessed.text({
      parent: modal,
      bottom: 0,
      left: 1,
      content: "Enter store  Esc cancel  Value remains masked",
      style: { bg: palette.panel, fg: palette.muted },
    });
    bindModalAction(modal, ["enter"], () =>
      submitModal(
        modal,
        error,
        () => secretStore.set(row.key, inputBox.getValue()),
        () => {
          state.notice = `Stored ${row.key}.`;
        },
      ));
    inputBox.focus();
    screen.render();
  }

  function openSecretClearModal() {
    const row = selectedSecretRow();
    if (!row) {
      return;
    }
    const modal = modalBox(`Clear ${row.key}`, { width: 62, height: 10 });
    blessed.text({
      parent: modal,
      top: 1,
      left: 1,
      right: 1,
      content: `Remove the stored ${row.key} value?\nEnvironment overrides are not changed.`,
      style: { bg: palette.panel, fg: palette.text },
    });
    const error = modalError(modal, 5);
    bindModalAction(modal, ["enter"], () =>
      submitModal(
        modal,
        error,
        () => secretStore.clear(row.key),
        () => {
          state.notice = `Cleared ${row.key}.`;
        },
      ));
    blessed.text({
      parent: modal,
      bottom: 0,
      left: 1,
      content: "Enter clear  Esc cancel",
      style: { bg: palette.panel, fg: palette.red },
    });
    modal.focus();
    screen.render();
  }

  function openSecretRevealModal() {
    const row = selectedSecretRow(true);
    if (!row) {
      return;
    }
    const modal = modalBox(`Reveal ${row.key}`, { width: "80%", height: 12 });
    blessed.box({
      parent: modal,
      top: 1,
      left: 1,
      right: 1,
      height: 6,
      scrollable: true,
      border: { type: "line" },
      content: row.storedValue,
      style: {
        bg: palette.background,
        fg: palette.orange,
        border: { fg: palette.orange },
      },
    });
    blessed.text({
      parent: modal,
      bottom: 0,
      left: 1,
      content: "Explicit reveal only - Esc closes and remasks",
      style: { bg: palette.panel, fg: palette.muted },
    });
    modal.focus();
    screen.render();
  }

  function liveRunSummary() {
    const settings = state.settings;
    return [
      "LIVE PURCHASE CAN SUBMIT REAL ORDERS.",
      "",
      ...state.runSetup.products.map((item) =>
        `${modeLabel(item.mode)} | ${retailerLabel(item.retailer)} | ${item.name}`,
      ),
      "",
      `Maximum item price: ${settings.maxItemPrice || "unlimited"}`,
      `Maximum order total: ${settings.maxOrderTotal || "unlimited"}`,
      `Expected fulfillment: ${settings.expectedFulfillment || "any detected"}`,
      `Challenge solver: ${state.runSetup.challengeSolver ? "enabled" : "disabled"}`,
    ].join("\n");
  }

  function openLiveConfirmation() {
    const modal = modalBox("CONFIRM LIVE PURCHASE", { width: "84%", height: 22 });
    blessed.box({
      parent: modal,
      top: 1,
      left: 1,
      right: 1,
      height: 12,
      scrollable: true,
      border: { type: "line" },
      content: liveRunSummary(),
      style: {
        bg: palette.background,
        fg: palette.red,
        border: { fg: palette.red },
        bold: true,
      },
    });
    const confirmation = formInput(modal, "Type LIVE", 14, "");
    const error = modalError(modal, 18);
    bindModalAction(modal, ["enter"], async () => {
      if (confirmation.getValue().trim() !== "LIVE") {
        error.setContent('Type exactly "LIVE" to start, or Esc to cancel.');
        screen.render();
        return;
      }
      closeModal(modal);
      await beginRun();
    });
    confirmation.focus();
    screen.render();
  }

  function appendRunLog(line) {
    state.runProjection.logs = appendProjectedLog(
      state.runProjection.logs,
      line,
    );
    if (state.view === "run" || state.view === "run-stats") {
      render();
    }
  }

  async function beginRun() {
    if (state.runSetup.products.length === 0) {
      state.notice = "No products are included.";
      render();
      return;
    }
    state.running = true;
    state.view = "run";
    state.runProjection = createRunProjection();
    state.runProjection.startedAt = new Date().toISOString();
    state.notice = `Running ${state.runSetup.executionMode}.`;
    render();
    const outputSink = createChunkLogSink(appendRunLog);
    const errorSink = createChunkLogSink(appendRunLog, "ERROR: ");
    let runResult = { code: 1, signal: null, interrupted: false };
    let retryableFailure = false;
    try {
      runResult = await runEngine(
        store,
        state.runSetup.executionMode,
        {
          adapterOptions: {
            target: {
              challengeSolver: state.runSetup.challengeSolver,
            },
          },
          secretStore,
          ensureCdp: true,
          output: outputSink,
          errorOutput: errorSink,
          onRunEvent(notification) {
            state.runProjection = projectRunEvent(
              state.runProjection,
              notification,
            );
            render();
          },
          onLifecycle(event) {
            state.runProjection = projectRunLifecycle(
              state.runProjection,
              event,
            );
            appendRunLog(
              `${event.retailer || "engine"}: ${event.type}` +
              (event.mode ? ` (${event.mode})` : ""),
            );
          },
        },
      );
      outputSink.flush();
      errorSink.flush();
      state.notice = runResult.interrupted
        ? "Run stopped by operator."
        : runResult.code === 0
          ? "Run completed."
          : `Run failed with exit code ${runResult.code}.`;
    } catch (error) {
      retryableFailure = Boolean(error.retryable);
      appendRunLog(`CONTROL PLANE ERROR: ${safeLogLine(error.message)}`);
      state.notice = `Run failed: ${error.message}`;
    } finally {
      state.running = false;
      state.runProjection = {
        ...state.runProjection,
        endedAt: state.runProjection.endedAt || new Date().toISOString(),
        outcome: runResult.interrupted
          ? "stopped"
          : runResult.code === 0
            ? "completed"
            : "failed",
      };
      await refreshData();
      state.view = state.view === "run-stats" ? "run-stats" : "run";
      render();
      if (
        retryableFailure &&
        !runResult.interrupted &&
        !hasTerminalRunOutcome()
      ) {
        scheduleAutomaticRestart();
      }
    }
  }

  async function activateRunSetup() {
    const index = state.runSetupIndex;
    if (index < executionModeOptions.length) {
      state.runSetup.executionMode = executionModeOptions[index].id;
      render();
      return;
    }
    if (index === executionModeOptions.length) {
      state.runSetup.challengeSolver = !state.runSetup.challengeSolver;
      render();
      return;
    }
    await startConfiguredRun();
  }

  async function startConfiguredRun({ automatic = false } = {}) {
    if (automatic && !state.autoRunEnabled) {
      return;
    }
    clearAutomaticRestart();
    if (!automatic) {
      state.autoRunEnabled = true;
    }
    if (!state.runSetup || state.runSetup.products.length === 0) {
      state.notice = "No products are included.";
      render();
      return;
    }
    if (state.runSetup.executionMode === "live-purchase") {
      if (automatic) {
        await beginRun();
      } else {
        openLiveConfirmation();
      }
    } else {
      await beginRun();
    }
  }

  async function openView(id) {
    if (id === "add") {
      openProductForm();
      return;
    }
    if (id === "import") {
      openImportModal();
      return;
    }
    if (id === "run-setup") {
      await refreshData();
      state.view = "run-setup";
      state.runSetupIndex = 0;
    } else {
      state.view = id;
    }
    render();
  }

  function moveSelection(delta) {
    if (state.focus === "navigation") {
      const selected = Math.max(
        0,
        Math.min(navigationItems.length - 1, navigation.selected + delta),
      );
      navigation.select(selected);
      screen.render();
      return;
    }
    if (state.view === "products" && state.items.length > 0) {
      state.selectedIndex = Math.max(
        0,
        Math.min(state.items.length - 1, state.selectedIndex + delta),
      );
      state.selectedProductId = currentItem()?.id || null;
    } else if (state.view === "settings") {
      const count = adapterForRetailer("target").settings.rows(state.settings).length;
      state.settingsIndex = Math.max(
        0,
        Math.min(count - 1, state.settingsIndex + delta),
      );
    } else if (state.view === "secrets") {
      const count = secretRows(state.secrets, env).length;
      state.secretsIndex = Math.max(
        0,
        Math.min(count - 1, state.secretsIndex + delta),
      );
    } else if (state.view === "run-setup") {
      state.runSetupIndex = Math.max(
        0,
        Math.min(executionModeOptions.length + 1, state.runSetupIndex + delta),
      );
    }
    render();
  }

  async function activateSelection() {
    if (state.focus === "navigation") {
      await openView(navigationItems[navigation.selected].id);
      state.focus = "content";
      render();
      return;
    }
    if (state.view === "products" && currentItem()) {
      openProductForm(currentItem());
    } else if (state.view === "settings") {
      openSettingModal();
    } else if (state.view === "secrets") {
      openSecretSetModal();
    } else if (state.view === "run-setup") {
      await activateRunSetup();
    }
  }

  function destroy() {
    if (state.closed) {
      return;
    }
    state.closed = true;
    clearAutomaticRestart();
    if (runStatsTimer) {
      clearInterval(runStatsTimer);
      runStatsTimer = null;
    }
    screen.destroy();
    closeResolve();
  }

  async function handleAction(action) {
    if (state.modal) {
      return;
    }
    if (action === "stop-run" && !state.running) {
      state.autoRunEnabled = false;
      clearAutomaticRestart();
      state.notice = "Automatic runs stopped. Press r to start again.";
      render();
      return;
    }
    if (state.running) {
      if (action === "stop-run") {
        state.autoRunEnabled = false;
        clearAutomaticRestart();
        process.emit("SIGINT");
      } else if (action === "run-stats") {
        state.view = "run-stats";
        render();
      } else if (action === "back" && state.view === "run-stats") {
        state.view = "run";
        render();
      } else if (action === "quit" || action === "back" || action === "run") {
        state.notice = "A worker is active. Press Ctrl+C to stop it safely.";
        render();
      }
      return;
    }
    if (action === "previous" || action === "next") {
      moveSelection(action === "previous" ? -1 : 1);
    } else if (action === "activate") {
      await activateSelection();
    } else if (action === "focus-navigation") {
      state.focus = "navigation";
      state.notice = "Navigation focused. Press Enter to open.";
      render();
    } else if (action === "focus-content") {
      state.focus = "content";
      state.notice = "Content focused.";
      render();
    } else if (action === "toggle-focus") {
      state.focus = state.focus === "navigation" ? "content" : "navigation";
      render();
    } else if (action === "toggle-armed" && state.view === "products" && currentItem()) {
      try {
        const item = currentItem();
        await store.setArmed([item.id], !item.armed);
        state.notice = `${item.name} is now ${item.armed ? "excluded" : "included"}.`;
        await refreshData();
      } catch (error) {
        state.notice = `Cannot change run inclusion: ${error.message}`;
      }
      render();
    } else if (action === "add") {
      openProductForm();
    } else if (action === "edit" && currentItem()) {
      openProductForm(currentItem());
    } else if (action === "import") {
      openImportModal();
    } else if (action === "delete" && state.view === "products" && currentItem()) {
      openDeleteModal(currentItem());
    } else if (action === "run") {
      await openView("run-setup");
    } else if (action === "run-stats") {
      await openView("run-stats");
    } else if (action === "settings") {
      await openView("settings");
    } else if (action === "clear-secret" && state.view === "secrets") {
      openSecretClearModal();
    } else if (action === "reveal-secret" && state.view === "secrets") {
      openSecretRevealModal();
    } else if (action === "back") {
      if (state.view !== "products") {
        state.view = "products";
        render();
      }
    } else if (action === "quit") {
      destroy();
    }
  }

  screen.on("keypress", (_, key) => {
    const action = actionForKey(key);
    if (action) {
      handleAction(action).catch((error) => {
        state.notice = `Error: ${error.message}`;
        render();
      });
    }
  });
  screen.on("resize", render);

  const ready = refreshData()
    .then(() => {
      runStatsTimer = setInterval(() => {
        const backoffVisible = Boolean(
          formatBackoffRemaining(state.runProjection.backoffUntil),
        );
        if (
          !state.closed &&
          state.running &&
          (backoffVisible || backoffWasVisible) &&
          (state.view === "run" || state.view === "run-stats")
        ) {
          if (!backoffVisible) {
            state.runProjection.backoffUntil = null;
          }
          render();
        }
        backoffWasVisible = backoffVisible;
      }, 1000);
      render();
      if (autoStart && state.runSetup.products.length > 0) {
        startConfiguredRun({ automatic: true }).catch((error) => {
          state.notice = `Automatic run failed: ${error.message}`;
          render();
        });
      }
      return state;
    })
    .catch((error) => {
      destroy();
      throw error;
    });

  return {
    screen,
    state,
    ready,
    closed,
    destroy,
    handleAction,
    refresh: async () => {
      await refreshData();
      render();
    },
  };
}

async function launchDealsTui(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "The full-screen PokemonDeals UI requires an interactive terminal. Use a direct subcommand for redirected input or output.",
    );
  }
  const tui = createDealsTui({ ...options, input, output });
  await tui.ready;
  await tui.closed;
}

module.exports = {
  actionForKey,
  appendProjectedLog,
  createChunkLogSink,
  createDealsTui,
  createImportController,
  createRunProjection,
  executionModeOptions,
  formatRunElapsed,
  launchDealsTui,
  minimumTerminalSize,
  navigationItems,
  palette,
  productDetail,
  productTableHeader,
  productRows,
  projectRunLifecycle,
  projectRunEvent,
  runSetupDefaults,
  safeLogLine,
  statusColor,
  terminalSizeState,
};
