// 方案A 接线锁（前端 + 前后端一致，2026-11-28）。纯静态读源断言：默认项去硬编码改动态、boot
// GET 读取、「设为默认」按钮绑定、langchange 重刷、后端路由/方法/端点字符串前后端一致。
// 用「剥关键部分即翻红」decoy 差分证 load-bearing。镜像 test_sampling_snapshot_wiring.mjs 写法。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fePath = path.join(here, "..", "serve", "web", "app.js");
const htmlPath = path.join(here, "..", "serve", "web", "index.html");
const i18nPath = path.join(here, "..", "serve", "web", "i18n.js");
const bePath = path.join(here, "..", "runtime", "http_server.py");
const fe = fs.readFileSync(fePath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");
const i18n = fs.readFileSync(i18nPath, "utf8");
const be = fs.readFileSync(bePath, "utf8");

let pass = 0, fail = 0;
function lock(name, cond) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name); }
}

// ── 默认项不再硬编码：HTML 两个 value="" option 用 id（无 data-i18n 固定文案）──
lock("HTML-opt-sampling-id", html.includes('id="opt-sampling-default"'));
lock("HTML-opt-scheduler-id", html.includes('id="opt-scheduler-default"'));
lock("HTML-no-data-i18n-on-defaults",
  !/<option value="" id="opt-(sampling|scheduler)-default" data-i18n=/.test(html));

// ── 「设为默认」按钮存在且走端点 ──
lock("HTML-setbtn", html.includes('id="img-set-sampling-default"'));

// ── 前端 JS：动态文案函数 + 读取 + 按钮绑定 + langchange + boot ──
lock("FE-applySamplingDefaultLabels-def", /function\s+applySamplingDefaultLabels\s*\(\s*\)/.test(fe));
lock("FE-loadSamplingDefaults-def", /function\s+loadSamplingDefaults\s*\(\s*\)/.test(fe));
lock("FE-default-label-uses-t-withval", /t\("img\.defaultWithVal",\s*\{v:\s*_samplingDefaults\./.test(fe));
lock("FE-fetch-defaults-endpoint", fe.includes('"api/sampling-defaults"'));
lock("FE-boot-load-call", /loadSamplingDefaults\(\);\s*\/\/\s*boot/.test(fe));
lock("FE-setbtn-onclick", /\$\("img-set-sampling-default"\)\.onclick\s*=\s*async/.test(fe));
lock("FE-setbtn-posts-defaults", /method:\s*"POST",\s*headers:\s*headers\(true\),\s*\n\s*body:\s*JSON\.stringify\(body\)/.test(fe));
lock("FE-langchange-rerender", /addEventListener\("strata:langchange",\s*applySamplingDefaultLabels\)/.test(fe));

// ── i18n 新词条（zh + en 各一份，键存在）──
lock("I18N-defaultWithVal-zh", i18n.includes('"img.defaultWithVal": "默认（{v}）"'));
lock("I18N-defaultWithVal-en", i18n.includes('"img.defaultWithVal": "default ({v})"'));
lock("I18N-setAsDefault-zh", i18n.includes('"img.setAsDefault": "设为默认"'));

// ── 后端接线：常量 + 路由分支 + dispatch + 方法 def + 兜底 + 落盘路径 ──
lock("BE-defaults-const", /SAMPLING_DEFAULTS\s*=\s*os\.environ\.get\("STRATA_SAMPLING_DEFAULTS"/.test(be));
lock("BE-fallback-const", be.includes('SAMPLING_DEFAULTS_FALLBACK = {"sampling": "euler_a", "scheduler": "simple"}'));
lock("BE-route-branch", /path\.rstrip\("\/"\)\s*==\s*"\/api\/sampling-defaults"/.test(be));
lock("BE-route-dispatch", be.includes("self._api_sampling_defaults(method)"));
lock("BE-method-def", /def\s+_api_sampling_defaults\s*\(\s*self,\s*method/.test(be));
lock("BE-data-dir-default", be.includes("sampling_defaults.json"));

// ── 端点字符串前后端一致 ──
lock("ENDPOINT-consistent",
  fe.includes('"api/sampling-defaults"') && be.includes('"/api/sampling-defaults"'));

// ── decoy 差分：证关键锁 load-bearing ──
const wouldFail = (src, re) => !re.test(src);
const decoyBoot = fe.replace(/loadSamplingDefaults\(\);\s*\/\/\s*boot/, "void 0; // decoy");
lock("DECOY-boot-loadbearing", wouldFail(decoyBoot, /loadSamplingDefaults\(\);\s*\/\/\s*boot/));
const decoyBe = be.replace(/def\s+_api_sampling_defaults\s*\(\s*self,\s*method/, "def _REDACTED(self, method");
lock("DECOY-method-loadbearing", wouldFail(decoyBe, /def\s+_api_sampling_defaults\s*\(\s*self,\s*method/));
const decoyFallback = be.replace('SAMPLING_DEFAULTS_FALLBACK = {"sampling": "euler_a", "scheduler": "simple"}', "SAMPLING_DEFAULTS_FALLBACK = {}");
lock("DECOY-fallback-loadbearing", wouldFail(decoyFallback, be.includes("euler_a") ? /SAMPLING_DEFAULTS_FALLBACK = \{"sampling": "euler_a"/ : /SAMPLING_DEFAULTS_FALLBACK/));

console.log(`\nTOTAL pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
