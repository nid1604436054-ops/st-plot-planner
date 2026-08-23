// M0 独立大模型通道：OpenAI 兼容 /chat/completions，浏览器直连
// 注意：所选服务商需允许浏览器跨域（CORS）；不支持时优先换支持跨域的服务商/中转/本地网关
import { settings } from "./settings.js";

export class ApiError extends Error {
    constructor(message, { status, body } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

function requireConfig() {
    const { baseUrl, model } = settings.api;
    if (!baseUrl || !model) {
        throw new ApiError('请先在「剧情规划器 → 设置」页签里配置 API 地址和模型');
    }
}

// 关闭思考参数（设置页「关闭思考」勾上时附带）：GLM 系认 thinking、Qwen 系认 enable_thinking，
// 一并带上各家只认自己的、陌生的多半忽略；端点对陌生参数直接报 400/422 时由调用处去掉重发一次
function thinkingOffParams() {
    return settings.api.thinkingOff ? { thinking: { type: 'disabled' }, enable_thinking: false } : {};
}

// 取补全的最终文本，兼容三种正文形态：普通字符串 / 分段数组（content:[{type:'text'}]）/
// 推理模型正文为空时把内容放进思考字段（reasoning_content / reasoning）。
// 仍取不到时按证据报错：finish_reason 与 usage 能区分「长度耗尽 / 被过滤 / 字段不认识」
function pickContent(message, { finishReason = '', completionTokens = null } = {}) {
    const c = message?.content;
    let text = typeof c === 'string' ? c
        : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('') : '');
    if (!text.trim()) {
        const r = [message?.reasoning_content, message?.reasoning].find(v => typeof v === 'string' && v.trim());
        if (r) text = r;
    }
    if (text.trim()) return text;

    const raw = JSON.stringify(message) ?? '';
    const evidence = `finish_reason=${finishReason || '（无）'}${completionTokens != null ? `，completion_tokens=${completionTokens}` : ''}，消息原文（前 150 字）：${raw.slice(0, 150)}`;
    if (finishReason === 'length') {
        throw new ApiError(`模型返回了空内容（${evidence}）。输出长度上限用完且一字未落到正文：推理模型的思考也计入「单次上限 tokens」，继续调大或换非推理模型`);
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
 * @param {number} [options.temperature]  缺省用设置里的值
 * @param {number} [options.maxTokens]    缺省用设置里的值
 * @param {AbortSignal} [options.signal]
 * @param {(fullText:string)=>void} [options.onDelta]  提供时走 SSE 流式，逐步回调累计文本
 * @returns {Promise<string>} 模型输出的文本
 */
export async function chatCompletion({ messages, temperature, maxTokens, signal, onDelta } = {}) {
    requireConfig();
    const { baseUrl, apiKey, model } = settings.api;
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const stream = typeof onDelta === 'function';

    const doFetch = extra => fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
            model,
            messages,
            temperature: temperature ?? settings.api.temperature,
            max_tokens: maxTokens ?? settings.api.maxTokens,
            stream,
            ...extra,
        }),
        signal,
    });

    let res;
    try {
        const extra = thinkingOffParams();
        res = await doFetch(extra);
        if (extra && (res.status === 400 || res.status === 422)) {
            res = await doFetch({});   // 端点不认关闭思考的参数：去掉重发一次
        }
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        // 网络层失败最常见的原因是 CORS 拦截或地址写错
        throw new ApiError(`请求失败（检查地址是否正确、服务商是否支持浏览器跨域）：${err.message}`);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ApiError(`API 返回 ${res.status}：${body.slice(0, 300)}`, { status: res.status, body });
    }

    if (!stream) {
        const data = await res.json();
        const choice = data?.choices?.[0];
        if (!choice?.message) throw new ApiError('API 返回结构异常（缺少 choices[0].message）');
        return pickContent(choice.message, { finishReason: choice.finish_reason, completionTokens: data?.usage?.completion_tokens });
    }

    // SSE 流式：逐行解析 data: {...}，聚合增量并回调 onDelta
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
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
            if (data === '[DONE]') return full;
            try {
                const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
                if (delta) {
                    full += delta;
                    onDelta(full);
                }
            } catch {
                // 忽略无法解析的心跳/注释行
            }
        }
    }
    return full;
}

export async function testConnection() {
    return chatCompletion({
        messages: [
            { role: 'system', content: '你是连通性测试，只回复 pong。' },
            { role: 'user', content: 'ping' },
        ],
        maxTokens: 10,
        temperature: 0,
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
// 用途：设置页「测试搜索」直接调；剧情分析/检查报告时作为 web_search 工具交给模型自主调用
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

// web_search 工具定义（OpenAI tools 协议）：只让模型在「需要现实世界真实信息」时用
const WEB_SEARCH_TOOL = {
    type: 'function',
    function: {
        name: 'web_search',
        description: '联网搜索现实世界的信息。当任务涉及真实事实、时效性信息（近期事件、最新数据）或你不确定的现实细节时调用；纯虚构设定不要调用。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词，简洁明确' },
            },
            required: ['query'],
        },
    },
};

