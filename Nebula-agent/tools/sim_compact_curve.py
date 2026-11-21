#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上下文占用曲线 · 仿真（非实测）

说明：本脚本是**模型**，不是对真实任务的测量。它用一组显式假设演示「自动压缩
阈值」对占用曲线的影响，用来辅助判断把自动压缩阈值从「自适应默认 83%」降到
「UI 建议值 45%」会发生什么。真实数字请用运行中的网关+引擎、观察 UI 的上下文% 芯片。

关键结论（模型）：
- 压缩前峰值 = 阈值本身（83% vs 45%）。
- 压缩后回落到的「地板」≈ 固定免疫区 + 未压缩尾部 + 摘要上限，由压缩器 tail/summary
  旋钮决定，**不随 compactPct 变化**。所以降低阈值只会压低峰值/平均占用、远离 92%
  溢出护栏，但「压缩后还 ~30%」这个地板不变。要压地板得调 tool_keep_recent 或
  压缩器 max_chars。
"""
import os

W = 131072          # token 窗口 (STRATA_MAX_CONTEXT)
F = 0.09 * W        # 固定免疫开销：system prompt + 工具 schema + RULES
TAIL = 0.17 * W     # 最近消息原样保留（含 tool_keep_recent 未封顶部分）
SUMMARY = 0.04 * W  # 压缩后中间段摘要上限
G = 0.045 * W       # 每个 agent 回合平均新增 token
FLOOR = F + TAIL + SUMMARY
TURNS = 60
OVERFLOW_GUARD = 0.92 * W


def simulate(threshold):
    occ = FLOOR
    series = []
    compactions = 0
    for _ in range(TURNS):
        occ += G
        if occ >= threshold * W:
            compactions += 1
            occ = FLOOR
        series.append(occ / W * 100.0)
    return series, compactions


old_s, old_c = simulate(0.83)
new_s, new_c = simulate(0.45)
avg_old = sum(old_s) / len(old_s)
avg_new = sum(new_s) / len(new_s)

print(f"window W            = {W} tokens")
print(f"fixed immune F      = {F / W * 100:.1f}%")
print(f"post-compact FLOOR  = {FLOOR / W * 100:.1f}%  (unchanged by threshold)")
print(f"per-turn growth G   = {G / W * 100:.1f}%")
print(f"--- threshold 83% (old adaptive default) ---")
print(f"  peak ~83%, avg occupancy = {avg_old:.1f}%, compactions = {old_c}")
print(f"--- threshold 45% (UI-set, recommended) ---")
print(f"  peak ~45%, avg occupancy = {avg_new:.1f}%, compactions = {new_c}")
print(f"avg occupancy reduction: {avg_old - avg_new:.1f} pts; peak reduction: 38 pts")
print("NOTE: post-compaction floor (~30%) is set by compressor tail/summary, not by")
print("      compactPct. To lower the floor, reduce tool_keep_recent or compressor max_chars.")


def build_svg():
    m_l, m_r, m_t, m_b = 56, 16, 16, 34
    width, height = 780, 380
    plot_w = width - m_l - m_r
    plot_h = height - m_t - m_b

    def x(i, n):
        return m_l + (i * plot_w / max(1, n - 1))

    def y(p):  # p in percent 0..100
        return m_t + plot_h - (p / 100.0) * plot_h

    def poly(series):
        pts = " ".join(f"{x(i, len(series)):.1f},{y(v):.1f}" for i, v in enumerate(series))
        return pts

    # gridlines + y labels at 0,20,40,60,80,100
    grid = ""
    for p in (0, 20, 40, 60, 80, 100):
        yy = y(p)
        grid += (f'<line x1="{m_l}" y1="{yy:.1f}" x2="{width - m_r}" y2="{yy:.1f}" '
                 f'stroke="#e2e8f0" stroke-width="1"/>')
        grid += (f'<text x="{m_l - 8}" y="{yy + 4:.1f}" text-anchor="end" '
                 f'font-size="11" fill="#64748b">{p}%</text>')

    # floor line (30%) and overflow guard (92%)
    fl = y(FLOOR / W * 100.0)
    og = y(OVERFLOW_GUARD / W * 100.0)
    guides = (
        f'<line x1="{m_l}" y1="{fl:.1f}" x2="{width - m_r}" y2="{fl:.1f}" '
        f'stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="5 4"/>'
        f'<text x="{width - m_r}" y="{fl - 5:.1f}" text-anchor="end" font-size="10" fill="#64748b">'
        f'压缩后地板 ~{FLOOR / W * 100:.0f}%</text>'
        f'<line x1="{m_l}" y1="{og:.1f}" x2="{width - m_r}" y2="{og:.1f}" '
        f'stroke="#ef4444" stroke-width="1.2" stroke-dasharray="5 4"/>'
        f'<text x="{width - m_r}" y="{og - 5:.1f}" text-anchor="end" font-size="10" fill="#ef4444">'
        f'溢出护栏 92%</text>'
    )

    old_pts = poly(old_s)
    new_pts = poly(new_s)

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <rect width="{width}" height="{height}" fill="#ffffff"/>
  <text x="{width/2:.1f}" y="14" text-anchor="middle" font-size="13" font-weight="600" fill="#0f172a">上下文占用曲线仿真：阈值 83%(红) vs 45%(绿)</text>
  {grid}
  {guides}
  <polyline points="{old_pts}" fill="none" stroke="#ef4444" stroke-width="1.6" opacity="0.85"/>
  <polyline points="{new_pts}" fill="none" stroke="#22c55e" stroke-width="1.6"/>
  <line x1="{m_l}" y1="{m_t}" x2="{m_l}" y2="{height - m_b}" stroke="#cbd5e1" stroke-width="1"/>
  <line x1="{m_l}" y1="{height - m_b}" x2="{width - m_r}" y2="{height - m_b}" stroke="#cbd5e1" stroke-width="1"/>
  <text x="{m_l}" y="{height - 10}" font-size="11" fill="#64748b">回合 0</text>
  <text x="{width - m_r}" y="{height - 10}" text-anchor="end" font-size="11" fill="#64748b">回合 {TURNS}</text>
  <g font-size="11">
    <rect x="{m_l + 6}" y="{m_t + 4}" width="12" height="3" fill="#ef4444"/>
    <text x="{m_l + 22}" y="{m_t + 9}" fill="#334155">自适应默认 83% (峰值~83%, 均值{avg_old:.0f}%)</text>
    <rect x="{m_l + 6}" y="{m_t + 20}" width="12" height="3" fill="#22c55e"/>
    <text x="{m_l + 22}" y="{m_t + 25}" fill="#334155">UI 建议 45% (峰值~45%, 均值{avg_new:.0f}%)</text>
  </g>
</svg>'''
    return svg


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "outputs")
    os.makedirs(out_dir, exist_ok=True)
    svg = build_svg()
    html = (
        "<!doctype html><html lang='zh'><head><meta charset='utf-8'>"
        "<title>上下文占用曲线仿真</title>"
        "<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;"
        "max-width:840px;margin:24px auto;padding:0 16px;color:#0f172a}"
        ".note{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;"
        "padding:12px 14px;font-size:13px;line-height:1.6;color:#334155}"
        "code{background:#f1f5f9;padding:1px 4px;border-radius:4px}</style></head>"
        "<body><h2>上下文占用曲线仿真（模型，非实测）</h2>"
        + f"<div class='note'>本图是<strong>模型</strong>而非对真实任务的测量。假设：窗口={W} token，"
        f"固定免疫区≈{F/W*100:.0f}%，每回合增长≈{G/W*100:.1f}%，"
        f"压缩后地板≈{FLOOR/W*100:.0f}%（由压缩器 tail/summary 决定，不随阈值变）。<br>"
        "把阈值从「自适应默认 83%」降到「UI 建议 45%」：<strong>峰值</strong>从 ~83% 降到 ~45%、"
        "<strong>平均占用</strong>从 " + f"{avg_old:.0f}% 降到 {avg_new:.0f}%、更远离 92% 溢出护栏；"
        "但<strong>压缩后回落到的地板（~30%）不变</strong>——要压地板得调 "
        "<code>tool_keep_recent</code> 或压缩器 <code>max_chars</code>。"
        "真实曲线请用运行中的网关+引擎、观察 UI 的上下文% 芯片。</div>"
        + svg + "</body></html>"
    )
    path = os.path.join(out_dir, "compact_curve.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
