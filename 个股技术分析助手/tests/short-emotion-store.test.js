// @vitest-environment node
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("short-emotion data branch (file store → GitHub read store)", () => {
  const dir = mkdtempSync(join(tmpdir(), "short-emotion-data-"));
  let realFetch;

  beforeAll(() => {
    process.env.WIND_MOCK = "1";
    process.env.SHORT_EMOTION_STORE = "file";
    process.env.SHORT_EMOTION_DATA_DIR = dir;
    realFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    delete process.env.SHORT_EMOTION_STORE;
    delete process.env.SHORT_EMOTION_DATA_DIR;
  });

  it("the Actions job writes snapshots that the Vercel read API can serve", async () => {
    const { runScheduledRefresh, readResource } = await import("../api/_lib/short-emotion/service.js");
    const result = await runScheduledRefresh({ force: true });
    expect(result.status).toBe("ok");

    // Vercel side: read-only store over raw.githubusercontent.com, served here from the same files.
    process.env.SHORT_EMOTION_STORE = "github";
    process.env.SHORT_EMOTION_DATA_URL = "https://raw.example/short-emotion-data";
    globalThis.fetch = async (url) => {
      const relative = String(url).replace("https://raw.example/short-emotion-data/", "");
      try {
        const body = readFileSync(join(dir, relative), "utf8");
        return new Response(body, { status: 200 });
      } catch {
        return new Response("not found", { status: 404 });
      }
    };

    const emotion = await readResource("emotion");
    expect(emotion.score).toBeGreaterThan(0);
    expect(emotion.storedAt).toBeTruthy();
    const anomalies = await readResource("anomalies");
    expect(Array.isArray(anomalies.items)).toBe(true);
    const history = await readResource("history");
    expect(history.history.length).toBeGreaterThan(0);
    const status = await readResource("status");
    expect(status.storage).toBe("github");
    expect(status.lastRun.status).toBe("ok");
  });

  it("the read-only store refuses writes", async () => {
    const { getStore } = await import("../api/_lib/short-emotion/store.js");
    process.env.SHORT_EMOTION_STORE = "github";
    await expect(getStore().kvSet("x", 1)).rejects.toThrow();
  });

  it("keeps A股 and 台股 apart when reading the data branch", async () => {
    process.env.SHORT_EMOTION_STORE = "github";
    process.env.SHORT_EMOTION_DATA_URL = "https://raw.example/split";
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.endsWith("/split/kv/emotion_latest.json")) return new Response(JSON.stringify({ value: { score: 42 } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const { getStore } = await import("../api/_lib/short-emotion/store.js");
    expect((await getStore("cn").kvGet("emotion:latest")).value.score).toBe(42);
    expect(await getStore("tw").kvGet("emotion:latest")).toBeNull();
  });
});
