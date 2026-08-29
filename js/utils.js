// 通用工具：转义 / 截断 / 容错 JSON 解析 / 指纹 / 文件读写

export function escapeHtml(text) {
    return String(text ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function clamp(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

// 粗估一段文本的 token 数（浏览器里没有真分词器的折中办法）：
// 中日韩/全角字符按 1 字 ≈ 1 token，其余（英文/数字/符号）按约 4 字符 ≈ 1 token。
// 各家模型分词器差异不小，结果只作规模参考，不用于计费
export function estimateTokens(text) {
    const s = String(text ?? '');
    let wide = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if ((c >= 0x2E80 && c <= 0x9FFF) ||     // CJK 部首·标点·汉字·假名
            (c >= 0xAC00 && c <= 0xD7AF) ||     // 韩文音节
            (c >= 0xF900 && c <= 0xFFEF)) wide++;   // CJK 兼容汉字·全角符号
    }
    return Math.round(wide + (s.length - wide) / 4);
}

// 修模型常犯的 JSON 格式伤（只在字符串与结构边界动小手术，不动内容）：
// 值内未转义的英文引号补转义（引号后不是结构位置即视为内文引号）、值内裸换行/制表转义、
// 换行分隔的属性/元素缺逗号补上、尾逗号删掉。仅在直接解析失败后作为第二道尝试。
function repairModelJson(s) {
    let out = '';
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (!inStr) {
            if (c === '"') inStr = true;
            out += c;
            continue;
        }
        if (c === '\\') { out += c + (s[i + 1] ?? ''); i++; continue; }
        if (c === '"') {
            // 只在同一行内向后看：行尾引号一律视为字符串结束（漂亮排版的 JSON 每个值都在行尾收尾），
            // 同一行内引号后紧跟其他文字才是内文引号
            let j = i + 1;
            while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
            const next = s[j];
            if (next === undefined || next === '\n' || next === '\r' || next === ',' || next === ':' || next === '}' || next === ']') {
                inStr = false;
                out += c;
            } else {
                out += '\\"';
            }
            continue;
        }
        if (c === '\n') { out += '\\n'; continue; }
        if (c === '\r') { continue; }
        if (c === '\t') { out += '\\t'; continue; }
        out += c;
    }
    return out
        .replace(/(["}\]])\s*\n(\s*["{\[])/g, '$1,\n$2')
        .replace(/,(\s*[}\]])/g, '$1');
}

// 截断兜底：输出被单次回复长度上限拦腰截断时，括号配不平——截到最后一个完整值、
// 补上还开着的括号（字符串感知：值里的括号引号不参与计数）。抢不回任何完整值就放弃。
function closeUnbalancedJson(s) {
    const stackAt = end => {
        const stack = [];
        let inStr = false, esc = false;
        for (let i = 0; i < end; i++) {
            const c = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') inStr = true;
            else if (c === '{' || c === '[') stack.push(c);
            else if (c === '}' || c === ']') stack.pop();
        }
        return { stack, inStr };
    };
    const whole = stackAt(s.length);
    if (!whole.stack.length && !whole.inStr) return null;   // 括号配平，不归截断管
    const cut = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (cut <= 0) return null;   // 一个完整值都没落下来
    const atCut = stackAt(cut + 1);
    return s.slice(0, cut + 1) + atCut.stack.reverse().map(c => (c === '{' ? '}' : ']')).join('');
}

// 容错提取模型输出中的 JSON：剥掉 ``` 围栏，先试直接解析，再试首 { 到尾 } 截取 + 格式伤修复，
// 都败且括号没配平（疑似截断）再补闭合抢救前段；报错自带解析器原文与输出首尾片段，排查不用另找入口
export function extractJson(text) {
    const stripped = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) {
        const head = stripped.slice(0, 160).trim();
        throw new Error(head
            ? `模型输出中未找到 JSON。输出开头：「${head}」`
            : '模型输出为空：推理模型常见原因是思考耗光了「单次上限 tokens」，到「设置 → 高级设置」调大后重试');
    }
    const candidates = [stripped.slice(first, last + 1), stripped];
    let lastErr = null;
    for (const c of candidates) {
        try { return JSON.parse(c); } catch (e) { lastErr = e; }
        try { return JSON.parse(repairModelJson(c)); } catch (e) { lastErr = e; }
    }
    for (const c of candidates) {
        const closed = closeUnbalancedJson(c);
        if (closed === null || closed === c) continue;
        try { return JSON.parse(closed); } catch (e) { lastErr = e; }
    }
    throw new Error(`模型输出不是合法 JSON（自动修复未能救回）。解析器报错：${lastErr ? lastErr.message : '未知'}。开头：「${stripped.slice(0, 120).trim()}」…结尾：「${stripped.slice(-120).trim()}」`);
}

// 密封内容的「指纹」：只暴露长度与校验值，不暴露正文
export function fingerprint(text) {
    const s = String(text ?? '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return `${s.length} 字 · ${h.toString(16).padStart(8, '0')}`;
}

// user 编排黄牌扫描（第七轮 user 不可编排的本地粗扫）：正则扫规划文本里「替 user 编排」的
// 句式，逐句亮牌——只提醒不拦截，采用与否仍由用户定（模型侧条款在规划系统提示词与 beats
// 字段说明，这里是给人工二检的最后一道肉眼辅助）。「若 user X，则 Y」是唯一合法写法，
// 扫描时让行（lead 以 若/如果/一旦/当 结尾的不算）。纯逻辑放 utils：离线测试台可直接覆盖
export function scanUserScripting(text) {
    const hits = [];
    const seen = new Set();
    const clauseRe = /[^\n，。；]*user[^\n，。；]*(?:说|说道|开口|回答|答道|问|答应|同意|承诺|承认|拒绝|主动|提出|邀请|帮)[^\n，。；]*/gi;
    for (const m of String(text ?? '').matchAll(clauseRe)) {
        const clause = m[0];
        const lead = clause.slice(0, clause.toLowerCase().indexOf('user')).trim();
        if (/(若|如果|一旦|当)$/.test(lead)) continue;   // 「若 user 主动…」＝合法的条件式接口
        const key = clause.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hits.push(key);
    }
    return hits;
}

export function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
        reader.readAsText(file, 'utf-8');
    });
}

export function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
