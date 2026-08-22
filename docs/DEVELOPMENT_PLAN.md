# 剧情规划器（Plot Planner）开发方案

> 本文档是项目的基准文档（single source of truth）。后续所有开发以本文为准；
> 涉及架构、数据结构的重大变更，先改本文再改代码，并在第 12 节记录变更。
>
> 状态标记：✅ 可用 · 🔶 部分实现 · ⬜ 未开始（对照第 8 节路线图）

---

## 1. 项目概述

一个 SillyTavern（酒馆）前端扩展，围绕「剧情编排」提供五个功能板块，
通过 GitHub 仓库分发，自带一条**独立于主界面的大模型 API 通道**。

核心价值：

- **独立通道**：规划、事件生成等调用走插件自配的 API，不占用主对话连接的算力，也不向主对话提示词追加 token。
- **按需检索**：世界书不全量输入，先判断「当前剧情实际用到哪些条目」，只把命中条目 + 必要上下文喂给模型。
- **幕后编排**：明盘 / 密封双模式隐身注入，解决「让模型输出其他角色 → 用户全知视角；不让输出 → 模型缺上下文瞎写」的矛盾。
- **轻量依赖**：纯前端 ES Module，零构建步骤，无第三方库。

## 2. 术语表

| 术语 | 含义 |
|---|---|
| 主对话 / 主 API | 酒馆界面里角色扮演所用的连接与提示词 |
| 规划调用 | 插件通过自带 API 通道发起的调用（剧情指导、随机事件、密封生成） |
| 世界书（Lorebook） | 条目集合，每条含触发词与设定内容 |
| 检索 | 扫描最近若干层消息，按关键词/正则判断哪些条目被「用到」 |
| 幕后内容 / 隐藏剧本 | 注入给模型、但不出现在聊天界面里的剧情安排或设定 |
| 明盘注入 | 内容经用户审核（AI 起草 → 人工编辑）后隐身注入；用户知道内容 |
| 密封注入 | 内容由 AI 生成后**不向用户展示**直接注入（如对手手牌），杜绝用户无意全知 |
| 指纹 | 密封内容只展示「字数 + 校验值」，不暴露正文 |

## 3. 已确认的关键决策（2026-08-22）

| 决策点 | 结论 | 备注 |
|---|---|---|
| 分发方式 | GitHub 仓库 + 标准 `manifest.json` | 扩展面板「Install extension」粘贴仓库地址安装 |
| API 通道 | **纯前端直连** OpenAI 兼容接口 | 浏览器直接 fetch；服务商需支持 CORS，遇到再换中转/本地网关；服务端插件代理仅作远期备选 |
| 世界书检索用途 | **只喂给规划调用** | 主对话的世界书照旧走酒馆原生机制，互不干扰 |
| 检索方式 | **关键词/正则**起步 | 预留向量语义检索接口（二期以后） |
| 隐身注入 | **双模式** | 明盘（AI 起草→人工编辑/意见重写→注入）+ 密封（指令→AI 生成→不展示→注入） |
| 世界书来源 | 酒馆原生 JSON + 纯文本导入 | 纯文本按第 5 节 M1 的格式约定切分 |

## 4. 总体架构

