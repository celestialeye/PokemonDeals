const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const { pathToFileURL } = require("node:url");

const installedLogger = Symbol.for("pokemonDeals.amazonRunLogger");

function sanitizeAmazonLogText(value) {
  return String(value)
    .replace(
      /(https:\/\/(?:www\.)?amazon\.com\/(?:checkout|gp\/buy)(?:\/[^\s"'<>?]*)?)\?[^\s"'<>]*/gi,
      "$1?<redacted>",
    )
    .replace(
      /("(?:offeringID|offerListingID|AMAZON_CHECKOUT_URL|authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"<redacted>"',
    )
    .replace(
      /((?:offeringID|offerListingID|AMAZON_CHECKOUT_URL)"?\s*[=:]\s*)"?[^&\s"'<>]*/gi,
      "$1<redacted>",
    )
    .replace(
      /((?:authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)\s*[=:]\s*)[^\r\n]*/gi,
      "$1<redacted>",
    )
    .replace(/\b\d{3}-\d{7}-\d{7}\b/g, "<redacted-order-id>");
}

function sanitizeMetadata(metadata = {}) {
  const sensitiveKeyPattern =
    /^(?:offeringID|offerListingID|AMAZON_CHECKOUT_URL|authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)$/i;
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      sensitiveKeyPattern.test(key)
        ? "<redacted>"
        : Array.isArray(value)
          ? value.map((item) => sanitizeAmazonLogText(item))
          : sanitizeAmazonLogText(value),
    ]),
  );
}

function defaultLogPath(workflow) {
  const safeWorkflow = String(workflow || "amazon")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(
    process.cwd(),
    "logs",
    `${safeWorkflow || "amazon"}-${timestamp}-${process.pid}.jsonl`,
  );
}

function createAmazonRunLogger({
  workflow,
  metadata = {},
  logPath = process.env.AMAZON_RUN_LOG_PATH,
}) {
  if (!workflow) {
    throw new Error("Amazon run logging requires a workflow name.");
  }

  const resolvedPath = path.resolve(logPath || defaultLogPath(workflow));
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.closeSync(fs.openSync(resolvedPath, "a"));

  const safeMetadata = sanitizeMetadata(metadata);
  let writeFailureReported = false;

  function write(level, args, eventOverride) {
    const message = sanitizeAmazonLogText(util.format(...args));
    const event =
      eventOverride ||
      message.match(/^([A-Z][A-Z0-9_]+)/)?.[1] ||
      "AMAZON_LOG";
    const record = {
      timestamp: new Date().toISOString(),
      workflow,
      pid: process.pid,
      level,
      event,
      message,
      ...safeMetadata,
    };

    try {
      fs.appendFileSync(resolvedPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      if (!writeFailureReported) {
        writeFailureReported = true;
        process.stderr.write(
          `AMAZON_LOG_WRITE_FAILED ${sanitizeAmazonLogText(error.message)}\n`,
        );
      }
    }
  }

  return {
    filePath: resolvedPath,
    fileUrl: pathToFileURL(resolvedPath).href,
    write,
  };
}

function installAmazonRunLogger(options) {
  if (global[installedLogger]) {
    return global[installedLogger];
  }

  const logger = createAmazonRunLogger(options);
  const originals = {
    error: console.error.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };

  for (const [method, level] of [
    ["log", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ]) {
    console[method] = (...args) => {
      const message = sanitizeAmazonLogText(util.format(...args));
      originals[method](message);
      logger.write(level, [message]);
    };
  }

  process.once("exit", (code) => {
    logger.write(
      code === 0 ? "info" : "error",
      [`AMAZON_PROCESS_EXIT code=${code}`],
      "AMAZON_PROCESS_EXIT",
    );
  });

  global[installedLogger] = logger;
  logger.write("info", ["AMAZON_RUN_STARTED"], "AMAZON_RUN_STARTED");
  console.log(`AMAZON_LOG_FILE ${logger.fileUrl}`);
  return logger;
}

module.exports = {
  createAmazonRunLogger,
  installAmazonRunLogger,
  sanitizeAmazonLogText,
};
