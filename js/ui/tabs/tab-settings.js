// 设置页签：独立大模型通道（地址/密钥/模型）+ 检索与生成参数 + 预设（全局固定要求）管理
// + 数据备份与搬家（导出备份 / 导入备份 / 备份继承）
// 配置直接放在主面板里，魔法棒 → 剧情规划器 → 设置，无需再去扩展面板
// （「生效中的隐身注入」原住本页底部，2026-08-26 搬去剧情指导页底部工具区——见 tab-events.js）
import { settings, save, newId } from "../../settings.js";
import { testConnection, fetchModels, searchWeb } from "../../api.js";
import { guidanceSystemPrompt } from "../../planner.js";
import { activeStory } from "../../story.js";
import { chatDataKey, resetChatDataCache } from "../../chatdata.js";
import { listenerCfg, setListenerEnabled } from "../../listener.js";
import { escapeHtml, clamp, readFileAsText } from "../../utils.js";

// 拉取过的模型列表缓存：页签每次激活都会重渲染，缓存避免切换后下拉列表丢失
let modelIds = [];
// true = 手动填模型名（拉取的列表里没有时用），false = 下拉选择
let manualModel = false;
// 大区块折叠状态（页签会话内保留）：大模型连接默认展开，其余默认收起
const secFolds = { conn: true, search: false, listener: false, kb: false, advanced: false, backup: false };

// 重建模型下拉框；当前已保存的模型若不在列表里，作为「当前自定义」置顶保留
function rebuildModelSelect(container) {
    const select = container.querySelector('#pp_set_model');
    if (!select) return;
    const current = settings.api.model;
    let html = '';
    if (!modelIds.length) {
        html += `<option value="">${current ? `当前自定义：${escapeHtml(current)}` : '请先点「获取模型列表」'}</option>`;
    } else {
        if (!current || !modelIds.includes(current)) {
            html += `<option value="${escapeHtml(current)}" selected>${current ? `当前自定义：${escapeHtml(current)}` : '（未选择）'}</option>`;
        }
        html += modelIds.map(id => `<option value="${escapeHtml(id)}" ${id === current ? 'selected' : ''}>${escapeHtml(id)}</option>`).join('');
    }
    select.innerHTML = html;
}

// 按 manualModel 切换 下拉框/手动输入框 两个控件
function applyModelMode(container) {
    const select = container.querySelector('#pp_set_model');
    const text = container.querySelector('#pp_set_model_text');
    const toggle = container.querySelector('#pp_set_model_toggle');
    if (!select || !text || !toggle) return;
    select.hidden = manualModel;
    text.hidden = !manualModel;
    toggle.textContent = manualModel ? '改为下拉' : '手动输入';
    toggle.title = manualModel ? '切换回下拉选择' : '列表里没有想要的模型？点这里手动填模型名';
    if (manualModel) text.value = settings.api.model;
    else rebuildModelSelect(container);
}

// 供应商方案下拉：留底的连接方案列成选项（首项占位，选中的保持显示方便接着删）
function rebuildProfileSelect(container) {
    const sel = container.querySelector('#pp_set_prof');
    if (!sel) return;
    const list = settings.api.profiles ?? [];
    sel.innerHTML = '<option value="">选择方案切换…</option>'
        + list.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
}

