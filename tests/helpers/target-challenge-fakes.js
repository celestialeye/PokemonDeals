/**
 * Small behavioral double, NOT a browser/DOM emulator. Tests explicitly mutate
 * state/nodes to model failure, label changes, or clearance; events record input
 * order so cleanup can be asserted. Real geometry, shadow roots, and trusted
 * pointer events belong in target-challenge-solver.integration.test.js.
 */
function fakePage({ controls = [{ name: "Press and hold" }], children = [], body = "Quick verification", title = "Target", url = "https://www.target.com/p/-/A-1007918679", readError = false } = {}) {
  const events = [];
  const state = { body, title, url, closed: false, released: false, clearOnRelease: false };
  const empty = { count: async () => 0 };
  const nodes = controls.map((control) => ({ visible: true, enabled: true, ...control }));
  const wrap = (node) => ({
    isVisible: async () => node.visible,
    isEnabled: async () => node.enabled,
    hover: async () => { events.push("hover"); if (node.hoverError) { throw new Error(node.hoverError); } },
    elementHandle: async () => ({
      boundingBox: async () => node.noGeometry ? null : { x: 10, y: 20, width: 80, height: 40 },
      isVisible: async () => node.visible,
      dispose: async () => events.push("dispose"),
    }),
  });
  const matches = (pattern, rolesOnly) => {
    const selected = nodes.filter((node) => (!rolesOnly || !node.textOnly) && pattern.test(node.name));
    return { count: async () => selected.length, nth: (index) => wrap(selected[index]) };
  };
  const page = {
    state, events, nodes,
    isClosed: () => state.closed,
    url: () => state.url,
    title: async () => state.title,
    locator: (selector) => {
      if (selector === "body") {
        return { innerText: async () => {
          if (readError) { throw new Error("read failure"); }
          return state.body;
        } };
      }
      if (selector === "iframe, frame") {
        return {
          count: async () => children.length,
          nth: (index) => ({ isVisible: async () => children[index].visible !== false }),
        };
      }
      return empty;
    },
    frameLocator: () => ({ nth: (index) => children[index] }),
    getByRole: (_, { name }) => matches(name, true),
    getByText: (pattern) => matches(pattern, false),
    mouse: {
      move: async (x, y) => events.push(["move", x, y]),
      down: async () => events.push("down"),
      up: async () => {
        events.push("up");
        state.released = true;
        if (state.clearOnRelease) {
          state.body = "Pokemon product Add to cart";
          nodes.forEach((node) => { node.visible = false; });
        }
      },
    },
  };
  return page;
}

/**
 * Advance logical attempt time whenever the solver waits; onWait can model a
 * state transition at a chosen instant. This does not replace native timers in
 * withTimeout(), so protocol-stall tests still exercise a real bounded timer.
 */
function fakeTime(onWait = () => {}) {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms) => { time += ms; onWait(time); },
  };
}

module.exports = { fakePage, fakeTime };
