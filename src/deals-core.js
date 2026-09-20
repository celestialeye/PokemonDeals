const userModes = Object.freeze({
  "buy-now": "Buy Now",
  preorder: "Preorder",
  buy: "Buy",
});

function normalizeMode(value, { allowEmpty = false } = {}) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (!normalized && allowEmpty) {
    return null;
  }
  const aliases = {
    "buy-now": "buy-now",
    buynow: "buy-now",
    preorder: "preorder",
    "pre-order": "preorder",
    buy: "buy",
    "add-to-cart": "buy",
    addtocart: "buy",
  };
  const mode = aliases[normalized];
  if (!mode) {
    throw new Error("Mode must be Buy Now, Preorder, or Buy.");
  }
  return mode;
}

function modeLabel(mode) {
  return mode ? userModes[mode] || String(mode) : "-";
}

function normalizeUrl(value) {
  let input = String(value || "").trim();
  if (!input) {
    throw new Error("URL is required.");
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error(`Malformed URL: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }
  url.hash = "";
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.href;
}

function suggestedProductName(value, fallback = "Product") {
  let url;
  try {
    url = new URL(normalizeUrl(value));
  } catch (error) {
    return fallback;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    return fallback;
  }

  const segments = pathname
    .split("/")
    .filter(Boolean)
    .reverse();
  const candidate = segments.find((segment) =>
    !/^A-\d{7,}$/i.test(segment) &&
    !/^\d+$/.test(segment) &&
    segment !== "-",
  );
  if (!candidate) {
    return fallback;
  }

  const name = candidate
    .replace(/\bA-\d{7,}\b/gi, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
  return name || fallback;
}

function looksLikeUrl(value) {
  const input = String(value || "").trim();
  return /^(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$))/i.test(
    input,
  );
}

function parseGroupedList(text) {
  const items = [];
  const errors = [];
  let group = "";
  const lines = String(text || "").split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    if (line.endsWith(":") && !looksLikeUrl(line.slice(0, -1))) {
      group = line.slice(0, -1).trim();
      if (!group) {
        errors.push(`Line ${index + 1}: group heading is empty.`);
      }
      return;
    }

    if (looksLikeUrl(line)) {
      try {
        items.push({
          name: "",
          group,
          url: normalizeUrl(line),
          sourceLine: index + 1,
        });
      } catch (error) {
        errors.push(`Line ${index + 1}: ${error.message}`);
      }
      return;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      errors.push(
        `Line ${index + 1}: expected "Name: URL", a URL, or a heading ending in ":".`,
      );
      return;
    }
    const name = line.slice(0, separator).trim();
    const rawUrl = line.slice(separator + 1).trim();
    if (!name || !rawUrl) {
      errors.push(`Line ${index + 1}: both name and URL are required.`);
      return;
    }
    try {
      items.push({
        name,
        group,
        url: normalizeUrl(rawUrl),
        sourceLine: index + 1,
      });
    } catch (error) {
      errors.push(`Line ${index + 1}: ${error.message}`);
    }
  });

  if (items.length === 0 && errors.length === 0) {
    errors.push("No products were found.");
  }
  return { items, errors };
}

module.exports = {
  modeLabel,
  normalizeMode,
  normalizeUrl,
  parseGroupedList,
  suggestedProductName,
  userModes,
};