export const settingsTab = {
    id: 'settings',
    title: '设置',
    render(container) {
        container.innerHTML = `
        <div class="pp-section">
            <details class="pp-fold" data-secfold="conn" ${secFolds.conn ? 'open' : ''}>
                <summary><i class="fa-solid fa-plug"></i> 大模型连接</summary>
                <label class="pp-label" title="把不同供应商的连接各存一套（地址+密钥+模型），下拉一键切换，测试不同供应商不用反复粘贴；温度等其余参数全局共用">供应商方案</label>
            <div class="pp-model-row">
                <select id="pp_set_prof" class="text_pole" title="选择已保存的方案立即整套启用（地址、密钥、模型一起换过来）；切换后模型下拉显示「当前自定义」，点「获取模型列表」可刷新成新供应商的列表"></select>
                <div id="pp_set_prof_save" class="menu_button" title="把当前地址、密钥、模型存成一个方案：名字自动取地址域名；同一地址+密钥再次保存只更新模型，同域名不同密钥会另存一条（名字带 -2 -3 区分）">保存</div>
                <div id="pp_set_prof_del" class="menu_button" title="删除下拉里选中的方案（只删留底的方案，不动当前连接）">删除</div>
            </div>
            <label class="pp-label">API 地址（含 /v1）</label>
            <input id="pp_set_base" class="text_pole textarea_compact" type="text" placeholder="https://api.openai.com/v1" autocomplete="off" />
            <label class="pp-label">API 密钥</label>
            <div class="pp-keyrow">
                <input id="pp_set_key" class="text_pole textarea_compact" type="password" placeholder="sk-..." autocomplete="off" />
                <span class="menu_button" data-keyeye="pp_set_key" title="点一下显示密钥原文（核对粘贴有没有错），再点隐藏"><i class="fa-solid fa-eye"></i></span>
            </div>
            <label class="pp-label">模型</label>
            <div class="pp-model-row">
                <select id="pp_set_model" class="text_pole"></select>
                <input id="pp_set_model_text" class="text_pole textarea_compact" type="text" placeholder="手动填写模型名" hidden autocomplete="off" />
                <div id="pp_set_model_toggle" class="menu_button">手动输入</div>
                <div id="pp_set_fetch_models" class="menu_button" title="从 API 拉取可用模型列表，之后在下拉框中选择">获取模型列表</div>
            </div>
            <div class="pp-btn-row">
                <div id="pp_set_test" class="menu_button">测试连接</div>
            </div>
            <div id="pp_set_test_result" class="pp-muted"></div>
            </details>
        </div>
        <div class="pp-section">
            <details class="pp-fold" data-secfold="search" ${secFolds.search ? 'open' : ''}>
                <summary><i class="fa-solid fa-globe"></i> 联网搜索（Tavily）</summary>
                <label class="pp-label">搜索 API 密钥（tvly- 开头，tavily.com 注册）</label>
            <div class="pp-keyrow">
                <input id="pp_set_skey" class="text_pole textarea_compact" type="password" placeholder="tvly-..." autocomplete="off" />
                <span class="menu_button" data-keyeye="pp_set_skey" title="点一下显示密钥原文（核对粘贴有没有错），再点隐藏"><i class="fa-solid fa-eye"></i></span>
            </div>
            <label class="pp-label" title="单次搜索带回并塞给模型的结果条数">每次带回条数</label>
            <input id="pp_set_smax" class="text_pole textarea_compact" type="number" min="1" max="10" />
            <div class="pp-grid2">
                <div>
                    <label class="pp-label" title="联网搜索总开关：勾上后「分析」与「检查当前剧情」可以联网取现实信息，搜不搜由右边「模型搜索前判断」的口径决定；取消则完全不联网，只保留下方的手动试搜">启用联网搜索</label>
                    <input id="pp_set_stool" type="checkbox" />
                </div>
                <div>
                    <label class="pp-label" title="勾上后每次搜索前先由一次轻量判断（只发剧情简报）决定要不要搜——纯虚构剧情默认不检索，省调用；取消则只要联网搜索开着，每次分析/检查都直接检索（轻量调用只为取关键词，不再判「不需要」）">模型搜索前判断</label>
                    <input id="pp_set_prejudge" type="checkbox" />
                </div>
            </div>
            <label class="pp-label" title="验证搜索真的能用">试搜</label>
            <input id="pp_set_stestq" class="text_pole textarea_compact" type="text" placeholder="输入关键词，如：最近的新闻" autocomplete="off" />
            <div class="pp-btn-row">
                <div id="pp_set_stest" class="menu_button">测试搜索</div>
            </div>
            <div id="pp_set_stest_result" class="pp-muted"></div>
            </details>
        </div>
        <div class="pp-section">
            <details class="pp-fold" data-secfold="listener" ${secFolds.listener ? 'open' : ''}>
                <summary title="2.0 监听（逐轮判定＋微量指导注入）的全局项；逐轮留痕与挂载单位按聊天存在「监听」页签里"><i class="fa-solid fa-ear-listen"></i> 监听</summary>
                <div class="pp-grid2">
                    <div>
                        <label class="pp-label" title="监听总开关：开 = 每轮扮演模型输出完毕后自动判定并注入指导；关 = 完全不分析、不注入、不扣发送。监听页签里也有同一个开关">启用监听</label>
                        <input id="pp_set_ls_on" type="checkbox" />
                    </div>
                    <div>
                        <label class="pp-label" title="监听模型固定项（2.0 里唯一不逐次选模型的调用）：选一个供应商方案给判定与指导用；默认用方案库第一个；方案库空时退回上面的主连接。逐轮判定建议放便宜模型或主流模型轻量版">监听模型</label>
                        <select id="pp_set_ls_prov" class="text_pole"></select>
                    </div>
                </div>
                <div class="pp-muted">监听固定关闭思考，不吃高级设置里「关闭思考」总开关——监听每轮都跑、开了思考成本会爆炸；剧情规划等其余调用仍跟总开关走</div>
                <label class="pp-label" title="监听指导注入槽的深度（0 = 紧贴上下文末尾；数字越大越靠前）。默认 2，比 1.0 剧情注入（默认 4）更靠近末端；同轮并存时监听指导在更后面">注入深度</label>
                <input id="pp_set_ls_depth" class="text_pole textarea_compact" type="number" min="0" max="100" />
                <hr class="pp-hr" />
                <div class="pp-grid2">
                    <div>
                        <label class="pp-label" title="换算锚：一层楼的有效剧情推进按这个区间综合衡量（不逐字换算），两端是示意默认、可调">有效推进区间·低（字）</label>
                        <input id="pp_set_ls_pmin" class="text_pole textarea_compact" type="number" min="50" step="50" />
                    </div>
                    <div>
                        <label class="pp-label" title="同上：区间高端">有效推进区间·高（字）</label>
                        <input id="pp_set_ls_pmax" class="text_pole textarea_compact" type="number" min="100" step="50" />
                    </div>
                </div>
                <div class="pp-grid2">
                    <div>
                        <label class="pp-label" title="附加材料：判定时附带世界书检索命中（共用上面的检索口径）">附带世界书</label>
                        <input id="pp_set_ls_lore" type="checkbox" />
                    </div>
                    <div>
                        <label class="pp-label" title="附加材料：判定时附带记忆表格（全量口径；将来要与 1.0 分开口径时在这里做减法）">附带记忆表格</label>
                        <input id="pp_set_ls_mem" type="checkbox" />
                    </div>
                </div>
            </details>
        </div>
        <div class="pp-section">
            <details class="pp-fold" data-secfold="kb" ${secFolds.kb ? 'open' : ''}>
                <summary title="知识库（自建素材清单，§6.9）的抓取与冷却参数；清单与条目在「知识库」页签管理"><i class="fa-solid fa-lightbulb"></i> 知识库</summary>
                <div class="pp-grid2">
                    <div>
                        <label class="pp-label" title="剧情指导页第 1 步「知识库抓取」时，每张勾选的**抽样**清单各发多少条（轮换制：整张清单洗牌按序发，全部条目各发一次之前不重复、发完一轮自动重洗；不按语境过滤；冷却中的条目本轮跳过；一轮剩余不足时有多少发多少）。全量清单不受此项影响——整表条目全部随行">每清单抓取条数（抽样清单）</label>
                        <input id="pp_set_kb_grab" class="text_pole textarea_compact" type="number" min="1" max="20" />
                    </div>
                    <div>
                        <label class="pp-label" title="规划确认采用（或转隐身注入）时，模型自报导选用过的条目进冷却：接下来 N 次采用里，抓取自动跳过它——防模型从小把里连挑最熟那条。草稿放弃/重写不碰冷却；冷却中的条目在「知识库」页点冷却徽章可立即清零。0 = 不冷却。默认 3 为提案值，用实感调整">冷却采用次数</label>
                        <input id="pp_set_kb_cool" class="text_pole textarea_compact" type="number" min="0" max="50" />
                    </div>
                </div>
            </details>
        </div>
        <div class="pp-section">
            <details class="pp-fold" data-secfold="advanced" ${secFolds.advanced ? 'open' : ''}>
                <summary title="保持默认即可"><i class="fa-solid fa-gear"></i> 高级设置</summary>
                <div class="pp-grid2">
                <div>
                    <label class="pp-label" title="越低输出越稳定，越高越发散">温度</label>
                    <input id="pp_set_temp" class="text_pole textarea_compact" type="number" min="0" max="2" step="0.1" />
                </div>
                <div>
                    <label class="pp-label" title="规划类请求单次最多生成的 tokens">单次上限 tokens</label>
                    <input id="pp_set_maxtok" class="text_pole textarea_compact" type="number" min="128" step="64" />
                </div>
                <div>
                    <label class="pp-label" title="推理模型把「单次上限 tokens」全花在思考上、正文一个字不出（报空内容且 finish_reason=length）时勾上：请求会带上主流服务商的关闭思考参数（GLM 系 thinking / Qwen 系 enable_thinking），端点不认这些参数时自动去掉重发一次。只管生成侧（剧情规划、检查、随机事件、路人反应、AI 打标建库、玩法咨询）；监听固定关思考、不吃这个开关">关闭思考</label>
                    <input id="pp_set_thinkoff" type="checkbox" />
                </div>
            </div>
            <hr class="pp-hr" />
            <div class="pp-label pp-group-title">世界书检索</div>
            <label class="pp-label" title="在世界书里找条目时，拿最近几层对话文本去匹配关键词；范围越大越不容易漏，但越费 token；0 = 不限（扫全部对话）">用最近几层对话找关键词（0 = 不限）</label>
            <input id="pp_set_scan" class="text_pole textarea_compact" type="number" min="0" max="100" />
            <div class="pp-grid2">
                <div>
                    <label class="pp-label" title="单次检索最多带出的世界书条目数；0 = 不限（命中多少带多少）">最多带出条目（0 = 不限）</label>
                    <input id="pp_set_maxent" class="text_pole textarea_compact" type="number" min="0" max="50" />
                </div>
                <div>
                    <label class="pp-label" title="命中的条目内容拼在一起的总字数上限，防止撑爆请求；0 = 不截断">结果字数上限（0 = 不限）</label>
                    <input id="pp_set_maxch" class="text_pole textarea_compact" type="number" min="0" step="500" />
                </div>
            </div>
            <hr class="pp-hr" />
            <label class="pp-label" title="记忆表格召回结果拼进提示词的字符上限；0 = 不限。全量召回表格很大时注意 token 消耗">记忆表格召回字数上限（0 = 不限）</label>
            <input id="pp_set_memch" class="text_pole textarea_compact" type="number" min="0" step="500" />
            <hr class="pp-hr" />
            <label class="pp-label" title="「剧情指导 / 随机事件」调用大模型时，附带最近几层对话当上下文（只影响本插件的规划请求，不影响主对话）；0 = 不限（有多少层带多少层）">规划时附带最近几层对话（0 = 不限）</label>
            <input id="pp_set_ctx" class="text_pole textarea_compact" type="number" min="0" max="200" />
            <hr class="pp-hr" />
            <label class="pp-label" title="用户构思里没点名数量时，剧情规划的节点（beats）数量下限——规划给到的节点数不得少于这个数，不设上限（节点是后续监听判断的挂载点，多点细排便于跟进执行；示例数量会被模型当上限用，所以只写下限）。用户构思里点名了数量的，以构思为准（一样按「不少于」落实）。0 = 不设下限。默认 5">规划节点下限（0 = 不设）</label>
            <input id="pp_set_minbeats" class="text_pole textarea_compact" type="number" min="0" max="50" />
            <hr class="pp-hr" />
            <label class="pp-label" title="规划分析完成后自动追加第二遍调用：同一份材料再发给模型当「对齐审校员」，只改违反时间基准／既定事实与设定／点名要求／user 不可编排的地方（如把今天的事排成第二天），改动清单在第 3 步「第二遍对齐修改」行逐条展示。计费：两遍的提示词开头逐字节相同（第二遍只在材料末尾追加审校指令与草稿），支持前缀缓存的服务商（DeepSeek、部分中转）第二遍的输入大头走缓存价（约一折），整体约 ×1.2～1.4；输出无缓存折扣；服务商不做前缀缓存时仍接近 ×2。第二遍失败或中断会保留第一遍结果交付。关掉则只跑第一遍（时间基准字段仍保留）">生成后对齐修改（第二遍）</label>
            <input id="pp_set_alignpass" type="checkbox" />
            </details>
        </div>
        <div class="pp-section" id="pp_set_preset"></div>
        <div class="pp-section" id="pp_set_backup"></div>`;

        const bind = (id, get, set) => {
            const el = container.querySelector(id);
            el.value = get();
            el.addEventListener('change', () => { set(el.value); save(); });
        };
        const bindNum = (id, get, set) => bind(id, () => get(), v => set(Number(v) || 0));

        // 密钥小眼睛（第八轮）：显示/隐藏只切输入框 type，不动存的值
        container.querySelectorAll('[data-keyeye]').forEach(btn => btn.addEventListener('click', () => {
            const inp = container.querySelector(`#${btn.dataset.keyeye}`);
            if (!inp) return;
            const show = inp.type === 'password';
            inp.type = show ? 'text' : 'password';
            const icon = btn.querySelector('i');
            if (icon) icon.className = `fa-solid ${show ? 'fa-eye-slash' : 'fa-eye'}`;
        }));

        bind('#pp_set_base', () => settings.api.baseUrl, v => settings.api.baseUrl = String(v).trim());
        bind('#pp_set_key', () => settings.api.apiKey, v => settings.api.apiKey = String(v).trim());
        bindNum('#pp_set_temp', () => settings.api.temperature, v => settings.api.temperature = v);
        bindNum('#pp_set_maxtok', () => settings.api.maxTokens, v => settings.api.maxTokens = v);
        bindNum('#pp_set_scan', () => settings.retrieval.scanDepth, v => settings.retrieval.scanDepth = v);
        bindNum('#pp_set_maxent', () => settings.retrieval.maxEntries, v => settings.retrieval.maxEntries = v);
        bindNum('#pp_set_maxch', () => settings.retrieval.maxChars, v => settings.retrieval.maxChars = v);
        bindNum('#pp_set_memch', () => settings.retrieval.memChars, v => settings.retrieval.memChars = v);
        bindNum('#pp_set_ctx', () => settings.retrieval.contextLayers, v => settings.retrieval.contextLayers = v);
        bindNum('#pp_set_minbeats', () => settings.guidance.minBeats, v => settings.guidance.minBeats = Math.min(Math.max(v || 0, 0), 50));
        const alignPass = container.querySelector('#pp_set_alignpass');
        alignPass.checked = settings.guidance.alignPass !== false;
        alignPass.addEventListener('change', () => { settings.guidance.alignPass = alignPass.checked; save(); });
        const thinkOff = container.querySelector('#pp_set_thinkoff');
        thinkOff.checked = settings.api.thinkingOff === true;
        thinkOff.addEventListener('change', () => { settings.api.thinkingOff = thinkOff.checked; save(); });

        bind('#pp_set_skey', () => settings.search.apiKey, v => settings.search.apiKey = String(v).trim());
        bindNum('#pp_set_smax', () => settings.search.maxResults, v => settings.search.maxResults = Math.min(Math.max(v || 5, 1), 10));
        const sTool = container.querySelector('#pp_set_stool');
        const sJudge = container.querySelector('#pp_set_prejudge');
        sTool.checked = settings.search.enabled !== false;
        sJudge.checked = settings.search.preJudge !== false;
        // 总开关关掉时「搜索前判断」没有意义，置灰防误导；重开时勾选态原样恢复
        const syncJudgeDisabled = () => { sJudge.disabled = !sTool.checked; };
        sTool.addEventListener('change', () => { settings.search.enabled = sTool.checked; save(); syncJudgeDisabled(); });
        sJudge.addEventListener('change', () => { settings.search.preJudge = sJudge.checked; save(); });
        syncJudgeDisabled();

        // 监听区：总开关 / 模型固定项 / 注入深度 / 换算锚区间 / 附加材料
        const ls = listenerCfg();
        const lsOn = container.querySelector('#pp_set_ls_on');
        lsOn.checked = ls.enabled === true;
        lsOn.addEventListener('change', () => {
            setListenerEnabled(lsOn.checked);
            if (lsOn.checked) toastr.info('监听已启用：扮演模型每轮输出完毕后自动判定，指导写入独立注入槽');
        });
        const lsProvSel = container.querySelector('#pp_set_ls_prov');
        const rebuildLsProv = () => {
            const profs = settings.api.profiles ?? [];
            lsProvSel.innerHTML = `<option value="">方案库第一个（默认）</option>`
                + `<option value="__main__">主连接（不单独指定）</option>`
                + profs.map(p => `<option value="${escapeHtml(p.id)}" ${ls.providerId === p.id ? 'selected' : ''}>${escapeHtml(p.name)} · ${escapeHtml(p.model ?? '')}</option>`).join('');
        };
        rebuildLsProv();
        lsProvSel.addEventListener('change', () => {
            ls.providerId = lsProvSel.value === '__main__' ? '__main__' : lsProvSel.value;
            save();
        });
        bindNum('#pp_set_ls_depth', () => ls.depth, v => ls.depth = Math.max(0, v));
        bindNum('#pp_set_ls_pmin', () => ls.progressMin, v => ls.progressMin = Math.max(50, v));
        bindNum('#pp_set_ls_pmax', () => ls.progressMax, v => ls.progressMax = Math.max(ls.progressMin + 50, v));
        const lsLore = container.querySelector('#pp_set_ls_lore');
        lsLore.checked = ls.withLorebook !== false;
        lsLore.addEventListener('change', () => { ls.withLorebook = lsLore.checked; save(); });
        const lsMem = container.querySelector('#pp_set_ls_mem');
        lsMem.checked = ls.withMemory !== false;
        lsMem.addEventListener('change', () => { ls.withMemory = lsMem.checked; save(); });

        // 知识库区：每清单抓取条数 / 冷却生成次数（清单与条目在「知识库」页签管理）
        const kb = settings.knowledge ?? {};
        bindNum('#pp_set_kb_grab', () => kb.grabCount ?? 5, v => { settings.knowledge.grabCount = Math.min(Math.max(v || 5, 1), 20); });
        bindNum('#pp_set_kb_cool', () => kb.cooldownGens ?? 3, v => { settings.knowledge.cooldownGens = Math.min(Math.max(Number.isFinite(v) ? v : 3, 0), 50); });

        applyModelMode(container);
        container.querySelector('#pp_set_model').addEventListener('change', () => {
            settings.api.model = String(container.querySelector('#pp_set_model').value || '').trim();
            save();
        });
        container.querySelector('#pp_set_model_text').addEventListener('change', () => {
            settings.api.model = String(container.querySelector('#pp_set_model_text').value || '').trim();
            save();
        });
        container.querySelector('#pp_set_model_toggle').addEventListener('click', () => {
            manualModel = !manualModel;
            applyModelMode(container);
        });

        // 供应商方案：测试不同供应商时把连接整套存下来/切回来，不用反复粘贴地址密钥
        rebuildProfileSelect(container);
        const profSel = container.querySelector('#pp_set_prof');
        profSel.addEventListener('change', () => {
            const p = (settings.api.profiles ?? []).find(x => x.id === profSel.value);
            if (!p) return;
            settings.api.baseUrl = p.baseUrl;
            settings.api.apiKey = p.apiKey;
            settings.api.model = String(p.model ?? '');
            save();
            container.querySelector('#pp_set_base').value = p.baseUrl;
            container.querySelector('#pp_set_key').value = p.apiKey;
            modelIds = [];          // 列表是旧供应商拉的，作废待重取
            manualModel = false;
            applyModelMode(container);
            toastr.success(`已切换到「${p.name}」，模型列表请重新获取`);
        });
        container.querySelector('#pp_set_prof_save').addEventListener('click', () => {
            // 显式同步输入框当前值，避免依赖 blur/change 触发时序
            const base = String(container.querySelector('#pp_set_base').value || '').trim();
            const key = String(container.querySelector('#pp_set_key').value || '').trim();
            if (!base) { toastr.warning('请先填写 API 地址'); return; }
            settings.api.baseUrl = base;
            settings.api.apiKey = key;
            save();
            const list = settings.api.profiles ??= [];
            const same = list.find(x => x.baseUrl === base && x.apiKey === key);
            if (same) {
                same.model = settings.api.model;
                save();
                toastr.success(`方案「${same.name}」已更新（模型 ${settings.api.model || '未选'}）`);
            } else {
                let host = base;
                try { host = new URL(base).host; } catch { /* 地址不规范就用原文当名字 */ }
                let name = host, n = 2;
                while (list.some(x => x.name === name)) name = `${host}-${n++}`;
                list.push({ id: newId('ap-'), name, baseUrl: base, apiKey: key, model: settings.api.model });
                save();
                rebuildProfileSelect(container);
                toastr.success(`已保存方案「${name}」`);
            }
        });
        container.querySelector('#pp_set_prof_del').addEventListener('click', () => {
            const list = settings.api.profiles ?? [];
            const idx = list.findIndex(x => x.id === profSel.value);
            if (idx < 0) { toastr.warning('请先在下拉里选中要删除的方案'); return; }
            const [removed] = list.splice(idx, 1);
            save();
            rebuildProfileSelect(container);
            toastr.success(`已删除方案「${removed.name}」`);
        });

        container.querySelector('#pp_set_fetch_models').addEventListener('click', async function () {
            const result = container.querySelector('#pp_set_test_result');
            this.classList.add('disabled');
            result.textContent = '正在拉取模型列表……';
            try {
                // 显式同步输入框当前值，避免依赖 blur/change 触发时序
                settings.api.baseUrl = String(container.querySelector('#pp_set_base').value || '').trim();
                settings.api.apiKey = String(container.querySelector('#pp_set_key').value || '').trim();
                save();
                modelIds = await fetchModels();
                if (!settings.api.model) {
                    settings.api.model = modelIds[0];
                    save();
                }
                // 拉到列表就切回下拉模式，方便直接选
                manualModel = false;
                applyModelMode(container);
                result.textContent = `已获取 ${modelIds.length} 个模型，点击「模型」下拉框选择`;
                toastr.success(`已获取 ${modelIds.length} 个模型`);
            } catch (err) {
                result.textContent = '';
                toastr.error(String(err.message ?? err));
            } finally {
                this.classList.remove('disabled');
            }
        });

        container.querySelector('#pp_set_test').addEventListener('click', async function () {
            const result = container.querySelector('#pp_set_test_result');
            this.classList.add('disabled');
            result.textContent = '测试中……';
            try {
                const reply = await testConnection();
                result.textContent = `连接成功：${reply.slice(0, 50)}`;
                toastr.success('API 连接正常');
            } catch (err) {
                result.textContent = '';
                toastr.error(String(err.message ?? err));
            } finally {
                this.classList.remove('disabled');
            }
        });

        container.querySelector('#pp_set_stest').addEventListener('click', async function () {
            const box = container.querySelector('#pp_set_stest_result');
            // 显式同步密钥输入框当前值，避免依赖 blur/change 触发时序
            settings.search.apiKey = String(container.querySelector('#pp_set_skey').value || '').trim();
            save();
            const query = String(container.querySelector('#pp_set_stestq').value || '').trim();
            if (!settings.search.apiKey) { toastr.warning('请先填写搜索 API 密钥'); return; }
            if (!query) { toastr.warning('请先在输入框里填一个关键词'); return; }
            this.classList.add('disabled');
            box.textContent = '搜索中……';
            try {
                const results = await searchWeb(query);
                box.innerHTML = results.length
                    ? `共 ${results.length} 条结果：<div class="pp-search-list">` + results.map(r =>
                        `<div class="pp-search-hit"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title || r.url)}</a>`
                        + `<span class="pp-muted">${escapeHtml(r.content.slice(0, 140))}</span></div>`).join('') + '</div>'
                    : '搜索请求成功，但没有命中结果：换个关键词试试';
                toastr.success('联网搜索可用');
            } catch (err) {
                box.textContent = '';
                toastr.error(String(err.message ?? err));
            } finally {
                this.classList.remove('disabled');
            }
        });

        renderPreset(container);
        renderBackup(container);
        // 折叠状态记忆（toggle 事件不冒泡，逐个绑定；备份区在 renderBackup 里渲染，放它后面）
        container.querySelectorAll('details[data-secfold]').forEach(el =>
            el.addEventListener('toggle', () => { secFolds[el.dataset.secfold] = el.open; }));
    },
};

