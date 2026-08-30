# 代码地图（CODE MAP）

> 用途：改代码前的**定位图**——每个文件管什么、核心链路怎么走、「改 X 先读 Y」。
> 与 docs/DESIGN.md 的分工：DESIGN 管「为什么、口径是什么」；本图管「在哪、怎么接线」。
> 维护纪律（2026-08-30 第十七轮立，缘由＝用户指出「每次一点小改动都要阅读很久」）：
> 新增文件、新增链路、某文件职责变化时**必须与代码同一提交更新本图**；行数与行号会漂，
> 定位一律以**分区横幅标题＋函数名**为准，不要按行号找。

## 0. 全景：加载与分层

- 入口＝仓库根 `index.js`（manifest 指定）。装配顺序：initDrawer（主面板＋页签注册）→ initWandMenu（魔法棒入口）→ initListener（监听引擎，总开关默认关）→ 挂三个酒馆事件（CHAT_CHANGED / MESSAGE_RECEIVED / MESSAGE_EDITED，各自做什么见 index.js 注释）。
- **分层**（自上而下调用，尽量别跨层）：
  1. **UI 层**：`index.js` ＋ `js/ui/**`（drawer / wandMenu / tabs/*）——只管界面、勾选、按钮；模型调用与数据规则一律下沉业务层。
  2. **业务层**：planner / listener / knowledge / randomEvents / reactions / memoryTable / lorebook / store / injection / units / story / gameplayConsult / materials。
  3. **通道层**：`api.js`——**全部模型调用与联网搜索的唯一出口**。全局预设注入、思考关闭（含分家）、思考标头掐断重试、坏 JSON 修复重试、400 参数梯子全在这层，任何调用方都自动受益。
  4. **数据层**：`settings.js`（全局设置单例）/ `chatdata.js`（每聊天数据按聊天身份走）/ `utils.js`（纯函数）/ `context.js`（对 getContext() 的唯一依赖点）。
- **酒馆全局依赖收口**：`from "/script.js"` 或 `from "/scripts/extensions.js"` 只出现在 5 个文件——`index.js`、`settings.js`、`injection.js`、`store.js`、`listener.js`。宿主升级失联先查这五扇门（与 DESIGN §4 同口径）。

## 1. 文件清单（行数为 2026-08-30 量级，只作大小感）

**通道与数据（小而稳，很少动）**

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| api.js | ~440 | 模型通道＋联网搜索；预设/思考关闭/标头重试/JSON 修复全在这 | chatCompletion、parseModelJson、globalPresetBlock、withGlobalPresets、searchWeb |
| settings.js | ~150 | 设置单例＋默认值＋老安装迁移（补键都在 ensureDefaults） | settings、save、newId |
| chatdata.js | ~140 | 每聊天数据冷热双层（chatMetadata 热层 ↔ settings.chatData 冷层留底） | loadChatData、saveChatData、flushChatData |
| context.js | ~70 | getContext() 唯一依赖点：聊天记录＋角色卡摘要 | collectPlanningContext、characterSummary |
| utils.js | ~170 | 转义/截断/容错 JSON（extractJson）/指纹/文件读写/token 粗估 | extractJson、escapeHtml |
| materials.js | ~110 | 材料小节拼装（规划/检查/事件/反应共用——预览与真实调用同一拼法） | materialSections |
| injection.js | ~140 | M4 隐身注入：setExtensionPrompt 调用全部收口在这 | addInjection、replayScopedInjections、tickInjectionExpiries |
| store.js | ~60 | M5 游戏玩法注入（键空间 pps:） | scanAndApplyStorage |
| units.js | ~210 | T2 单元池数据层（chatdata 的 units 块） | 单元增删改、加工史徽章规则 |
| story.js | ~85 | 进行中剧情＋历史归档（经 chatdata 按聊天走） | 采用/完结/归档入口 |
| lorebook.js | ~250 | M1 世界书导入＋关键词检索 | scanLorebooks、resolveLorePicks |

**业务逻辑（改动热点）**

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| planner.js | ~680 | 规划分析（两遍调用编排）/检查报告/联网研究/规划系统提示词 | runPlotGuidance、runStoryReview、buildGuidanceMessages、guidanceSystemPrompt、alignTailPrompt |
| listener.js | ~950 | 2.0 监听引擎：单位/轻量双模式、两套提示词、判定落账、排队闸、宿主接线 | runListenerRound、initListener、listenerProvider、buildUnitPrompt、buildLightPrompt、createSendGate |
| knowledge.js | ~430 | 知识库数据层：清单/条目/轮换抓取/发送集裁决/冷却/长草稿分批导入 | kbSendPayload、grabFromList、knowledgeSection、structureImport、settleCooldown |
| longform.js | ~560 | 2.0 长线规划：chatdata longform 块（书-卷-章-节点＋进度账）、四份管线提示词、六步编排（骨架/具体化/修订/再切小）、章→监听单位挂载 | lfState、runLfSkeleton、runLfDetailBatch、runLfRevise、runLfSplitBatch、mountChapter、syncLfProgress、rescaleFloors |
| randomEvents.js | ~310 | M3 随机事件三层（维度/条目/掷骰管线）＋三路生成 | 各生成入口 |
| reactions.js | ~165 | 路人反应校准卡生成 | 生成入口 |
| memoryTable.js | ~585 | 记忆表格对接（只读 st-memory-enhancement 原始数据）＋镜像维护＋AI 打标 | buildMemoryContext、syncMemory、mergeMirrorFromSource |
| gameplayConsult.js | ~50 | 玩法咨询：一句思路→完整玩法规则 | 咨询入口 |

**UI 层**

| 文件 | 行数 | 职责 |
|---|---|---|
| ui/drawer.js | ~160 | 主面板抽屉＋页签注册（UI 铁则见 DEVELOPMENT_PLAN §13；排版宁宽勿挤） |
| ui/wandMenu.js | ~30 | 魔法棒菜单入口 |
| ui/tabs/tab-guidance.js | ~2530 | **最大文件**：三步向导全部＋两个工具面板＋两个材料面板（内部分区见下） |
| ui/tabs/tab-memory.js | ~705 | 记忆表格页（镜像/原表库/已删除/打标/备份恢复） |
| ui/tabs/tab-settings.js | ~680 | 设置页（连接/方案库/联网搜索/监听/知识库/高级/预设/备份搬家） |
| ui/tabs/tab-events.js | ~500 | 事件库设置＋AI 建库两折叠区 |
| ui/tabs/tab-worldbook.js | ~460 | 世界书页（导入/启停/条目编辑/检索测试/回收站） |
| ui/tabs/tab-knowledge.js | ~450 | 知识库页（清单管理/结构化导入/冷却徽章） |
| ui/tabs/tab-listener.js | ~390 | 监听页（状态条/当前单位/本轮指导/旋钮/留痕悬浮窗） |
| ui/tabs/tab-longform.js | ~430 | 长线规划页（参数表单/卷卡/修订/再切小/执行总览——挂载与接续入口在这） |
| ui/tabs/tab-storage.js | ~330 | 游戏玩法工具区（条目库＋就地编辑） |

**tab-guidance.js 内部分区**（定位先搜这些横幅标题）：向导进度快照 → 步骤跳转条 → 悬浮查看器 → 第 1 步勾选按对话记忆 → 第 1 步渲染（材料页）→ 顶部：进行中剧情状态条＋历史归档 → 剧情注入自动绑定 → 主区：按向导步骤渲染（①材料/②确认/运行页/③结果，最大的区）→ 两个现场工具的悬浮面板（随机事件/路人反应，产物＝单元）→ 知识库抓取悬浮面板 → 世界书自选悬浮面板 → 分析调用/第 3 步人工二检＋封装 → 近期草稿骨架 → 检查报告。

**listener.js 内部分区**：概览逻辑（单位文本）→ 每聊天状态（chatdata 的 listener 块）→ 单位构造与 1.0 规划节点化 → 楼层收集与格式化 → 两套提示词组装（单位/轻量）→ 输出契约规范 → 判定结果落账 → 排队闸状态机 → 宿主接线：引擎循环（runListenerRound/listenerAttempt/writeSlot）→ 宿主接线：触发时机（initListener）。

## 2. 核心链路（谁调谁）

1. **规划分析（两遍调用）**：tab-guidance 的 startAnalyze → planner.runPlotGuidance → 材料拼装（planner.materialSections＋knowledge.knowledgeSection＋materials/lorebook 各小节，排序规则＝稳定在前、会变的垫底）→ api.chatCompletion 第一遍（onStage('analysis')）→ parseModelJson → 第二遍：messages 与第一遍逐字节相同＋planner.alignTailPrompt 审校指令追加 user 末尾（吃前缀缓存——**第二遍的改动只许追加在尾部**）→ 返回 {result, raw, usage} 随向导快照留底 → 确认采用时 story 落账＋knowledge.settleCooldown＋骨架清空。
2. **监听一轮**：listener.initListener（MESSAGE_RECEIVED 去抖）→ runListenerRound → collectFloors/assembleWorldbook/assembleExtra → buildUnitPrompt 或 buildLightPrompt → listenerAttempt（**恒 thinkingOff:true，第十七轮分家**；90 秒超时重试一次）→ normalize×2 → applyUnitOutcome/applyLightOutcome 落账 → writeSlot 写独立注入槽 → 派发 pp-listener-updated → tab-listener 刷新。切聊天＝中断在途＋clearListenerSlot。
3. **知识库**：导入＝tab-knowledge → knowledge.structureImport（长草稿分批，每批一次调用）→ 入库；抓取＝tab-guidance 面板 → knowledge.grabFromList（轮换队列在 list.queue）→ 面板勾选/踢/整把重抓 → knowledge.kbSendPayload 裁决发送集（面板/确认页/真实调用三处共用）→ knowledgeSection 进材料 → 结果页 knowledgeUsedLabels 解析自报 → settleCooldown 只在确认采用/转注入时结算（草稿放弃不碰）。
4. **隐身注入**：story 确认采用自动绑定 → injection.addInjection/applyInjection → index.js 事件里 tickInjectionExpiries（按楼层净增计层）＋replayScopedInjections（切聊天重放）→ 生效中的注入在 tab-guidance 底部折叠区查看/撤下。
5. **检查报告**：tab-guidance 检查入口 → planner.runStoryReview（与向导共用运行页、流式上屏与并发闸）→ 报告页。
6. **长线管线（第十八轮新增）**：tab-longform 参数表单（想法/楼数随 longform 块留底）→ longform.runLfSkeleton（骨架＋切块一次调用；rescaleFloors/validateVolumes 楼数算术在本地）→ runLfDetailBatch 逐卷并行（材料与骨架块整批拼一次、逐卷共享同一前缀）→ runLfRevise 按意见整书修订 → runLfSplitBatch 逐卷并行切章（章预算同款本地重配）→ mountChapter 把章挂进监听单位槽（source:'longform'、unitId 记在章上）→ 监听每轮判定后 syncLfProgress 把 nodeIdx 写回章的 lit（进度账的持久方是 longform 块，监听槽只是执行位）。

## 3. 「改 X 先读 Y」路由

| 要改什么 | 先读 | 注意 |
|---|---|---|
| 任何提示词文案 | planner.js（guidanceSystemPrompt/alignTailPrompt）或 listener.js 提示词区 | 改了＝新提示词，交付报告送全文（未点名＝过审，2026-08-30 立规） |
| 界面文案/布局 | 对应 tab 文件＋DEVELOPMENT_PLAN §13（UI 铁则） | 用户可见文案逐条点名；改名须点名「X 已改名 Y」 |
| 材料口径/排序 | materials.js＋knowledge.knowledgeSection | **排序对前缀缓存敏感**：开头会变的垫底、差异只许追加尾部 |
| 计费/usage | planner.runPlotGuidance 的 usage 合并＋api 的 onUsage | 两遍合并实报；中断/掐断的口径要如实 |
| 冷却/轮换 | knowledge.js（settleCooldown/grabFromList） | 结算只在确认采用/转注入；轮换两层防重复与冷却互不替代 |
| 长线管线/章挂载 | longform.js 对应分区＋tab-longform | 楼层算术（rescaleFloors/validateVolumes）全在本地、模型给的数只作参考；卷/章预算改了必须过校验；进度账在 longform 块、监听槽只是执行位（syncLfProgress 单向回写）；换算锚与监听共用 settings.listener.progressMin/Max |
| 监听判定/指导 | listener.js 对应分区 | 发调恒 thinkingOff:true；失败路径绝不挂死发送（排队闸兜底） |
| 加设置项 | settings.js 的 DEFAULTS＋ensureDefaults＋tab-settings.js | 三处一起动；老安装迁移靠 ensureDefaults 补键 |
| 注入相关 | injection.js＋index.js 事件 | setExtensionPrompt 只准在 injection.js / store.js / listener.js 三处出现 |
| 思考关闭/参数方言 | api.js 的 thinkingOffParams＋重试梯子 | 用户环境＝DeepSeek 官方（DESIGN §6.5）；新增方言加在 thinkingOffParams |
| 向导状态机/快照 | tab-guidance 的快照区＋restoreWizard | 快照是进度留底的权威；改状态机先看令牌作废路径 |

## 4. 状态放在哪（改前先分清「这份数据属于谁」）

- `settings.*`＝全局（跨聊天）：连接/方案库/检索参数/知识库清单/监听全局项/事件库/玩法条目。
- `chatdata`（按聊天身份）：记忆镜像/剧情档案/向导勾选 picks/单元池/监听留痕与状态/向导快照（wizard 块）/近期草稿骨架/长线整本（longform 块：书-卷-章-节点＋进度账＋挂载记录）。
- 模块变量（刷新即失）：tab-guidance 的流式上屏态（streamText/streamReason/streamFirstText，结构见 updateStreamView）、listener 的 running/gate。
- 经验教训（第五轮）：状态清理按「数据属于谁」分家——生成结果该清、用户攒的材料不陪清；有副作用的账只挂「正式生效」的动作。

## 5. 易踩点（历轮教训沉淀）

- **chatdata 就绪窗口**：插件侧双层存储即时可读，ctx.chat/chatMetadata 随大聊天延迟加载——比对前查 ctx.chat 非空；早退分支记得清陈旧标志（E5 误报根因）。
- **向导令牌**：切聊天/重开向导作废在途回调；新加异步回调先想令牌。
- **流式上屏**：增量走 scheduleStreamView 约 120ms 一拍；结构切换整体重建是 O(全文)，别在热路径全量重排（第十四轮卡死根因）。
- **酒馆页面跑旧 JS**：真机复验前 Ctrl+F5 强刷。
- **展开字符串字面量**：`...(cond ? 'a' : 'b')` 会按字符拆散，必须 `['...']` 包数组。
- **cmd 环境**：无 ls/rm/head/grep；`;` 不是命令分隔符（用 &&）；rg 正则里的 `|` 会被 shell 当管道（拆多个 -e）；rg 中文经管道输出会 GBK 乱码；node --import 必须 file:///C:/... 带盘符冒号。
- **离线测试台**：%TEMP%\pp-re-test（第十六轮重建的精简台，第十八轮扩至 61 项）；%TEMP% 会被系统清理——重要断言随轮次记进交付记录，丢了照记录重建（搭法在记忆 offline-testbed-technique）。
