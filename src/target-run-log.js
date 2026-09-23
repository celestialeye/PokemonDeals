const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const { pathToFileURL } = require("node:url");

// Defense for persisted JSONL and line-buffered terminal forwarding, including
// browser fill("...") traces. Sensitive actions should still log categories.
function sanitizeTargetLogText(value) {
  return String(value)
    .replace(/\bfill\("(?:\\.|[^"\\])*"\)/gi, 'fill("<redacted>")')
    .replace(/\bfill\('(?:\\.|[^'\\])*'\)/gi, 'fill("<redacted>")')
    .replace(
      /(https:\/\/(?:www\.)?target\.com\/[^\s"'<>?]+)\?[^\s"'<>]*/gi,
      "$1?<redacted>",
    )
    .replace(
      /("(?:authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"<redacted>"',
    )
    .replace(
      /((?:authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)\s*[=:]\s*)[^\r\n]*/gi,
      "$1<redacted>",
    )
    .replace(
      /\b(?:order(?:\s+number)?|confirmation)\s*(?:#|:)?\s*[A-Z0-9-]{6,}\b/gi,
      "<redacted-order-id>",
    );
}

function sanitizeMetadata(metadata = {}) {
  const sensitiveKeyPattern =
    /^(?:authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)$/i;
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      sensitiveKeyPattern.test(key)
        ? "<redacted>"
        : Array.isArray(value)
          ? value.map((item) => sanitizeTargetLogText(item))
          : sanitizeTargetLogText(value),
    ]),
  );
}

function defaultLogPath(workflow) {
  const safeWorkflow = String(workflow || "target")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(
    process.cwd(),
    "logs",
    `${safeWorkflow || "target"}-${timestamp}-${process.pid}.jsonl`,
  );
}

function createTargetRunLogger({
  workflow,
  metadata = {},
  logPath = process.env.TARGET_RUN_LOG_PATH,
}) {
  if (!workflow) {
    throw new Error("Target run logging requires a workflow name.");
  }

  const resolvedPath = path.resolve(logPath || defaultLogPath(workflow));
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.closeSync(fs.openSync(resolvedPath, "a"));

  const safeMetadata = sanitizeMetadata(metadata);
  let writeFailureReported = false;

  function write(level, args, eventOverride) {
    const message = sanitizeTargetLogText(util.format(...args));
    const event =
      eventOverride ||
      message.match(/^([A-Z][A-Z0-9_]+)/)?.[1] ||
      "TARGET_LOG";
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
          `TARGET_LOG_WRITE_FAILED ${sanitizeTargetLogText(error.message)}\n`,
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

module.exports = {
  createTargetRunLogger,
  sanitizeTargetLogText,
};