/** 搜索工具是否已配置可用（设置页填了密钥即算） */
export function searchToolReady() {
    return Boolean(settings.search?.apiKey);
}

/** 非流式请求内核：工具循环专用，不碰 chatCompletion 的流式逻辑 */
async function postCompletion(body, signal) {
    requireConfig();
    const { baseUrl, apiKey } = settings.api;
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const doFetch = extra => fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ ...body, ...extra }),
        signal,
    });
    let res;
    try {
        const extra = thinkingOffParams();
        res = await doFetch(extra);
        if (extra && (res.status === 400 || res.status === 422)) {
            res = await doFetch({});   // 端点不认关闭思考的参数：去掉重发一次
        }
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new ApiError(`请求失败（检查地址是否正确、服务商是否支持浏览器跨域）：${err.message}`);
    }
    if (!res.ok) {
        const raw = await res.text().catch(() => '');
        throw new ApiError(`API 返回 ${res.status}：${raw.slice(0, 300)}`, { status: res.status, body: raw });
    }
    return res.json();
}

/**
 * 带工具的对话补全：模型可自主调用 web_search，工具结果回填后继续，直到给出最终文本。
 * 兼容性：逆向/中转端点可能不认 tools 参数——首轮遇到 4xx（鉴权与限流除外）自动去掉工具重发，
 * 退化为普通调用；模型全程不调工具时与普通调用等价。
 * @param {object} options 同 chatCompletion 的非流式部分，另加 maxToolRounds（缺省 3）
 * @returns {Promise<{content:string, searchLogs:string[]}>} 最终文本与模型实际搜索过的关键词
 */
export async function chatCompletionWithTools({ messages, temperature, maxTokens, signal, maxToolRounds = 3 } = {}) {
    const msgs = messages.map(m => ({ ...m }));
    const searchLogs = [];
    // 真实账单（服务商返回的 usage 累计，非估算）：工具每往返一轮就把全部材料原样重发一遍，
    // 输入按请求次数累加——后台看到的总输入是 N 倍单次规模，这里记下来供界面汇报
    const usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
    let withTools = true;

    for (let round = 0; ; round++) {
        let data;
        try {
            data = await postCompletion({
                model: settings.api.model,
                messages: msgs,
                temperature: temperature ?? settings.api.temperature,
                max_tokens: maxTokens ?? settings.api.maxTokens,
                ...(withTools ? { tools: [WEB_SEARCH_TOOL] } : {}),
            }, signal);
        } catch (err) {
            if (withTools && err instanceof ApiError && err.status >= 400 && err.status < 500
                && err.status !== 401 && err.status !== 403 && err.status !== 429) {
                withTools = false;   // 大概率是端点不认识 tools 参数：去掉工具重试一次
                continue;
            }
            throw err;
        }

        usage.requests++;
        usage.promptTokens += data?.usage?.prompt_tokens ?? 0;
        usage.completionTokens += data?.usage?.completion_tokens ?? 0;

        const message = data?.choices?.[0]?.message;
        const calls = withTools && Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        if (!calls.length) {
            return { content: pickContent(message, { finishReason: data?.choices?.[0]?.finish_reason, completionTokens: data?.usage?.completion_tokens }), searchLogs, usage };
        }
        if (round >= maxToolRounds) {
            // 到达轮次上限：撤掉工具并明确要求收尾，逼模型基于已有信息输出最终结果
            msgs.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
            msgs.push({ role: 'user', content: '（系统提示：工具调用轮次已达上限，不要再调用工具，直接基于已有信息输出最终结果。）' });
            withTools = false;
            continue;
        }

        msgs.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
        for (const call of calls) {
            let out;
            if (call?.function?.name === 'web_search') {
                let query = '';
                try {
                    query = String(JSON.parse(call.function?.arguments ?? '{}')?.query ?? '');
                } catch {
                    query = String(call.function?.arguments ?? '');   // 参数不是 JSON 就原样当关键词
                }
                try {
                    const results = await searchWeb(query);
                    searchLogs.push(query);
                    out = JSON.stringify({ query, results });
                } catch (err) {
                    out = JSON.stringify({ query, error: String(err.message ?? err) });
                }
            } else {
                out = JSON.stringify({ error: `未知工具：${call?.function?.name ?? ''}` });
            }
            msgs.push({ role: 'tool', tool_call_id: call?.id ?? '', name: call?.function?.name ?? '', content: out });
        }
    }
}
