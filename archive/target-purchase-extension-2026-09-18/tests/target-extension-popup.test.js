const assert = require("assert");
const fs = require("fs");
const path = require("path");

const popupDirectory = path.join(
  __dirname,
  "..",
  "extension",
  "target-purchase",
  "popup",
);
const html = fs.readFileSync(path.join(popupDirectory, "popup.html"), "utf8");
const css = fs.readFileSync(path.join(popupDirectory, "popup.css"), "utf8");
const script = fs.readFileSync(path.join(popupDirectory, "popup.js"), "utf8");

for (const id of [
  "scheduler-state",
  "current-tab",
  "arm-product",
  "arm-checkout",
  "stop-tab",
  "stop-all",
  "interval-ms",
  "target-checkout-pin",
  "save-settings",
  "run-now",
  "tab-status-list",
]) {
  assert.match(html, new RegExp(`id="${id}"`));
}

assert.match(html, /Arm product tab/);
assert.match(html, /Arm checkout tab/);
assert.match(html, /Stop this tab/);
assert.match(html, /Stop all/);
assert.match(html, /Refresh interval/);
assert.match(html, /Target checkout PIN/);
assert.match(html, /Only used for Confirm your PIN/);

assert.match(css, /--paper:\s*#FAFAF8/i);
assert.match(css, /--ink:\s*#17202A/i);
assert.match(css, /--target-red:\s*#CC0000/i);
assert.match(css, /:focus-visible/);
assert.doesNotMatch(html, /https?:\/\//i);
assert.match(script, /SET_INTERVAL/);
assert.match(script, /SET_TARGET_CHECKOUT_PIN/);
assert.match(script, /RUN_TICK_NOW/);

console.log("target-extension-popup tests passed");
