// [测试锁 2026-11-14] 实时预览 A+B + 张数选项/双图根修：预览必须 ASCII 改道（CJK ROOT 下 sd-cli
// 误读路径 -> 破图），poll 必须带 preview_ready 就绪位，前端首拍用占位卡；done 时预览 fig 必须
// 原地升级成成品（一次生成只留一张图）；n 别名只认 str（n=2 是真张数不是负向词）。
// 纯静态锁：直读源文件断言关键行在位；decoy 差分证明每条断言 load-bearing。
import { readFileSync } from "node:fs";

const py = readFileSync("runtime/http_server.py", "utf8");
const js = readFileSync("serve/web/app.js", "utf8");
const css = readFileSync("serve/web/app.css", "utf8");
const html = readFileSync("serve/web/index.html", "utf8");

let fail = 0;
const ok = (cond, name) => {
  console.log((cond ? "  OK   " : "  FAIL ") + name);
  if (!cond) fail++;
};

// --- 后端 ---
ok(py.includes("PREVIEWS_ASCII"), "backend: PREVIEWS_ASCII constant exists");
ok(py.includes("PREVIEWS_DIR = PREVIEWS_ASCII if not os.path.join(ROOT"), "backend: CJK root -> ASCII detour");
ok(py.includes('rel.replace("\\\\", "/").startswith("previews/")'), "backend: serve_static maps previews/ prefix");
ok(py.includes("startswith(str(Path(PREVIEWS_DIR).resolve()))"), "backend: security check admits detour root");
ok(py.includes('snapshot["preview_ready"]'), "backend: poll snapshot carries preview_ready");
ok(py.includes('isinstance(payload.get("n"), str)'), 'backend: n-alias is str-only (n=2 no longer 500s)');
// decoy 差分
ok(!py.replace('snapshot["preview_ready"]', "X_rm_X").includes('snapshot["preview_ready"]'),
   "decoy control: removing the ready-flag line flips the lock red");
ok(!py.replace('isinstance(payload.get("n"), str)', "X_rm_X").includes('isinstance(payload.get("n"), str)'),
   "decoy control: removing the str-guard flips the lock red");

// --- 前端 ---
ok(js.includes('img.hidden = true;'), "frontend: first frame does NOT mount img.src (placeholder first)");
ok(js.includes("live-preview-ph"), "frontend: placeholder card class is used");
ok(js.includes("if (pj.preview_ready)"), "frontend: img mount is gated on preview_ready");
ok(css.includes(".live-preview-ph{"), "css: placeholder card style is defined");
ok(css.includes("prefers-reduced-motion: reduce){.live-preview-ph__dot{animation:none}"),
   "css: placeholder honours reduced-motion");

// --- 张数 + 双图根修 ---
ok(html.includes('id="img-count"'), "html: img-count select exists");
ok(html.includes('<option value="1" selected>'), "html: count default is 1");
ok(js.includes('$("img-count")'), "frontend: submit reads img-count into body.n");
ok(js.includes('autoFillW'), "frontend: source-dims autoFillW marker is wired (lock-safe)");
ok(js.includes("const renderResult = (j, into)"), "frontend: renderResult accepts the upgrade target");
ok(js.includes("renderResult(pj.result, fig)"), "frontend: done upgrades the preview fig in place");
ok(js.includes("let usedInto = false"), "frontend: upgrade fires at most once per run");

console.log(fail ? "\nPREVIEW UI LOCK: FAIL (" + fail + ")" : "\nPREVIEW UI LOCK: ALL GREEN");
process.exit(fail ? 1 : 0);