```
┌ 酒馆页面 ──────────────────────────────────────────────┐
│                                                        │
│  主对话提示词 ←─ setExtensionPrompt ←─ M4 隐身注入       │
│        ↑                                M5 储存空间     │
│   （主 API 生成时读到幕后内容，聊天界面不渲染）              │
│                                                        │
│  ┌ 剧情规划器（右侧抽屉） ────────────────────────────┐  │
│  │  M2 剧情指导          M3 随机事件                   │  │
│  │      └──── 共用管线 ────┘                          │  │
│  │  context.js（聊天/角色卡上下文）                      │  │
│  │  lorebook.js（世界书检索）                           │  │
│  │  api.js（独立 OpenAI 兼容通道） ──→ 外部大模型        │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

一次典型工作流：**检索世界书 → 规划 / 随机事件 → 用户审核（或密封）→ 隐身注入 → 主 API 带着幕后状态继续扮演**。

兼容性封装原则：对酒馆内部 API 的依赖集中在少数文件
（`js/context.js`、`js/injection.js`、`js/store.js`、`js/settings.js`、`index.js`），
酒馆版本变动时只改这些封装点，业务模块不直接碰酒馆 API。

导入约定（ST 1.15.0 实测，务必遵守）：对酒馆内部模块**一律使用绝对路径导入**——
`/script.js`（setExtensionPrompt、extension_prompt_types/roles、eventSource、event_types、saveSettingsDebounced）、
`/scripts/extensions.js`（extension_settings）；不要使用相对层级（`../../…`），扩展目录深度一旦和假设不符就会 404，
表现为扩展加载失败 `[object Event]`。`getContext` 通过全局 `SillyTavern.getContext()` 获取
（1.15 的实现位于 scripts/st-context.js，context 对象含 chat / chatId / getCurrentChatId）。

## 5. 模块详细设计

### M0 基础：设置与独立 API 通道 ✅

**职责**：manifest 分发、设置持久化、OpenAI 兼容调用封装（含 SSE 流式）。

设置存储在 `extension_settings['plot-planner']`，结构：

```jsonc
{
  "api": {
    "baseUrl": "",        // OpenAI 兼容根地址，如 https://api.openai.com/v1
    "apiKey": "",
    "model": "",
    "temperature": 0.7,
    "maxTokens": 1500
  },
  "retrieval": {
    "scanDepth": 20,      // 世界书检索扫描最近多少层消息
    "maxEntries": 10,     // 单次检索最多带出条目数
    "maxChars": 6000,     // 检索结果拼装字符上限（控制规划调用输入规模）
    "contextLayers": 30   // 规划调用携带的最近对话层数
  },
  "lorebooks": [],        // M1
  "injections": [],       // M4
  "storageItems": [],     // M5
  "eventRules": []        // M3
}
```

`api.js` 对外只暴露：

- `chatCompletion({ messages, temperature?, maxTokens?, signal?, onDelta? }) → Promise<string>`
  - `onDelta` 存在时走 SSE 流式，逐步回调累计文本（供后续 UI 打字机效果）。
- `testConnection() → Promise<string>`：发一条 ping/pong 验证配置。
- 错误统一抛 `ApiError`（含 status/body），UI 层 `toastr.error` 呈现。

**CORS 注意**：浏览器直连要求服务商允许跨域。OpenAI 及多数中转支持；
不支持时的对策：换服务商 / 中转 / 本地网关（如 one-api）。
报错信息里已提示这一原因，避免误判为插件缺陷。

**密钥安全**：密钥存于酒馆设置（浏览器 + 服务器 settings.json），仅本插件使用；
不做任何遥测或上传。

### M1 世界书导入与按需检索 ✅（条目级编辑、高级字段 ⬜）

**职责**：导入世界书（酒馆 JSON / 纯文本）到插件自有库；按需检索命中条目；
检索结果**只**用于 M2/M3 的规划调用。

数据结构：

```ts
interface Lorebook { id: string; name: string; enabled: boolean; source: 'st-json' | 'plain-text'; entries: LoreEntry[] }
interface LoreEntry {
  uid: number; comment: string;          // 条目名
  keys: string[]; secondaryKeys: string[]; regex: string[];
  content: string; constant: boolean;    // constant = 常驻（恒命中）
  order: number; disabled: boolean;
}
```

酒馆原生 JSON 字段映射（未列出的高级字段暂忽略）：

| 酒馆字段 | 本插件字段 | 说明 |
|---|---|---|
| `key` / `keysecondary` | `keys` / `secondaryKeys` | 触发词数组 |
| `content` | `content` | 条目正文 |
| `comment` | `comment` | 条目名 |
| `constant` | `constant` | 常驻 |
| `disable` | `disabled` | 停用 |
| `order` | `order` | 插入排序权重 |

纯文本导入格式约定：

```
# 条目标题 | 关键词1,关键词2
条目正文，可多行……

---

# 常驻条目 | [常驻] 
无需触发词、恒命中的正文……

---

# 另一个条目
（无关键词头也可，整段作为正文，之后可在条目编辑中补触发词）
```

- 空行 `---` 分隔条目；首行 `# 标题 | 关键词` 解析为头部；关键词段以 `[常驻]` 开头表示 constant。

检索算法（`scanLorebooks(scanText)`）：

```
输入：最近 scanDepth 层消息拼成的文本（小写化）
对每个启用书籍的每个非停用条目：
  命中 ⟸ constant
      ∨ 任一主关键词为文本子串（若设有次关键词，还须任一次关键词命中）
      ∨ 任一正则 test 通过
输出：按 order 升序（同 order 按 uid），截 maxEntries 条，
      拼装总字符不超过 maxChars（超出截断并加省略号）
```

