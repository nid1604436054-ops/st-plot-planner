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

// 容错提取模型输出中的 JSON：剥掉 ``` 围栏，先试直接解析，再试首 { 到尾 } 截取 + 格式伤修复；
// 报错自带原始输出片段（找不到 JSON 给开头、修复救不回给开头和结尾），排查不用另找入口
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
    for (const c of candidates) {
        try { return JSON.parse(c); } catch { }
        try { return JSON.parse(repairModelJson(c)); } catch { }
    }
    throw new Error(`模型输出不是合法 JSON（自动修复未能救回）。开头：「${stripped.slice(0, 120).trim()}」…结尾：「${stripped.slice(-120).trim()}」`);
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
