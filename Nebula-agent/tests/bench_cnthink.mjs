// bench_cnthink.mjs — 真实 A/B 基准：强制中文思考（cnThink）开关对速度/上下文/产出的影响
//
// 复刻前端 streamAssistant 的请求形态（OpenAI 兼容 /v1/chat/completions），对同一个中文
// 推理任务分别用「cnThink=OFF（仅 BASE_SYSTEM）」与「cnThink=ON（BASE_SYSTEM + 中文思考规则）」
// 各跑两次（交替顺序以抵消冷启动/预热偏差），比较：
//   - 上下文占用（prompt_tokens，应因多一条规则而略增）
//   - 推理 token 数 / 输出 token 数 / 总完成 token 数
//   - 首 token 延迟（TTFT）、思考时长、生成时长、总时长
//   - 推理速度（reasoning tok/s，若引擎上报 reasoning_tokens）、输出速度（content tok/s）
//
// 用法：node tests/bench_cnthink.mjs
// 依赖：Node 22 自带 fetch，无需第三方包。

const API_URL = "http://127.0.0.1:8080/v1/chat/completions";
const MODEL = "swift-1.5-iq3_xxs";          // 来自 /health 实时探测

// —— 与 serve/web/app.js 完全一致，避免漂移 ——
const BASE_SYSTEM =
  "你是一个名为 Strata 的本地智能体助手，运行在用户自己的机器上，帮助用户完成编程、文件处理与自动化任务。\n" +
  "【语言】始终使用简体中文撰写你的最终回答（代码、命令、变量名、技术专有名词可保留原文）。即使用户用其他语言提问，或粘贴了英文报错/文档，你也要用中文向用户解释与总结。";
const CN_THINK_RULE = "\n【思考语言】请同样使用中文进行内部思考（reasoning），与最终回答保持一致。";

// 一个需要推理（先分析再给方案）的中文任务；temperature=0 保证可复现
const PROMPT =
  "请分析下面这段 Python 代码的性能问题，并给出三种优化方案，用中文解释每种方案的取舍：\n\n" +
  "def fib(n):\n" +
  "    if n < 2:\n" +
  "        return n\n" +
  "    return fib(n - 1) + fib(n - 2)\n\n" +
  "要求：先说明它为什么慢（时间复杂度），再给出三种优化思路，最后用一句话总结你最推荐哪一种。";

async function runOnce(cnThink) {
  const sys = BASE_SYSTEM + (cnThink ? CN_THINK_RULE : "");
  const body = {
    model: MODEL,
    stream: true,
    reasoning_effort: "high",   // 对应默认 settings.thinking
    temperature: 0,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: PROMPT },
    ],
  };

  const t0 = Date.now();
  let firstTokAt = null, firstReasoningAt = null, firstContentAt = null, endAt = null;
  let reasoning = "", content = "", usage = null;

  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error("HTTP " + r.status + " " + txt.slice(0, 500));
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try { j = JSON.parse(data); } catch (e) { continue; }
      if (j.usage) usage = j.usage;
      const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
      if (d.reasoning_content) {
        if (!firstTokAt) firstTokAt = Date.now();
        if (!firstReasoningAt) firstReasoningAt = Date.now();
        reasoning += d.reasoning_content;
      }
      if (d.content) {
        if (!firstTokAt) firstTokAt = Date.now();
        if (!firstContentAt) firstContentAt = Date.now();
        content += d.content;
      }
    }
  }
  endAt = Date.now();

  const thinkSecs = (firstReasoningAt && firstContentAt)
    ? (firstContentAt - firstReasoningAt) / 1000 : 0;
  const genSecs = firstContentAt ? (endAt - firstContentAt) / 1000 : (endAt - t0) / 1000;
  const comp = usage ? usage.completion_tokens : null;
  const pt = usage ? usage.prompt_tokens : null;
  const rdet = (usage && usage.completion_tokens_details)
    ? usage.completion_tokens_details.reasoning_tokens : null;
  const outTok = (comp != null && rdet != null) ? Math.max(0, comp - rdet) : comp;
  const outTokS = (outTok != null && genSecs > 0.25) ? outTok / genSecs : null;
  const thinkTokS = (rdet != null && thinkSecs > 0.25) ? rdet / thinkSecs : null;

  return {
    cnThink,
    ttft_s: firstTokAt ? +((firstTokAt - t0) / 1000).toFixed(2) : null,
    think_s: +thinkSecs.toFixed(2),
    gen_s: +genSecs.toFixed(2),
    total_s: +((endAt - t0) / 1000).toFixed(2),
    prompt_tokens: pt,
    completion_tokens: comp,
    reasoning_tokens: rdet,
    out_tokens: outTok,
    out_tok_s: outTokS != null ? +outTokS.toFixed(1) : null,
    think_tok_s: thinkTokS != null ? +thinkTokS.toFixed(1) : null,
    reasoning_chars: reasoning.length,
    content_chars: content.length,
    content,
  };
}

