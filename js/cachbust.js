// 打散扮演请求的前缀缓存（第六十轮，用户开工令「我这边没有关闭，你做吧」）
// 背景：插件自己的模型调用（监听/规划/知识库等）开头稳定＝每轮吃 DeepSeek 官方前缀缓存
// （有意设计，不碰）；扮演模型走 Kiro 逆向端点，吃缓存后注意力劣化（用户实测：只顾前几轮
// 的指令、忘了本轮要干什么）。前缀缓存按「从请求第一个词起逐词相同」记账——在请求最前面
// 塞一段每次都不同的短标记＝整个请求必定缓存未命中。
// 边界：标记只进发出去的请求体，不写聊天记录——监听判定读的是聊天记录，永远看不到它。
// 本文件不直接 import 酒馆全局（/script.js 五门规，见 CODE_MAP §0）：挂载由 index.js
// 注入 eventSource/event_types。
// 挂点（安装副本源码核实，2026-09-04）：聊天式接口 openai.js sendOpenAIRequest 发
// CHAT_COMPLETION_SETTINGS_READY(generate_data)，随后同一对象直接 JSON.stringify 进请求体；
// 文本式接口 script.js Generate 发 GENERATE_AFTER_DATA(generate_data, dryRun)，同一对象随后
// 交给发送函数。酒馆自己的 TempResponseLength 恢复钩子同样挂这两扇门改数据，有官方先例。
import { settings } from './settings.js';

// 标记样式：固定壳子＋随机内容，长得像会话编号一类的中性文本，无指令味，模型基本无视
export function makeBustMarker() {
    return `[pp-sid:${Math.random().toString(16).slice(2, 10)}]`;
}

// 聊天式：messages 换成「标记消息＋原数组」的新数组（不原地 unshift，防共享引用污染别处）
export function bustChatPayload(data) {
    if (!data || !Array.isArray(data.messages) || data.messages.length === 0) return null;
    const marker = makeBustMarker();
    data.messages = [{ role: 'system', content: marker }, ...data.messages];
    return marker;
}

// 文本式：prompt 字符串前拼标记。聊天式接口的 GENERATE_AFTER_DATA 里 prompt 是数组，
// 这里的字符串闸天然跳过——两种挂点不会给同一请求打两遍标
export function bustTextPayload(data) {
    if (!data || typeof data.prompt !== 'string' || !data.prompt) return null;
    const marker = makeBustMarker();
    data.prompt = `${marker}\n${data.prompt}`;
    return marker;
}

// 挂载：index.js 传 eventSource/event_types 进来（门规：本文件不碰酒馆全局）。
// 开关＝全局 settings.bustRpCache、独立于监听总开关——关掉监听也能单独用；
// 每次发标在控制台打一行，真机上拿它跟请求记录核对
export function installCacheBust(eventSource, eventTypes) {
    if (!eventSource?.on || !eventTypes) return;
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, (data) => {
        if (!settings.bustRpCache) return;
        const m = bustChatPayload(data);
        if (m) console.log('[PlotPlanner] 扮演请求缓存已打散，标记：', m);
    });
    if (eventTypes.GENERATE_AFTER_DATA) eventSource.on(eventTypes.GENERATE_AFTER_DATA, (data, dryRun) => {
        if (!settings.bustRpCache || dryRun) return;   // 干跑不落请求，不打标
        const m = bustTextPayload(data);
        if (m) console.log('[PlotPlanner] 扮演请求缓存已打散，标记：', m);
    });
}
