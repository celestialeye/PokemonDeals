class GlobalRequestQueue {
  constructor({ cooldownMs, jitterRatio = 0.1, now = Date.now, wait }) {
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new Error("cooldownMs must be a non-negative number.");
    }
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
      throw new Error("jitterRatio must be between 0 and 1.");
    }

    this.cooldownMs = cooldownMs;
    this.jitterRatio = jitterRatio;
    this.now = now;
    this.wait = wait;
    this.tail = Promise.resolve();
    this.lastCompletedAt = null;
    this.active = 0;
    this.maximumActive = 0;
    this.completed = 0;
  }

  nextCooldownMs() {
    const factor = 1 - this.jitterRatio + Math.random() * this.jitterRatio * 2;
    return Math.round(this.cooldownMs * factor);
  }

  enqueue(action) {
    const run = this.tail.then(async () => {
      if (this.lastCompletedAt !== null) {
        const elapsedMs = this.now() - this.lastCompletedAt;
        const remainingMs = Math.max(0, this.nextCooldownMs() - elapsedMs);
        if (remainingMs > 0) {
          await this.wait(remainingMs);
        }
      }

      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      try {
        return await action();
      } finally {
        this.active -= 1;
        this.completed += 1;
        this.lastCompletedAt = this.now();
      }
    });

    this.tail = run.catch(() => {});
    return run;
  }

  snapshot() {
    return {
      completed: this.completed,
      active: this.active,
      maximumActive: this.maximumActive,
      lastCompletedAt: this.lastCompletedAt,
    };
  }
}

module.exports = { GlobalRequestQueue };
