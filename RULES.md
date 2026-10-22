星云前端唯一权威源是工作区 serve/web/，改前端只改这里；Strata-main\serve\web 是 robocopy /MIR 同步的副本，禁止手改
前端改动后通过双击 deploy_to_strata.bat 同步到寄生模式 Strata-main；后端/skills/mcp_servers.json 改动不需部署，重启进程即生效（寄生模式需重启 Strata）
含中文路径（星云智能体）的 robocopy 命令行直调会因代码页失败，优先双击 bat 执行；自动化脚本需先 chcp 65001
部署脚本用 GBK 编码保存，勿用 UTF-8 编辑器另存覆盖，否则中文路径乱码
前端所有非对话视图(.view)统一由一个内容容器负责滚动，新增视图不要逐名加 overflow-y，避免遗漏
记忆页等含长内容的标签页：统一「整页滚」或「卡内滚」一种滚动归属，避免双层滚动条
前端 serve/web 改动并验证通过后，默认由我主动执行 cp+逐文件MD5校验 同步到 Strata-main 寄生副本（中文路径禁用 robocopy 命令行直调）
仅前端需同步部署；后端/skills/mcp_servers.json 改动只需重启进程，不需部署
要让模型真能看图（多模态），须在独立模式三层打通：_mcp_base 加结构化 image 返回通道（向后兼容，call_tool 返回 str 时行为不变）+ browser screenshot 返回 base64 image 块 + executor.py 组装多模态消息
browser__screenshot 只存盘回路径、不读 PNG；需要"识别图片"时不能只看该工具输出，必须另走多模态入口
寄生模式看图依赖宿主补丁：MCP 服务端已产出 image 块，第三方客户端 result_text 会拍平它，须由 apply_host_patch.py 在 call()/loop 两处把它透成结构化 image part 才能送达模型
每次 Strata 升级都会重写 serve/ 冲掉补丁，升级后必须重跑 apply_host_patch.py 或双击 deploy_host_patch.bat 重放，否则寄生模式看图失效（upgrade_check.py 会顺带报补丁是否在位）
宿主多模态补丁权威源是 strata-agent/tools/apply_host_patch.py，锚点式重放；补丁落点是第三方客户端两处锚点：serve/mcp.py 的 call() 末尾（携带结构化 content）+ serve/server.py 的 run_with_mcp results 组装（content 优先于 text）；frontend 已原生支持 tool 消息读 image，无需改
锚点补丁脚本铁律：按行 strip 匹配（免受行尾/缩进微调影响）、幂等（MARK 标记行）、改写前自动备份、锚点命中数≠1 时报错交人工不盲改
锚点补丁/部署 bat 保持纯 ASCII 提示，避免中文 echo 经代码页乱码被误解析为命令；deploy_host_patch.bat 已按此改写
锚点补丁/部署类 bat 一律纯 ASCII 提示，避免中文 echo 经代码页乱码被 cmd 误当命令执行；deploy_host_patch.bat 已按此改写
寄生看图的复验夹具固定在 strata-agent/tools/_live_vision.py + 工作区 vision_test.html（紫底黄字 PARROT）：重启加载补丁后跑一次即可确认模型能描述真图
_live_vision.py --assert 为 CI 回归门禁：硬断言 PARROT+purple 必须双路通过才绿灯；软断言（红/绿/蓝/橙）为警告不影响退出码
vision_test.html 现为多物体版（红圆/蓝矩形/绿三角/橙菱形/黄色PARROT/紫底），vision_test_shot.png 为其配套截图
START-HERE.bat 已被补丁管理（锚点 ::STRATA-MULTIMODAL-PATCH）；首次升级需手动重放一次 deploy_host_patch.bat 之后永久自动
apply_host_patch.py --quiet 模式为 START-HERE.bat 静默重放专用，仅在实际写入时输出（正常启动零输出）
shell MCP server 执行命令必须 stdin=subprocess.DEVNULL 且 try/except subprocess.TimeoutExpired 返回字符串：否则未闭合引号的命令会挂在继承来的 JSON-RPC stdin 上死等，且超时异常冲垮 MCP 响应链会污染该 server 后续所有请求（连简单 echo 都超时）
写命令路径不要带尾部反斜杠紧贴闭合引号（...\）——反斜杠会转义引号导致未闭合；PowerShell 用 ; 而非 && 分隔
shell_server.py 等 servers/ 下脚本改动需重启该 MCP server 才生效；重启会切断经由它执行工具的当前会话（自重启），需用户决定时机
读写编码必须对称：凡按代码页(GBK)写出的文件，读取侧也要镜像(读字节→试utf-8→回退gbk)，否则幂等/二次读取会 UnicodeDecodeError 崩溃
CI 断言关键词匹配须识别否定语境：模型说"NO red circles"时，纯子串匹配会把"no red"误判为 PASS；应加否定词检测或词边界，否则软断言假阳性误导
量化小模型(IQ3_S 级)对多物体/小图形的分辨力有限，常只识别主背景+主文字；多物体断言应作软警告，CI 门禁只锁主特征(PARROT/purple)
_live_vision.py 的 max_tokens 设 800；硬断言=CI 红绿线(双路必须过)，软断言=多物体能力探针(仅警告)
自动压缩阈值现为前端硬编码常量 AUTO_COMPACT_PCT=85，settings 无对应字段；加可调阈值要在 app.js 默认/保存/读取三处对称新增字段（遵守读写对称铁律）
自适应触发点必须=窗口−安全余量，余量≥压缩请求自身输入+一次往返（压缩动作本身也烧token，近100%才触发会塞不下压缩请求）
压缩策略是append-only分区冻结(为前缀缓存热)，自适应应"晚压+一次压够"，禁止频繁小压缩打断缓存
"自适应"要有可观测反馈信号才成立；当前只有占用比例+压缩成本，质量退化无可量化反馈(小模型尤甚)，故纯自适应=伪自适应，只做"按窗口调余量"
部署铁律：星云工作区 serve/web/ 是唯一真相源，任何 Strata 实例的 serve/web/ 都是它的镜像，方向永不逆转
单点风险防护：建议定期将 serve/web/ 打包 zip 存到云盘或 Git（工作区本身丢失则 BAT 无法恢复）
BAT 部署命令：deploy_to_strata.bat [目标路径]，无参数=默认 Strata-main，有参数=任意目标
速度/性能对比问题：先确认两种模式连的是否同一上游模型——同模型则速度相同，模式只影响前端服务与工具执行归属，不影响推理本身
模式选择默认：日常用寄生（功能最全）；需接非 Strata 上游或避免升级冲补丁时用独立；两者前端同源只维护一份
自适应阈值中的模型原生窗口不得硬编码全局常量，一律从 models.json 每模型字段读取并保留回落值
_live_vision.py 等 CI 断言关键词匹配须识别否定语境：模型说"NO red circles"时，纯子串匹配会把"no red"误判为 PASS；应加否定词检测或词边界，否则软断言假阳性误导
多模态 CI 门禁若跑在 IQ3_S 级量化模型上，对合成测试图会产生幻觉（描述成熟悉的界面图），硬断言不可信——门禁须跑在视觉可靠的更大量化模型，硬断言只锁模型真能稳定识别的主特征
验证脚本统一纯 ASCII 输出：含中文字符串的 print 经管道/代码页会被吞，只打印命中行号与计数，不打印中文本体
部署脚本 deploy_to_strata.bat 写死的默认目标为 E:\Program Files\Strata-main\serve\web，可作同步目标事实
无头 Edge 截图时 --screenshot 输出路径必须避开含中文的目录（写入会被拒绝访问 0x5），改写到 C:\Users\sk 等纯 ASCII 路径
browser__render/console 依赖 BROWSER_BINARY_PATH 且读不到会话临时环境变量；本机有 Edge 时直接用 msedge --headless=new --dump-dom 读页面 computed 值作确凿证据
任务面板数值型文案若要单独着色，须先把数字从 i18n 整句里拆出包 span 再 CSS 着色；用主色 token（accent/info）而非 warn/danger，避免正常值被误读成报警
面板整句渲染若需局部 HTML（如着色 span），从 textContent 改 innerHTML 时必须：非 HTML 片段走 esc 转义 + 用 dataset 缓存守卫避免逐帧重写 innerHTML
面板数字统一着色统一走共享 escNum(s, tone) + .ins-note__val class：默认主色绿，报警型数值（上下文占用）按 data-tone 跟随语义色，避免高值时绿数字与红进度条冲突
同一渲染函数内多个数字/文案需局部 HTML 时：helper 提升到函数顶部共享，每个节点各自用 dataset._h 缓存守卫防逐帧重写 innerHTML
面板共享 escNum helper 现为 /g 全匹配（捕获组保留）：单数字与多数字（如 done/total）调用点统一复用，禁止再造第二个 helper
浅色主题 --st-accent-text #0c8a60 对白卡对比度 4.36，低于正文 AA 4.5（已知事实）：小字号正文若需严格达标须用专用色，勿擅改全局 token
面板浅色专用色写法：[data-theme="light"] .ins-note__val:not([data-tone]) 提权只覆盖默认角色，不动全局 token，warn/danger 语义色保持继承
双主题视觉验证必须按整页主题（html data-theme 全局）分别渲染；岛式混主题（局部 div 挂 data-theme）会让祖先选择器规则跨岛生效，实测结论不适用于真实应用
改 app.js/i18n.js 一律用锚点编辑脚本（命中数≠1 即报错退出，改前留 .bak，验证后删）
锚点须先做归一化比较（读入后 CRLF→LF），目标文件写回统一 CRLF
i18n 测试是键数对账制：新增键必须中英成对，测试自动覆盖无需改测试
中文/多行命令场景：写脚本文件再执行，勿信被吞的直接输出，写完读回验证
部署铁律：Python shutil.copy 同步到 E:\Program Files\Strata-main\serve\web 后逐文件 MD5 校验，重启生效
续跑徽标机制：resumeBadge 一次性变量由续跑钩子写入，streamAssistant 开头消费（m.autoResume + m.meta），禁止其他路径写入
快照判定三路：plan 未完成项 ∥ limit/canContinue/notice（含 autoResume 自引用）∥ 末尾未答复 user 消息；手动压缩永不触发
锚点编辑脚本中文文案易错点：生成后读回核对用字（本次「继跑→续跑」即靠人工发现）
测试断言中文匹配统一走纯 ASCII 词（如 Auto-resume），中文只作展示不参与匹配
快照拍取收敛到 compactConversation() 单一入口（auto/manual 都拍），finalize 钩子条件不辨 auto/manual
续跑三路判定（plan 未完成项 ∥ limit/canContinue/notice ∥ 末尾未答复 user）两条路径通用；干净收尾永不续跑
test_turn_budget 的 [5] silent-upstream 是计时敏感用例，偶发红先连跑两次复核再定性，勿当契约破坏处理
清理脚本只删本轮自己的临时文件（按明确文件名删），禁止 tools/_*.py 这类宽 glob 扫尾——本轮因此误删了 _live_vision.py 等永久脚本
tools/ 下 _patch_*/_live_vision/_verify_encoding 等幂等常驻脚本是规则资产，删除前需逐个点名确认
前端改动「不生效」排查三步：磁盘 MD5 → 从运行端口拉静态文件比对 → 浏览器硬刷新，浏览器旧缓存是第一嫌疑
在线实例静态路径核实法：8080 寄生版走 /web/<name>，8099 独立版走 /<name>，取回与磁盘逐文件 MD5 比对
快照三路判定只扫最近一条 assistant 消息即停，与面板「最近含 plan 轮次」显示可不一致——判定只作展示信号，不作续跑否决权（压缩即续跑，undo/Stop 反悔）
压缩即续跑铁律：任何压缩（auto/manual）都拍快照并触发收尾续跑，三路判定只作展示信号，undo/Stop 是用户反悔闸
建议决策卡铁律：给用户的改动/优化建议须先实证其好坏处（读代码/跑测试/测量），用 ```proposal 围栏输出结构化决策卡（含 verified/evidence 字段）；未实测标 verified:false 且好坏处注明“初步分析”。详细好坏处禁止写进散文回复——只进提案卡，避免撑大上下文
(空——本次暂不新增规则，待落地验证后再沉淀)
快照判定已反转（2026-10 批准）：任何压缩（auto/manual）均拍快照并触发收尾续跑，三路判定只作面板展示信号；undo(3s)/Stop 是用户反悔闸——推翻 2026-10-19「scan decides」旧规，缘由是反悔闸此时已就位
用户手动钉压缩阈值(compactPct>0)时,小聊天豁免(messages≤6)不得拦截已越钉值的触发;95%紧急豁免线仅服务自适应模式(钉0)
行为回归套件从 app.js 原文 grab 真函数时,作用域桩必须补齐被测函数的全部依赖符号(nativeWindow/speedBaseline/lastTurnSpeed 等),缺一个静默判空就是死区
PowerShell 5.1 用 -File 执行无 BOM 的 UTF-8 脚本时会按 GBK 解码，脚本内中文（含中文路径）当场乱码——含中文的 .ps1 必须存为 UTF-8 with BOM（canary 黄灯项 ps-file-nobom，2026-10-21 实测坐实）；纯 ASCII 的 -Command 传入中文参数则依赖代码页，跨代码页脚本优先 ASCII 匹配串+UTF-8 BOM 文件
常驻运行脚本（bat/py）统一落 strata-agent\tools\；执行前先核对引用路径与实际落点一致（工作区根 tools\ 是另一个目录）
_baseline_probe.py 为常驻资产（与 _live_vision.py 同批）；Windows 路径写进 Python docstring/字符串一律 r 前缀，防 \U\c 转义炸 SyntaxError
thinkOpen 优先级链（2026-10-21 定案）：手动意图 > (live∥最新消息)&&show开关 > 默认折叠——手动折叠（含 fold-all 写入的 false）必须能压过自动展开
凡含多步骤的任务，回答最后一个动作必须是回填「全勾的 plan 清单 + 一段完成总结」；被上下文压缩打断或多轮接力时同样适用——接力收尾轮不许只干活不回填，宁可重跑验证也要把清单勾满并给总结
任务完成度前端兜底：plan 面板空闲态发现未勾项时追加提醒行（i18n 键 insp.plan.reminder，中英成对），流动态 planLive 不画保 live 测试；提醒行 CSS 复用 info 语义色与进度条呼应，断言用纯 ASCII 词 unticked
8099 独立版排查前端问题时，一切读码/修改落点默认工作区 strata-agent/serve/web/；对账 Strata-main 只是只读镜像确认，不得演变成修改动作
gateway.py 的 Executor.tools 是 property，tool_log_dir 开着就永含合成工具 recall_tool_log，故"工具表空"自检须按 server 判（not any(srv.tools for srv in servers)）而非字面 not executor.tools，否则形同虚设
常驻缓存/探针脚本统一落 strata-agent\tools\，含中文 print 的脚本走"落盘 report 文件+type 读回"绕开管道吞输出；纯 ASCII print 可直接看
run_tests 的常驻门禁命名用 _*_gate.py 前缀下划线(区别于 tests/)，门禁对上游依赖需自跳过返回0(防CI假红)，且并入SUITE列表时紧跟同类live-gate(_seg_scroll_baseline/_semantic_summarizer_gate 同批)
README「实测边界/诚实记录」小节用于承载「区分确定性实测 vs 端到端不经济故未跑」的诚实标注；凡机制靠纯函数/契约测试坐实、端到端受算力物理限制未跑的，必须显式标注「未跑+不经济原因」，不得谎称有端到端数据
门禁锁清单可加「上次实跑绿」列，但须注明它是人工实跑观测锚（最后一次全套ALL GREEN的commit），非git自动字段；只改文档不重跑全套时该锚合理不变
工作区根 tools\ = 纯 scratch（git tracked=0，删除是零 git 影响的卫生操作）；常驻门禁锁一律在 strata-agent\tools\ 子目录——删 scratch 前务必按此边界甄别，勿跨目录误删
run_tests 的 post-green 钩子 = 全套 ALL GREEN 后自动跑 _rollback_verify --no-nest 复验最新 tag；rollback 脚本绝不可作为 SUITES 成员（会自递归），只能作 main() 全绿后的后置钩子
