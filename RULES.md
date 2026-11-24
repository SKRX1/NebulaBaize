星云前端唯一权威源是工作区 serve/web/，改前端只改这里；Strata-main\serve\web 是 robocopy /MIR 同步的副本，禁止手改
前端改动后通过双击 deploy_to_strata.bat 同步到寄生模式 Strata-main；后端/skills/mcp_servers.json 改动不需部署，重启进程即生效（寄生模式需重启 Strata）
含中文路径（星云白泽）的 robocopy 命令行直调会因代码页失败，优先双击 bat 执行；自动化脚本需先 chcp 65001
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
常驻运行脚本（bat/py）统一落 Nebula-agent\tools\；执行前先核对引用路径与实际落点一致（工作区根 tools\ 是另一个目录）
thinkOpen 优先级链（2026-10-21 定案）：手动意图 > (live∥最新消息)&&show开关 > 默认折叠——手动折叠（含 fold-all 写入的 false）必须能压过自动展开
凡含多步骤的任务，回答最后一个动作必须是回填「全勾的 plan 清单 + 一段完成总结」；被上下文压缩打断或多轮接力时同样适用——接力收尾轮不许只干活不回填，宁可重跑验证也要把清单勾满并给总结
任务完成度前端兜底：plan 面板空闲态发现未勾项时追加提醒行（i18n 键 insp.plan.reminder，中英成对），流动态 planLive 不画保 live 测试；提醒行 CSS 复用 info 语义色与进度条呼应，断言用纯 ASCII 词 unticked
8099 独立版排查前端问题时，一切读码/修改落点默认工作区 Nebula-agent/serve/web/；对账 Strata-main 只是只读镜像确认，不得演变成修改动作
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
前端权威源现在只有工作区Nebula-agent/serve/web一处，改前端不再需要deploy_frontend.py镜像到Strata-main（该脚本已退役归档）
setup_env.py改写清单现只剩mcp_servers.json+run_standalone.bat两项（deploy_to_strata/deploy_host_patch已归档，死条目已清）
任务完成轮必须输出 next-steps 建议条（哪怕本轮只是单步收尾/选定项执行）：漏发=疏漏非渲染bug——面板完成徽标与底部绿勾只在我输出的 next-steps 围栏被渲染时才亮，围栏不发徽标就永远不出，此为坐实根因（2026-10-25）
凡多步任务，回答开头即用 ```plan 围栏写清单（边做边勾）；任何收尾轮（含单步收尾）都必须给出建议条：决策卡/等拍板轮用 ? 档作停等闸、绿黄只填被误跑也无害的动作，绝不整块漏发
README 追加前必须 `git ls-files --eol` 核对 index 行尾，写入用与 index 一致的行尾（本仓 README index=LF）；混入异行尾致 diff 虚高时 soft reset 后按文件原行尾重建，勿硬掰全局
模型宣布「已完成」的同一轮：plan 栏要么整栏不发，要么把已完成项勾成 [x] 只留真正 pending 项；严禁「正文说完成 + plan 全 [ ] + 完成徽标不亮」的自相矛盾显示
删除一律送 Windows 系统回收站（Shell.Application Namespace(10).MoveHere），绝不物理删除，保留还原机会
删除一律送 Windows 系统回收站（Shell.Application COM），绝不物理删除，保留还原机会；临时脚本用毕也送回收站
前端删除类动作一律走 /api/recycle（机制A COM 送真回收站），禁止 fsWrite 副本+物理删的伪回收站写法
对超大文件(如 serve/web/app.js 520KB)做单行替换时,禁用 filesystem__write(其默认 overwrite 会把整个文件覆盖成传入片段),须用 python 脚本读全文+精确 replace+断言命中次数
部署对账=跑 Nebula-agent/tools/_deploy_mirror.py（权威源 serve/web→E:\Program Files\Strata-main\serve\web 逐文件MD5，幂等，跑完即ALL MATCH即视为一致）；servers/ 不在镜像范围（后端从工作区直跑，无需镜像同步）
contenteditable 输入框的全局快捷键守卫豁免判断，必须同时认 isCE(el)（认 contenteditable=true/DIV），只写 id/tagName===TEXTAREA 会漏整个 contenteditable 家族导致打字键被吞。
输入框依赖"打字即时刷新"的绑定不能只挂 input：中文输入法落字/粘贴常常不派发标准 input 事件，须统一补 compositionend（必要时 paste）兜底；已覆盖 composer、ws-path、bugbox-search，后续同类刷新点一并遵守。
星云白泽运行的版本一直是工作区里的独立版不是寄生版,优先修改修复独立版
命令行内联 python -c/单行命令只做单行；多行逻辑一律写临时 _q_*.py 脚本再跑、用完即删，避免转义踩坑（本轮两次验证）。
重启 8099 网关 = 自杀型动作（agent 寄生在监听 worker 进程树下），必须用 tools/_restart_8099.ps1 经 Start-Process 分离发射真杀，脚本 netstat 动态发现 listener + CIM 解析父链（绝不写死 PID），完成证据读 C:\Users\sk\strata_snapshots\_restart_8099_report.txt 的 killed-listener + 新监听 PID 换血坐实
改models.json后需重启8099网关才生效(models.json后端读):杀监听PID→run_standalone.bat的:loop约3秒拉起加载最新磁盘代码
app.js/models.json改动前先copy备份(.bak_xxx),用逐处断言命中=1次的精确字符串替换脚本落地,改完立即node --check+读回+跑对应jsdom回归
workspaceSystem() 中 knowledge/experience 通过 _memInject() 注入，超过 LAZY_MEM_THRESHOLD(3000 chars) 走摘要行+按需 memory__recall 检索；rules 保持全文注入
loadMemoryState() 中 GLOBAL_ROOT 去重：当 workspace/.Nebula-memory == GLOBAL_ROOT 时清空 globalKnowledge/globalExperience，防重复注入
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
全套回归跑 Nebula-agent\tools\run_tests.py（约190项含post-green钩子）；工作区根 tools\run_all_tests.py 的 ROOT 硬编码指向旧路径 E:\WorkBuddy\...，输出 TOTAL 0 属假绿不可采信
创建定时任务时（凡我代拟任务名/任务内容），name 与 task 语言跟随主人本轮指令的主体语言（中文→中文、English→英文、其他语言→对应语言，混合取主体）；前端弹窗手填天然满足无需改码；编辑/重命名保持原语言，主人主动换才换；schedule 链路已验证 Unicode 安全（后端无字符集校验、前端 esc+dataset，中文任务名有活样本在跑）
定时任务的 task 字段是实际执行的 shell 命令（不可翻译，翻译即执行失败）；"按语言创建任务"的约定只落在显示名 name 上——中文名/英文名按主人指令语言，task 命令本体保持可执行原样
app.js 里被 updateAssistant 等 boot 期函数调用的新函数，禁止用顶层 const/let 承载（TDZ 会让 jsdom 测试崩），改 function 声明+惰性 window 缓存
commit 前先跑 git diff --ignore-cr-at-eol --stat 甄别"换行符假象 vs 真改动"，仓库 LF→CRLF 入库会让全文件 diff 虚高到数万行
跨进程传中文路径进 PowerShell 易被代码页吞，改走"写 ps1 脚本文件 + -File 执行 + $MyInvocation 自定位目录"
杀「本会话祖先链」内的进程(gateway/watchdog)不能用同步 shell,会触发 self-suicide guard;须写成 detached 脚本(Start-Process Bypass)跑完写盘报告,再单独读报告
Start-Process 没有 -ExecutionPolicy 参数,须经 -ArgumentList 逐项传给被启动进程(如 '-NoProfile','-ExecutionPolicy','Bypass','-File',脚本路径)
重启链脚本放 tools/ 下、运行时用 netstat+CIM 发现 PID(绝不硬编码快照 PID)、ASCII-only 输出写盘报告
前端唯一权威源是 serve/web/app.js(部署到 Strata-main 已退役,该目录本机不存在),改完硬刷新浏览器即生效,无需额外部署
i18n 门禁真实脚本是 tests/test_i18n.mjs(node 单跑),不是 tools/test_i18n.js;强制 en/zh 键数一致,新增 key 必须两字典各加一个
browser__sim 纯沙箱跑大型前端 app.js 会中途崩(缺真 DOM 上下文,顶层 const/let 探针 ReferenceError),只能验 DOM 接线/默认态;行为级契约实测须用 jsdom harness(可 mock fetch 完整跑 propose),二者分工勿混用
聊天消息里用户贴的图(模型能看到)不会自动落盘到 workspace/temp;agent 要用 PIL 按主色+尺寸从磁盘候选里读图核对确认是哪张,不能仅凭文件名或时间猜,更无法凭"看到"就导出成文件。
serve/web/img/ 下图片被根 .gitignore 第19行 *.png 全仓忽略,属运行时资源——图片改动不进 git,靠 tools\_deploy_mirror.py 同步到部署镜像(脚本会一并镜像 img 子目录)。
捐助页收款码图片真实落点在 serve/web/img/（用户手动放置文件），文件名即引用名 donate-alipay.jpg（支付宝是jpg）/donate-usdc.png（USDC是png）；引用扩展名须与真实文件实际格式一致，零转码保真，不靠肉眼重绘。
聊天消息里用户贴的图对模型可见但不落盘，agent 无法凭"看到"导出文件；只有用户作为附件/手动放入磁盘的文件才能被脚本读取复制。
run_tests 的绿门禁 = tools/run_tests.py 的 SUITES 列表（每行一个测试，.mjs/.js 用 node 跑、.py 用 python，exit 0=绿）；新测试登记时按文件真实换行风格插入，纯侦察脚本（_grep_/_dump_/_find_/_resolve_）写一次即用完。
真实 DOM 竞态类 bug 若 jsdom 复现不了机制（如共享 caret/insertHTML），用「忠实建模竞态的确定性差分 + 静态锁防漂移」固化，单变量翻转须 load-bearing（fix 结果严格优于 control），这是 codebase 既有 test_safety_pad_gate 的写法。
code_hygiene 护栏抓到的新增 silent-except-swallow，优先「真处理」(给 except 体加可见动作)而非 --bless 抬基线；--bless 仅用于确认要保留的既有豁免
在 runtime/http_server.py 等受 hygiene 守卫的文件里新增 except 块时，body 不能只有 pass/continue（会被 test_code_hygiene 计入 silent swallow 回归），必须带一行日志（print 到 stderr 或调用 audit）。
多文件 commit 前只 git add 本轮目标文件，用 git status 甄别工作区无关漂移（如 config/*.json 运行态漂移），不裹入本次 commit
git add 后先查 git diff --cached --numstat 确认入库行数无 CRLF 翻转虚高，再 commit
新增门禁测试必须显式登记进 Nebula-agent/tools/run_tests.py 的 SUITES 列表（硬编码，不登记就不跑），并在行尾注释写明它锁什么
像素 fixture 必须内嵌真实 index.html 骨架（不能裸 body 只有 #chat）——app.js 在 $("theme-btn").onclick 拿 null 即崩，连带顶层 const/let（esc/inline/messages）全没初始化，探针撞 TDZ；纯沙箱跑大型 app.js 同理只能验 DOM 接线，行为级须 jsdom（runScripts:outside-only + win.eval 暴露 __api）
前端 CSS 布局改动用 Python 锚点脚本插入（先断言锚点唯一），保持文件原有换行风格（git ls-files --eol 查工作区风格），CSS 注释用 /* */
前端行为冒烟：把探针拼进与 i18n.js+app.js 的同一次 win.eval 里执行，才能访问模块作用域的 let/const 顶层变量（jsdom runScripts:outside-only 下顶层声明不进 window）
新增测试必须登记进 tools/run_tests.py 的清单并跑一次 python tools\run_tests.py 全套回归确认 ALL GREEN，再宣布完成。
引用扫描生成清单/报告时，扫描脚本自身必须从引用结果中排除（脚本文件名列举了被扫目标会自污染），且脚手架脚本用完即删
改 run_tests.py 主回归登记新 suite 时：真浏览器冷启动类归 SLOW_SUITES 区（紧凑列表），SUITES 区每条之间留空行保持该区风格，改完必 py_compile + 单跑该 suite 验证调度认得它
批量送 Windows 回收站的文件清单，引用扫描生成的清单/报告须排除扫描脚本自身(自污染)；"零引用"才入清理批，仅被历史日志快照(data/tool-log)提及的项按默认保留、不自动删
git 提交"本轮任务产出"时只纳入本轮门禁/接线/清单闭环文件；别处工作线成果(如视觉源文件 app.css/app.js)与配置漂移(mcp_servers.json)一律不裹入，提交前用 git status --untracked-files=all 圈定、用 diff --stat 核对入库行数无 CRLF 虚高
命令行给解释器/PowerShell 传含中文的路径或字符串易被代码页吞，统一用 UTF-8 脚本读改写、PowerShell 走 -EncodedCommand（base64 UTF-16LE）；本次改源码即用 UTF-8 补丁脚本精确替换+回读核验。
MCP server 子进程是常驻的，源码改动需宿主重启才对实时工具生效；验证改动用"新进程 import 真实代码路径"实测，不要假装当前工具的常驻进程已加载新代码
测试脚本里跑中文 print 要先包 sys.stdout=UTF-8，且别在 cmd 命令行里传中文（会被代码页吞），中文放脚本文件内
收尾被打断任务时，凡"既有契约门禁被工作树改动打破"须先判定是功能被正当推翻还是半路画蛇添足，门禁锁定的既有拍板优先保留、工作树改动默认视为待确认
pip 卸载无回收站语义（物理删除）；只有磁盘上的模型/临时文件才走 Shell.Application COM 送系统回收站
批量字符串替换前先探测目标文件行尾（本项目 app.js/app.css 是 CRLF、index.html 是 LF），多行锚点须按真实行尾构造，否则 count=0 失配
本机 `python -c "..."` 内联脚本 stdout 常被吞无输出；需要确定读取输出时写成 .py 脚本文件执行
改 app.js 生产行为后，必须补"运行时实测"（喂真实输入断言行为），不能只靠静态读实 + node --check 就宣布完成
修一个前端渲染 bug 时，配套写一条 DOM-身份回归测试（断言关键节点跨多次 repaint 不被重建），并注册进 tools/run_tests.py 的 SUITES 清单，否则该修复不进回归网。
async 函数里 await 之前捕获的索引/引用（如编辑快照 index）在 await 之后使用前必须重新校验——await 期间全局可变状态（messages、分支、撤销栈）可能被并发改变致其越界
对象字面量里 get xxx() 定义的成员必须按属性读取（d.current），绝不能写成 d.current()——getter 返回值是 truthy 的非函数对象，`d.current ? d.current()` 会过了 truthy 检查后对对象求值抛 "is not a function"
新增静默 except 块（body 仅 pass/continue/docstring/注释）会撞上 tests/test_code_hygiene.py 的棘轮基线；要规避就给 body 放一条真实语句（如 return/记日志），而非靠加注释
星云白泽前端无 token 时 app.js 会降级隐藏大部分控件，无头截图不能证伪完整版布局；完整版布局需带 token 浏览器实看
sim 沙箱跑含顶层 TDZ(settings)的 app.js 会崩，纯 CSS 布局改动以「静态 DOM 结构+选择器命中」读回坐实即可，不必强跑 sim
批量移动 scratch 到 .Nebula-recycle 用 Python shutil 时，git status 输出的相对路径分隔符是 /，Windows 下须先 p.replace('/',os.sep) 再拼绝对路径，否则 os.rename/CopyFile2 报 WinError 3
量显存峰值用「边跑边每<1s采样 nvidia-smi 抓 max」，sd-cli 进度输出要重定向到文件而非 PIPE，否则进度流填满 pipe buffer 会卡住进程采不到峰值
前端持久化数据要进备份的，一律走「后端 JSON 权威 + localStorage 镜像」双写（bugBox/interruptLog/promptBook 三处同一模式），纯 localStorage 不进 git/bundle
给 http_server.py 的新路由加测试时用 STRATA_* 环境变量隔离数据文件（照 STRATA_INTERRUPT_LOG/STRATA_PROMPT_BOOK 惯例），测试绝不碰真实 config/
换图落位铁律：源图→字节级复制入 serve/web/img/（引用名沿用不改前端）、旧图落 .bak、SRC/DST MD5 对账，png 零转码
全套回归本机跑法：79 个脚本式测试逐个 python 直跑（pytest 收集会被自带 sys.exit 的脚本打断），3 项既有失败：test_encoding(缺编码声明)、gateway_monitor/management_api(需网关在线)
用完即送的脚手架只指本轮自建的；tools/ 历史积压未经扫描不得扩大删除范围
门禁测试锁定 run_all_tests.py 转发器：定位失败必红（非零+诚实stderr）、委托退出码必透传、参数必转发——防工作区根假绿旧病复发
前端行为门禁被本轮拍板正当推翻时（如控件形态改变），更新断言锁住「事实」（默认值/行为），不锁旧形态
无头浏览器截图工具等待窗<2.8s：harness 的自动交互脚本要安排在 ≤300ms 触发，长等待探针交给 browser__sim/jsdom
浏览器类 e2e（*_live.mjs、test_local_sibling_browser.mjs 等）默认 chromium.launch({channel:"msedge"}) 复用系统已装 Edge，免下载自带的 Chromium（PW_CHANNEL=chromium 才回退自带构建）；但 playwright 这个纯 JS 库本身仍需在装有 npm 的机器上安装——省的是浏览器二进制，不是库。
本地 harness 页必须放 serve/web/ 内经 http://127.0.0.1:8099/ 访问（放 evidence/ 走 file:// 会因相对 CSS 路径 404 渲染成裸页）
涉及8099的任务回答正文禁提宿主/8080/apps-host(历史经验检索结果与当前任务无关时不带入正文,避免用户误读「你在改宿主」)
涉及 i18n 文案改动：中文+英文两侧 + 静态 HTML 兜底文本三处必须同步，避免双语门禁红或加载前闪现。
commit 须在全套回归绿之后落，且只精确 add 本次相关文件（不裹跨会话笔记/脚手架），中文 message 走 UTF-8 文件 + commit -F。
回收站删除分两条路径：文件数 ≤ _RECYCLE_TRASH_SYNC_MAX(=3) 走同步（逐条 _recycle_resolve），> 阈值走后台批量 job；任何对 url→安装根映射的修复必须两条路径同时覆盖。
回收站映射差分锁在 tests/test_recycle_url_mapping.py（R1-R8），改映射逻辑后跑 python -X utf8 tests/test_recycle_url_mapping.py；锁必须含「原始输入不含安装根」的反向差分证 load-bearing。
改动含「移动代码行到函数顶部」时，必须先核对该函数入口处的卫语句（如 if(!sel) return）是否会拦掉新路径——本次 B4 场景实测抓到
jsdom 门禁里点按钮的 selector 就是 UI 契约的一部分：融合/移除按钮时同步改点击目标，并把旧结构写成负向锁（grep 不到旧 append 形状）
导入项删除的原件回链约定：source==="import" 且 name 在生成目录有实体文件时，删除请求必须同时携带 saved_images 副本 path 与 /data/generated/images/<name> 原件 path（app.js galleryTrashFiles，2026-11-16 方案A）
改 serve/web/app.js 前先备份 app.js.bak-<主题>，node --check 验语法，跑 test_gallery_import_jsdom + test_img_gallery_jsdom 双门禁后才算完成
Nebula-agent/serve/web/app.js 是 CRLF 文件：用 Python 重写它后必须把全文归一回 CRLF（门禁 test_gallery_import_jsdom.mjs 头部注释明示此约定）
画廊删除链的观测约定：前端埋点（fe_trash）盖 filter 前的逐条决策、后端 recycle-trace.jsonl 落 request/sync_one/batch_parse——根因未稳定复现前不得拆除，稳定后前端腿可降级为仅 console
画廊埋点降级已执行（2026-11-16）：fe_trash 前端腿=仅 console 不落盘，后端 jsonl 腿保留；周复盘任务已删；门禁 test_gallery_import_jsdom+test_img_gallery_jsdom 双绿
行尾甄别基线（2026-11-16 盘点）：i/-text 文本文件只剩 tests/test_ce_text_extract.mjs、tests/test_schedule_contract.mjs、tools/_flash_probe_upstream.py 三个；i/-text 是"本次入库瞬间"态，commit 后 git 重新嗅探会归一（test_img_gallery 实测），numstat 虚高须用 --ignore-cr-at-eol 取真实行数
Start-Process 分离发射 powershell 真跑脚本（如 _restart_8099.ps1）时，必须用 -ArgumentList 把 -ExecutionPolicy Bypass 传给被启动进程，否则新 powershell 退出码非0、不写 on-disk 报告；DryRun 分支在 self-protection guard 之前可安全直跑
8099 重启换血的权威证据以 netstat 当前 LISTENING PID 为准（须≠旧 listener），不要信脚本报告里 sleep-8s 时刻的 new-listener 空行（启动器有冷却、滞后）
改顶层启动器 bat 文件名时，活引用集中在三处须同步：i18n.js 中/英两处 chat.notice.gateway_down 文案里的「双击『X.bat』」、setup_env.py 完成提示 run 提示；用 git mv 改名（参数走 Unicode），i18n 只改 value 不动键名保键数
bat 改名属 git 跟踪文件，用 git mv 让 git 识别为 rename；bat 内的 title/注释是品牌名"Nebula Agent"与文件名无关，不必改；历史 changelog(VERSION_MANIFEST.md)记录旧名属历史事实保留不改
改 i18n.js 这类被多工作线共改的文件时，用 git add -p 按 hunk 只选本轮 hunk（喂 "n\ny\n..." 决策序列），把别的工作线改动留在工作区不裹入本次提交
改文件名/全仓引用替换时，扫描必须覆盖磁盘全量（含未跟踪文件）而非只 git ls-files，且镜像解码（utf-8→回退gbk）：GBK 文件用 decode("utf-8") 会被 except 跳过致漏检（本轮 setup.bat/部署说明.md 即如此漏）
被 .gitignore 显式忽略的文件（如 setup.bat @.gitignore:108）改动只落磁盘即对用户生效，不进 commit——改前先 git check-ignore 判定是否需入库
改名跨工作区/记忆/代码三处的目录时：先 git grep 摸全量引用面分 A代码/B测试/C配置/D文档/E历史流水，改 A-D 不动 E，测试路径锁必同步否则假红
工作区被 gitignore 的运行数据目录改名：物理 mv 整个目录即可；其中若有被 git 跟踪的例外文件（如归档 _mirror_parity_gate.py），到新位置需 git add -f 强制跟踪以保持"可 git 还原"语义
改 .gitignore 把旧目录名换成新名后，各工作区残留的旧名历史数据会暴露进 status；追加旧名忽略行（新旧同存）让历史数据留盘不污染 status，勿删数据
子工作区残留旧名数据目录改名：先 git ls-files 确认无跟踪文件（运行数据多被 gitignore），是纯磁盘 ren、不进 commit；根级 .gitignore 的 .Nebula-* 模式会覆盖各子目录同名目录，改名后仍被忽略不污染 status
改名被 gitignore 忽略的子工作区运行数据目录（.Nebula-recycle 等）：纯物理 ren 即可，不产生被跟踪改动、无需 commit；收尾只需 git grep 确认被跟踪文件无旧名引用，勿把别的工作线遗留 M 项混入本轮
验证涉及"正在运行的 8099 工作区"改名时：必须先实测对应 ledger/数据文件在新名路径完好到位，再跑全套回归，二者都绿才算无损迁移
改名被运行进程锁定的目录时：用脱离进程树的分离脚本(Start-Process)原子完成"停栈→git mv→改引用→重启→落盘报告"，脚本自身命令行须不含目标名以免误杀自己；主会话改前先备好文本引用脚本、改后做验证与提交
改源码根目录名后必查 load-bearing 硬编码：run_all_tests 转发器的 REAL_ROOT=os.path.join(WORKSPACE,"strata-agent") 这类写死子目录名的转发器/fixture，是改名最容易漏的断点
改名范围严格二分：指向当前目录的现行引用(配置/启动/规则/说明/资源/ROOT注释)全改；"过去的事实"(WorkBuddy旧绝对路径报错样本、旧root bug叙事、README git身份、退役归档件)保留——改了反而失真
清理 gitignore 忽略的一次性脚手架用"非 git 跟踪集 = 安全删除集"判据：先 git ls-files 取跟踪清单作保护白名单，删前再对候选逐一反向断言无一被跟踪，逐个点名送 VB DeleteFile(SendToRecycleBin)，保留其中的 *_gate.py 与登记在 run_tests 的在用工具，清后复跑全套回归坐实仍绿
回归门禁产出的 *_report.txt 是再生型产物（每次跑全量重写、判定已聚合进 stdout、无回读点），run_tests.py 在 main() 末尾 verdict 已定后调用 best-effort purge_transient_reports() 删与 .gitignore tools/*_report.txt 同集合的文件，OSError 静默跳过，绝不影响 CI 判定
对巨型单体的"纯函数等价迁移"重构：先用 AST 计算每个候选函数的精确行区间+扫描其引用的模块全局名(排除stdlib/局部名/内建)，external-deps 为空或仅彼此/纯stdlib 者才列为"安全叶子"整搬；搬出后立即与原文做 byte-identical 逐字比对作硬证，再仿既有 from serve.X import 的 try/except 双路径接入、调用点保持原名不改
续跑钩子("继续完成被打断的任务")触发时：先用 git status/diff 工具核实真实遗留，区分"未落账的记忆写入(先 diff 补齐)"与"计划里规划但尚未执行的下一步(继续做)"，两类都做完才收尾；对"看似成簇"的重构目标做整搬判定，必须递归一层核实其对簇外定义的依赖是否也纯净、并 grep 簇外定义的其余引用点——簇外依赖纯净且引用点少时可连依赖一并搬、用顶部 import 兜回以保调用点不变，依赖运行时态(如 Service/Event)的函数则留下不强搬
巨型单体"摘叶子成模块"选下一块时：先 AST 扫描列纯叶子，但成组必须读源码研判真实主题内聚(函数是否共享同一语义)，排除虽纯但异主题(如 RAM 告警 vs 采样校验)或内部 lazy-import 了 first-party 模块(如 gpu_vram_mib 引 serve.telemetry)的成员；调用点须 grep 全量(含被多处调用)由顶部 try/except import 兜回、调用点不改名
全套 --full 出现非本轮相关测试 FAIL 时，先单跑该测试(exit0=flaky)+排除 CPU 争用复跑全套取干净绿，勿据 flaky 误判为本轮回归(实测于 shell_timeout/self_suicide_guard 高负载)
给"等价迁移"拆出的纯模块补单测时，断言须对照被测函数真实契约(读源码确认)，每项配 load-bearing 差异分支，并必单跑——防止把测试写成"我以为的行为"而非真实语义
判断两函数是否同主题成模块时，按职责性质而非所属子系统：同一子系统的"配置装配"与"启动失败诊断"属异质职责不应合并；反之早前因"与A模块异主题"被排除的函数，常与另几个被同样排除者才是彼此的强内聚组成员，可据此成组
摘带模块级 os/sys 引用的纯叶子时，扫描按 stdlib 计 out-deps=0，但迁出后新模块顶部仍须补 import os/sys(模块级引用)；函数内 lazy-import 的 optional 依赖(psutil)留在函数内保其"缺件仍能 import 模块"性质
收尾确认脚本也要送 Windows 回收站，勿用 cmd del 物理删(本轮 _q_final.py 即误用 del)；含 find /c 计 0 时 cmd 返回码 1 属正常非错
用 Python 三引号模板批量生成测试/代码写入磁盘时，禁用 raw(r''')：raw 会让模板内 \n 保持字面反斜杠 n，写出的测试里 f.write(...\n...) 等换行断言失效；模板含 \n 字面须用普通三引号让 Python 还原真换行（本次 raw 误伤 test 夹具，靠读盘+独立诊断坐实）。
拍板指令里"给当前HEAD打baseline tag"：先完成本轮工作使HEAD前进后，tag落最新HEAD(含全部已完成成果)，正文注明所指SHA是下指令时快照；tag与bundle顺序=先tag后bundle(让新回滚点进--all备份)
删 baseline tag 这类不可逆 ref 操作前：先把每个 tag 的 40 位 commit sha 落进 docs/baseline-tag-archive.md 重建账本（随文档 commit 入库），并在删除脚本内断言“账本存在 + 逐 tag git merge-base --is-ancestor tag HEAD 全 rc=0”双保险通过才放行——祖先即删不丢 commit（master 链已含），账本 + 旧 bundle（留 14 份）双作可审计可复原的替代保障
删 baseline tag 要持久化必须本地删+git push origin --delete 删远端两步都做；只做本地 git tag -d 则远端保留全量 tag，任何 git fetch --tags 会把远端 tag 全量拉回本地、还原本地清理；GitHub push:tags:["v*"] 仅 tag 创建时触发 build、删 tag 是 delete 事件不触发，可安全批量删远端 tag
摘"引用模块级字面量常量的纯函数"为净叶子=连常量同搬+re-import三名字；搬前必 grep 全仓确认这些常量无其他引用点，且确认同族 impure 常量未被该函数读取(留原处)
判断"新增 .gitignore 规则是否误伤已跟踪源码"：带前导斜杠的 /serve/ 只锚定仓库根一级，不匹配 Nebula-agent/serve/；用 git check-ignore -v --no-index <已跟踪文件> 看命中哪条规则（donate-usdc.png 命中 :19 *.png 属既有规则非新规则），并用 git ls-files 确认已跟踪文件集不变——已跟踪文件不会因新增 ignore 规则被剔除，但需确认 status 无意外 D
.gitignore/RULES.md 等 i/lf w/crlf 文件追加时：Python 二进制读保留 \r\n、追加块用 CRLF；守卫判"规则是否已存在"须按整行 strip()==目标，勿用 substring in raw（会误匹配 Nebula-agent/serve 里的 /serve/ 子串致误跳过）
路由/能力开关类改动涉及多类条目（self 空 base / 外部端点 / 带 base_url 的兄弟本地实例）时，改前必须读实每条分支对该能力的真实处理，并确保同一能力对所有条目类型行为一致；旧注释里对某类条目能力的隐含假设（如“兄弟实例自带工具故纯代理”）是这类静默失效的高发来源。
需要 ROOT 的新模块一律 `from config_loader import project_root; ROOT = project_root(__file__)`，禁止再各自写 dirname 两层（产物里必偏一层）
登记新 suite 到 run_tests.py 的三条硬验：位置在 SUITES 主区（不在 SLOW_SUITES）、前一项必须以逗号结尾、全套输出里必须真出现该 suite 的 PASS 行
给带行尾注释的列表项补尾逗号时，逗号必须插在闭合引号之后、`#` 之前；在行尾 append 只会改到注释文本
插入"列表条目 / YAML 步骤"这类顺序敏感的改动，验收一律用语义求值（AST 求列表、解析后比对步骤顺序），不能只凭 py_compile 或"YAML 可解析"
用 Python 向已有文件插入文本块时，全文只允许一次行尾转换（先二进制读→按目标 eol 只转换插入块），插入后断言"空行段数不得多于基线"，否则会产生 \r\r\n 并在归一时变成隔行空行（2026-11-20 实测虚插 36 空行）
目标文件的权威行尾以 `git show HEAD~1:<file>` 的 blob 字节为准，不是工作树 w/crlf；怀疑行尾被污染时最可靠的做法是从 HEAD~1 blob 重建 + 重放插入，而不是反复猜 CRLF/LF
清理一次性脚手架前跑引用扫描并分三档：零引用=删、仅被历史流水(.Nebula-memory/logs)提及=默认保留、被代码/配置/测试/文档提及=保留；扫描必须排除自身且候选互引不计
工作区里凡带 .Nebula-secrets/ 的目录即便被 .gitignore 屏蔽，token 轮换闭环完成后必须主动清理目录内的旧 token 文件（送 Windows 回收站），别只盯 .git/config 的明文
GitHub 凭据托管首选 gh CLI(winget install GitHub.cli; gh auth login --with-token 走 stdin 喂 token; gh auth setup-git 接管),它写 host 级 credential.https://github.com.helper 而非全局 credential.helper——核查 helper 生效要看 git config --get-all credential.https://github.com.helper,读全局 credential.helper 会误判仍是 manager
前端把某配置项塞进共用 store 键（如 settings→sampling）= 它会被整对象写连带落盘，易被旧标签页陈旧快照交叉覆盖；需要独立持久化语义的字段应拆独立 store 键并加 Array.isArray/undefined 回退守卫
baseline 回滚 tag 命名沿用 v-baseline-YYYY-MM-DD-字母(如 v-baseline-2026-11-21-a);打 tag 前先 git tag -l "v-baseline-<今天>*" 确认无冲突,git tag -a <名> <sha> -m "..." 在指定 commit 打带注释 tag,git rev-list -n1 <tag> 核对指向(git rev-parse 的 ^{commit} 在 cmd 下会被转义破坏,用 rev-list 规避)
前端 serve/web 改动收尾：node --check 验 app.js/i18n.js 语法 → 跑对应 jsdom 门禁(含 decoy) → tools\run_tests.py 全套 ALL GREEN → git diff --numstat 与 --ignore-cr-at-eol 必须相等(零行尾污染)才落 commit
侧栏工作区排序模型(方案C)：pinned 强制浮顶 + loose 无工作区桶强制最底 = 不可拖拽/不可作落点的分层墙；中间层按 workspaces 数组序自由拖拽；默认顺序快照 = 注册顺序(ws.order.default)
Nebula-agent/data/ 下运行态数据(semantic.db/episodic.jsonl/uploads)已 gitignore：体积/数据优化只动代码与数据文件本身，绝不 git add 这些；落账精确暂存代码文件并排除别线(RULES.md/fs_allowed_roots.txt)漂移
改 runtime/semantic.py 或 servers/memory_server.py 后收尾必跑全套回归(含 test_policy.py)——memory 契约锁集中在此，改默认行为极易触发 RED，numstat==--ignore-cr-at-eol 才落 commit
加调度任务时 task 命令必须带 cd /d "绝对路径" && 前缀 + 配 roots，对齐既有备份任务格式：调度器不在 Nebula-agent cwd 下跑，裸相对路径 python tools\... 会找不到脚本形同虚设，加完必模拟跑一次该命令坐实可执行
给 commit message 含特殊字符（> < & | 等 shell 元字符）时禁用 PowerShell 内联字符串拼接（外层 cmd 会把 >= 当重定向切正文+凭空生成文件），改用 python io.open 写 message 文件 + git commit -F，写完 git log 探针验证正文完整
向含别工作线未提交漂移的共享文件追加本轮条目时，插在 committed 区中部(与末尾漂移被≥3行上下文分隔)使成本轮独立 hunk，再 git add -p 喂 y(本轮)/n(别线)决策串拆分；提交后用 git diff --cached --numstat 核验 staged 行数恰=本轮真实改动数(防裹入别线)
判定测试退出码（CI 契约以 returncode==0 为唯一判据）时，cmd 里同一条行用 %errorlevel% / && / || / findstr 串联都会污染或错位读取退出码（实测出现 %errorlevel% 空、&&|| 全假红而脚本实际 EXIT 0）；须用 Python subprocess.run(...).returncode 单独读取才是可信判据
baseline-tag-archive.md 真实落点是 Nebula-agent/docs/（非仓库根 docs/），登记"当前回滚点"时沿用其既有表格+重建命令格式，新增"当前回滚点（保留）"小节而非改写被清理条目
backup-bundle 的镜像偶发只写主盘导致两盘集合分叉一个时间戳：此时两盘仍各自正确执行 keep-14、不会误删共有备份，且最新回滚点两盘一致——复核判据应看"共有同名 bundle 字节一致 + 最新点同含目标 tag"，而非仅看"逐名严格相同"
改 星云白泽.bat/.sh 启动器时：run_standalone 是前台阻塞的 8099 网关(带自愈 loop)，必须另开窗口(.bat start / .sh nohup &)起它，否则占用本窗无法自动关窗；gw_watchdog.* 自身已后台化(start /min 或 nohup &)，调用它用 call/bash 直接调即可、勿再套 start 免多空壳窗
maybeAutoResume 的 early-done 分支已按 Plan A 改造：earlyCap=独立常量 EARLY_DONE_CAP(2)，且 awaitingReply(未关闭决策卡∨hold 等确认项) 时不触发；改动 app.js 该函数后必须同步给抽取真身的 harness（test_early_done_lane/test_autoresume_lanes/test_owner_binding_jsdom）注入 let EARLY_DONE_CAP=2，否则真身求值 ReferenceError
新增"前端设置可调配额"时镜像同形态姊妹项（如 default=2 的 emptyRoundMax）四件套：DEFAULTS 默认值 + 运行时 earlyCap 读 settings.X 且非法回落模块级常量兜底 + loadDrawer hydrate + saveSettings clamp 持久化 + index.html 数值 input + i18n 四键 zh/en；保留模块级常量作默认安全网，运行期优先读 settings。改 earlyCap 这类函数后须给抽取真身的 test_early_done_lane harness 同步注入新 settings 字段才能测覆盖分支
星云文档语言约定（2026-11-22 拍板，与软件默认语言一致）：裸名 X.md = 简体中文默认版，X.en.md = 英文对照翻译；GitHub 按访客浏览器语言自动在两者间切换，故"裸名"必须放中文。新增文档一律遵此命名，顶栏统一写「**简体中文** | [English](X.en.md)」互链。法律文件 CLA.md 双语同文件属例外，不拆。
打基线 tag 的措辞铁律：annotated message 只写本轮"实际验证过"的事实，不得写未经实跑的状态（如纯文档改动不可写 "CI green"）；命名 v-baseline-YYYY-MM-DD-<字母>，按当天已有 tag 续字母，遵循不推 origin 的仓库惯例（先 git cat-file -t 比对既有 tag 类型再打）。
加/跑 backup-bundle 类容灾任务前先 fetch 坐实本地=远端 0 0 且 status 干净，确认 bundle 取的是无漂移的权威 HEAD，再执行备份
补文档 .en.md 双语对照的标准做法：仅译说明性正文，git 命令/SHA/英文 commit message/UI 实体名/真实路径作为历史数据逐字保留不译；中英两版顶部都加「简体中文 | English」互链顶栏（模板=docs/backup-soft-alert.md）
给中文原文补顶栏用 Python 脚本：二进制读→按首行换行判定原行尾→逻辑 LF 编辑→按原行尾写回→断言顶栏标记 count==1，避免 CRLF/LF 污染
新增测试必须登记进 Nebula-agent/tools/run_tests.py 的硬编码清单（非 glob 自动发现）；纯静态锁（直读源文件+decoy 差分+process.exit）紧跟同族 preview 锁、归 quick 档。run_tests.py 是混合行尾(CRLF)，插入须用二进制按 \r\n split/join 保留行尾。
tests/test_model_switcher.mjs 已完整 boot app.js 并暴露 window.__api（含 openModelForm/submitModelForm/$=getElementById），是给模型管理相关前端新功能做运行时实测的理想 harness——复用它在末尾追加 Tn，勿另造 boot
给 model-modal 加新交互时，代码不得含完整串 `if (e.target === $("model-modal")) closeModelModal();`（test_form_modal_close 锁#1）；多行 if 条件且不 close（如仅弹提示）即安全
backup-bundle 前置铁律精化：若本地 ahead 远端且有要固化的 commit，顺序必须是 push→再 fetch 坐实 0 0→再 bundle，让 bundle 取到已同步的权威 HEAD；左0右N 是纯快进 push 安全，双侧各 ahead 才是真分叉须先停。切勿在 ahead 状态直接 bundle（会把"未推送"误固化）
前端设计规范放 group 层（.Nebula-memory/groups/<组>/RULES.md）：只在已归组工作区注入、未归组零成本，优于 global 层无条件全注入；归组用「设置本工作区分组」按钮填组名（currentGroup=getGroupLabel 读 <ws>/.Nebula-memory/group.txt）
记忆页所有 .mem-tabpanel 卡同时可见各自可折叠（app.js applyMemSubTab 11337+），新增一类记忆卡只需追加 data-mem 卡 + 对应 renderXxxCard 接进 renderMemory，无需改 sub-tab 切换器
规范/rules 类内容不做 token 级懒加载（区别于 knowledge/experience）：硬约束漏注入即失效；其"按作用域(工作区/组)条件加载"本身就是恰当粒度
前端规范自动加载(方案C)落点在 loadMemoryState 的 group 分支：currentGroup=deriveGroup(base)——显式 group.txt 组名 > __none__ 哨兵(尊重不外推) > 仅"从未配置"时按 <ws>/serve/web/(app.js|index.html) 只读探测映射 frontend，绝不写盘；新建工作区经 ws-apply(2067)或 selectSession(1626)都触发它故自动生效
自动检测类特性一律"只读推导当前态、不写持久文件"，并提供显式 opt-in/opt-out 覆盖；要区分"用户主动退出"与"从未配置"需写显式哨兵(如 __none__)而非空行，空行无法区分二者
归组能力的唯一真相源是 setGroupLabel + <ws>/.Nebula-memory/group.txt（含 __none__ 退出哨兵）；任何新增归组入口都必须复用它，不得另起第二套逻辑。归组字段"留空"必须是不写盘的 no-op，绝不能调 setGroupLabel("")（那会误写退出哨兵并覆盖方案C自动探测）
归组枚举用 listGroups() 只读列 <GLOBAL_ROOT>/groups/，渲染下拉用 fillGroupSelect()：首位空选项=不归组、列出全部已有组、当前组即使不在盘上也始终呈现以便选中
"内置标识符显示层映射"必配静态契约锁防漏用：锁「option value=真实id(esc(g)) 但可见文本必须 groupDisplayName(g)」、锁展示文本渲染点(当前分组行/卡摘要)经映射、锁控件形态不回退(ws-group 必须真 select 不得 datalist)，并用「剥掉映射包裹后对应锁即翻红」的 decoy 差分证 load-bearing
把 text+datalist 控件改成 select 时：select 只能列已有项，"创建新项"的能力必须另留一个自由文本框承载，提交逻辑"新建名优先、否则取 select 值"；同时去掉任何无处理器的即时按钮(表单提交式弹窗由主提交按钮统一处理，多余即时按钮=误导)
统一误用术语(如"空间/工作空间"→"工作区")时逐条对照该 key 的英文原值判语义：英文是 workspace 才改，英文是 storage/space 等真实义(如 Browser storage is full→存储空间)保留不动；改完复扫确认只剩真语义那处
新增 .mjs 测试必须登记进 tools/run_tests.py 的 SUITES(按主题就近、保持该区条目间空行风格、按 CRLF 行插入并 py_compile)，否则不参与全套回归
凡设 overflow-y:auto/scroll 的滚动容器必须显式声明另一轴 overflow-x（本UI里聊天/列表类外层用 overflow-x:hidden，内层 .st-code pre/.table-wrap 各自 overflow:auto）：CSS 规范下一个轴为 auto 会把另一轴的 visible 计算成 auto，瞬时横向溢出就会弹出多余横滚动条；改后须用真实浏览器读 getComputedStyle().overflowX 复验(jsdom/sim 不算 CSS)
加固单轴 overflow 前必先按三档定性再动手，禁一刀切：①真隐患=竖向列表/面板/输入外层缺 overflow-x→补 hidden；②有意单轴横滚=横向标签栏/胶片条/横向表格(.st-header .st-tabs/.img-gallery__grid--strip/.table-wrap)→保留；③同元素另一条规则补另一轴(如 .table-wrap.all 叠 .table-wrap)或 overflow-y:visible 非滚动→跳过。同名 class 的媒体查询块可能是 width-only 非滚动，按块内容 overflow-y:auto 判定，勿按选择器名批量改。
打完最新 baseline tag 后随手同步远端（常规流程）：先 git push origin main（先核 behind=0 再 fast-forward 直推）让 origin/main 前进，再单独 git push origin <最新那一个 tag> 只带上这一个最新回滚点；绝不用 --tags（会把所有历史基线一次性洗上远端），历史基线保持本地不推（已由 E/F 双盘 bundle 兜底）。推送后坐实 origin/main...HEAD=0 0 且远端 tag 仅新增这一个。
推送顺序必须先 main 后单个 tag：单推一个尚未上远端的 tag 会半推（commit 对象随 tag 上传但 main ref 不动），先推 main 前进再推 tag 才干净一致。
apiMessages→assistantMessages 是发往上游的唯一 message 组装路径；任何进入请求的 content 必须已是 string 或 content-parts 数组。判定某字段在历史里可能有坏类型的最强旁证=渲染层已对该字段做 String() 包裹/==null 判断——凡发往上游的同字段必须做同款规整（工具结果即 toolResultText：null→""、string 原样、对象→JSON.stringify），否则严格上游报 400 "content must be a string or an array of content parts"。
setup_env.py 换路径闭环：fs_allowed_roots.txt 是 git 跟踪的原作者个人目录清单，换机器/换盘后多半不存在；module 级纯函数 reset_fs_allowed_roots(path,root,keep) 默认剔除本机 isdir=False 的条目并补上安装根 ROOT（开发机幂等原样、首次备份 .bak 不覆盖），--keep-roots 原样保留手配白名单；main step3.5 调用它；setup.bat 转发 %*、setup.sh 转发 "$@"（setup.sh 是 git attr eol=lf 强制 LF，改写它必须按 LF 写回，否则破坏行尾）；回归锁 tests/test_setup_backup_lock.py（已登记 run_tests.py）。
往含别线未提交漂移的共享文件（RULES.md 等）只追加本轮 1 条时，用「备份工作树→临时写成 HEAD blob+本轮条→git add→还原备份」实现比喂 git add -p stdin 更可控的精准 stage：index 仅比 HEAD 多本轮条，别线漂移留工作树 unstaged；还原后必须读回断言本轮条在工作树仅出现 1 次（防双份）
别线 RULES 漂移处置约定：工作树里 RULES.md 相对 HEAD 多出的未提交条目，是别的工作线早已沉淀（已生效，系统每轮从磁盘工作树注入）但一直没 commit 的有效记忆，不是垃圾——不得删。整批做一次独立 chore commit 落账即可（git add RULES.md 整文件，commit 前用 numstat==--ignore-cr-at-eol 坐实零行尾污染），提交后工作树转干净、条目进 bundle 备份可还原。
门禁登记档位以实测墙钟为准，勿按测试名字猜 SLOW/quick：先单跑计时(<1s 归 SUITES 主区，≥3s 才归 SLOW_SUITES)，且登记后跑全套确认该 suite 的 PASS 行真出现在输出里。
新增设置抽屉布尔开关需 5 处接线：app.js DEFAULTS 字段 + index.html toggle-row(id=s-xxx) + loadDrawer 读回 + collect 写盘 + onclick 切换，全部对齐既有 s-stepsfold 模式
i18n 新增 drawer.* 键必须 zh/en 双语各补一份且值末尾保留逗号（tests/test_i18n.mjs 锁 zh/en 键数一致）
web 前端 app.js/index.html 改动需重启 8099 才生效，仅浏览器刷新不够
门禁 node 在 "E:\Program Files\nodejs\node.exe"；test_i18n.mjs/test_debug_section_collapse.mjs 在 Nebula-agent/tests/，jsdom 用 createRequire 指向 C:/Users/sk/.workbuddy/binaries/node/workspace/
run_tests.py 实际在 tools/ 下（非 Nebula-agent 根），只支持 --quick/--full 跑全套，无按名过滤；.mjs 门禁登记进 tools/run_tests.py 的 SUITES 列表即入 QUICK 档
新增对称布尔开关时，若两个开关默认值不同(如 debugFold=true / memFold=false)，loadDrawer 的 aria-checked 表达式也要随默认值反向：默认true用 `!== false`、默认false用 `=== true`
采样抽屉双层默认值模型(方案A 2026-11-24)：sampling 键=当前生效值(s-apply/s-setdefault 都写)、sampling.default 键=重置基线(仅 s-setdefault 写)；s-reset=loadDrawer(store.get("sampling.default")??DEFAULTS) 只刷界面不落盘；s-setdefault=s-apply 后再 store.set("sampling.default",深拷贝settings)
改 s-reset/s-setdefault 这类按钮语义的连带面：i18n drawer.reset.tip + drawer.setdefault.tip + drawer.setdefault.confirm 三键中英各改(仅改value不动键名保键数) + 改既有 test_setdefault_button_jsdom.mjs 若契约被推翻 + 同步补新行为门禁登记 SUITES
仓库无项目级 CHANGELOG 时按 Keep a Changelog 惯例在仓库根新建 CHANGELOG.md，[Unreleased] 段记近期未发布改动，中英对照；.md 类文件行尾用纯 CRLF（与 DESIGN.md/RULES.md/CONTRIBUTING.md 一致）
修回归 harness 脚本(_rollback_verify.py/run_tests.py)用 in-place Python 逐行 splitlines(keepends=True) 改写保留原 CRLF，改前改后各测 crlf/bare_lf 计数比对 HEAD blob 坐实零行尾污染，再 py_compile 验语法。
给静态门禁脚本登记 SUITES 前先单跑计时：<1s 归 run_tests.py SUITES 主区(QUICK)，≥3s 才归 SLOW_SUITES；登记后必跑全套确认该 suite 的 PASS 行真出现。
PowerShell `Get-Content -Raw | Set-Content` 写含中文的 .py 会落 GBK 致 Non-UTF-8 SyntaxError；脚手架 .py 一律纯 ASCII 或由 Python 自身写出，别用 PS 改写。
win32com Shell.Application 送回收站的命名空间方法名是 `NameSpace(10)`（大写 S），写成 `Namespace` 会 AttributeError。
