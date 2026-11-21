# serve 根验证页清单（一次性，可清理）

> 本目录下的 `_*.html` 是一次性视觉验证 / 复现 / 定稿对比页，整批被 `.gitignore`
> 规则 `Nebula-agent/serve/_*.html` 忽略（不进 git），仅供本机复看，可随时清理。
> **本清单本身进 git**（名为 `VERIFICATION_PAGES.md`，不以 `_` 开头、不被 `_*.html` 吞），
> 作为「哪些验证页存在、各自做什么、能否安全删」的登记册，方便日后清理。
>
> 关键事实（本清单生成时实测）：这些页绝大多数引用 `web/tokens.css`，即依赖
> **它们位于 serve 根**这个位置才能正确加载样式——这正是 `tests/test_visual_http_render.py`
> 门禁锁定的根因（页面若被挪到 serve/web/ 下，相对 CSS 解析成 web/web/ 而 404、截图黑块）。
> 因此若要复看这些页，请用 http://（起一个 serve 根的 http.server），不要用 file://。
>
> 门禁自身用的是 tempdir 自包含 fixture，**不依赖**下列任何一页；扫描代码/门禁引用后
> 全部为「无代码引用」（_brandlight 仅被 data/tool-log 历史对话日志快照提及，属噪音非代码引用）
> → 21 页全部理论可清理。
>
> 扫描脚本自身（tools/_q_*.py 已删）不计入引用，避免自污染。

| 文件 | 字节 | 最后修改 | 引用 tokens.css | 代码/门禁引用 | 用途 |
|---|---:|---|:---:|---|---|
| `_brandlight.html` | 2083 | 2026-10-26 | ✅ | 历史日志快照(噪音) | 品牌区/配色对比截图页 |
| `_d_status_pick.html` | 2426 | 2026-10-21 | ✅ | — | D 页背景 + 当前状态配色对比（title: D-status-pick） |
| `_final_D.html` | 2680 | 2026-10-21 | ✅ | — | 配色定稿对比页（title: final-D） |
| `_lightdot_pair.html` | 1585 | 2026-10-21 | — | — | 明暗状态点 pairwise 对比（title: pairwise） |
| `_lightdot_test.html` | 2143 | 2026-10-21 | ✅ | — | 明暗状态点实测（title: light-real） |
| `_lightfull_test.html` | 4280 | 2026-10-21 | ✅ | — | 明暗整页对比（title: light-full） |
| `_pick_green.html` | 4501 | 2026-10-21 | ✅ | — | 绿色档定稿对比（title: pick-green） |
| `_pixeldiag.html` | 4035 | 2026-10-28 | ✅ | — | 像素诊断页（differential 探针源） |
| `_repro_baseline.html` | 90341 | 2026-11-01 | ✅ | — | 星尘/渲染复现：基线 |
| `_repro_bigStars.html` | 90398 | 2026-11-01 | ✅ | — | 星尘/渲染复现：大星 |
| `_repro_fenceNear.html` | 90413 | 2026-11-01 | ✅ | — | 星尘/渲染复现：围栏邻近 |
| `_repro_full.html` | 91146 | 2026-11-01 | ✅ | — | 星尘/渲染复现：整页 |
| `_repro_hugePara.html` | 90344 | 2026-11-01 | ✅ | — | 星尘/渲染复现：超大段落 |
| `_repro_incr.html` | 90738 | 2026-11-01 | ✅ | — | 星尘/渲染复现：增量 |
| `_repro_mixedHuge.html` | 90419 | 2026-11-01 | ✅ | — | 星尘/渲染复现：混合超大 |
| `_repro_render.html` | 2816 | 2026-11-01 | — | — | 星尘/渲染复现：渲染 |
| `_repro_starStorm.html` | 90383 | 2026-11-01 | ✅ | — | 星尘/渲染复现：星暴 |
| `_repro_starsRun.html` | 90345 | 2026-11-01 | ✅ | — | 星尘/渲染复现：星流 |
| `_shot_light.html` | 1842 | 2026-10-28 | ✅ | — | 一次性 light 主题品牌区截图页（HTML 注释：复刻权威源品牌区 DOM，主题强制 light） |
| `_verify_arc_card_top.html` | 97960 | 2026-11-10 | ✅ | — | 执行过程折叠卡-置顶验证页 |
| `_verify_arc_sys.html` | 97959 | 2026-11-11 | ✅ | — | 执行过程折叠卡-系统块验证页 |

_清理判据：确认无门禁/脚本引用（上表引用列为 — 或仅历史日志快照）即可删；删除走 Windows 回收站。_