**简化点（有意为之）**：次关键词只实现「AND ANY」；
不做递归扫描、矢量深度、时间/概率激活等原生高级特性——插件检索只服务规划调用，够用优先。

UI：世界书页签 = 导入按钮 ×2 + 书籍列表（启用/删除）+「检索测试」（用当前聊天即时验证命中）。

### M2 剧情指导（手动触发）🔶

**职责**：点击「开始分析」→ 收集上下文 + 检索 → 调用独立 API →
输出 **OOC 检测** + **剧情规划（隐藏剧本）**；支持人工编辑与「按修改意见重写」迭代；
产出可一键转为隐身注入。定位是**给固定场景预编排幕后剧本**。

输入构成（拼进 user 消息）：

| 部分 | 来源 | 预算 |
|---|---|---|
| 角色设定摘要 | 角色卡 name/description/personality/scenario | ≤800 字 |
| 最近对话 | `contextLayers` 层 | 可配 |
| 世界书命中 | `scanLorebooks` | `maxEntries`/`maxChars` |
| 上一版规划 + 修改意见 | 迭代时携带 | 全量 |
| 用户补充说明 | 输入框 | 用户自控 |

输出 JSON schema（系统提示词中约定，`extractJson` 容错解析）：

```jsonc
{
  "ooc": {
    "found": true,
    "items": [ { "aspect": "性格|事实|关系|世界观|口吻", "evidence": "对话依据", "severity": "轻微|中等|严重", "fix": "修正建议" } ]
  },
  "plan": {
    "summary": "一句话概括接下来的走向",
    "beats": [ { "stage": "阶段名", "content": "该阶段幕后剧情安排" } ],
    "risks": ["可能跑偏的点"]
  }
}
```

迭代：再次调用时携带 `previousPlan`（当前编辑框内容）与 `revisionNote`（修改意见），
要求模型在原方案基础上修订。

转注入：编辑框最终文本 → `addInjection({ mode:'open', source:'planner' })`，深度默认 4。

**待办**：提示词需用真实剧情实测调优；OOC 严重度阈值与呈现方式。

### M3 随机事件 🔶

**职责**：与 M2 共用管线，但定位不同——不是给固定场景预编排，
而是**开放情境下的动态遭遇**（「走在路上」式），带随机性。

数据结构：

```ts
interface EventRule {
  id: string; name: string; enabled: boolean;
  probability: number;      // 触发概率 0-1
  weight: number;           // 命中后的加权权重
  cooldownLayers: number;   // 冷却：间隔多少层消息才可能再次触发
  promptHint: string;       // 事件方向提示，喂给生成提示词
}
```

掷骰算法：`probability` 过筛 → 命中池内按 `weight` 加权随机取一。
冷却：记录 `lastTriggerLayer`，当前消息层数差小于 `cooldownLayers` 则不入池
（自动判定挂 `MESSAGE_RECEIVED` 钩子，Phase 3 实现；当前为手动掷骰）。

生成输出 schema：

```jsonc
{ "title": "事件标题", "description": "遭遇描述（150字内）", "options": [ { "label": "选项名", "hint": "选后的幕后走向提示" } ] }
```

选项处理：选中后组装为明盘注入（事件描述 + 选定走向 + 幕后提示），
默认 `expires: { type:'layers', layers: 20 }`，即 20 层后自动过期撤销。

### M4 隐身注入 🔶

**职责**：把幕后内容注入主对话提示词——**模型可见、聊天界面不渲染**。
两条工作流：

```
明盘：AI 起草(M2/M3) → 人工编辑 / 按意见重写 → 确认注入
      （或直接手写内容注入；用户知道内容）
密封：用户写生成指令 → 规划 API 生成 → 不展示正文 → 直接注入
      （用户不知道内容；UI 只显示指纹「N 字 · 校验值」）
```

数据结构：

```ts
interface InjectionItem {
  id: string; label: string;
  mode: 'open' | 'sealed';
  content: string;               // 密封条目同样落盘，但 UI 不渲染正文
  depth: number; role: 'system' | 'user';
  scope: 'chat' | 'global';      // chat：绑定创建时的 chatId
  chatId?: number;
  enabled: boolean;
  source: 'manual' | 'planner' | 'event';
  createdAt: number;
  expires: { type: 'never' | 'layers'; layers?: number };
  age?: number;                  // 已经历的层数（layers 过期用）
}
```

