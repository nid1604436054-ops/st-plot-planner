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
export function extractJson(text) {
    const stripped = String(text ?? '').replace(/```(?:json)?/gi, '');
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('模型输出中未找到 JSON（可查看原始输出排查）');
    }
    return JSON.parse(stripped.slice(start, end + 1));
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
