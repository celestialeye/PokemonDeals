const assert = require("assert");
const fs = require("fs");
const path = require("path");

const script = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "install-target-extension.ps1"),
  "utf8",
);

assert.match(script, /extension\\target-purchase/i);
assert.match(script, /ConvertFrom-Json/);
assert.match(script, /npm test/);
assert.match(script, /npm run check/);
assert.match(script, /Start-Process/);
assert.match(script, /-WindowStyle Hidden/);
assert.match(script, /target-extension-scheduler\.js/);
assert.match(script, /Get-CimInstance\s+Win32_Process/);
assert.match(script, /Port 18765 is already owned by another process/);
assert.match(script, /Scheduler did not start listening on port 18765/);
assert.doesNotMatch(script, /Stop-Process.*chrome/i);

console.log("target-extension-install tests passed");
