const assert = require("assert");
const WebSocket = require("ws");
const {
  createSchedulerServer,
} = require("../scripts/target-extension-scheduler");
const {
  schedulerToken,
} = require("../extension/target-purchase/lib/core");

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for scheduler message.")),
      3000,
    );
    socket.on("message", function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    });
  });
}

(async () => {
  const scheduler = createSchedulerServer({
    port: 0,
    intervalMs: 5000,
    autoTick: false,
  });
  await scheduler.ready;

  const socket = new WebSocket(
    `ws://127.0.0.1:${scheduler.port}/?token=${schedulerToken}`,
    { headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } },
  );
  const connectedPromise = waitForMessage(
    socket,
    (message) => message.type === "scheduler-status",
  );
  await waitForOpen(socket);
  const connected = await connectedPromise;
  assert.strictEqual(connected.intervalMs, 5000);

  const tickPromise = waitForMessage(
    socket,
    (message) => message.type === "tick",
  );
  scheduler.tickNow();
  const tick = await tickPromise;
  assert.ok(Number.isFinite(tick.at));

  const heartbeatPromise = waitForMessage(
    socket,
    (message) => message.type === "heartbeat",
  );
  scheduler.heartbeatNow();
  assert.ok(Number.isFinite((await heartbeatPromise).at));

  const configuredPromise = waitForMessage(
    socket,
    (message) => message.type === "scheduler-configured",
  );
  socket.send(JSON.stringify({ type: "configure", intervalMs: 7500 }));
  const configured = await configuredPromise;
  assert.strictEqual(configured.intervalMs, 7500);
  assert.strictEqual(scheduler.getIntervalMs(), 7500);

  const minimumPromise = waitForMessage(
    socket,
    (message) => message.type === "scheduler-configured",
  );
  socket.send(JSON.stringify({ type: "configure", intervalMs: 1000 }));
  assert.strictEqual((await minimumPromise).intervalMs, 3000);

  socket.send("{invalid");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(socket.readyState, WebSocket.OPEN);

  const rejectedSocket = new WebSocket(`ws://127.0.0.1:${scheduler.port}`);
  const rejected = new Promise((resolve) => {
    rejectedSocket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
    });
  });
  assert.strictEqual(await rejected, 401);

  socket.close();
  await scheduler.close();
  console.log("target-extension-scheduler tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