实现：封装 `setExtensionPrompt('pp:<id>', content, IN_PROMPT, depth, false, role)`；
撤销 = 置空同 key。枚举值从 `extensions.js` 导入并做缺省回退（兼容层集中在 `injection.js`）。

生命周期：

- `CHAT_CHANGED`：撤销不属于当前聊天的 `scope:'chat'` 注入，重放其余启用的。
- `MESSAGE_RECEIVED`：`expires.type==='layers'` 的条目 `age+1`，达到 `layers` 即停用并撤销。
- M5 储存条目共用同一机制，键空间 `pps:` 隔离。

**防泄露清单**（密封模式）：

- [x] UI 不渲染正文，只显示指纹；
- [x] 内容不写入聊天记录（仅存在于 extension prompt 与设置中）；
- [ ] 「查看提示词」类调试功能会看到内容——属用户主动行为，文档中说明即可；
- [ ] 导出/备份设置会包含密封内容——README 已提醒。

**待办**：场景标签分组（一个场景一组注入、结束时整组撤销）、注入深度可视化预览。

### M5 储存空间 🔶

**职责**：一次性内容（游戏规则、地图、跑团数值等）的条目库，
按触发条件自动注入主对话，**让这类内容不必专门写成世界书**。

```ts
interface StorageItem { id: string; name: string; keys: string[]; constant: boolean; depth: number; content: string; enabled: boolean }
```

注入逻辑：`CHAT_CHANGED` / `MESSAGE_RECEIVED` 时扫描最近 20 层消息，
`constant` 或任一 `keys` 命中 → `setExtensionPrompt('pps:<id>', ...)`，否则清空该键。
支持整个库导入/导出 JSON、手动「按当前剧情重放」。

**待办**：条目编辑（当前为添加 + 删除）、按条目预览命中情况。

## 6. 数据模型汇总

见第 5 节各模块的 TypeScript 定义；所有持久化数据都在
`extension_settings['plot-planner']` 之下，随酒馆设置一起保存（`saveSettingsDebounced`）。

## 7. UI 设计

设置区块（酒馆「扩展」面板内，inline-drawer 折叠）：

```
┌ 剧情规划器 ▾ ────────────────────────┐
│ API 地址（OpenAI 兼容，含 /v1）        │
│ [ https://……                    ]    │
│ API 密钥 [••••]   模型 [        ]    │
│ 温度 [0.7]  单次上限 tokens [1500]    │
│ ── 世界书检索 ──                       │
│ 扫描层数 [20] 最多条目 [10] 字数 [6000]│
│ 规划携带对话层数 [30]                  │
│ [测试连接] [打开剧情规划器]             │
└──────────────────────────────────────┘
```

主面板：右侧抽屉（`min(560px, 94vw)`），五个页签：

