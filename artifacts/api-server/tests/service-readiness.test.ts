import assert from "node:assert/strict";
import test from "node:test";
import { waitForHealthyService } from "../src/lib/service-readiness";

function clock(fetchHealth: (time: number) => Promise<Response>, advanceDuringProbe = 0) {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
    fetch: (async (_url, _options) => {
      time += advanceDuringProbe;
      return fetchHealth(time);
    }) as typeof fetch,
  };
}

const base = {
  url: "http://backend/healthz",
  serviceName: "FastAPI",
  assertRunning: () => {},
};

test("cold service taking over 15 seconds can start within publishing budget", async () => {
  const deps = clock(async (time) => {
    if (time < 22_000) throw new Error("ECONNREFUSED");
    return new Response("ok", { status: 200 });
  });
  await waitForHealthyService(base, deps);
  assert.equal(deps.now(), 22_000);
});

test("deadline includes the time spent awaiting probes", async () => {
  const deps = clock(async () => new Response("starting", { status: 503 }), 400);
  await assert.rejects(
    waitForHealthyService({ ...base, timeoutMs: 1000 }, deps),
    /within 1 seconds/,
  );
  assert.equal(deps.now(), 1050);
});

test("a never-ready service still fails within the bounded startup window", async () => {
  const deps = clock(async () => new Response("starting", { status: 503 }));
  await assert.rejects(waitForHealthyService(base, deps), /within 50 seconds/);
  assert.equal(deps.now(), 50_000);
});

test("child failure is propagated rather than waiting out the timeout", async () => {
  const deps = clock(async () => new Response("starting", { status: 503 }));
  await assert.rejects(waitForHealthyService({
    ...base,
    assertRunning: () => {
      if (deps.now() >= 500) throw new Error("FastAPI exited with code 1");
    },
  }, deps), /exited with code 1/);
  assert.equal(deps.now(), 500);
});

test("spawn errors are reported without making a probe", async () => {
  let probes = 0;
  const deps = clock(async () => { probes++; return new Response("ok"); });
  await assert.rejects(waitForHealthyService({
    ...base,
    assertRunning: () => { throw new Error("spawn python ENOENT"); },
  }, deps), /ENOENT/);
  assert.equal(probes, 0);
});