// ---------------------------------------------------------------------------
// 数据备份与搬家：插件数据不进聊天文件（见 chatdata.js），这里是它的保险丝——
// 导出备份（全局设置 + 所有聊天各自的数据）成 JSON 文件存到任意位置；
// 导入备份恢复；备份继承把别的聊天的数据整个搬给当前聊天（新聊天继承旧聊天 /
// 开分支 / 聊天改名后找回数据都靠它）
// ---------------------------------------------------------------------------

function renderBackup(container) {
    const el = container.querySelector('#pp_set_backup');
    if (!el) return;
    el.innerHTML = `
    <details class="pp-fold" data-secfold="backup" ${secFolds.backup ? 'open' : ''}>
        <summary><i class="fa-solid fa-box-archive"></i> 数据备份与搬家</summary>
        <div class="pp-btn-row">
            <select id="pp_set_transfer_from" class="text_pole" title="备份继承的源聊天。聊天身份 = 角色头像｜聊天文件名。开分支、改聊天名、换新聊天文件都会被认成新聊天（数据不自动跟过去）——从列表里选旧身份，点下方「备份继承」把它的数据整个搬过来"></select>
        </div>
        <div class="pp-btn-row">
            <div id="pp_set_export" class="menu_button" title="把插件的全部数据导出成一个 JSON 文件，存到你选的位置：全局设置（连接/预设/世界书/事件库/玩法/注入）+ 每个聊天各自的数据（记忆表格镜像、剧情档案、各类勾选、书单）。换电脑、重装酒馆前的救命备份">导出备份</div>
            <label class="menu_button" for="pp_set_import_file" title="选一个之前导出的备份文件恢复：全局设置整份覆盖，各聊天的数据按聊天身份合并回来；导入后建议刷新一次页面">导入备份</label>
            <input id="pp_set_import_file" type="file" accept=".json,application/json" hidden />
            <div id="pp_set_transfer" class="menu_button" title="把上面选中的聊天的全部插件数据（记忆表格镜像、剧情档案、勾选、书单）复制给当前聊天；当前聊天已有的数据会被覆盖。适合：旧聊天太卡换了新的、开分支、改名后找回数据">备份继承</div>
        </div>
    </details>`;

    el.querySelector('#pp_set_export').addEventListener('click', () => {
        const { chatData, ...global } = settings;
        const payload = {
            app: 'st-plot-planner-backup',
            version: 1,
            at: new Date().toISOString(),
            global,
            chats: chatData ?? {},
        };
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const t = new Date();
        const pad = n => String(n).padStart(2, '0');
        a.download = `plot-planner-backup-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        toastr.success('已导出全部数据（全局设置 + 所有聊天的插件数据）');
    });

    el.querySelector('#pp_set_import_file').addEventListener('change', async function () {
        const f = this.files?.[0];
        this.value = '';
        if (!f) return;
        try {
            const data = JSON.parse(await readFileAsText(f));
            if (data?.app !== 'st-plot-planner-backup' || typeof data.global !== 'object') {
                throw new Error('不是本插件导出的备份文件');
            }
            Object.assign(settings, data.global);
            settings.chatData = { ...(settings.chatData ?? {}), ...(data.chats ?? {}) };
            // 以刚导入的冷层为准：作废会话缓存与浏览器热层，后续读取回落到冷层
            resetChatDataCache();
            save();
            rebuildTransferList(container);
            toastr.success('备份已导入：全局设置与各聊天数据已恢复，建议刷新一次页面');
        } catch (err) {
            toastr.error(`导入失败：${String(err.message ?? err)}`);
        }
    });

    el.querySelector('#pp_set_transfer').addEventListener('click', () => {
        const from = el.querySelector('#pp_set_transfer_from').value;
        const src = from ? settings.chatData?.[from] : null;
        if (!from || !src) { toastr.warning('请先在上方选择要继承的源聊天'); return; }
        settings.chatData ??= {};
        settings.chatData[chatDataKey()] = JSON.parse(JSON.stringify(src));
        resetChatDataCache();
        save();
        rebuildTransferList(container);
        toastr.success(`已从「${from}」继承全部数据到当前聊天（记忆表格/剧情档案/勾选/书单），建议刷新一次页面`);
    });

    rebuildTransferList(container);
}

function rebuildTransferList(container) {
    const sel = container.querySelector('#pp_set_transfer_from');
    if (!sel) return;
    const current = chatDataKey();
    const keys = Object.keys(settings.chatData ?? {})
        .filter(k => k !== current && Object.keys(settings.chatData[k] ?? {}).length);
    sel.innerHTML = keys.length
        ? keys.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('')
        : '<option value="">（没有其他聊天的数据）</option>';
    sel.disabled = !keys.length;
    container.querySelector('#pp_set_transfer')?.classList.toggle('disabled', !keys.length);
}

// ---------------------------------------------------------------------------
// 预设（全局固定要求）：多条命名预设，默认折叠成一条摘要行（交互同记忆表格「原表库」）。
// 勾选「启用」即全局生效——插件发给大模型的每一次调用（规划分析/检查报告/随机事件/路人反应/
// AI 打标/AI 建库/联网判断）都会把启用中的预设按列表顺序拼进系统提示词末尾（chatCompletion
// 出口统一附加，见 api.globalPresetBlock）。所有改动即时保存。
// 管理入口在本页（原挂剧情指导页底部，应用户要求挪到设置）；向导第 1 步与反应卡的
// 逐次预设勾选已随全局化移除——这里的启用开关是唯一开关
// ---------------------------------------------------------------------------

let presetOpen = false;
let editingPreset = null;   // 正在编辑内容的预设 id

function findPreset(id) {
    return (settings.guidance?.presets ?? []).find(p => p.id === id);
}

function presetSummary() {
    const list = settings.guidance?.presets ?? [];
    const n = list.filter(p => p.enabled).length;
    return list.length ? `${list.length} 个预设 · ${n} 个全局生效` : '未设置';
}

// 预设行：顺序 = 新建先后，不可调（2026-08-27 用户拍板撤掉上移/下移）
function presetRow(p) {
    const editing = editingPreset === p.id;
    return `
    <div class="pp-item" data-preset-item="${p.id}">
        <div class="pp-item-main">
            <label title="勾选后全局生效：插件发给大模型的任何调用都会附上这条预设"><input type="checkbox" data-pena="${p.id}" ${p.enabled ? 'checked' : ''} /> <b class="pp-gd-pname">${escapeHtml(p.name)}</b></label>
        </div>
        <div class="pp-item-ops">
            <span class="pp-muted pp-gd-plen">${String(p.content ?? '').trim().length} 字</span>
            <span class="menu_button" data-pedit="${p.id}">${editing ? '收起' : '编辑'}</span>
            <span class="menu_button fa-solid fa-trash" data-pdel="${p.id}" title="删除该预设"></span>
        </div>
    </div>
    ${editing ? `
    <div class="pp-gd-editor">
        <label class="pp-label">预设名</label>
        <input type="text" class="text_pole" data-pname="${p.id}" value="${escapeHtml(p.name)}" />
        <label class="pp-label">内容（固定要求：内容格式、文风、篇幅、侧重点等；全局生效，改动即时保存）</label>
        <textarea class="text_pole textarea_compact" rows="6" data-pcontent="${p.id}">${escapeHtml(p.content ?? '')}</textarea>
    </div>` : ''}`;
}

function renderPreset(container) {
    const el = container.querySelector('#pp_set_preset');
    if (!el) return;
    const presets = settings.guidance?.presets ?? [];
    const head = `
    <div class="pp-item" id="pp_set_preset_head" title="写一次、处处生效的固定要求（格式/文风/篇幅/侧重点等）。勾选「启用」的按列表顺序拼接（每条自带预设名做小标题），拼进插件发给大模型的每一次调用的系统提示词末尾——规划分析、检查报告、随机事件、路人反应、AI 打标、AI 建库、联网判断全都带上，可多条同时启用做组合；开关只有这里这一处。注意：输出须仍是各任务的 JSON 骨架（程序要解析），格式要求写在内容层面（写法、语言、详细程度），别要求改成纯正文——预设头部自带格式保护语，但别刻意对抗">
        <div class="pp-item-main"><b>预设（全局固定要求）</b></div>
        <div class="pp-item-ops">
            <span class="pp-muted">${presetSummary()}</span>
            <span class="menu_button" id="pp_set_preset_toggle">${presetOpen ? '收起' : '编辑'} <i class="fa-solid fa-chevron-${presetOpen ? 'down' : 'right'}"></i></span>
        </div>
    </div>`;

    if (!presetOpen) {
        el.innerHTML = head;
        el.querySelector('#pp_set_preset_toggle').addEventListener('click', () => {
            presetOpen = true;
            renderPreset(container);
        });
        return;
    }

    el.innerHTML = `
    ${head}
    ${presets.map(p => presetRow(p)).join('') || '<div class="pp-muted">还没有预设，点下面「新建预设」加一条</div>'}
    <div class="pp-btn-row">
        <span id="pp_set_preset_new" class="menu_button"><i class="fa-solid fa-plus"></i> 新建预设</span>
        <span id="pp_set_preset_builtin" class="menu_button" title="展开查看内置的系统指令和预设拼接的位置">查看内置指令</span>
    </div>
    <div id="pp_set_preset_view" class="pp-gd-builtin" style="display:none"></div>`;

    const refreshHead = () => {
        el.querySelector('#pp_set_preset_head .pp-muted').textContent = presetSummary();
    };

    el.querySelector('#pp_set_preset_toggle').addEventListener('click', () => {
        presetOpen = false;
        editingPreset = null;
        renderPreset(container);
    });
    el.querySelector('#pp_set_preset_new').addEventListener('click', () => {
        const list = settings.guidance.presets;
        const p = { id: newId('gd-'), name: `预设 ${list.length + 1}`, content: '', enabled: true };
        list.push(p);
        editingPreset = p.id;
        save();
        renderPreset(container);
        el.querySelector(`[data-pcontent="${p.id}"]`)?.focus();
    });
    el.querySelectorAll('[data-pena]').forEach(cb => cb.addEventListener('change', () => {
        const p = findPreset(cb.dataset.pena);
        if (p) { p.enabled = cb.checked; save(); refreshHead(); }
    }));
    el.querySelectorAll('[data-pedit]').forEach(btn => btn.addEventListener('click', () => {
        editingPreset = editingPreset === btn.dataset.pedit ? null : btn.dataset.pedit;
        renderPreset(container);
    }));
    el.querySelectorAll('[data-pdel]').forEach(btn => btn.addEventListener('click', () => {
        const list = settings.guidance.presets;
        const idx = list.findIndex(x => x.id === btn.dataset.pdel);
        if (idx >= 0) {
            const [removed] = list.splice(idx, 1);
            save();
            toastr.success(`已删除预设「${removed.name}」`);
        }
        if (editingPreset === btn.dataset.pdel) editingPreset = null;
        renderPreset(container);
    }));
    // 名字/内容编辑即时保存，只更新行内文字，不整块重渲染（避免打断输入）
    el.querySelectorAll('[data-pname]').forEach(inp => inp.addEventListener('input', () => {
        const p = findPreset(inp.dataset.pname);
        if (!p) return;
        p.name = inp.value;
        save();
        const row = el.querySelector(`[data-preset-item="${p.id}"]`);
        row.querySelector('.pp-gd-pname').textContent = p.name || '（未命名）';
    }));
    el.querySelectorAll('[data-pcontent]').forEach(ta => ta.addEventListener('input', () => {
        const p = findPreset(ta.dataset.pcontent);
        if (!p) return;
        p.content = ta.value;
        save();
        el.querySelector(`[data-preset-item="${p.id}"] .pp-gd-plen`).textContent = `${ta.value.trim().length} 字`;
    }));
    el.querySelector('#pp_set_preset_builtin').addEventListener('click', () => {
        const view = el.querySelector('#pp_set_preset_view');
        const show = view.style.display === 'none';
        view.style.display = show ? '' : 'none';
        if (show) {
            const hasActive = Boolean((activeStory()?.planText ?? '').trim());
            view.textContent = `${guidanceSystemPrompt(hasActive)}\n\n## 用户全局预设（启用中的预设按顺序追加在这里——所有模型调用共用这一拼法，规划分析/检查报告/随机事件/路人反应/AI 打标/AI 建库/联网判断都会带上，每条带「### 预设名」小标题）`
                + `\n（上面是「${hasActive ? '有' : '无'}进行中剧情」时的版本：progress 进度项只在该版本出现，第 3 步的「剧情进度」行同理）`;
        }
    });
}
