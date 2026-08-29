// M0 独立大模型通道：OpenAI 兼容 /chat/completions，浏览器直连
// 注意：所选服务商需允许浏览器跨域（CORS）；不支持时优先换支持跨域的服务商/中转/本地网关
import { settings } from "./settings.js";
import { extractJson } from "./utils.js";

export class ApiError extends Error {
    constructor(message, { status, body } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

function requireConfig(conn) {
    if (!conn.baseUrl || !conn.model) {
        throw new ApiError('请先在「剧情规划器 → 设置」页签里配置 API 地址和模型');
    }
}

// 关闭思考参数（设置页「关闭思考」勾上时附带）：各家只认自己的、陌生的多半忽略——
// deepseek/GLM 认 thinking、Qwen 认 enable_thinking、OpenAI 系认 reasoning_effort、
// vLLM 部署的混合思考模型认 chat_template_kwargs，一并带上。
// 端点对陌生参数直接报 400/422 时按报错点名的参数**定向去除**重发（见 chatCompletion），
// 不再一刀全去——一刀全去＝把「关闭思考」一起丢掉、思考静默回来（2026-08-31 第八轮真机
// 教训：V4-Flash 思考默认开、effort 默认 high，一刀切后一万多输出）
function thinkingOffParams() {
    return settings.api.thinkingOff ? {
        thinking: { type: 'disabled' },
        enable_thinking: false,
        reasoning_effort: 'none',
        chat_template_kwargs: { thinking: false },
    } : {};
}

// 取补全的最终文本，兼容三种正文形态：普通字符串 / 分段数组（content:[{type:'text'}]）/
// 推理模型正文为空时把内容放进思考字段（reasoning_content / reasoning）。
// 仍取不到时按证据报错：finish_reason 与 usage 能区分「长度耗尽 / 被过滤 / 字段不认识」
function pickContent(message, { finishReason = '', completionTokens = null, promptTokens = null } = {}) {
    const c = message?.content;
    let text = typeof c === 'string' ? c
        : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('') : '');
    if (!text.trim()) {
        const r = [message?.reasoning_content, message?.reasoning].find(v => typeof v === 'string' && v.trim());
        if (r) text = r;
    }
    if (text.trim()) return text;

    const raw = JSON.stringify(message) ?? '';
    const evidence = `finish_reason=${finishReason || '（无）'}`
        + `${completionTokens != null ? `，completion_tokens=${completionTokens}` : ''}`
        + `${promptTokens != null ? `，输入实报 ${promptTokens.toLocaleString()} tokens` : ''}`
        + `，消息原文（前 150 字）：${raw.slice(0, 150)}`;
    if (finishReason === 'length') {
        const offNote = settings.api.thinkingOff
            ? '。「关闭思考」已勾上仍如此：这个端点/中转多半没真正执行关闭参数（参数收下了、思考照做，或把思考扣下不回传但照样计费）'
            : '';
        throw new ApiError(`模型返回了空内容（${evidence}）。输出长度上限用完且正文一字未落：推理模型的思考计入「单次上限 tokens」、计费口径的「输出 tokens」通常也包含思考——若上面消息原文里连思考字段都没有，就是端点把已生成的内容扣下不回传了；继续调大上限或换非推理模型${offNote}`);
    }
    if (finishReason === 'content_filter' || finishReason === 'sensitive') {
        throw new ApiError(`模型返回了空内容（${evidence}）。被服务商内容安全过滤拦下（finish_reason 已标明），换模型/服务商或精简对话后重试`);
    }
    throw new ApiError(`模型返回了空内容（${evidence}）。finish_reason=stop 却无正文，多半是服务商内容安全过滤（命中敏感内容时返回 200 但正文置空，可换模型/服务商或精简对话再试），也可能是回答放在了上面「消息原文」里不认识的字段——把这段报错发维护者即可适配`);
}

/**
 * 发起一次对话补全。
 * @param {object} options
 * @param {Array<{role:string,content:string}>} options.messages
 * @param {number} [options.temperature] 缺省用设置里的值
 * @param {number} [options.maxTokens]    缺省用设置里的值
 * @param {AbortSignal} [options.signal]
 * @param {(fullText:string)=>void} [options.onDelta]  提供时走 SSE 流式，逐步回调累计文本
 * @param {(reasonText:string)=>void} [options.onReasoning] 流式收到思考增量时回调累计思考全文
 *        （长度即字数；正文与思考分开流时才有；「关闭思考」开着却一直在涨＝端点没执行关闭参数，界面据此提示）
 * @param {(usage:object)=>void} [options.onUsage]     回传服务商实报 usage：非流式必有；
 *        流式时请求带 stream_options.include_usage、服务商在末包附上才回调（不附就不回调）
 * @param {boolean} [options.skipPresets]  true 时跳过全局预设注入（仅连通性测试用）
 * @param {{baseUrl:string,apiKey:string,model:string}} [options.provider]
 *        独立连接覆盖（监听模型固定项用）：提供时地址/密钥/模型走这一套，
 *        不提供走当前主连接；温度等其余参数全局共用
 * @returns {Promise<string>} 模型输出的文本（启用中的预设已随 system 消息附带）
 */
// ---------------------------------------------------------------------------
// 全局预设：设置页「预设」勾选启用后，插件发给大模型的每一次调用都自动附上
// （规划分析 / 检查报告 / 随机事件 / 路人反应 / AI 打标 / AI 建库 / 联网判断）。
// 在这里统一拼装、在 chatCompletion 出口统一注入——预览与真实调用走同一个函数，
// 看到的与发出的完全一致；头部带输出格式保护语，预设改不掉各任务的 JSON 骨架
// ---------------------------------------------------------------------------

export function globalPresetBlock() {
    const list = (settings.guidance?.presets ?? []).filter(p => p.enabled && String(p?.content ?? '').trim());
    if (!list.length) return '';
    return '## 用户全局预设（全局生效的固定要求；在不改变本任务要求的输出格式的前提下遵照执行，明显与本任务无关的可忽略）\n'
        + list.map(p => `### ${p.name}\n${String(p.content).trim()}`).join('\n\n');
}

// 把全局预设块拼进第一条 system 消息（没有 system 消息时在最前插一条），不改动入参数组
export function withGlobalPresets(messages) {
    const block = globalPresetBlock();
    if (!block) return messages;
    const idx = messages.findIndex(m => m?.role === 'system');
    if (idx === -1) return [{ role: 'system', content: block }, ...messages];
    return messages.map((m, i) => i === idx ? { ...m, content: `${m.content}\n\n${block}` } : m);
}

export async function chatCompletion({ messages, temperature, maxTokens, signal, onDelta, onUsage, onReasoning, skipPresets = false, provider } = {}) {
    const conn = provider ?? settings.api;
    requireConfig(conn);
    const url = `${conn.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const stream = typeof onDelta === 'function';
    const sent0 = skipPresets ? messages : withGlobalPresets(messages);

    const doFetch = extra => fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
        },
        body: JSON.stringify({
            model: conn.model,
            messages: sent0,
            temperature: temperature ?? settings.api.temperature,
            max_tokens: maxTokens ?? settings.api.maxTokens,
            stream,
            ...extra,
        }),
        signal,
    });

    let res;
    let lastErrText = '';
    try {
        // 附加参数两来源：关闭思考全家（设置开关）＋流式对账 stream_options。端点不认时按
        // 重试梯子走：全量 → 去掉**报错点名**的参数 → 只留最通用的 thinking 一档 → 全去。
        // 失败的 400/422 请求不产 token，多试几次不花成本；把「只留 thinking」垫在「全去」
        // 之前＝deepseek/GLM 官方口径优先保住，全去是最后手段（那等于放任思考回来）。
        // 上限四发（第九轮放宽自三发）：deepseek 官方端点正是「严格点名陌生参数」型且倾向
        // 一次只点一个名——四家里的三家方言要三轮点名才去完，三发上限会在中途报错断掉
        const streamOpt = stream && typeof onUsage === 'function' ? { stream_options: { include_usage: true } } : {};
        let attempt = { ...thinkingOffParams(), ...streamOpt };
        let sent = attempt;
        // 报错点名参数的判定：长名先占位再查短名——报错文案写 enable_thinking 时，
        // 其子串 thinking 不能算 thinking 参数也被点了名（点名错人会误删好的参数）
        const blameKeys = keys => {
            const found = [];
            let rest = lastErrText;
            for (const k of [...keys].sort((a, b) => b.length - a.length)) {
                if (rest.includes(k)) {
                    found.push(k);
                    rest = rest.split(k).join(' ');
                }
            }
            return found;
        };
        for (let round = 0; ; round++) {
            sent = attempt;
            res = await doFetch(sent);
            if (res.ok || (res.status !== 400 && res.status !== 422) || !Object.keys(sent).length || round >= 3) break;
            lastErrText = await res.text().catch(() => '');
            const blamed = blameKeys(Object.keys(sent));
            if (blamed.length) {
                attempt = Object.fromEntries(Object.entries(sent).filter(([k]) => !blamed.includes(k)));
            } else if (settings.api.thinkingOff && sent.thinking
                && Object.keys(sent).some(k => k !== 'thinking' && k !== 'stream_options')) {
                attempt = { thinking: { type: 'disabled' }, ...(sent.stream_options ? { stream_options: sent.stream_options } : {}) };
            } else {
                attempt = {};   // 最后手段：全部去掉重发（原行为，只在梯子走完仍被拒时才到这）
            }
        }
        if (res.ok && settings.api.thinkingOff
            && !(sent.thinking || sent.enable_thinking === false || sent.reasoning_effort || sent.chat_template_kwargs)) {
            toastr.warning('「关闭思考」的参数被这个端点拒绝、已全部去掉后重发——本次模型可能照常思考（运行页的「思考」计数能实时看到，不对劲就点「中断」止损）');
        }
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        // 网络层失败最常见的原因是 CORS 拦截或地址写错
        throw new ApiError(`请求失败（检查地址是否正确、服务商是否支持浏览器跨域）：${err.message}`);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '') || lastErrText;
        throw new ApiError(`API 返回 ${res.status}：${body.slice(0, 300)}`, { status: res.status, body });
    }

    if (!stream) {
        const data = await res.json();
        const choice = data?.choices?.[0];
        if (!choice?.message) throw new ApiError('API 返回结构异常（缺少 choices[0].message）');
        if (typeof onUsage === 'function' && data?.usage) onUsage(data.usage);
        return pickContent(choice.message, { finishReason: choice.finish_reason, completionTokens: data?.usage?.completion_tokens, promptTokens: data?.usage?.prompt_tokens });
    }

    // SSE 流式：逐行解析 data: {...}，聚合增量并回调 onDelta；末包的 usage（若有）回传对账。
    // 正文增量全空时兜底聚合思考字段增量——与非流式 pickContent 同一口径
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let reasoning = '';
    let usage = null;
    const finish = () => {
        if (usage && typeof onUsage === 'function') onUsage(usage);
        return full || reasoning;
    };
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') return finish();
            try {
                const chunk = JSON.parse(data);
                if (chunk?.usage && (chunk.usage.prompt_tokens || chunk.usage.completion_tokens)) usage = chunk.usage;
                const delta = chunk?.choices?.[0]?.delta;
                if (typeof delta?.content === 'string' && delta.content) {
                    full += delta.content;
                    onDelta(full);
                } else if (delta && (delta.reasoning_content || delta.reasoning)) {
                    reasoning += String(delta.reasoning_content ?? delta.reasoning ?? '');
                    if (typeof onReasoning === 'function') onReasoning(reasoning);
                }
            } catch {
                // 忽略无法解析的心跳/注释行
            }
        }
    }
    return finish();   // 流没等到 [DONE] 就断了：按已收到的内容收尾
}

// ---------------------------------------------------------------------------
// 结构化输出的契约加固（T3）：要求模型只回一个 JSON，现实里仍会夹说明、裹围栏、
// 值内裸引号换行、甚至被截断。utils.extractJson 在本地能修的（剥围栏/定位/格式伤）
// 都修了；这里补最后一道——本地修不回时把坏输出原样回传、附修复提示重发一次原请求，
// 再失败才向上抛。反应卡 / 报告卡 / 自动打标 / 事件选项与建库各结构化流共用。
// 联网判断的输出不走这里：它坏了按「不需要」处理（宁可少搜不多搜），不该多花一次调用
// ---------------------------------------------------------------------------

// 修复提示共享一份，不感知各任务的 schema——要修的是「格式」，内容指令是「保持不变」
const JSON_REPAIR_PROMPT = '你上一条回复没能解析成 JSON。请重新输出同一份内容：内容保持不变，只修复格式——'
    + '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字（不要说明文字，不要用 Markdown 代码围栏包裹）；'
    + '字符串值内不要出现英文双引号（引用一律改写为中文「」）、不要在值内换行（改写为空格或分号）；'
    + '补齐缺失的逗号与引号，删掉尾逗号。若上一条是被截断的，请精简各字段的文字，确保 JSON 完整收尾。';

/**
 * 解析模型输出中的 JSON，本地修不回时自动带修复提示回炉一次。
 * @param {string} raw       第一次调用的模型输出
 * @param {object} [request] 第一次调用的请求原样传入：重试时 messages 换成
 *                           「原对话 + 坏输出（assistant）+ 修复提示（user）」，其余参数
 *                           （temperature/maxTokens/signal/onUsage/onDelta）原样随行；
 *                           call 可覆盖实际发调函数（默认 chatCompletion，
 *                           检查报告等走 guidanceCompletion 包装的流用它保持账单口径）
 * @returns {Promise<{result:Object, raw:string, retried:boolean}>}
 *          raw = 实际解析成功的那份输出（重试成功即修复后的）
 */
export async function parseModelJson(raw, { messages = [], call = chatCompletion, ...rest } = {}) {
    try {
        return { result: extractJson(raw), raw: String(raw ?? ''), retried: false };
    } catch { /* 落到修复重试 */ }
    toastr.info('模型输出不是合法 JSON，已带修复提示自动重试一次');
    const repaired = await call({
        ...rest,
        messages: [...messages, { role: 'assistant', content: String(raw ?? '') }, { role: 'user', content: JSON_REPAIR_PROMPT }],
    });
    try {
        return { result: extractJson(repaired), raw: repaired, retried: true };
    } catch (err) {
        err.raw = repaired;   // 上层展示排查看最后一次的输出（首次输出已随修复对话发给模型）
        err.message = `自动修复重试一次后仍解析失败：${err.message}`;
        throw err;
    }
}

export async function testConnection() {
    return chatCompletion({
        messages: [
            { role: 'system', content: '你是连通性测试，只回复 pong。' },
            { role: 'user', content: 'ping' },
        ],
        maxTokens: 10,
        temperature: 0,
        skipPresets: true,   // 连通性测试只验管道：预设会挤占这 10 个 token 的回复预算
    });
}

/**
 * 拉取可用模型列表（GET /models）。兼容 {data:[{id}]} 与裸数组两种返回。
 * @returns {Promise<string[]>} 模型 id 列表
 */
export async function fetchModels() {
    const { baseUrl, apiKey } = settings.api;
    if (!baseUrl) throw new ApiError('请先填写 API 地址');
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;

    let res;
    try {
        res = await fetch(url, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
    } catch (err) {
        throw new ApiError(`请求失败（检查地址是否正确、服务商是否支持浏览器跨域）：${err.message}`);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ApiError(`API 返回 ${res.status}：${body.slice(0, 200)}`, { status: res.status, body });
    }

    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    const ids = list.map(m => m?.id ?? m?.name).filter(v => typeof v === 'string' && v);
    if (!ids.length) throw new ApiError('模型列表为空，请手动填写模型名称');
    return ids;
}

// ---------------------------------------------------------------------------
// 联网搜索（Tavily）：独立于大模型通道，浏览器直连 api.tavily.com
// 用途：设置页「测试搜索」直接调；剧情分析/检查前由 planner.js 的判断调用给关键词、本地直查
// ---------------------------------------------------------------------------

/**
 * 调 Tavily 搜索一次。
 * @param {string} query 搜索关键词
 * @param {object} [options]
 * @param {number} [options.maxResults] 缺省用设置里的值
 * @returns {Promise<Array<{title:string,url:string,content:string}>>} 结果列表（可能为空）
 */
export async function searchWeb(query, { maxResults } = {}) {
    const cfg = settings.search ?? {};
    if (!cfg.apiKey) throw new ApiError('请先在「设置」页填写联网搜索的 API 密钥');
    const q = String(query ?? '').trim();
    if (!q) throw new ApiError('搜索关键词为空');
    const count = Math.min(Math.max(Number(maxResults ?? cfg.maxResults) || 5, 1), 10);

    let res;
    try {
        res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify({ query: q, max_results: count, search_depth: 'basic' }),
        });
    } catch (err) {
        throw new ApiError(`搜索请求失败（检查网络能否直连 api.tavily.com）：${err.message}`);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ApiError(`搜索 API 返回 ${res.status}：${body.slice(0, 200)}`, { status: res.status, body });
    }
    const data = await res.json().catch(() => null);
    return (data?.results ?? []).map(r => ({
        title: String(r?.title ?? ''),
        url: String(r?.url ?? ''),
        content: String(r?.content ?? '').slice(0, 600),   // 截断控制塞给模型的体量
    }));
}

/** 搜索工具是否已配置可用（设置页填了密钥即算） */
export function searchToolReady() {
    return Boolean(settings.search?.apiKey);
}