function avg(arr, key) {
  const xs = arr.filter(x => x[key] != null).map(x => x[key]);
  if (!xs.length) return null;
  return +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
}

async function main() {
  console.log(`model=${MODEL}  endpoint=${API_URL}`);
  console.log("running A/B (off, on, on, off) to balance warmup...\n");

  const order = [false, true, true, false];
  const runs = [];
  for (let i = 0; i < order.length; i++) {
    const cn = order[i];
    process.stdout.write(`  [${i + 1}/4] cnThink=${cn ? "ON " : "OFF"} ... `);
    const res = await runOnce(cn);
    runs.push(res);
    console.log(`done  total=${res.total_s}s  prompt=${res.prompt_tokens}tk  comp=${res.completion_tokens}tk  out=${res.out_tok_s ?? "-"}tok/s`);
  }

  const off = runs.filter(r => !r.cnThink);
  const on = runs.filter(r => r.cnThink);

  const summarize = (label, grp) => ({
    label,
    prompt_tokens: avg(grp, "prompt_tokens"),
    completion_tokens: avg(grp, "completion_tokens"),
    reasoning_tokens: avg(grp, "reasoning_tokens"),
    out_tokens: avg(grp, "out_tokens"),
    ttft_s: avg(grp, "ttft_s"),
    think_s: avg(grp, "think_s"),
    gen_s: avg(grp, "gen_s"),
    total_s: avg(grp, "total_s"),
    out_tok_s: avg(grp, "out_tok_s"),
    think_tok_s: avg(grp, "think_tok_s"),
    reasoning_chars: avg(grp, "reasoning_chars"),
    content_chars: avg(grp, "content_chars"),
  });

  const so = summarize("OFF (仅中文输出)", off);
  const sn = summarize("ON  (中文输出+中文思考)", on);

  const pct = (a, b) => (a != null && b != null && b !== 0) ? (((a - b) / b) * 100).toFixed(1) + "%" : "-";
  const row = (k, a, b) => `  ${k.padEnd(18)} ${String(a).padStart(12)} ${String(b).padStart(12)} ${String(pct(a, b)).padStart(10)}`;

  console.log("\n==================== A/B 对比（各取两次均值） ====================");
  console.log(`  ${"指标".padEnd(18)} ${"OFF".padStart(12)} ${"ON".padStart(12)} ${"ON vs OFF".padStart(10)}`);
  console.log(row("上下文 prompt_tk", so.prompt_tokens, sn.prompt_tokens));
  console.log(row("总完成 token", so.completion_tokens, sn.completion_tokens));
  console.log(row("推理 token", so.reasoning_tokens, sn.reasoning_tokens));
  console.log(row("输出 token", so.out_tokens, sn.out_tokens));
  console.log(row("首token延迟 s", so.ttft_s, sn.ttft_s));
  console.log(row("思考时长 s", so.think_s, sn.think_s));
  console.log(row("生成时长 s", so.gen_s, sn.gen_s));
  console.log(row("总时长 s", so.total_s, sn.total_s));
  console.log(row("输出速度 tok/s", so.out_tok_s, sn.out_tok_s));
  console.log(row("推理速度 tok/s", so.think_tok_s, sn.think_tok_s));
  console.log(row("推理字数", so.reasoning_chars, sn.reasoning_chars));
  console.log(row("正文汉字数", so.content_chars, sn.content_chars));
  console.log("==================================================================");

  // 质量侧写：打印 ON 组首次输出的正文开头，便于人工对比（中文是否更顺、是否多废话）
  const sample = on[0];
  console.log("\n--- 质量侧写：cnThink=ON 首次回复正文（前 600 字）---");
  console.log(sample.content.slice(0, 600));

  const out = { model: MODEL, prompt: PROMPT, runs, summary: { off: so, on: sn } };
  const fs = await import("node:fs");
  fs.writeFileSync(new URL("./bench_cnthink.result.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("\n结果已写入 tests/bench_cnthink.result.json");
}

main().catch(e => { console.error("BENCH FAILED:", e); process.exit(1); });
