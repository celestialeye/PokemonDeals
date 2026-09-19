const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const piRoot = path.join(root, ".pi");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// Deliberately validate this harness's flat, single-line string format, not YAML
// in general. No dependency on a machine-specific pi installation or provider.
function resource(relative) {
  const text = read(relative).replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]+?)\n---\n([\s\S]+)$/);
  assert.ok(match, `${relative}: missing frontmatter/body`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-z][a-z-]*): (.+)$/);
    assert.ok(field, `${relative}: use single-line string fields`);
    const [, key, raw] = field;
    assert.ok(!Object.hasOwn(fields, key), `${relative}: duplicate ${key}`);
    if (raw.startsWith('"')) {
      fields[key] = JSON.parse(raw);
    } else {
      assert.ok(!/[:#\[\]{}'"\n]/.test(raw), `${relative}: quote YAML-sensitive values`);
      fields[key] = raw;
    }
    assert.equal(typeof fields[key], "string");
    assert.ok(fields[key].trim(), `${relative}: empty ${key}`);
  }
  assert.ok(fields.description, `${relative}: missing description`);
  return { fields, body: match[2], text };
}

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.isFile() && entry.name.endsWith(".md") ? [full] : [];
  });
}

const expectedTools = {
  "deals-scout": ["read", "grep", "find", "ls"],
  "deals-worker": ["read", "grep", "find", "ls", "edit", "write", "powershell"],
  "deals-reviewer": ["read", "grep", "find", "ls", "powershell"],
};
const agents = Object.keys(expectedTools);
const skills = ["deals-maintenance", "deals-verification"];

for (const name of agents) {
  test(`${name}: discoverable metadata, explicit tools/model, and skill handoff`, () => {
    const { fields, body } = resource(`.pi/agents/${name}.md`);
    assert.equal(fields.name, name);
    assert.deepEqual(fields.tools.split(",").map((tool) => tool.trim()), expectedTools[name]);
    assert.equal(fields.model, "litellm-local/gpt-6-astra");
    assert.match(body, /\.pi\/skills\/deals-maintenance\/SKILL\.md/);
    assert.match(body, /HANDOFF/);
    assert.match(body, /prior/i);
    assert.match(body, /coordinator/i);
    for (const match of body.matchAll(/`(\.pi\/[^`]+\.md)`/g)) {
      assert.ok(fs.existsSync(path.join(root, match[1])), `missing ${match[1]}`);
    }
  });
}

for (const name of skills) {
  test(`${name}: valid skill metadata and bounded instructions`, () => {
    const { fields, body, text } = resource(`.pi/skills/${name}/SKILL.md`);
    assert.equal(fields.name, name);
    assert.match(fields.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(fields.name.length <= 64);
    assert.ok(fields.description.length <= 1024);
    assert.ok(text.split("\n").length < 500);
    assert.match(body, /BLOCKED/);
    assert.match(body, /CDP/);
    assert.match(body, /HANDOFF/);
  });
}

test("resource inventory has no unregistered agents, skills, or prompts", () => {
  const names = (directory) => fs.readdirSync(path.join(piRoot, directory)).sort();
  assert.deepEqual(names("agents"), agents.map((name) => `${name}.md`).sort());
  assert.deepEqual(names("skills"), skills.slice().sort());
  assert.deepEqual(names("prompts"), ["deals.md"]);
});

test("prompt routes real agents with explicit scope, trust, and chain handoff", () => {
  const { body } = resource(".pi/prompts/deals.md");
  assert.match(body, /\$@/);
  assert.match(body, /agentScope: "both"/);
  assert.match(body, /confirmProjectAgents: true/);
  for (const agent of agents) assert.ok(body.includes(`\`${agent}\``));
  const blocks = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.ok(blocks.length > 0, "missing delegation example");
  for (const block of blocks) {
    const call = JSON.parse(block[1]);
    assert.equal(call.agentScope, "both");
    assert.equal(call.confirmProjectAgents, true);
    assert.ok(call.cwd);
    assert.ok(call.chain.length >= 2);
    call.chain.forEach((step, index) => {
      assert.ok(agents.includes(step.agent), `unknown agent ${step.agent}`);
      assert.ok(step.cwd);
      assert.match(step.task, /02_plan\.md/);
      if (index > 0) assert.match(step.task, /\{previous\}/);
    });
  }
  for (const marker of ["_workspace/", "manifest.md", "two repair rounds", "Test scenarios", "BLOCKED"]) {
    assert.ok(body.includes(marker), `missing workflow contract: ${marker}`);
  }
});

test("local Markdown links and module-map file references resolve", () => {
  for (const full of markdownFiles(piRoot)) {
    const text = fs.readFileSync(full, "utf8");
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:\/\//i.test(target)) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(full), target)), `${full}: broken ${target}`);
    }
  }
  const map = read(".pi/skills/deals-maintenance/references/module-map.md");
  for (const match of map.matchAll(/`([^`]+\.(?:js|md|json))`/g)) {
    assert.ok(fs.existsSync(path.join(root, match[1])), `module map: missing ${match[1]}`);
  }
});

test("project pointers and workspace exclusion are present", () => {
  assert.match(read("AGENTS.md"), /\.pi\/prompts\/deals\.md/);
  assert.match(read("README.md"), /\.pi\/README\.md/);
  assert.ok(read(".gitignore").split(/\r?\n/).includes("/_workspace/"));
});
