const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseTargetBuyUrl } = require("./target-buy-input");

function resolveTargetBuyInvocation(events) {
  const user = [...events].reverse().find((event) => event?.type === "user.message");
  const turnId = user?.data?.turnId;
  const raw = user?.data?.content;
  const invoked = events.some((event) =>
    event?.type === "skill.invoked" &&
    event.data?.name === "target-buy" &&
    event.data?.trigger === "user-invoked" &&
    String(event.data?.invokedAtTurn) === String(turnId),
  );
  if (turnId === undefined || !invoked || typeof raw !== "string") {
    throw new Error("TARGET_BUY_INPUT_MISSING: No active user-invoked Target buy turn.");
  }
  if (!/^\/target-buy(?:\s|$)/i.test(raw)) {
    throw new Error("TARGET_BUY_INPUT_MISSING: The current turn did not invoke Target buy.");
  }
  const match = raw.trim().match(/^\/target-buy\s+(\S+)$/i);
  if (!match) {
    throw new Error(
      raw.trim().toLowerCase() === "/target-buy"
        ? "TARGET_BUY_INPUT_MISSING: No product URL in the current invocation."
        : "TARGET_BUY_INPUT_INVALID: Expected exactly one product URL.",
    );
  }
  try {
    return parseTargetBuyUrl(match[1]);
  } catch {
    throw new Error("TARGET_BUY_INPUT_INVALID: Invalid Target product URL.");
  }
}

function readActiveTargetBuyInvocation({
  sessionId = process.env.COPILOT_AGENT_SESSION_ID,
  sessionRoot = path.join(os.homedir(), ".copilot", "session-state"),
} = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId || "")) {
    throw new Error("TARGET_BUY_INPUT_MISSING: Active Copilot session is unavailable.");
  }
  let contents;
  try {
    contents = fs.readFileSync(
      path.join(sessionRoot, sessionId, "events.jsonl"),
      "utf8",
    );
  } catch {
    throw new Error("TARGET_BUY_INPUT_MISSING: Active invocation record is unavailable.");
  }
  let events;
  try {
    const lines = contents.split(/\r?\n/);
    if (!contents.endsWith("\n")) {
      lines.pop();
    }
    events = lines.filter(Boolean).map((line) =>
      JSON.parse(line),
    );
  } catch {
    throw new Error("TARGET_BUY_INPUT_MISSING: Active invocation record is unreadable.");
  }
  return resolveTargetBuyInvocation(events);
}

module.exports = {
  readActiveTargetBuyInvocation,
  resolveTargetBuyInvocation,
};
