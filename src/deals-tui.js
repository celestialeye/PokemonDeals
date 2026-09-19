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
  gold: "#f2c94c",
  cyan: "#56d6e7",
  text: "#d9e6ee",
  muted: "#7691a3",
  green: "#54d17a",
  red: "#ff667a",
  orange: "#ffad5c",
});

const navigationItems = Object.freeze([
  { id: "products", label: "Products" },
  { id: "import", label: "Import" },
  { id: "add", label: "Add Product" },
  { id: "run-setup", label: "Run Engine" },
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
    ["ARM", "MODE", "STORE", "NAME", "GROUP", "STATUS", "CHECKED"],
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
    products: items.filter((item) => item.armed),
    executionMode: configuredMode,
    challengeSolver: settings.solverEnabled !== false,
  };
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
  const next = {
    statuses: { ...(state.statuses || {}) },
    logs: [...(state.logs || [])],
  };
  const event = notification?.event;
  if (!event || typeof event.status !== "string") {
    return next;
  }
  const at = notification.at || new Date().toISOString();
  for (const id of notification.itemIds || []) {
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
    armed: false,
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
    runProjection: { statuses: {}, logs: [] },
    notice: "Ready",
    modal: null,
    closed: false,
  };

  let closeResolve;
  const closed = new Promise((resolve) => {
    closeResolve = resolve;
  });

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
      selected: { bg: palette.gold, fg: palette.background, bold: true },
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
    const armed = state.items.filter((item) => item.armed).length;
    const solver = state.runSetup?.challengeSolver ??
      state.settings.solverEnabled !== false;
    const mode = state.running
      ? state.runSetup?.executionMode || "running"
      : "idle";
    header.setContent(
      `{bold}{${palette.gold}-fg}PokemonDeals{/${palette.gold}-fg}{/bold}` +
      `  {${palette.cyan}-fg}${state.items.length} products{/${palette.cyan}-fg}` +
      `  ${armed} armed  Mode: ${mode}  Solver: ${solver ? "on" : "off"}\n` +
      `{${palette.muted}-fg}${state.notice}{/${palette.muted}-fg}`,
    );
    const base = "arrows/j/k move  Enter open  Space arm  a add  e edit  i import  d delete  r run  s settings";
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
          `{${palette.muted}-fg}Nothing can run until a supported product is armed.{/${palette.muted}-fg}`,
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
        selected: { bg: palette.panelAlt, fg: palette.gold, bold: true },
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
        selected: { bg: palette.panelAlt, fg: palette.gold, bold: true },
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
        selected: { bg: palette.panelAlt, fg: palette.gold, bold: true },
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
        "  Space arm/disarm   a add   e edit   i import   d delete",
        "",
        `{${palette.gold}-fg}Control plane{/${palette.gold}-fg}`,
        "  r run setup   s settings   q quit   Ctrl+C stop active worker",
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
    titleBox("RUN SETUP", "Review armed products and choose execution behavior");
    const productSummary = setup.products.length
      ? setup.products.map((item) =>
        `${item.mode.padEnd(9)} ${retailerLabel(item.retailer).padEnd(10)} ${item.name}`,
      ).join("\n")
      : "No products are armed. Return to Products and press Space.";
    blessed.box({
      parent: main,
      top: 3,
      left: 3,
      right: 3,
      height: Math.min(9, Math.max(4, setup.products.length + 2)),
      label: " Armed products ",
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
        selected: { bg: palette.panelAlt, fg: palette.gold, bold: true },
      },
    });
    list.select(state.runSetupIndex);
  }

  function renderRunView() {
    clearMain();
    titleBox("RUN ENGINE", state.running
      ? "Worker active - Ctrl+C stops the child safely"
      : "Run complete - Esc returns to Products");
    const rows = state.runSetup.products.map((item) => {
      const projected = state.runProjection.statuses[item.id];
      const status = projected?.status || item.lastStatus;
      const outcome = projected?.terminalOutcome || item.terminalOutcome || "-";
      return `${modeLabel(item.mode).padEnd(10)} ${item.name.padEnd(32)} ` +
        `${truncateText(status, 35).padEnd(35)} ${outcome}`;
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
    log.setContent(state.runProjection.logs.join("\n"));
    log.setScrollPerc(100);
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
    }
    const navIndex = navigationItems.findIndex((item) => item.id === state.view);
    if (navIndex >= 0) {
      navigation.select(navIndex);
    }
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

  async function submitModal(modal, errorWidget, operation, onSuccess) {
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
      try {
        await refreshData();
        render();
      } catch (refreshError) {
        state.notice = `Catalog refresh failed: ${refreshError.message}`;
        render();
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
    modal.on("element keypress", (element, _, key) => {
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
      height: 24,
    });
    const name = formInput(modal, "Name", 1, item?.name || "");
    const group = formInput(modal, "Group", 4, item?.group || "");
    const url = formInput(modal, "URL", 7, item?.url || "");
    blessed.text({
      parent: modal,
      top: 11,
      left: 1,
      width: 16,
      content: "Mode",
      style: { bg: palette.panel, fg: palette.cyan },
    });
    const modes = blessed.list({
      parent: modal,
      top: 10,
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
    const armed = blessed.checkbox({
      parent: modal,
      top: 15,
      left: 18,
      width: 25,
      height: 1,
      text: "Armed",
      checked: Boolean(item?.armed),
      keys: true,
      style: { bg: palette.panel, fg: palette.text, focus: { fg: palette.gold } },
    });
    const error = modalError(modal, 17);
    blessed.text({
      parent: modal,
      bottom: 0,
      left: 1,
      right: 1,
      content: "Tab move  Space toggle  Ctrl+S save  Esc cancel",
      style: { bg: palette.panel, fg: palette.muted },
    });
    bindModalAction(modal, ["C-s"], () => {
      const input = {
        name: name.getValue(),
        group: group.getValue(),
        url: url.getValue(),
        mode: modeIds[modes.selected],
        armed: armed.checked,
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
      );
    });
    name.focus();
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
        content: 'Paste headings ending in ":" and products as "Name: URL".',
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
          `${item.group ? `[${item.group}] ` : ""}${item.name}\n  ${item.url}`,
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
      const armed = blessed.checkbox({
        parent: modal,
        top: "56%",
        left: 39,
        width: 30,
        text: "Arm imported products",
        checked: controller.state.armed,
        keys: true,
        style: { bg: palette.panel, fg: palette.text, focus: { fg: palette.gold } },
      });
      const error = modalError(modal, "100%-5");
      blessed.text({
        parent: modal,
        bottom: 0,
        left: 1,
        right: 1,
        content: "arrows select mode  Space armed  Enter import  F2 edit paste  Esc cancel",
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
      bindModalAction(modal, ["space"], (element) => {
        if (element === armed) {
          if (controller.state.armed !== armed.checked) {
            controller.toggleArmed();
          }
        } else {
          armed.checked = controller.toggleArmed();
        }
        screen.render();
      });
      bindModalAction(modal, ["f2"], renderPaste);
      bindModalAction(modal, ["enter"], (element) => {
        if (element === armed && controller.state.armed !== armed.checked) {
          controller.toggleArmed();
        }
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
        ["1", "2", "3", "space", "f2", "enter", "escape"],
      );
      bindFocusedModalActions(
        modal,
        armed,
        ["1", "2", "3", "space", "f2", "enter", "escape"],
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
    const modal = modalBox(`Edit ${row.label}`, { width: 70, height: 12 });
    const inputBox = formInput(modal, "Value", 2, row.value === "unset" ? "" : row.value);
    const error = modalError(modal, 6);
    blessed.text({
      parent: modal,
      bottom: 0,
      left: 1,
      content: `${row.key}  |  Enter save  Esc cancel`,
      style: { bg: palette.panel, fg: palette.muted },
    });
    bindModalAction(modal, ["enter"], () =>
      submitModal(
        modal,
        error,
        () => store.setSetting(
          "target",
          row.key.slice("target.".length),
          inputBox.getValue(),
        ),
        () => {
          state.notice = `Updated ${row.key}.`;
        },
      ));
    inputBox.focus();
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
      `Maximum item price: ${settings.maxItemPrice || "NOT SET"}`,
      `Maximum order total: ${settings.maxOrderTotal || "NOT SET"}`,
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
    if (state.view === "run") {
      render();
    }
  }

  async function beginRun() {
    if (state.runSetup.products.length === 0) {
      state.notice = "No products are armed.";
      render();
      return;
    }
    state.running = true;
    state.view = "run";
    state.runProjection = { statuses: {}, logs: [] };
    state.notice = `Running ${state.runSetup.executionMode}.`;
    render();
    const outputSink = createChunkLogSink(appendRunLog);
    const errorSink = createChunkLogSink(appendRunLog, "ERROR: ");
    try {
      const result = await runEngine(
        store,
        state.runSetup.executionMode,
        {
          adapterOptions: {
            target: {
              challengeSolver: state.runSetup.challengeSolver,
            },
          },
          secretStore,
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
            appendRunLog(
              `${event.retailer || "engine"}: ${event.type}` +
              (event.mode ? ` (${event.mode})` : ""),
            );
          },
        },
      );
      outputSink.flush();
      errorSink.flush();
      state.notice = result.interrupted
        ? "Run stopped by operator."
        : result.code === 0
          ? "Run completed."
          : `Run failed with exit code ${result.code}.`;
    } catch (error) {
      appendRunLog(`CONTROL PLANE ERROR: ${safeLogLine(error.message)}`);
      state.notice = `Run failed: ${error.message}`;
    } finally {
      state.running = false;
      await refreshData();
      state.view = "run";
      render();
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
    if (state.runSetup.executionMode === "live-purchase") {
      openLiveConfirmation();
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
    screen.destroy();
    closeResolve();
  }

  async function handleAction(action) {
    if (state.modal) {
      return;
    }
    if (state.running) {
      if (action === "stop-run") {
        process.emit("SIGINT");
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
        state.notice = `${item.name} is now ${item.armed ? "disarmed" : "armed"}.`;
        await refreshData();
      } catch (error) {
        state.notice = `Cannot change armed state: ${error.message}`;
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
      render();
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
  executionModeOptions,
  launchDealsTui,
  minimumTerminalSize,
  navigationItems,
  palette,
  productDetail,
  productTableHeader,
  productRows,
  projectRunEvent,
  runSetupDefaults,
  safeLogLine,
  statusColor,
  terminalSizeState,
};
