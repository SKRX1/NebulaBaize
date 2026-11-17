# 约定：调度执行与聊天共用同一模型路由源（per-request routing single source of truth）

落地：commit 27181c8（master）。

## 核心约定
调度触发的任务执行，必须与聊天走同一条模型路由——即 `model_registry.selected`
（前端模型切换器选中的那个）。绝不能让调度停在「启动时固定的 client / boot upstream」。

## 路由决策规则（与 http_server._route_model 完全一致）
- 选中的 entry 带真实 `base_url` → 路由打到它（例：selected=swift-iq3_s → 47831）。
- 选中 entry 的 `base_url` 为空（""）→ 表示「本网关自身 upstream（8080）」→ 回退 boot client。
- selected 查不到 / registry 抛异常 → 回退 boot client，绝不让一次执行崩溃。

## 注入点铁律（最易踩的坑）
重定向 client 时**必须同时覆盖 agent.client 和 agent.planner.client**。
原因：Planner 在构造时就把 client 存成自己的 ref——
  - runtime/loop.py L67：`self.planner = Planner(client, [])`
  - runtime/planner.py L26：`self.client = client` → plan() 调 `self.client.chat(...)`
若只换 agent.client，planner 仍会从自己的 ref 打到 boot client，路由不生效。
注入用 try/finally 恢复；idle-gate 串行保证调度执行期间无交互 turn 并发（无竞争）。

## model_registry 文件解析顺序（聊天与调度共用，确保同源）
1. $STRATA_MODELS_CONFIG
2. $STRATA_PROJECT/config/models.json
3. <package>/config/models.json（shell 直接 import 命中此项）
4. <代码旁>/models.json

## 锁
- 离线锁：tests/test_scheduler_host.py 的 host-i（4 场景）。
- 差分锁：tests/test_scheduler_host_differential.py 的 D-i（模拟「修复前永远回退 boot client」这一历史 bug，必须只让 host-i 变红）。
