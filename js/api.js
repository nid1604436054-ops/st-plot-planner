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
        throw new ApiError('请先在「扩展设置 → 剧情规划器」里配置 API 地址和模型');
    }
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

    let res;
    try {
        res = await fetch(url, {
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
            }),
            signal,
        });
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
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
            throw new ApiError('API 返回结构异常（缺少 choices[0].message.content）');
        }
        return content;
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
