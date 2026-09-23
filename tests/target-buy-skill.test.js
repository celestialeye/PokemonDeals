const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const skillPath = path.join(
  root,
  ".github",
  "skills",
  "target-buy",
  "SKILL.md",
);
const runnerPath = path.join(
  root,
  ".github",
  "skills",
  "target-buy",
  "run-target-buy.ps1",
);

test("target-buy skill declares the guarded one-product autonomous workflow", () => {
  const skill = fs.readFileSync(skillPath, "utf8");

  assert.match(skill, /^---\r?\nname: target-buy\r?\n/m);
  assert.match(skill, /explicitly invokes\s+`\/target-buy <target-url>/);
  assert.match(skill, /exactly one\s+quantity-one order/);
  assert.match(skill, /Buy Now\*\*, \*\*Preorder\*\*, then \*\*Add to cart/);
  assert.match(skill, /Never\s+ask the user to choose a purchase mode/i);
  assert.match(skill, /raw `user\.message\.data\.content`/);
  assert.match(skill, /active `COPILOT_AGENT_SESSION_ID`/);
  assert.match(skill, /rendered skill context omits `ARGUMENTS:`/);
  assert.match(skill, /Never search prior sessions/i);
  assert.match(skill, /`confidence:"unknown"` availability as \*\*unknown\*\*/i);
  assert.match(skill, /full slugged PDP paths/i);
  assert.match(skill, /TARGET_BUY_INPUT_MISSING/);
  assert.match(skill, /Do not open a form or ask a follow-up\s+question/i);
  assert.match(skill, /launch the authorized one-product worker immediately/i);
  assert.doesNotMatch(skill, /\[--mode/);
  assert.match(skill, /Press & Hold/);
  assert.match(skill, /TARGET_TERMINAL_SAFETY_STOP/);
  assert.match(skill, /shell ID `target-buy`/);
});

test("target-buy runner uses the shared lock and existing direct Target worker", () => {
  const runner = fs.readFileSync(runnerPath, "utf8");

  assert.match(runner, /readActiveTargetBuyInvocation/);
  assert.match(runner, /normalizeTargetBuyMode/);
  assert.match(runner, /Local\\PokemonDealsPurchase/);
  assert.match(runner, /\$mutex\.WaitOne\(0\)/);
  assert.match(runner, /\$mutex\.ReleaseMutex\(\)/);
  assert.match(runner, /TARGET_RUN_LOG_PATH/);
  assert.doesNotMatch(runner, /TARGET_SESSION_RESET_STARTED/);
  assert.doesNotMatch(runner, /target-session-reset/);
  assert.doesNotMatch(runner, /Stop-Process/);
  assert.match(runner, /TARGET_WORKER_EXIT/);
  assert.match(runner, /npm run target:direct-buy/);
  assert.match(runner, /A competing PokemonDeals purchase worker is already running/);
  assert.match(runner, /\$env:TARGET_BUY_MODE = "auto"/);
  assert.doesNotMatch(runner, /param\([^)]*\$TargetUrl/s);
  assert.doesNotMatch(runner, /\[ValidateSet\("auto"/);
  assert.doesNotMatch(runner, /Stop-Process -Name/);
  assert.doesNotMatch(runner, /amazon:checkout/);
});
