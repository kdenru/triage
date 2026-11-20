import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./server.mjs";

let server;
let base;

before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function triage(body) {
  const response = await fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const MANUAL = { status: "manual_review", topic: null, draft: null };

test("valid request returns topic and draft", async () => {
  const { status, body } = await triage({ text: "Какая цена на тариф?" });
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "pricing");
  assert.ok(body.draft.trim().length > 0);
});

for (const [name, payload] of [
  ["empty string", { text: "" }],
  ["whitespace only", { text: "   \n" }],
  ["missing text", {}],
  ["non-string text", { text: 42 }],
  ["null body", "null"],
  ["broken JSON", "{oops"],
]) {
  test(`invalid input: ${name} -> 400`, async () => {
    const { status, body } = await triage(payload);
    assert.equal(status, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  });
}

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`model failure ${marker} -> manual_review`, async () => {
    const { status, body } = await triage({ text: `Где моя доставка? ${marker}` });
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL);
  });
}

test("model timeout -> manual_review within ~300 ms", async () => {
  const started = performance.now();
  const { status, body } = await triage({ text: "Цена? [timeout]" });
  const elapsed = performance.now() - started;
  assert.equal(status, 200);
  assert.deepEqual(body, MANUAL);
  assert.ok(elapsed < 600, `took ${Math.round(elapsed)} ms`);
});

test("provider that ignores abort signal is still cut off", async () => {
  const hanging = createApp({ classifyFn: () => new Promise(() => {}), timeoutMs: 50 }).listen(0, "127.0.0.1");
  await new Promise((resolve) => hanging.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${hanging.address().port}/api/triage`, {
      method: "POST",
      body: JSON.stringify({ text: "привет" }),
    });
    assert.deepEqual(await response.json(), MANUAL);
  } finally {
    hanging.close();
  }
});