```
┌ 剧情规划器                      [✕] ┐
│ [世界书][剧情指导][随机事件][隐身注入][储存空间] │
│ ┌ 页签内容（滚动区） ───────────────┐ │
│ │ ……                              │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

交互约定：耗时操作按钮点击后进入「规划中……」状态文案；
所有错误 `toastr.error` 弹出；密封内容任何位置只显示指纹。

## 8. 开发路线图

| 阶段 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| Phase 0 骨架 | manifest / 设置面板 / API 通道（含流式）/ 抽屉框架 / 事件挂接 | 扩展可安装启用；测试连接通过；抽屉可开关 | ✅ |
| Phase 1 世界书 | 双格式导入、启停删、检索测试 | 导入真实世界书 JSON ≥1 本；检索测试命中符合预期 | ✅ |
| Phase 2 剧情指导 | 分析管线、迭代重写、转注入 | 在真实聊天中产出结构化 OOC+规划；编辑后注入生效（主 API 回复体现幕后走向且界面无显示） | 🔶 管线可用，提示词待实测调优 |
| Phase 3 注入成熟 | 明盘/密封完整流、生命周期、列表管理 | 密封生成后 UI 无正文；切聊天自动清理；层数过期自动撤销 | 🔶 基础可用；场景标签 ⬜ |
| Phase 4 随机事件 | 规则管理、掷骰、生成、选项转注入、自动判定+冷却 | 手动掷骰全流程可用；自动判定挂消息钩子 | 🔶 手动全流程可用；自动判定 ⬜ |
| Phase 5 储存空间 | 条目库、触发注入、导入导出 | 添加规则条目后关键词出现时主 API 行为变化 | 🔶 可用；条目编辑 ⬜ |
| Phase 6 发布打磨 | 提示词调优、i18n、README、版本发布 v0.1 | 从 GitHub 安装可用；文档完整 | ⬜ |

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 服务商不支持 CORS | 直连失败 | 报错信息已提示；换支持跨域的服务商/中转/本地 one-api；远期做服务端插件代理（决策已排除为首选） |
| 酒馆版本 API 变动 | 扩展失效 | ST API 依赖集中在 5 个封装文件；manifest 声明版本；升级酒馆后跑一遍测试清单 |
| 密钥泄露 | 资损 | 密钥仅存本地设置，无遥测；README 说明 |
| 规划调用输入超限 | 费用/截断 | `maxEntries` + `maxChars` + `contextLayers` 三重预算控制 |
| 密封内容意外暴露 | 剧透 | UI 只显示指纹；不进聊天记录；导出设置时的行为已文档化 |
| 模型不按 schema 输出 JSON | 解析失败 | `extractJson` 容错（剥围栏/截取大括号）；失败时展示原始输出供人工处理 |

## 10. 文件结构

```
st-plot-planner/
├── manifest.json              # 酒馆扩展清单（display_name/js/css/version…）
├── index.js                   # 入口：装配设置区块与抽屉，挂接聊天事件
├── css/style.css              # 抽屉与组件样式（尽量用酒馆主题变量）
├── js/
│   ├── settings.js            # 设置单例：extension_settings['plot-planner'] 读写
│   ├── api.js                 # M0 独立通道：OpenAI 兼容 chat/completions（含 SSE）
│   ├── context.js             # 兼容层：SillyTavern.getContext() 唯一依赖点
│   ├── lorebook.js            # M1 世界书：导入（双格式）+ 关键词/正则检索
│   ├── planner.js             # M2 剧情指导 + 密封内容生成
│   ├── randomEvents.js        # M3 随机事件：规则、掷骰、生成
│   ├── injection.js           # M4 隐身注入：setExtensionPrompt 封装与生命周期
│   ├── store.js               # M5 储存空间：条目库与触发注入
│   ├── utils.js               # escapeHtml / clamp / extractJson / 指纹 / 文件读写
│   └── ui/
│       ├── settingsPanel.js   # 扩展设置区块（API/检索参数）
│       ├── drawer.js          # 右侧抽屉与页签框架
│       └── tabs/
│           ├── tab-worldbook.js
│           ├── tab-guidance.js
│           ├── tab-events.js
│           ├── tab-injections.js
│           └── tab-storage.js
├── docs/DEVELOPMENT_PLAN.md   # 本文档
└── README.md
```

## 11. 测试清单（手动验收）

1. 本地安装：文件夹放入 `public/scripts/extensions/third-party/` → 重启 → 扩展面板出现「剧情规划器」并可用。
2. 设置：填 API 后「测试连接」返回 pong；错误密钥给出可读报错。
3. 世界书：导入酒馆 JSON（条目数正确）；导入纯文本（`---` 切分与 `[常驻]` 生效）；检索测试在含关键词的聊天中命中、不含时不命中。
4. 剧情指导：有 ≥5 层对话的聊天中「开始分析」→ 返回 OOC+规划 JSON 并正常渲染；修改意见重写后内容变化；「转为隐身注入」后隐身注入列表出现新条目。
5. 注入生效验证：开启酒馆的提示词查看（或观察 token 数变化）确认幕后内容已进主提示词、聊天界面无显示；继续对话主 AI 行为体现幕后走向。
6. 密封：生成后 UI 只显示指纹；主 AI 后续回复确实依据密封内容。
7. 生命周期：切换聊天后 scope=chat 的注入被清理；层数过期的注入自动停用。
8. 储存空间：添加带触发词的规则条目 → 对话提到关键词后主 AI 行为变化；导入导出往返一致。

## 12. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-22 | 初版：确认五模块方案与关键决策；完成 Phase 0 骨架与 Phase 1-5 的基础实现 |
| 2026-08-22 | 修复 1.15.0 加载失败（[object Event]）：ST 内部导入由相对层级改为绝对路径；符号位置以 1.15.0 实测为准（setExtensionPrompt/枚举/事件由 script.js 再导出，extension_settings 在 extensions.js，getContext 走全局 SillyTavern）；兼容基线定为 1.15.0 |
