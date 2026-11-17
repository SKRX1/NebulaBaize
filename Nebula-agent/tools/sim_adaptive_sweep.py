#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自适应压缩阈值 · 扫参实验（模型，非实测）

目的：不拍脑袋定魔法数。把候选「自动压缩触发阈值 T」逐个跑一遍，量化每档的
权衡，供人工决定把自适应因子（app.js:2155 的 0.85）和地板（2157 的 50）调多大。

T 与本机的关系（native=128000 兜底, maxCtx=131072）：
    T = clamp(factor * 128000/131072 * 100, floor, 90) = clamp(factor*97.7, floor, 90)
    factor 0.85 -> 83%  | 0.75 -> 73% | 0.65 -> 64% | 0.55 -> 54% | <=0.50 被地板 50 钳住
    => 想落到 50 以下，必须同时把地板(50)调低，否则 factor 再小也无用。

每档量化的指标：
- 峰值     = 触发点本身（压缩前最高占用）
- 平均占用 = 整段会话均值
- 溢出余量 = 92%(溢出护栏) - 峰值
- 压缩次数 = 80 回合内触发 compaction 的次数（= 中断/总结调用成本）
- 单回合溢出风险 = 峰值 + 2条未封顶工具结果(2*10000/131072=15.3%) 是否超过 92%
  （keep_recent=2 条工具结果不封顶，单条可达 max_result_chars=10000）

注意：压缩后回落到的「地板」≈ 固定免疫区(9%) + 尾部(17%) + 摘要(4%) = 30%，
由压缩器 tail/summary + tool_keep_recent 决定，**不随 T 变化**。所以降 T 只压
峰值/均值/溢出风险，不压那 30% 地板。
"""
import os

W = 131072            # token 窗口 (STRATA_MAX_CONTEXT)
F = 0.09 * W          # 固定免疫开销：system + 工具 schema + RULES
TAIL = 0.17 * W       # 最近消息原样保留（含 tool_keep_recent 未封顶）
SUMMARY = 0.04 * W    # 压缩后中间段摘要上限
FLOOR = F + TAIL + SUMMARY          # = 0.30*W 压缩后地板（恒定）
G = 0.045 * W         # 每个 agent 回合平均新增 token
KEEP_RECENT_BYTES = 2 * 10000       # tool_keep_recent=2 * max_result_chars
WORST_JUMP = KEEP_RECENT_BYTES / W * 100.0   # 单回合最坏跳变 ≈15.3%
OVERFLOW = 0.92 * W
GUARD_PCT = 92.0
TURNS = 80


def simulate(threshold):
    occ = FLOOR
    series = []
    compactions = 0
    peak = 0.0
    for _ in range(TURNS):
        occ += G
        peak = max(peak, occ)
        if occ >= threshold / 100.0 * W:
            compactions += 1
            occ = FLOOR
        series.append(occ / W * 100.0)
    avg = sum(series) / len(series)
    worst_peak = threshold + WORST_JUMP
    at_risk = worst_peak > GUARD_PCT
    return series, peak / W * 100.0, avg, compactions, worst_peak, at_risk


# 候选阈值（覆盖 factor 0.85->0.35 对应的 T，含需降地板才能达的档）
CANDIDATES = [83, 73, 64, 54, 50, 45, 40, 35, 30]


def main():
    print(f"window W={W}  fixed_immune={F/W*100:.0f}%  FLOOR={FLOOR/W*100:.0f}%  "
          f"per_turn_G={G/W*100:.1f}%  worst_jump={WORST_JUMP:.1f}%  guard={GUARD_PCT:.0f}%")
    print(f"{'T%':>4} {'峰值%':>6} {'均值%':>6} {'溢出余量%':>9} {'压缩次数':>7} "
          f"{'最坏峰值%':>9} {'风险':>4}  {'需降地板?':>9}")
    rows = []
    for T in CANDIDATES:
        s, pk, avg, c, wp, risk = simulate(T)
        need_floor = "是(地板>%d)" % T if T < 50 else "否"
        flag = "高" if risk else "低"
        print(f"{T:>4} {pk:>6.1f} {avg:>6.1f} {GUARD_PCT-pk:>9.1f} {c:>7} "
              f"{wp:>9.1f} {flag:>4}  {need_floor:>9}")
        rows.append((T, pk, avg, GUARD_PCT - pk, c, wp, risk, need_floor, s))

    # ---- 输出 HTML（完整表格 + 代表性 5 条曲线）----
    out_dir = os.path.join(os.path.dirname(__file__), "..", "outputs")
    os.makedirs(out_dir, exist_ok=True)

    def x(i, n):
        return 56 + (i * (780 - 56 - 16) / max(1, n - 1))

    def y(p):
        return 16 + (380 - 16 - 34) - (p / 100.0) * (380 - 16 - 34)

    def poly(series):
        return " ".join(f"{x(i, len(series)):.1f},{y(v):.1f}" for i, v in enumerate(series))

    grid = ""
    for p in (0, 20, 40, 60, 80, 100):
        yy = y(p)
        grid += (f'<line x1="56" y1="{yy:.1f}" x2="764" y2="{yy:.1f}" stroke="#e2e8f0"/>'
                 f'<text x="48" y="{yy+4:.1f}" text-anchor="end" font-size="11" fill="#64748b">{p}%</text>')
    fl = y(FLOOR / W * 100.0)
    og = y(GUARD_PCT)
    guides = (f'<line x1="56" y1="{fl:.1f}" x2="764" y2="{fl:.1f}" stroke="#94a3b8" '
              f'stroke-dasharray="5 4"/>'
              f'<text x="764" y="{fl-5:.1f}" text-anchor="end" font-size="10" fill="#64748b">'
              f'压缩后地板 ~{FLOOR/W*100:.0f}%（不随 T 变）</text>'
              f'<line x1="56" y1="{og:.1f}" x2="764" y2="{og:.1f}" stroke="#ef4444" '
              f'stroke-dasharray="5 4"/>'
              f'<text x="764" y="{og-5:.1f}" text-anchor="end" font-size="10" fill="#ef4444">'
              f'溢出护栏 {GUARD_PCT:.0f}%</text>')

    chart_lines = ""
    legend = ""
    for T, _, _, _, _, _, _, _, s in rows:
        if T not in (83, 64, 50, 40, 30):
            continue
        color = {83: "#ef4444", 64: "#f59e0b", 50: "#22c55e", 40: "#3b82f6", 30: "#8b5cf6"}[T]
        chart_lines += (f'<polyline points="{poly(s)}" fill="none" stroke="{color}" '
                        f'stroke-width="1.5"/>')
        legend += (f'<div style="display:flex;align-items:center;gap:6px;margin:2px 0">'
                   f'<span style="width:14px;height:3px;background:{color};display:inline-block">'
                   f'</span><span>T={T}%</span></div>')

    table_rows = ""
    for T, pk, avg, margin, c, wp, risk, need, _ in rows:
        rc = "#dc2626" if risk else "#16a34a"
        table_rows += (f"<tr><td>{T}%</td><td>{pk:.1f}%</td><td>{avg:.1f}%</td>"
                       f"<td>{margin:.1f}%</td><td>{c}</td><td>{wp:.1f}%</td>"
                       f"<td style='color:{rc};font-weight:600'>{'高' if risk else '低'}</td>"
                       f"<td>{need}</td></tr>")

    html = f"""<!doctype html><html lang='zh'><head><meta charset='utf-8'>
