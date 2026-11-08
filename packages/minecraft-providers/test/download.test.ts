import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchWithRetry, RETRY_DELAYS_MS } from "../src/download";

describe("fetchWithRetry", () => {
  const replies: number[] = [];
  let hits = 0;
  let base = "";
  const server = http.createServer((_req, res) => {
    hits++;
    res.statusCode = replies.shift() ?? 200;
    res.end("ok");
  });
  const saved = [...RETRY_DELAYS_MS];

  beforeAll(async () => {
    RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 5, 5);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, ...saved);
    server.close();
  });
  const run = async (codes: number[]) => {
    replies.splice(0, replies.length, ...codes);
    hits = 0;
    const res = await fetchWithRetry(base, {});
    return { status: res.status, hits };
  };

  it("retries transient server errors and rate limits", async () => {
    expect(await run([504, 429])).toEqual({ status: 200, hits: 3 });
  });
  it("gives up after three attempts and returns the last response", async () => {
    expect(await run([502, 503, 500, 200])).toEqual({ status: 500, hits: 3 });
  });
  it("does not retry client errors", async () => {
    expect(await run([404])).toEqual({ status: 404, hits: 1 });
  });
  it("retries connection errors but not aborts", async () => {
    await expect(fetchWithRetry("http://127.0.0.1:1", {})).rejects.toThrow();
    const ctrl = new AbortController();
    ctrl.abort();
    hits = 0;
    await expect(fetchWithRetry(base, { signal: ctrl.signal })).rejects.toThrow();
    expect(hits).toBe(0);
  });
});
