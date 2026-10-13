type ReadinessOptions = {
  url: string;
  serviceName: string;
  assertRunning: () => void;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  intervalMs?: number;
};

type ReadinessDependencies = {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * Wait for actual backend readiness, within the publisher's 60-second port
 * startup window. Cold Python imports can exceed the old 15-second allowance.
 * Keep this deadline separate from HTTP request and report-generation limits.
 */
export async function waitForHealthyService(
  { url, serviceName, assertRunning, timeoutMs = 50_000, probeTimeoutMs = 500, intervalMs = 250 }: ReadinessOptions,
  dependencies: ReadinessDependencies = {
    fetch,
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<void> {
  const deadline = dependencies.now() + timeoutMs;
  while (dependencies.now() < deadline) {
    assertRunning();
    const remaining = Math.max(1, Math.ceil(deadline - dependencies.now()));
    let ready = false;
    try {
      const response = await dependencies.fetch(url, {
        signal: AbortSignal.timeout(Math.min(probeTimeoutMs, remaining)),
      });
      ready = response.ok;
      await response.body?.cancel();
    } catch {
      // Connection refused or a failed probe is expected while importing.
    }
    assertRunning();
    if (ready) return;
    const delay = Math.min(intervalMs, deadline - dependencies.now());
    if (delay > 0) await dependencies.sleep(delay);
  }
  throw new Error(`${serviceName} did not become healthy within ${timeoutMs / 1000} seconds`);
}