<title>自适应压缩阈值扫参</title>
<style>body{{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
max-width:900px;margin:24px auto;padding:0 16px;color:#0f172a}}
.note{{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;
font-size:13px;line-height:1.6;color:#334155}} code{{background:#f1f5f9;padding:1px 4px;border-radius:4px}}
table{{border-collapse:collapse;width:100%;margin:14px 0;font-size:13px}}
th,td{{border:1px solid #e2e8f0;padding:6px 8px;text-align:center}}
th{{background:#f1f5f9}}</style></head><body>
<h2>自适应压缩阈值 · 扫参实验（模型，非实测）</h2>
<div class='note'>本表/图是<strong>模型</strong>而非实测。假设：窗口={W} token，固定免疫≈{F/W*100:.0f}%，
压缩后地板≈{FLOOR/W*100:.0f}%（恒定，不随 T 变），每回合增长≈{G/W*100:.1f}%，
单回合最坏跳变≈{WORST_JUMP:.1f}%（keep_recent=2 条未封顶工具结果）。<br>
<strong>怎么读</strong>：T 越小→峰值/均值越低、距溢出护栏余量越大（更安全），但压缩次数越多
（每压一次=一次总结 LLM 调用 + 中途上下文被摘要，可能丢细节）。T 降到 50 以下还需同时把地板
（现 50）调低才会生效。真实曲线请用运行中的网关+引擎、观察 UI 上下文% 芯片。</div>
<svg xmlns="http://www.w3.org/2000/svg" width="780" height="380" viewBox="0 0 780 380"
 font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<rect width="780" height="380" fill="#fff"/>{grid}{guides}{chart_lines}
<line x1="56" y1="16" x2="56" y2="346" stroke="#cbd5e1"/>
<line x1="56" y1="346" x2="764" y2="346" stroke="#cbd5e1"/>
<text x="56" y="364" font-size="11" fill="#64748b">回合 0</text>
<text x="764" y="364" text-anchor="end" font-size="11" fill="#64748b">回合 {TURNS}</text>
</svg>
<div style="margin-top:-8px">{legend}</div>
<table><thead><tr><th>触发阈值 T</th><th>峰值</th><th>均值</th><th>溢出余量</th>
<th>压缩次数(80回合)</th><th>最坏峰值</th><th>单回合溢出风险</th><th>需降地板?</th></tr></thead>
<tbody>{table_rows}</tbody></table>
<div class='note'><strong>读数提示</strong>：压缩次数在 T=30 时高达 {[r for r in rows if r[0]==30][0][4]} 次
（几乎每回合都压，过度中断）；T=83 仅 {[r for r in rows if r[0]==83][0][4]} 次但最坏峰值
{[r for r in rows if r[0]==83][0][5]:.1f}% 贴近护栏、风险高。中段（50–64）在「安全」与「中断成本」间较平衡。
</div></body></html>"""
    path = os.path.join(out_dir, "adaptive_sweep.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
