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

// 容错提取模型输出中的 JSON：剥掉 ``` 围栏，截取首个 { 到最后一个 }
// 报错自带原始输出片段（找不到 JSON 给开头、解析失败给结尾），排查不用另找入口
export function extractJson(text) {
    const stripped = String(text ?? '').replace(/```(?:json)?/gi, '');
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        const head = stripped.trim().slice(0, 160);
        throw new Error(head
            ? `模型输出中未找到 JSON。输出开头：「${head}」`
            : '模型输出为空：推理模型常见原因是思考耗光了「单次上限 tokens」，到「设置 → 高级设置」调大后重试');
    }
    try {
        return JSON.parse(stripped.slice(start, end + 1));
    } catch (err) {
        const tail = stripped.slice(start).slice(-160).trim();
        throw new Error(`模型输出不是合法 JSON（${err.message}；结尾突兀多半是被「单次上限 tokens」截断，到「设置 → 高级设置」调大后重试）。输出结尾：「${tail}」`);
    }
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
