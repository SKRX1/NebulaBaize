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
抽屉开关类"两态语义预览"优先复用已写准的现有 i18n 键渲染，零新键即不动键数对账测试
观测锚/探针脚本若被 README 诚实记录小节引用，即升格为常驻资产，纳入 git 跟踪，不得当 scratch 删除
Windows cmd 里 Python 单行 -c 含双引号会被解析破坏（"unbalanced double quotes"）；复杂脚本改写进 .py 文件再执行，别用 -c 内联双引号。
确定性出前端像素样本：复制真实 index.html 去 web/ 前缀、注入结构化 steps 数组直喂 renderNextSteps（不走 markdown 解析避开转义），先 browser__render 读 DOM 确认注入脚本跑通（看 title 探针）再 screenshot。
每轮给用户的建议必须用标准 ```next-steps``` 围栏输出（行首 * 推荐 / 无符号 - 一般 / ? 等用户确认 / ! 不推荐，颜色即决定），不得用散文罗列建议代替围栏
记忆条目若写入后未 commit，下次续做先 git diff 把它连同截断行一起补齐落账，别只口头承认
每轮输出前对回复自检四项：①存在独立成行落笔的标准围栏块、必须逐字核对实际输出（禁止把"打算写/行内反引号描述"当成"已写"——这是前几轮死循环的真根因）②行首规范档符号齐（* 绿 / 无符号 - 黄 / ? 蓝 / ! 红）③正文不写建议句子冒充建议条 ④本轮含"等你确认"则蓝档作停等闸、绿黄只填"被误跑也无害"的动作。
输出前自检裁决A-vs-B（2026-10-23 拍板）：每轮都必须独立成行落笔真围栏块；本轮若在等用户拍板，不得整块漏发围栏——用蓝档(等你确认)作停等闸，绿/黄只填被误跑也无害的动作。此条裁决推翻「停等轮不出建议条以防自我复读」旧读法(规则B旧解)。
app.js/i18n.js 等含中文的前端文件必须用文件工具(UTF-8)读写，禁止用 PowerShell 控制台 Get-Content 读回(GBK 会显示乱码且可能损坏中文注释)
i18n data-i18n-attr 多属性分隔符是逗号(如 "placeholder:key,title:key")，不是竖线
前端 JS 契约测试：调用未定义符号语法合法、node --check 查不出，必须用 jsdom boot 断言 helper 是真 function 且在最小输入上跑出正确结果，静态层再锁「定义+调用点」成对存在
run_tests.py SUITES 登记的 .mjs 必须自带 process.exit(失败数?1:0)，否则 jsdom timer 会吊住进程 30s 超时被杀
门禁锚串行链已含「纯文档登记 commit 可含门禁表锚推进的 diff」这一合法情形：登记 commit 本身不进锚，但它承载「把门禁表锚推进到上一个真跑绿 commit」的改动，二者同落一个 commit 是允许的（本次 e06890c 即 7行门禁表diff + 1行登记条）
在 core.autocrlf=true 的 Windows 仓库里用 Python 脚本写回源文件前，必须先 `git ls-files --eol <file>` 查真实行尾；判据不能只看字节数猜，否则会把 index=LF 的文件整文件规范化成 CRLF、git diff 虚高成全文件改动（实测虚报 5742 行 vs 真实 52 行）
校验"改动是否干净"用 `git diff --numstat`（默认 autocrlf 行为）：应只剩你真正插入/删除的行数；若某文件 diff 接近全文行数即行尾污染信号，须从 HEAD blob 重建还原
重启8099须用 Start-Process 分离发射（默认执行策略会拒加载.ps1导致脚本静默失败），且脚本须ASCII路径入口或纯ASCII内容
常驻重启脚本禁止写死PID——必须netstat现查监听+CIM解析父链，因进程树每次重启都会洗牌使快照PID过期
agent会话寄生在被重启的gateway进程树下，故重启脚本的真杀动作只能分离执行；dry-run只查不杀可直接跑
给「显示层截断」做放宽时，若该选择器已有门禁静态锁（如 test_memory_card_title 锁 .kb-source__name 省略号），放宽CSS必须同步翻转该锁为「锁放宽态」保持防漂移，否则全套必红
前端权威源现在只有工作区strata-agent/serve/web一处，改前端不再需要deploy_frontend.py镜像到Strata-main（该脚本已退役归档）
setup_env.py改写清单现只剩mcp_servers.json+run_standalone.bat两项（deploy_to_strata/deploy_host_patch已归档，死条目已清）
改共享默认行为（如 autostepsRec）会联动断言该默认的门禁测试：应把无关测试的开关 pin 回旧值（test_card_guard 钉 false），把新默认的行为锁放在它专属测试（test_autosteps 差分正/负例），避免一个改动污染多个差分对
recommended-only 开关复活铁律：默认勾上→auto-drive 只跑绿；取消勾→绿+橙；红/蓝永不变；接线面 loadDrawer+saveSettings+onclick 三处必须齐全，否则 filter 读不到 settings 形同虚设
任务完成轮必须输出 next-steps 建议条（哪怕本轮只是单步收尾/选定项执行）：漏发=疏漏非渲染bug——面板完成徽标与底部绿勾只在我输出的 next-steps 围栏被渲染时才亮，围栏不发徽标就永远不出，此为坐实根因（2026-10-25）
凡多步任务，回答开头即用 ```plan 围栏写清单（边做边勾）；任何收尾轮（含单步收尾）都必须给出建议条：决策卡/等拍板轮用 ? 档作停等闸、绿黄只填被误跑也无害的动作，绝不整块漏发
README 追加前必须 `git ls-files --eol` 核对 index 行尾，写入用与 index 一致的行尾（本仓 README index=LF）；混入异行尾致 diff 虚高时 soft reset 后按文件原行尾重建，勿硬掰全局
含 CJK 的命令行内联 python -c 会被代码页吞码点产生错字；CJK 写入必须走纯 ASCII 脚本文件（码点用 \uXXXX），写完必须读回对账
改 serve/web CSS 配色前先用脚本读回锚点真实字节（CRLF 文件），每个锚点校验命中数=1 再替换，防误伤
写回 serve/web 文件用 open(...,newline='') 保持原 CRLF，写完用 rb 读回核对 CRLF 对数与孤立 LF 数
嵌套双引号在 PowerShell 里会吞掉 python -c 的引号，多行锚点脚本一律写成 .py 文件再跑
CRLF 文件的锚点替换脚本必须按文件真实换行符动态转换锚点块再匹配（读 rb 判断 crlf，匹配串 .replace 成对应换行），写回用 wb 保持原换行
判别式/守卫类兜底：放宽判据时差分锁必须同时锁正例（新形状）与负例（原误判边界），防口径污染
品牌区/胶囊这类「CSS 与 DOM 分两个文件」的视觉改动，落地时必须同轮把 index.html 的 DOM 一起改，不能只改 CSS 那一半
commit 落在 detached HEAD（从 v-baseline tag checkout 来）时 master 不会自动跟上，落地后必须 git checkout master && git merge --ff-only <sha> 快进落账，防止改动再被下一次 checkout 洗掉
brand-sub 内要让冒号紧贴其标签词，须把冒号并入词所在的 span（词+冒号同 span），不要拆成相邻 span——否则被 .brand-sub 的 gap 推离产生空隙
视觉索引登记条若本轮现象有变（如冒号归词），须把差分对账结论追加进对应登记条备注并 commit 落账 master，而非仅更新像素文件
shell_server.py 长输出截断路径：送 smart_decode 前须 trim 末尾不完整多字节序列（对齐完整 UTF-8 字符边界），防 GBK 兜底抢跑致整段乱码
模型宣布「已完成」的同一轮：plan 栏要么整栏不发，要么把已完成项勾成 [x] 只留真正 pending 项；严禁「正文说完成 + plan 全 [ ] + 完成徽标不亮」的自相矛盾显示
RULES.md 单行拆 commit 法：构造 index=HEAD+目标行（脚本写盘→git add→立刻写回工作树完整7行→commit 只落 index），中文从已有字节复制、按文件真实行尾（index LF/工作树 CRLF）落笔，git apply 严格匹配易失败时优先用此法
长列表"打开即卡"先分清是渲染层（DOM 一次铺太多）还是存储层（localStorage 配额），二者独立、药方不同
三处前端权威源行尾不一：app.js/i18n.js 磁盘=CRLF、index.html=LF，改文件须按各文件原行尾写回（用 splitlines 读、按目标行尾 join），勿混用致行尾污染
前端空态语义铁律：函数用三元 `arr.length ? arr : 旧值` 写回时，"空列表/空集合"会被误判成"无改动"而 fallback 保留旧值；凡 DOM/读回/数组三方已一致为"删空"的，空态就是真实意图（真删除），判据须用 Array.isArray(arr)（或显式 undefined 守卫）而非 .length，防"删光了等于没改"复发
删除一律送 Windows 系统回收站（Shell.Application Namespace(10).MoveHere），绝不物理删除，保留还原机会
删除一律送 Windows 系统回收站（Shell.Application COM），绝不物理删除，保留还原机会；临时脚本用毕也送回收站
前端删除类动作一律走 /api/recycle（机制A COM 送真回收站），禁止 fsWrite 副本+物理删的伪回收站写法
对超大文件(如 serve/web/app.js 520KB)做单行替换时,禁用 filesystem__write(其默认 overwrite 会把整个文件覆盖成传入片段),须用 python 脚本读全文+精确 replace+断言命中次数
给「同级结构 + aria 双射 + data-tab/id/白名单三集合一致」补门禁时用 jsdom 真实解析验父链（direct==total），静态标签栈单用会被 HTML 解析器 un-nest 骗过
工作树混入上一轮遗留（RULES经验行/scratch）挡住 post-green 打 tag 时，按归属分 commit：本轮真实改动单独 feat-commit，上轮遗留单独 chore-commit，scratch 送回收站——绝不把别轮产物混进本轮 commit，也不物理删 scratch（铁律 COM SendToRecycleBin）
部署对账=跑 strata-agent/tools/_deploy_mirror.py（权威源 serve/web→E:\Program Files\Strata-main\serve\web 逐文件MD5，幂等，跑完即ALL MATCH即视为一致）；servers/ 不在镜像范围（后端从工作区直跑，无需镜像同步）
git stash drop 只认 stash@{N} 索引、不吃裸SHA（用SHA报'not a stash reference'）；批量删多条须从后往前反向删(stash@{高}→stash@{低})防索引移位误删
test_model_live.mjs 是手动 live 测试（不在 run_tests 套件），用例写死假设 selected=local(iq3_xxs)；当真实 selected=custom 时它会因「dot期望on实际na」而红，属用例假设与配置耦合，非代码回归——判断此类红须做 stash 差分坐实基线同样红。
精准改含中文的配置/前端文件前，先 dry-run 确认锚点精确命中恰好1次，再 apply，并跑对应门禁（i18n 中英键数必须成对增长）坐实不破绿。
含中文的 README 追加必须「写脚本→读回逐字核对用字→错字立即锚点修正→numstat 验行尾」四步串行，本次靠读回抓到 3 处手打字面错字（工件/巻化/后套），验证了此铁律是防错唯一闸
contenteditable 输入框的全局快捷键守卫豁免判断，必须同时认 isCE(el)（认 contenteditable=true/DIV），只写 id/tagName===TEXTAREA 会漏整个 contenteditable 家族导致打字键被吞。
输入框依赖"打字即时刷新"的绑定不能只挂 input：中文输入法落字/粘贴常常不派发标准 input 事件，须统一补 compositionend（必要时 paste）兜底；已覆盖 composer、ws-path、bugbox-search，后续同类刷新点一并遵守。
前端状态显示机制已知结论（防误判成 bug）：顶部 pill 文案由 poll 每 1 s 拉网关 /metrics 快照→render(live.state) 驱动，聊天正文由 streamAssistant 逐 token 即时写入——二者数据源不同、天然差≤1 个 poll 周期属固有滞后；收尾瞬间靠 bumpNebDone 只切图标，文字对齐已由 setPill 完成窗口补齐（门禁 test_pill_closeout_align.mjs）。默认保持该 bumpNebDone 窗口口径不动。
收尾轮自检裁决A-vs-B（2026-10-23 拍板）：每轮都必须独立成行落笔真围栏块；本轮若在等用户拍板，不得整块漏发围栏——用蓝档(等你确认)作停等闸，绿/黄只填被误跑也无害的动作。此条裁决推翻「停等轮不出建议条以防自我复读」旧读法(规则B旧解)。
收尾/选择条漏发的机制层兜底乙（已落地门禁锁）：renderNextSteps 的无-chips 分支——本轮回填了全勾 plan 或有未处置决策卡却无 chips 时画最小 info 提醒，纯空 steps 仍隐藏（不破坏既有 hidden-on-empty 门禁），把"漏发不再纯押模型自律"从行为约定升级为可验证机制。
filesystem__write 只能写 allowed roots 内的路径；给被驱动脚本准备的探针/临时件应由脚本自己写盘（Python tempfile 或工作区根内相对路径），不要经由 filesystem_write 写到沙箱外绝对路径（如 C:\Users\sk），否则报 path escapes sandbox root
门禁表锚串行链「绿→打tag→推锚→纯文档登记」里，若某轮真跑绿 commit 当时未及时把门禁表锚列对齐到该轮 tag，下一次真跑绿轮须把门禁表锚值统一推到最新真跑绿 tag 并在登记条注明「统一推进行为」，避免锚值滞后于实际链尾
执行记忆里记录的历史动作前先按磁盘真值确认文件是否还在（已退役脚本读必报 does not exist）
决策卡轮不等于可省建议条：当一轮既收尾又等你拍板时，须发标准next-steps围栏、把待拍板事项放进蓝档(?)作停等闸；完成徽标/底部绿勾仅在围栏被渲染时才亮，不能只写"已收尾"文字而不发围栏
可复用锚点补丁工具沉淀于 tools/_anchor_patch.py：jobs.json驱动,命中≠1报错退出、每文件独立链副本、默认dry-run只写.qchain副本(--commit才落盘并自动留.bak_<tag>),模式replace/after/before按行strip匹配
星云智能体运行的版本一直是工作区里的独立版不是寄生版,优先修改修复独立版
可复用锚点补丁工具沉淀于 strata-agent/tools/_anchor_patch.py：jobs.json驱动,命中≠1报错退出、每文件独立链副本、默认dry-run只写.qchain副本(--commit才落盘并自动留.bak_<tag>),模式replace/after/before按行strip匹配；"纳入git跟踪"才算真沉淀，落工作区根tools\=scratch未跟踪不算兑现
门禁补「合法用例测试」时必须实测该正则对目标输入的真实返回值再写断言，勿凭记忆旧结论下笔；字符类内 \N 是八进制转义(chr)非反向引用——三字符hr是它唯一能匹配的形态。
commit后必须对最终拓扑重跑orphan-chain门禁转绿才算锚链健康,别因"全套里绿过"或"单独退出码异常"就宣布完成
纯文档登记(README锚表/注册行)单独成commit挂在tag之后、绝不混入锚定commit;跨轮脏项(如他人遗留的RULES.md)精确add本轮件不混入
改动新增顶层常量/符号时，须排查所有 extract-source（只eval函数体片段）的同族门禁是否已 stub 该符号——若否则它们会 ReferenceError；优先选不破坏既有家族契约的最小落点（如save源头clamp而非运行时读新常量）。
命令行内联 python -c/单行命令只做单行；多行逻辑一律写临时 _q_*.py 脚本再跑、用完即删，避免转义踩坑（本轮两次验证）。
前端发送层 body.strata_mcp 取全局 mcpInfo.tools，per-model 的 tools 字段在发送层不被读取；改 per-model tools 语义时不要以为它直接驱动前端发送链路
图像渲染运行时回退必须靠 <img onerror>（ref 坏链时 JS 取非空 ref 不回退 url，纯字符串 || 做不到），不能依赖 im.ref||im.url 字符串优先级
前端粘贴/上传守卫判定 per-model modelAcceptsImages()，勿被全局 health.images 一票否决（外部端点未配 vision 时粘贴会被源头丢弃）
图像门禁套件 test_image_persist_serialize.mjs 已含 I1/J1 静态锁锁死粘贴守卫为 modelAcceptsImages()，改动时勿删
指向外部端点（非本机网关默认上游）的模型条目在 models.json 必须标 kind:custom（非 local），否则前端 poll 豁免与工具勾选两处 local 分支逻辑都会误判
一次性 scratch 落地脚本（如 _add_*_lock.py/_land_*.py）任务收尾即删除；baseline tag 命名沿用 v-baseline-YYYY-MM-DD-<字母> 递增
改产物 JS 引用新 i18n 文案时，必须在 i18n.js 的 zh+en 两处同键双写；只改一侧会让 i18n 门禁键数不一致变红。
给"每秒被轮询重画"的顶栏加 custom 多态：四态逻辑必须抽成共享 helper，render() 成功分支顶部加守卫优先调用、catch 兜底分支也调用同一 helper（单一来源），否则 native 在线时四态永不触发。
改产物 JS 引用新 i18n 文案时，必须在 i18n.js 的 zh+en 两处同键双写；只改一侧会让 i18n 门禁键数不一致变红（本次已实测 1124→1125×2 绿）。
本仓库 serve/web/*.js 历史按"纯 CRLF+BOM 字节"入库，core.autocrlf=true 会使整文件行尾漂移成巨量伪 diff；要纯逻辑提交须用 `git -c core.autocrlf=false add/commit` 按字节比对。
向 Windows 回收站送文件用 Shell.Application COM（Namespace 绝对路径 + ParseName + InvokeVerb('delete')），VisualBasic DeleteFile 重载在 PowerShell 绑定 enum 会失败。
PowerShell here-string 遇注释含单引号会解析失败；对含中文/引号的批量替换改用 Python 脚本（newline='' 保字节）。
空闲态顶栏文案用专用键 mon.pill.endpoint.idle（zh「端点在线（空闲中）」/en「Endpoint live (idle)」），工作态仍用 mon.state.working；两者都从 paintCustomPill 的非工作/工作分支分流，单一来源。
改 runtime/http_server.py 后必跑全套门禁 tests/run_tests.py（含 post-green rollback verify），不只跑单测
棘轮门禁（test_code_hygiene 的 swallow/stub 计数）报 NEW 时优先重构掉新引入的纯 pass except，不要 --bless 永久放宽基线
会话内commit后必跑tools/run_tests.py全套,ORPHAN-CHAIN-GATE报RED不得假绿;游离链修复前先git merge-base --is-ancestor确认纯快进再merge --ff-only
棘轮门禁(test_code_hygiene)报NEW时优先重构掉新引入的纯pass except(except body用真实动作如return不算哑弹),不--bless永久放宽基线
一次性侦察脚本命名tools/_q_*;清理用Shell.Application COM InvokeVerb('delete')逐个送回收站+0.25s停顿防批量丢项,可一键撤销
commit 落在 detached HEAD 会被 tools/_orphan_chain_gate.py 抓红（全套门禁之一）；归位用 git checkout master + git merge --ff-only <sha>（先 git merge-base --is-ancestor master HEAD 确认祖先，纯快进不重写历史）。
在 cmd 里 git rev-parse --short master HEAD 多参数会被解析报错；写文件/命令时 echo 文案严禁含 > < | 等重定向符（会生成垃圾文件如 HEAD)）。
重启 8099 网关 = 自杀型动作（agent 寄生在监听 worker 进程树下），必须用 tools/_restart_8099.ps1 经 Start-Process 分离发射真杀，脚本 netstat 动态发现 listener + CIM 解析父链（绝不写死 PID），完成证据读 C:\Users\sk\strata_snapshots\_restart_8099_report.txt 的 killed-listener + 新监听 PID 换血坐实
改动 E:\WorkBuddy\星云智能体\strata-agent 内的大文件（http_server.py 等数万行）时，绝不用 filesystem__write 的 overwrite 模式写占位符/小片段——它会整文件覆盖。一律用 Python 脚本「读全文→count(old) 断言==1→replace→写回」做精确替换，写盘前先校验锚点命中数。
strata-agent 内的 .bat 启动器一律用 %~dp0 相对自身定位脚本与 venv，禁止硬编码盘符绝对路径（项目目录会整体迁移）
strata-agent 内的 .bat 启动器一律用 %~dp0 相对自身定位脚本与 venv，禁止硬编码盘符绝对路径（项目目录会整体迁移）；run_standalone.bat 的 PYTHON 已据此改为 %ROOT%.venv\Scripts\python.exe
重启 8099 是分离发射（Start-Process 真杀当前监听 PID），启动器 run_standalone.bat 重启循环检测到非零退出后 3 秒用磁盘新版 bat 拉起新进程，换血即坐实新路径已加载；PID 树每次重启都会洗牌属正常
_rollback_verify.py 现已从 __file__ 派生 ROOT、从 ROOT 派生 WS（clone-safe），不再写死盘符绝对路径；迁移后全树写死旧根的常驻脚本应统一按此派生
setNebSpin 转速 clamp 现为 160（公式分母同为 160，0→5.20s、160→2.60s，端到端~51/引擎峰值~81 落中段可分辨）；test_nebula 已补差分对锁「51→4.37s 与 81→3.88s 必须不同」防未来 clamp 降回 51 以下把可分辨性改没
