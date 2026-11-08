// Gate for #chunkretry: exactly-one retry budget for transient contention on llmSummarize.
// Differential pairs per project rule: (positive: exceeded-shape retried) vs (negative:
// non-exceeded error fails fast with NO retry) on both shapes -- SSE error chunk and
// HTTP-400-with-exceeded (direct upstream). Grab real function from disk + inject stubs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(path.join(ROOT, "serve", "web", "app.js"), "utf8");

// ---- static layer: the retry block must exist with its markers -------------
let fails = 0;
const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) fails++; };

ok("S1 MAX_ATTEMPTS constant present", SRC.includes("const MAX_ATTEMPTS = 2;"));
ok("S2 retry trigger on SSE error chunk", SRC.includes('if (j && j.error && typeof j.error.message === "string") { errHit = j.error.message; continue; }'));
ok("S3 transient-only gate (regex on errHit)", SRC.includes('if (attempt >= MAX_ATTEMPTS || !/exceeded/i.test(errHit)) break;'));
ok("S4 fetch-throw path gates on exceeded too", SRC.includes('if (attempt >= MAX_ATTEMPTS || !(e && e.message && /exceeded/i.test(String(e.message)))) throw e;'));
ok("S5 #chunkfail fallback intact", SRC.includes('if (!out.trim()) out = reasoningAcc;'));

// ---- differential layer: run the REAL function body with stubbed deps -------
// Extract llmSummarize function body from disk
const fnMatch = SRC.match(/async function llmSummarize\(userPrompt\) \{([\s\S]*?)\n\}/);
if (!fnMatch) { console.log("FAIL  function extraction"); fails++; }
const fnBody = fnMatch ? fnMatch[1] : "";

function makeStream(chunks) {
  // chunks: array of strings to feed as SSE data lines
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            const txt = "data: " + JSON.stringify(chunks[i++]) + "\n";
            return { done: false, value: new TextEncoder().encode(txt) };
          }
          return { done: true, value: undefined };
        }
      })
    }
  };
}

async function runDifferential(name, expected, fetchScript) {
  let calls = 0;
  const fetchStub = async () => fetchScript(calls);
  const sleep = async () => {};
  const headers = () => ({});
  const requestModel = () => "test-model";
  const COMPACT_SYS = "sys";
  const COMPACT_THINK_EFFORT = "low";
  const compactThinkBudget = () => 1024;
  const compactChunkMaxTokens = () => 4096;
  const activeId = "test-session";
  const t = (k) => k;
  const toast = () => {};
  const fetchWithRetry = async (url, init, opts) => {
    calls++;
    const r = await fetchStub();
    if (r instanceof Error) throw r;
    return r;
  };

  const fn = new Function(
    "fetchWithRetry", "sleep", "headers", "requestModel", "COMPACT_SYS",
    "COMPACT_THINK_EFFORT", "compactThinkBudget", "compactChunkMaxTokens",
    "activeId", "t", "toast", "TextDecoder", "userPrompt",
    `"use strict"; return (async function(userPrompt){${fnBody}})(userPrompt);`
  );

  let result, error;
  try {
    result = await fn(fetchWithRetry, sleep, headers, requestModel, COMPACT_SYS,
      COMPACT_THINK_EFFORT, compactThinkBudget, compactChunkMaxTokens,
      activeId, t, toast, globalThis.TextDecoder, "test prompt");
  } catch (e) { error = e; }

  const pass = expected.calls === calls &&
    (expected.msg === undefined || (error && error.message.includes(expected.msg))) &&
    (expected.result === undefined || result === expected.result);
  ok(name + ` (calls=${calls}, expected=${expected.calls})`, pass);
}

// D1 positive: SSE error chunk with "exceeded" -> retried once, second attempt succeeds
await runDifferential(
  "D1 SSE exceeded-chained -> retry succeeds",
  { calls: 2, result: "REAL ANSWER" },
  (n) => n === 1
    ? makeStream([{ error: { message: "upstream error: context window exceeded even when compacting" } }])
    : makeStream([{ choices: [{ delta: { content: "REAL ANSWER" } }] }])
);

// D2 negative: SSE error chunk WITHOUT exceeded word -> fail fast, NO retry
await runDifferential(
  "D2 non-exceeded SSE error -> fail fast (no retry)",
  { calls: 1, msg: "empty summary" },
  () => makeStream([{ error: { message: "upstream error: some other failure" } }])
);

// D3 positive: fetch itself throws Error containing "exceeded" (direct-upstream 400 shape) -> retried once, succeeds
await runDifferential(
  "D3 HTTP-400-with-exceeded throw -> retry succeeds",
  { calls: 2, result: "SECOND TRY OK" },
  (n) => n === 1
    ? new Error("HTTP 400: context window exceeded")
    : makeStream([{ choices: [{ delta: { content: "SECOND TRY OK" } }] }])
);

// D4 negative: fetch throws non-exceeded error -> fail fast, NO retry
await runDifferential(
  "D4 non-exceeded throw -> fail fast (no retry)",
  { calls: 1, msg: "HTTP 400: bad model id" },
  () => new Error("HTTP 400: bad model id")
);

// D5 guard: second attempt also gets exceeded -> budget exhausted, throws empty summary
await runDifferential(
  "D5 budget EXACTLY ONE -- second exceeded throws",
  { calls: 2, msg: "empty summary" },
  () => makeStream([{ error: { message: "upstream error: context window exceeded even when compacting" } }])
);

console.log("");
console.log(fails === 0 ? "ALL GREEN" : `FAILS: ${fails}`);
process.exit(fails ? 1 : 0);
