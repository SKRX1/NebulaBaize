星云前端唯一权威源是工作区 serve/web/，改前端只改这里；Strata-main\serve\web 是 robocopy /MIR 同步的副本，禁止手改
前端改动后通过双击 deploy_to_strata.bat 同步到寄生模式 Strata-main；后端/skills/mcp_servers.json 改动不需部署，重启进程即生效（寄生模式需重启 Strata）
含中文路径（星云智能体）的 robocopy 命令行直调会因代码页失败，优先双击 bat 执行；自动化脚本需先 chcp 65001
部署脚本用 GBK 编码保存，勿用 UTF-8 编辑器另存覆盖，否则中文路径乱码
前端所有非对话视图(.view)统一由一个内容容器负责滚动，新增视图不要逐名加 overflow-y，避免遗漏
记忆页等含长内容的标签页：统一「整页滚」或「卡内滚」一种滚动归属，避免双层滚动条
前端 serve/web 改动并验证通过后，默认由我主动执行 cp+逐文件MD5校验 同步到 Strata-main 寄生副本（中文路径禁用 robocopy 命令行直调）
仅前端需同步部署；后端/skills/mcp_servers.json 改动只需重启进程，不需部署
shell MCP server 执行命令必须 stdin=subprocess.DEVNULL 且 try/except subprocess.TimeoutExpired 返回字符串：否则未闭合引号的命令会挂在继承来的 JSON-RPC stdin 上死等，且超时异常冲垮 MCP 响应链会污染该 server 后续所有请求（连简单 echo 都超时）
写命令路径不要带尾部反斜杠紧贴闭合引号（...\）——反斜杠会转义引号导致未闭合；PowerShell 用 ; 而非 && 分隔
shell_server.py 等 servers/ 下脚本改动需重启该 MCP server 才生效；重启会切断经由它执行工具的当前会话（自重启），需用户决定时机
读写编码必须对称：凡按代码页(GBK)写出的文件，读取侧也要镜像(读字节→试utf-8→回退gbk)，否则幂等/二次读取会 UnicodeDecodeError 崩溃
部署铁律：星云工作区 serve/web/ 是唯一真相源，任何 Strata 实例的 serve/web/ 都是它的镜像，方向永不逆转
单点风险防护：建议定期将 serve/web/ 打包 zip 存到云盘或 Git（工作区本身丢失则 BAT 无法恢复）
BAT 部署命令：deploy_to_strata.bat [目标路径]，无参数=默认 Strata-main，有参数=任意目标
速度/性能对比问题：先确认两种模式连的是否同一上游模型——同模型则速度相同，模式只影响前端服务与工具执行归属，不影响推理本身
模式选择默认：日常用寄生（功能最全）；需接非 Strata 上游或避免升级冲补丁时用独立；两者前端同源只维护一份
验证脚本统一纯 ASCII 输出：含中文字符串的 print 经管道/代码页会被吞，只打印命中行号与计数，不打印中文本体
部署脚本 deploy_to_strata.bat 写死的默认目标为 E:\Program Files\Strata-main\serve\web，可作同步目标事实
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
前端改动「不生效」排查三步：磁盘 MD5 → 从运行端口拉静态文件比对 → 浏览器硬刷新，浏览器旧缓存是第一嫌疑
在线实例静态路径核实法：8080 寄生版走 /web/<name>，8099 独立版走 /<name>，取回与磁盘逐文件 MD5 比对
建议决策卡铁律：给用户的改动/优化建议须先实证其好坏处（读代码/跑测试/测量），用 ```proposal 围栏输出结构化决策卡（含 verified/evidence 字段）；未实测标 verified:false 且好坏处注明“初步分析”。详细好坏处禁止写进散文回复——只进提案卡，避免撑大上下文
(空——本次暂不新增规则，待落地验证后再沉淀)
PowerShell 5.1 用 -File 执行无 BOM 的 UTF-8 脚本时会按 GBK 解码，脚本内中文（含中文路径）当场乱码——含中文的 .ps1 必须存为 UTF-8 with BOM（canary 黄灯项 ps-file-nobom，2026-10-21 实测坐实）；纯 ASCII 的 -Command 传入中文参数则依赖代码页，跨代码页脚本优先 ASCII 匹配串+UTF-8 BOM 文件
常驻运行脚本（bat/py）统一落 strata-agent\tools\；执行前先核对引用路径与实际落点一致（工作区根 tools\ 是另一个目录）
thinkOpen 优先级链（2026-10-21 定案）：手动意图 > (live∥最新消息)&&show开关 > 默认折叠——手动折叠（含 fold-all 写入的 false）必须能压过自动展开
凡含多步骤的任务，回答最后一个动作必须是回填「全勾的 plan 清单 + 一段完成总结」；被上下文压缩打断或多轮接力时同样适用——接力收尾轮不许只干活不回填，宁可重跑验证也要把清单勾满并给总结
任务完成度前端兜底：plan 面板空闲态发现未勾项时追加提醒行（i18n 键 insp.plan.reminder，中英成对），流动态 planLive 不画保 live 测试；提醒行 CSS 复用 info 语义色与进度条呼应，断言用纯 ASCII 词 unticked
8099 独立版排查前端问题时，一切读码/修改落点默认工作区 strata-agent/serve/web/；对账 Strata-main 只是只读镜像确认，不得演变成修改动作
gateway.py 的 Executor.tools 是 property，tool_log_dir 开着就永含合成工具 recall_tool_log，故"工具表空"自检须按 server 判（not any(srv.tools for srv in servers)）而非字面 not executor.tools，否则形同虚设
Windows cmd 里 Python 单行 -c 含双引号会被解析破坏（"unbalanced double quotes"）；复杂脚本改写进 .py 文件再执行，别用 -c 内联双引号。
确定性出前端像素样本：复制真实 index.html 去 web/ 前缀、注入结构化 steps 数组直喂 renderNextSteps（不走 markdown 解析避开转义），先 browser__render 读 DOM 确认注入脚本跑通（看 title 探针）再 screenshot。
每轮给用户的建议必须用标准 ```next-steps``` 围栏输出（行首 * 推荐 / 无符号 - 一般 / ? 等用户确认 / ! 不推荐，颜色即决定），不得用散文罗列建议代替围栏
记忆条目若写入后未 commit，下次续做先 git diff 把它连同截断行一起补齐落账，别只口头承认
每轮输出前对回复自检四项：①存在独立成行落笔的标准围栏块、必须逐字核对实际输出（禁止把"打算写/行内反引号描述"当成"已写"——这是前几轮死循环的真根因）②行首规范档符号齐（* 绿 / 无符号 - 黄 / ? 蓝 / ! 红）③正文不写建议句子冒充建议条 ④本轮含"等你确认"则蓝档作停等闸、绿黄只填"被误跑也无害"的动作。
输出前自检裁决A-vs-B（2026-10-23 拍板）：每轮都必须独立成行落笔真围栏块；本轮若在等用户拍板，不得整块漏发围栏——用蓝档(等你确认)作停等闸，绿/黄只填被误跑也无害的动作。此条裁决推翻「停等轮不出建议条以防自我复读」旧读法(规则B旧解)。
app.js/i18n.js 等含中文的前端文件必须用文件工具(UTF-8)读写，禁止用 PowerShell 控制台 Get-Content 读回(GBK 会显示乱码且可能损坏中文注释)
i18n data-i18n-attr 多属性分隔符是逗号(如 "placeholder:key,title:key")，不是竖线
前端 JS 契约测试：调用未定义符号语法合法、node --check 查不出，必须用 jsdom boot 断言 helper 是真 function 且在最小输入上跑出正确结果，静态层再锁「定义+调用点」成对存在
在 core.autocrlf=true 的 Windows 仓库里用 Python 脚本写回源文件前，必须先 `git ls-files --eol <file>` 查真实行尾；判据不能只看字节数猜，否则会把 index=LF 的文件整文件规范化成 CRLF、git diff 虚高成全文件改动（实测虚报 5742 行 vs 真实 52 行）
校验"改动是否干净"用 `git diff --numstat`（默认 autocrlf 行为）：应只剩你真正插入/删除的行数；若某文件 diff 接近全文行数即行尾污染信号，须从 HEAD blob 重建还原
前端权威源现在只有工作区strata-agent/serve/web一处，改前端不再需要deploy_frontend.py镜像到Strata-main（该脚本已退役归档）
setup_env.py改写清单现只剩mcp_servers.json+run_standalone.bat两项（deploy_to_strata/deploy_host_patch已归档，死条目已清）
任务完成轮必须输出 next-steps 建议条（哪怕本轮只是单步收尾/选定项执行）：漏发=疏漏非渲染bug——面板完成徽标与底部绿勾只在我输出的 next-steps 围栏被渲染时才亮，围栏不发徽标就永远不出，此为坐实根因（2026-10-25）
凡多步任务，回答开头即用 ```plan 围栏写清单（边做边勾）；任何收尾轮（含单步收尾）都必须给出建议条：决策卡/等拍板轮用 ? 档作停等闸、绿黄只填被误跑也无害的动作，绝不整块漏发
README 追加前必须 `git ls-files --eol` 核对 index 行尾，写入用与 index 一致的行尾（本仓 README index=LF）；混入异行尾致 diff 虚高时 soft reset 后按文件原行尾重建，勿硬掰全局
模型宣布「已完成」的同一轮：plan 栏要么整栏不发，要么把已完成项勾成 [x] 只留真正 pending 项；严禁「正文说完成 + plan 全 [ ] + 完成徽标不亮」的自相矛盾显示
前端空态语义铁律：函数用三元 `arr.length ? arr : 旧值` 写回时，"空列表/空集合"会被误判成"无改动"而 fallback 保留旧值；凡 DOM/读回/数组三方已一致为"删空"的，空态就是真实意图（真删除），判据须用 Array.isArray(arr)（或显式 undefined 守卫）而非 .length，防"删光了等于没改"复发
删除一律送 Windows 系统回收站（Shell.Application Namespace(10).MoveHere），绝不物理删除，保留还原机会
删除一律送 Windows 系统回收站（Shell.Application COM），绝不物理删除，保留还原机会；临时脚本用毕也送回收站
前端删除类动作一律走 /api/recycle（机制A COM 送真回收站），禁止 fsWrite 副本+物理删的伪回收站写法
对超大文件(如 serve/web/app.js 520KB)做单行替换时,禁用 filesystem__write(其默认 overwrite 会把整个文件覆盖成传入片段),须用 python 脚本读全文+精确 replace+断言命中次数
部署对账=跑 strata-agent/tools/_deploy_mirror.py（权威源 serve/web→E:\Program Files\Strata-main\serve\web 逐文件MD5，幂等，跑完即ALL MATCH即视为一致）；servers/ 不在镜像范围（后端从工作区直跑，无需镜像同步）
contenteditable 输入框的全局快捷键守卫豁免判断，必须同时认 isCE(el)（认 contenteditable=true/DIV），只写 id/tagName===TEXTAREA 会漏整个 contenteditable 家族导致打字键被吞。
输入框依赖"打字即时刷新"的绑定不能只挂 input：中文输入法落字/粘贴常常不派发标准 input 事件，须统一补 compositionend（必要时 paste）兜底；已覆盖 composer、ws-path、bugbox-search，后续同类刷新点一并遵守。
星云智能体运行的版本一直是工作区里的独立版不是寄生版,优先修改修复独立版
命令行内联 python -c/单行命令只做单行；多行逻辑一律写临时 _q_*.py 脚本再跑、用完即删，避免转义踩坑（本轮两次验证）。
重启 8099 网关 = 自杀型动作（agent 寄生在监听 worker 进程树下），必须用 tools/_restart_8099.ps1 经 Start-Process 分离发射真杀，脚本 netstat 动态发现 listener + CIM 解析父链（绝不写死 PID），完成证据读 C:\Users\sk\strata_snapshots\_restart_8099_report.txt 的 killed-listener + 新监听 PID 换血坐实
改models.json后需重启8099网关才生效(models.json后端读):杀监听PID→run_standalone.bat的:loop约3秒拉起加载最新磁盘代码
app.js/models.json改动前先copy备份(.bak_xxx),用逐处断言命中=1次的精确字符串替换脚本落地,改完立即node --check+读回+跑对应jsdom回归
workspaceSystem() 中 knowledge/experience 通过 _memInject() 注入，超过 LAZY_MEM_THRESHOLD(3000 chars) 走摘要行+按需 memory__recall 检索；rules 保持全文注入
loadMemoryState() 中 GLOBAL_ROOT 去重：当 workspace/.strata-memory == GLOBAL_ROOT 时清空 globalKnowledge/globalExperience，防重复注入
tools/ 目录有临时脚本清理机制（_*.py 跑完即被送回收站）：需要"落盘脚本→立即运行"的临时脚本，必须把运行命令接在写入后的同一条 shell 命令里，勿分两个回合（下一回合文件已不在）
语义合并/压缩类任务先跑数据驱动相似度扫描（difflib.SequenceMatcher，阈值~0.5）列出真实重复簇，禁止凭记忆判重复（怕误删同主题互补事实如 Shell.Application≠pywin32）
写全量语义合并脚本时守卫只禁"源行被多簇重复使用"，"缺失索引"是合法的原样保留行不得当错误 ABORT
用 io.open(path, 'r', encoding='utf-8') 读含 CRLF 的文件会触发 universal-newlines（\r\n→\n），使后续 '\r\n' in raw 行尾探测恒为 False、写回全变 LF，对 index=CRLF 的文件造成 git diff 全文虚高——落地脚本须二进制读(rb)保留原行尾，或显式 newline='' 关闭转换
判断 git index 真实行尾：i/crlf|i/lf 表 git 规范化存储按该值写回；i/-text 表 git 按字节原样存(不规范化)，工作树 w/crlf 即 index 真为 CRLF 字节；行尾污染恢复法 git checkout HEAD -- <file> + 二进制读 + 精确插行(新行用原文件行尾)，勿在 CRLF/LF 间反复猜
调度器融合 serve：纯 stdlib Scheduler 核心循环(run/due)零改动，新增 runtime/scheduler_host.py 做包装层（每tick磁盘reload实现热重载、idle_gate.wait实现busy排队、分片睡眠实现可中断），靠注入 clock/sleep/load_entries/run_task 离线测
交互忙闸用 GatewayState._active 计数 + _idle Event：begin_interaction 在 _agent_stream 顶层try首行、end_interaction 在同try的finally，严格配对防 setup 抛异常泄漏 _active
python 锚点编辑脚本：锚点字符串里出现 JS 字面 `\n`（如 `split("\n")`）时，Python 普通字符串会把 `\n` 解析成真换行导致 count=0——含反斜杠的锚点/new 块统一用 raw string（r'''...'''），raw 下 `\n` 即字面反斜杠n
jsdom 契约测试里 app.js 顶层 let/const（如 mcpInfo/t/编辑态）跨 win.eval 不可见（每个 eval 独立作用域）——所有 realm-internal 状态必须在同一个 boot eval 里用闭包暴露到 window.__api
本前端加顶部标签页必须三处同步：index.html tab按钮+view section配对(aria-controls/labelledBy)、app.js showTab 顶部 whitelist 数组、showTab 可见性 for-of 数组——test_nav_tabs_level.mjs 的 L4 会锁死三集一致，漏任一处即红
扫描 git 跟踪文件中的中文字符串时，PowerShell 逐文件 Select-String 会因 git 中文文件名八进制转义而报 PathNotFound，应改用 Python 对 git ls-files -z 的字节级扫描（tools/_q_* 探针系列）
全套回归跑 strata-agent\tools\run_tests.py（约190项含post-green钩子）；工作区根 tools\run_all_tests.py 的 ROOT 硬编码指向旧路径 E:\WorkBuddy\...，输出 TOTAL 0 属假绿不可采信
创建定时任务时（凡我代拟任务名/任务内容），name 与 task 语言跟随主人本轮指令的主体语言（中文→中文、English→英文、其他语言→对应语言，混合取主体）；前端弹窗手填天然满足无需改码；编辑/重命名保持原语言，主人主动换才换；schedule 链路已验证 Unicode 安全（后端无字符集校验、前端 esc+dataset，中文任务名有活样本在跑）
定时任务的 task 字段是实际执行的 shell 命令（不可翻译，翻译即执行失败）；"按语言创建任务"的约定只落在显示名 name 上——中文名/英文名按主人指令语言，task 命令本体保持可执行原样
app.js 里被 updateAssistant 等 boot 期函数调用的新函数，禁止用顶层 const/let 承载（TDZ 会让 jsdom 测试崩），改 function 声明+惰性 window 缓存
commit 前先跑 git diff --ignore-cr-at-eol --stat 甄别"换行符假象 vs 真改动"，仓库 LF→CRLF 入库会让全文件 diff 虚高到数万行
跨进程传中文路径进 PowerShell 易被代码页吞，改走"写 ps1 脚本文件 + -File 执行 + $MyInvocation 自定位目录"
