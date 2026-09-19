const { WebSocketServer, WebSocket } = require("ws");
const {
  normalizeInterval,
  schedulerToken,
} = require("../extension/target-purchase/lib/core");

function createSchedulerServer(options = {}) {
  const host = options.host || "127.0.0.1";
  const requestedPort = Number(options.port ?? 18765);
  const autoTick = options.autoTick !== false;
  let intervalMs = normalizeInterval(options.intervalMs);
  let tickTimer = null;
  let heartbeatTimer = null;

  const server = new WebSocketServer({
    host,
    port: requestedPort,
    verifyClient(info, done) {
      const requestUrl = new URL(info.req.url, `http://${host}`);
      const validToken = requestUrl.searchParams.get("token") === schedulerToken;
      const validOrigin =
        typeof info.origin === "string" &&
        /^chrome-extension:\/\/[a-p]{32}$/i.test(info.origin);
      done(validToken && validOrigin, 401, "Unauthorized");
    },
  });

  const ready = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of server.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  function tickNow() {
    broadcast({
      type: "tick",
      at: Date.now(),
    });
  }

  function heartbeatNow() {
    broadcast({
      type: "heartbeat",
      at: Date.now(),
    });
  }

  function resetTimer() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (autoTick) {
      tickTimer = setInterval(tickNow, intervalMs);
      tickTimer.unref?.();
    }
  }

  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "scheduler-status",
        intervalMs,
      }),
    );

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message?.type !== "configure") {
        return;
      }

      intervalMs = normalizeInterval(message.intervalMs);
      resetTimer();
      broadcast({
        type: "scheduler-configured",
        intervalMs,
      });
    });
  });

  ready.then(() => {
    resetTimer();
    if (autoTick) {
      heartbeatTimer = setInterval(heartbeatNow, 20000);
      heartbeatTimer.unref?.();
    }
  });

  return {
    ready,
    get port() {
      return server.address()?.port ?? requestedPort;
    },
    getIntervalMs() {
      return intervalMs;
    },
    heartbeatNow,
    tickNow,
    async close() {
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      for (const client of server.clients) {
        client.close();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

if (require.main === module) {
  const scheduler = createSchedulerServer({
    port: process.env.TARGET_EXTENSION_SCHEDULER_PORT || 18765,
    intervalMs: process.env.TARGET_EXTENSION_INTERVAL_MS || 5000,
  });

  scheduler.ready
    .then(() => {
      console.log(
        `TARGET_EXTENSION_SCHEDULER_READY port=${scheduler.port} intervalMs=${scheduler.getIntervalMs()}`,
      );
    })
    .catch((error) => {
      console.error(`TARGET_EXTENSION_SCHEDULER_FAILED ${error.message}`);
      process.exit(1);
    });

  async function shutdown() {
    await scheduler.close().catch(() => {});
    process.exit(0);
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = {
  createSchedulerServer,
};
