import assert from "node:assert/strict";
import { describe, it } from "node:test";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");

async function get(pathname: string): Promise<Response> {
  return fetch(`${base}${pathname}`);
}

describe("cook door", () => {
  it("serves health, the cook page, and the run list", async () => {
    const health = await get("/api/health");
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { ok?: boolean; service?: string; authMode?: string };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.service, "autocook");
    assert.equal(healthBody.authMode, "dev");

    const page = await get("/");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="task-body"/);
    assert.match(html, /Task body/);

    const runs = await get("/api/runs");
    assert.equal(runs.status, 200);
    const body = (await runs.json()) as { runs?: unknown; me?: { userId?: string } };
    assert.ok(Array.isArray(body.runs));
    assert.equal(body.me?.userId, "local-dev");
  });

  it("refuses an empty task body", async () => {
    const json = await fetch(`${base}/api/cook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    assert.equal(json.status, 400);
    const jsonBody = (await json.json()) as { error?: string };
    assert.match(jsonBody.error ?? "", /task body/);

    const form = new FormData();
    form.set("prompt", "");
    form.append("inputs", new Blob([Buffer.from("hello")]), "note.txt");
    const small = await fetch(`${base}/api/cook`, { method: "POST", body: form });
    assert.equal(small.status, 400);
    const smallBody = (await small.json()) as { error?: string };
    assert.match(smallBody.error ?? "", /task body/);
  });

  it("accepts a package larger than 10 MB without starting a cook", { timeout: 120_000 }, async () => {
    const form = new FormData();
    form.set("prompt", "");
    form.append("inputs", new Blob([Buffer.alloc(11 * 1024 * 1024)]), "package.bin");
    const response = await fetch(`${base}/api/cook`, { method: "POST", body: form });
    const text = await response.text();
    assert.equal(response.status, 400, text);
    assert.match(text, /task body/);
    assert.equal(/FormData|Failed to parse body/i.test(text), false);
  });
});
