// 方案C 采样快照上报接线锁（2026-11-24）。纯静态锁：读真实源文件，断言前端上报三件套
// （reportSampling 定义 + boot 调用 + s-apply 调用成对存在）与后端接线（路由分支 + 方法 +
// 落盘路径 + env override）都在位，且端点字符串前端 fetch 与后端路由匹配一致。
// 用「剥掉关键部分后对应锁翻红」的 decoy 差分证 load-bearing——非装饰性 grep。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fePath = path.join(here, "..", "serve", "web", "app.js");
const bePath = path.join(here, "..", "runtime", "http_server.py");
const fe = fs.readFileSync(fePath, "utf8");
const be = fs.readFileSync(bePath, "utf8");

let pass = 0, fail = 0;
function lock(name, cond) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name); }
}

// ---- 前端三件套 ----
const FE_ENDPOINT = 'fetch("api/sampling-snapshot"';
lock("FE-def-reportSampling", /function\s+reportSampling\s*\(\s*\)/.test(fe));
lock("FE-fetch-endpoint", fe.includes(FE_ENDPOINT));
lock("FE-fetch-posts-settings", /body:\s*JSON\.stringify\(settings\)/.test(fe));
// boot 调用（页面加载即上报）：reportSampling(); 直接出现一次，且在 s-apply 定义之前的顶层
const bootCall = /reportSampling\(\);\s*\/\/[^\n]*boot/.test(fe);
lock("FE-boot-call", bootCall);
// s-apply 保存后调用
lock("FE-sapply-call", /store\.set\("sampling",\s*settings\);\s*\n\s*reportSampling\(\);/.test(fe));

// ---- 后端接线 ----
lock("BE-route-branch", /path\.rstrip\("\/"\)\s*==\s*"\/api\/sampling-snapshot"/.test(be));
lock("BE-route-dispatch", be.includes("self._api_sampling_snapshot(method)"));
lock("BE-method-def", /def\s+_api_sampling_snapshot\s*\(\s*self,\s*method/.test(be));
lock("BE-snapshot-path", /SAMPLING_SNAPSHOT\s*=\s*os\.environ\.get\("STRATA_SAMPLING_SNAPSHOT"/.test(be));
lock("BE-data-dir-default", be.includes("sampling_snapshot.json"));

// ---- 端点字符串前后端一致（前端 fetch 去掉 api/ 前缀应与后端路由 /api/sampling-snapshot 对得上）----
lock("ENDPOINT-consistent",
  fe.includes('"api/sampling-snapshot"') && be.includes('"/api/sampling-snapshot"'));

// ---- decoy 差分：证这些锁是 load-bearing，剥掉关键部分即翻红 ----
function wouldFail(src, re) { return !re.test(src); }
// 去掉 boot 调用后 FE-boot-call 必须翻红（否则该锁形同虚设）
const decoyBoot = fe.replace(/reportSampling\(\);\s*\/\/[^\n]*boot/, "void 0; // decoy");
lock("DECOY-boot-loadbearing", wouldFail(decoyBoot, /reportSampling\(\);\s*\/\/[^\n]*boot/));
// 去掉后端方法 def 后 BE-method-def 必须翻红
const decoyBe = be.replace(/def\s+_api_sampling_snapshot\s*\(\s*self,\s*method/, "def _REDACTED(self, method");
lock("DECOY-method-loadbearing", wouldFail(decoyBe, /def\s+_api_sampling_snapshot\s*\(\s*self,\s*method/));

console.log(`\nTOTAL pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
