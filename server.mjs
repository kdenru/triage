import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const TOPICS = new Set(["delivery", "pricing", "other"]);
const MODEL_TIMEOUT_MS = 300;
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function parseInput(raw) {
  try {
    const body = JSON.parse(raw);
    const text = body?.text;
    return typeof text === "string" && text.trim() !== "" ? text : null;
  } catch {
    return null;
  }
}

// The model is untrusted: only a known topic and a non-empty draft count as a result.
function parseModelOutput(raw) {
  try {
    const { topic, draft } = JSON.parse(raw) ?? {};
    if (!TOPICS.has(topic) || typeof draft !== "string" || draft.trim() === "") return null;
    return { topic, draft: draft.trim() };
  } catch {
    return null;
  }
}

async function classifyWithTimeout(classifyFn, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Model timeout"));
    }, timeoutMs);
  });
  try {
    // race: a provider that ignores the signal still cannot hold the request
    return await Promise.race([classifyFn(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response, { classifyFn, timeoutMs }) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = parseInput(Buffer.concat(chunks).toString("utf8"));
  if (text === null) return json(response, 400, { status: "invalid_input" });

  let result = null;
  try {
    result = parseModelOutput(await classifyWithTimeout(classifyFn, text, timeoutMs));
  } catch {
    // timeout or provider error: fall through to manual review
  }
  if (!result) return json(response, 200, MANUAL_REVIEW);
  return json(response, 200, { status: "ready", ...result });
}

export function createApp({ classifyFn = classify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, { classifyFn, timeoutMs });
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
