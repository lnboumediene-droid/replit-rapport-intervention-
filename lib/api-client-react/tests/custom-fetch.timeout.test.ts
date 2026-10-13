import assert from "node:assert/strict";
import test from "node:test";
import { customFetch } from "../src/custom-fetch";

async function mockFetch(run: () => Promise<void>, fake: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("a stalled request becomes an explicit timeout", async () => {
  let signal: AbortSignal | null | undefined;
  await mockFetch(async () => {
    await assert.rejects(customFetch("/api/reports", { timeoutMs: 20 }), { name: "RequestTimeoutError" });
    assert.equal(signal?.aborted, true);
  }, async (_input, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  });
});

test("the deadline also covers a stalled response body", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array>;
  await mockFetch(async () => {
    try {
      await assert.rejects(customFetch("/api/reports", { timeoutMs: 20 }), { name: "RequestTimeoutError" });
    } finally { stream!.close(); }
  }, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; },
  }), { headers: { "content-type": "application/json" } }));
});

test("successful JSON clears the deadline", async () => {
  let signal: AbortSignal | null | undefined;
  await mockFetch(async () => {
    assert.deepEqual(await customFetch("/api/reports", { timeoutMs: 20 }), []);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(signal?.aborted, false);
  }, async (_input, init) => {
    signal = init?.signal;
    return new Response("[]", { headers: { "content-type": "application/json" } });
  });
});

test("caller cancellation is not misreported as a timeout", async () => {
  const caller = new AbortController();
  await mockFetch(async () => {
    const request = customFetch("/api/reports", { timeoutMs: 500, signal: caller.signal });
    caller.abort();
    await assert.rejects(request, { name: "AbortError" });
  }, async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const cancel = () => reject(new DOMException("Cancelled", "AbortError"));
    if (init?.signal?.aborted) cancel();
    else init?.signal?.addEventListener("abort", cancel, { once: true });
  }));
});
