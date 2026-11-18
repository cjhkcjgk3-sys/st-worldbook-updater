// Data-only functions. No host globals, HTML rendering, regex evaluation, or writes.
const own = (o, k) => Object.hasOwn(o, k);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const clone = value => structuredClone(value);

export function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
}

export function validateBook(book) {
    if (!record(book) || !record(book.entries)) throw new Error('请使用酒馆原生世界书 JSON（entries 应为对象）。');
    const entries = Object.entries(book.entries);
    if (entries.length > 10000) throw new Error('单本世界书最多支持 10000 条，请先拆分后再处理。');
    const walk = (x, depth = 0) => {
        if (depth > 50) throw new Error('JSON 层级过深，无法读取。');
        if (x && typeof x === 'object') for (const k of Object.keys(x)) {
            if (['__proto__', 'prototype', 'constructor'].includes(k)) throw new Error('JSON 含不受支持的属性名，已停止读取。');
            walk(x[k], depth + 1);
        }
    };
    walk(book);
    for (const [id, entry] of entries) {
        if (!/^(0|[1-9]\d*)$/.test(id) || !Number.isSafeInteger(Number(id)) || !record(entry)) throw new Error('世界书条目编号或结构不正确。');
        if (own(entry, 'uid') && String(entry.uid) !== id) throw new Error(`条目 ${id} 的 uid 与所在编号不一致。`);
        if (typeof entry.content !== 'string') throw new Error(`条目 ${id} 缺少正文，或正文不是文本。`);
        if (own(entry, 'comment') && typeof entry.comment !== 'string') throw new Error(`条目 ${id} 的标题格式不正确。`);
        for (const key of ['key', 'keysecondary']) {
            if (own(entry, key) && (!Array.isArray(entry[key]) || entry[key].some(x => typeof x !== 'string'))) throw new Error(`条目 ${id} 的关键词应为文本数组。`);
        }
    }
    return book;
}

export function parseBook(text) {
    if (typeof text !== 'string' || text.length > 20 * 1024 * 1024) throw new Error('世界书文件过大（上限 20 MB）。');
    let data;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('JSON 格式不正确，文件未载入。'); }
    return validateBook(data);
}

export function title(entry) {
    return entry.comment?.trim() || entry.key?.find(x => x.trim()) || `未命名条目 ${entry.uid ?? ''}`;
}

export function listEntries(book) {
    return Object.entries(book.entries).map(([id, entry]) => ({ id, entry })).sort((a, b) => {
        const x = a.entry.displayIndex ?? Number(a.id), y = b.entry.displayIndex ?? Number(b.id);
        return x - y || Number(a.id) - Number(b.id);
    });
}

function keySignature(entry) {
    const keys = [...new Set((entry.key || []).map(x => x.trim()).filter(Boolean))].sort();
    return keys.length ? JSON.stringify(keys) : '';
}

function matchEntries(oldBook, newBook, inScope) {
    validateBook(oldBook); validateBook(newBook);
    const titles = new Map(), signatures = new Map();
    function index(map, key, id) {
        if (!key) return;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(id);
    }
    for (const [id, entry] of Object.entries(oldBook.entries)) {
        const name = entry.comment?.trim() || '';
        if (name) {
            if (!titles.has(name)) titles.set(name, { ids: new Set(), keys: new Map(), sizes: new Map() });
            const group = titles.get(name), keywords = new Set((entry.key || []).map(x => x.trim()).filter(Boolean));
            group.ids.add(id);
            group.sizes.set(id, keywords.size);
            for (const key of keywords) index(group.keys, key, id);
        }
        index(signatures, keySignature(entry), id);
    }
    const winners = new Map(), resolutions = new Map();
    for (const [id, entry] of Object.entries(newBook.entries)) {
        if (inScope && !inScope(entry)) continue;
        const name = entry.comment?.trim() || '', signature = keySignature(entry);
        const combination = JSON.stringify([name, signature]);
        if (!resolutions.has(combination)) {
            const group = titles.get(name), byKey = signatures.get(signature);
            const sourceKeys = signature ? JSON.parse(signature) : [];
            const partialScore = (candidate, overlap) => 3 + overlap / (1 + Math.max(sourceKeys.length, group.sizes.get(candidate)));
            let oldId = null, score = 0, exactTie = false;
            if (group) {
                if (byKey) {
                    const [small, large] = group.ids.size <= byKey.size ? [group.ids, byKey] : [byKey, group.ids];
                    let count = 0;
                    for (const candidate of small) if (large.has(candidate)) {
                        oldId = candidate;
                        if (++count === 2) break;
                    }
                    if (count === 1) score = 4;
                    else if (count > 1) { oldId = null; exactTie = true; }
                }
                if (!score && !exactTie && group.ids.size === 1) {
                    const candidate = group.ids.values().next().value;
                    const overlap = sourceKeys.filter(key => group.keys.get(key)?.has(candidate)).length;
                    // An exact keyword signature identifying a different entry is conflicting evidence.
                    if (!byKey || byKey.has(candidate) || overlap || !group.keys.size) { oldId = candidate; score = overlap ? partialScore(candidate, overlap) : 2; }
                } else if (!score && !exactTie && group.ids.size > 1 && signature) {
                    const postings = sourceKeys.map(key => group.keys.get(key)).filter(Boolean).sort((a, b) => a.size - b.size);
                    if (postings.length) {
                        // A match in every posting has the highest possible overlap; stop on a tie.
                        let perfect = null, count = 0;
                        for (const candidate of postings[0]) if (postings.every(set => set.has(candidate))) {
                            perfect = candidate;
                            if (++count === 2) break;
                        }
                        if (count === 1) { oldId = perfect; score = partialScore(perfect, postings.length); }
                        else if (!count) {
                            const counts = new Map();
                            for (const posting of postings) for (const candidate of posting) counts.set(candidate, (counts.get(candidate) || 0) + 1);
                            let best = 0, tie = false;
                            for (const [candidate, value] of counts) {
                                if (value > best) { oldId = candidate; best = value; tie = false; }
                                else if (value === best) tie = true;
                            }
                            if (tie) oldId = null;
                            else if (oldId !== null) score = partialScore(oldId, best);
                        }
                    }
                }
            } else if (byKey?.size === 1) {
                oldId = byKey.values().next().value;
                score = 2;
            }
            resolutions.set(combination, { oldId, score, reason: score >= 3 ? '标题与关键词' : group ? '标题相同' : '关键词相同' });
        }
        const resolved = resolutions.get(combination);
        if (resolved.oldId === null) continue;
        const current = winners.get(resolved.oldId);
        if (!current || resolved.score > current.score) winners.set(resolved.oldId, { ...resolved, newId: id });
        else if (resolved.score === current.score) winners.set(resolved.oldId, { ...current, newId: null });
    }
    return [...winners.values()].filter(winner => winner.newId !== null)
        .map(({ oldId, newId, reason }) => ({ oldId, newId, checked: true, reason }));
}

export function autoMatch(oldBook, newBook) {
    return matchEntries(oldBook, newBook);
}

export function pairManually(pairs, oldId, newId) {
    if (pairs.some(p => (p.oldId === oldId || p.newId === newId) && !(p.oldId === oldId && p.newId === newId))) throw new Error('其中一个条目已配对，请先解除原配对。');
    return [...pairs.filter(p => p.oldId !== oldId), { oldId, newId, checked: true, reason: '手动配对' }];
}

function merge(oldValue, newValue) {
    if (!record(oldValue) || !record(newValue)) return clone(newValue);
    const result = clone(oldValue);
    for (const [key, value] of Object.entries(newValue)) result[key] = own(result, key) ? merge(result[key], value) : clone(value);
    return result;
}

export function replacement(oldEntry, newEntry, mode = 'content') {
    if (!['content', 'full'].includes(mode)) throw new Error('未知的替换范围。');
    if (mode === 'content') return { ...clone(oldEntry), content: newEntry.content };
    const next = merge(oldEntry, newEntry);
    if (own(oldEntry, 'uid')) next.uid = oldEntry.uid;
    else delete next.uid;
    // List position belongs to the target, like its local uid. Trigger order still updates.
    if (own(oldEntry, 'displayIndex')) next.displayIndex = oldEntry.displayIndex;
    else delete next.displayIndex;
    return next;
}

function entrySignature(entry) {
    const value = clone(entry);
    delete value.uid; delete value.displayIndex;
    if (record(value.extensions)) {
        delete value.extensions.display_index;
        if (!Object.keys(value.extensions).length) delete value.extensions;
    }
    return canonical(value);
}

export function classifyIncoming(oldBook, newBook, pairs = []) {
    const result = new Map(), paired = new Set(pairs.map(p => String(p.newId)));
    const oldTitles = new Set(), oldKeys = new Set();
    for (const entry of Object.values(oldBook.entries)) {
        if (entry.comment?.trim()) oldTitles.add(entry.comment.trim());
        for (const key of entry.key || []) if (key.trim()) oldKeys.add(key.trim());
    }
    const identityCounts = new Map();
    for (const entry of Object.values(newBook.entries)) {
        const identity = JSON.stringify([entry.comment?.trim() || '', keySignature(entry)]);
        identityCounts.set(identity, (identityCounts.get(identity) || 0) + 1);
    }
    for (const [id, entry] of Object.entries(newBook.entries)) {
        const name = entry.comment?.trim() || '', keys = (entry.key || []).map(x => x.trim()).filter(Boolean);
        let state;
        if (paired.has(id)) state = 'paired';
        else if ((!name && !keys.length) || oldTitles.has(name) || keys.some(k => oldKeys.has(k)) || identityCounts.get(JSON.stringify([name, keySignature(entry)])) > 1) state = 'review';
        else state = 'new';
        result.set(id, state);
    }
    return result;
}

export function pairChanged(oldBook, newBook, pair, mode) {
    return canonical(oldBook.entries[pair.oldId]) !== canonical(replacement(oldBook.entries[pair.oldId], newBook.entries[pair.newId], mode));
}

// Mirror native fields into the optional Character Book representation used for export.
// Based on SillyTavern 1.18/1.19 convertCharacterBook; preserve unrelated fields.
const originalFields = {
    comment: 'comment', content: 'content', key: 'keys', keysecondary: 'secondary_keys',
    constant: 'constant', selective: 'selective', order: 'insertion_order', characterFilter: 'character_filter',
};
const extensionFields = {
    displayIndex: 'display_index', position: 'position', depth: 'depth', role: 'role',
    excludeRecursion: 'exclude_recursion', preventRecursion: 'prevent_recursion', delayUntilRecursion: 'delay_until_recursion',
    probability: 'probability', useProbability: 'useProbability', selectiveLogic: 'selectiveLogic',
    outletName: 'outlet_name', group: 'group', groupOverride: 'group_override', groupWeight: 'group_weight',
    scanDepth: 'scan_depth', caseSensitive: 'case_sensitive', matchWholeWords: 'match_whole_words', useGroupScoring: 'use_group_scoring',
    automationId: 'automation_id', vectorized: 'vectorized', sticky: 'sticky', cooldown: 'cooldown', delay: 'delay',
    matchPersonaDescription: 'match_persona_description', matchCharacterDescription: 'match_character_description',
    matchCharacterPersonality: 'match_character_personality', matchCharacterDepthPrompt: 'match_character_depth_prompt',
    matchScenario: 'match_scenario', matchCreatorNotes: 'match_creator_notes', triggers: 'triggers', ignoreBudget: 'ignore_budget',
};

function syncOriginal(book, id, entry, source, mode, givenOriginal = null) {
    if (!Array.isArray(book.originalData?.entries)) return;
    const original = givenOriginal || book.originalData.entries.find(x => String(x.id ?? x.uid) === id);
    if (!original) return;
    if (mode !== 'settings') original.content = entry.content;
    if (mode === 'content') return;
    for (const [key, dest] of Object.entries(originalFields)) if (own(source, key)) original[dest] = clone(entry[key]);
    if (mode !== 'settings' && record(entry.extensions)) original.extensions = merge(original.extensions || {}, entry.extensions);
    for (const [key, dest] of Object.entries(extensionFields)) if (own(source, key)) {
        if (!record(original.extensions)) original.extensions = {};
        original.extensions[dest] = clone(entry[key]);
    }
    if (own(source, 'disable')) original.enabled = !entry.disable;
    if (own(source, 'position')) original.position = entry.position === 0 ? 'before_char' : 'after_char';
}

export function buildUpdate(oldBook, newBook, pairs, mode = 'content', options = {}) {
    validateBook(oldBook); validateBook(newBook);
    if (!['content', 'full'].includes(mode)) throw new Error('未知的替换范围。');
    const next = clone(oldBook), usedOld = new Set(), usedNew = new Set();
    const additions = (options.additions || []).map(String), forced = new Set((options.forceAdditions || []).map(String));
    if ((additions.length || forced.size) && !options.merge) throw new Error('请切换到融合模式后再新增条目。');
    const selectedAdditions = new Set(additions);
    for (const id of forced) if (!selectedAdditions.has(id)) throw new Error('强制复制条目必须同时列入新增选择。');
    let updated = 0, skipped = 0, added = 0;
    for (const pair of pairs) {
        const oldId = String(pair.oldId), newId = String(pair.newId);
        if (!own(oldBook.entries, oldId) || !own(newBook.entries, newId)) throw new Error('配对中的条目不存在，请重新载入世界书。');
        if (usedOld.has(oldId) || usedNew.has(newId)) throw new Error('配对重复，已停止替换。');
        usedOld.add(oldId); usedNew.add(newId);
        if (pair.checked !== true) continue;
        if (forced.has(newId)) throw new Error('同一条目不能同时更新和强制复制，请先取消更新。');
        const oldEntry = oldBook.entries[oldId], source = newBook.entries[newId];
        const entry = replacement(oldEntry, source, mode);
        if (canonical(entry) === canonical(oldEntry)) { skipped++; continue; }
        next.entries[oldId] = entry;
        syncOriginal(next, oldId, entry, source, mode);
        updated++;
    }
    const addedPairs = [];
    if (options.merge && additions.length) {
        const states = classifyIncoming(oldBook, newBook, pairs), approved = new Set((options.approvedNew || []).map(String));
        const seen = new Set(Object.values(next.entries).map(entrySignature)), requested = new Set(), used = new Set(Object.keys(next.entries));
        if (Array.isArray(next.originalData?.entries)) for (const entry of next.originalData.entries) {
            for (const id of [entry.id, entry.uid]) if (id !== undefined && /^(0|[1-9]\d*)$/.test(String(id))) used.add(String(id));
        }
        const portableSources = new Map((Array.isArray(newBook.originalData?.entries) ? newBook.originalData.entries : []).map(entry => [String(entry.id ?? entry.uid), entry]));
        let uid = 0;
        let total = Object.keys(next.entries).length;
        let displayIndex = Math.ceil(Object.entries(next.entries).reduce((m, [id, entry]) => Math.max(m, Number.isFinite(entry.displayIndex) ? entry.displayIndex : Number(id)), -1));
        for (const newId of additions) {
            if (!own(newBook.entries, newId)) throw new Error('待新增条目已不存在，请重新载入。');
            if (requested.has(newId)) throw new Error('新增条目被重复选择，已停止融合。');
            requested.add(newId);
            const force = forced.has(newId);
            if (usedNew.has(newId) && !force) throw new Error('已配对条目不能同时作为新条目加入，请先解除配对。');
            if (states.get(newId) === 'review' && !approved.has(newId) && !force) throw new Error('存在待处理条目，请先配对或标记为新增。');
            const source = newBook.entries[newId], signature = entrySignature(source);
            if (!force && (states.get(newId) === 'duplicate' || seen.has(signature))) { skipped++; continue; }
            if (total >= 10000) throw new Error('融合后将超过 10000 条，请先拆分世界书。');
            while (used.has(String(uid))) uid++;
            const entry = { ...clone(source), uid, displayIndex: ++displayIndex };
            next.entries[String(uid)] = entry; used.add(String(uid)); seen.add(signature);
            total++;
            if (Array.isArray(next.originalData?.entries)) {
                const portable = portableSources.get(newId);
                const original = { keys: entry.key || [], secondary_keys: entry.keysecondary || [], comment: entry.comment || '', content: entry.content, enabled: !entry.disable, constant: entry.constant ?? false, selective: entry.selective ?? true, insertion_order: entry.order ?? 100, position: (entry.position ?? 0) === 0 ? 'before_char' : 'after_char', ...clone(portable || {}), id: uid };
                if (own(original, 'uid')) original.uid = uid;
                next.originalData.entries.push(original);
                syncOriginal(next, String(uid), entry, entry, 'full', original);
            }
            addedPairs.push({ oldId: String(uid), newId, checked: false, reason: '本次新增' });
            added++;
        }
    }
    return { data: validateBook(next), updated, skipped, added, addedPairs };
}


// ---- 条目注入设置（只动设置，不动标题/关键词/正文） ----
export const SETTINGS_FIELDS = Object.freeze([
    { key: 'position', label: '注入位置', kind: 'enum', options: [
        { value: 0, label: '角色前' }, { value: 1, label: '角色后' }, { value: 2, label: '作者注上' },
        { value: 3, label: '作者注下' }, { value: 4, label: '指定深度' }, { value: 5, label: '示例上' }, { value: 6, label: '示例下' },
    ] },
    { key: 'depth', label: '深度', kind: 'number', min: 0, max: 9999 },
    { key: 'role', label: '插入角色', kind: 'enum', options: [
        { value: 0, label: '系统' }, { value: 1, label: '用户' }, { value: 2, label: '助手' },
    ] },
    { key: 'order', label: '注入顺序', kind: 'number', min: 0, max: 9999 },
    { key: 'constant', label: '常驻（蓝灯）', kind: 'boolean' },
    { key: 'excludeRecursion', label: '不可递归', kind: 'boolean' },
    { key: 'preventRecursion', label: '防止进一步递归', kind: 'boolean' },
    { key: 'delayUntilRecursion', label: '延迟到递归', kind: 'number', min: 0, max: 999 },
    { key: 'ignoreBudget', label: '无视回复限额', kind: 'boolean' },
]);
const SETTINGS_KEYS = new Set(SETTINGS_FIELDS.map(field => field.key));

export function isSettingsField(key) { return SETTINGS_KEYS.has(key); }

export function clampSetting(field, value) {
    if (field.kind === 'boolean') return Boolean(value);
    const number = Math.trunc(Number(value));
    if (field.kind === 'enum') {
        return field.options.some(option => option.value === number) ? number : field.options[0].value;
    }
    if (!Number.isFinite(number)) return field.min ?? 0;
    return Math.max(field.min ?? number, Math.min(field.max ?? number, number));
}

/** rows: [{ key, mode: 'set'|'add', value }]，只保留核心字段；布尔与枚举不支持 add。 */
export function buildSettingsPatch(rows) {
    const patch = {};
    for (const row of rows || []) {
        const field = SETTINGS_FIELDS.find(item => item.key === row?.key);
        if (!field || !row.mode || row.mode === 'keep') continue;
        if (row.mode === 'add' && field.kind !== 'number') continue;
        patch[field.key] = {
            mode: row.mode === 'add' ? 'add' : 'set',
            value: field.kind === 'boolean' ? row.value === true || row.value === 'true' : Number(row.value),
        };
    }
    return patch;
}

/** 只改 patch 里点到的字段；标题、关键词、正文不在可改范围内。 */
export function applySettingsPatch(entry, patch) {
    const next = { ...entry };
    for (const [key, op] of Object.entries(patch || {})) {
        const field = SETTINGS_FIELDS.find(item => item.key === key);
        if (!field) continue;
        const current = Number(entry[key]);
        const raw = op.mode === 'add' ? (Number.isFinite(current) ? current : 0) + Number(op.value) : op.value;
        next[key] = clampSetting(field, raw);
        // Blue (constant) and green (keyword) both clear the vectorized third state.
        if (key === 'constant') next.vectorized = false;
    }
    return next;
}

/** 取出条目的指定设置值，用于同步到另一本书。 */
export function pickSettings(entry, keys) {
    const picked = {};
    for (const key of keys || []) {
        if (!SETTINGS_KEYS.has(key)) continue;
        if (key === 'constant') {
            if (!own(entry, 'constant') && !own(entry, 'vectorized')) continue;
            picked.constant = Boolean(entry.constant);
            picked.vectorized = !picked.constant && Boolean(entry.vectorized);
        } else if (own(entry, key)) picked[key] = clone(entry[key]);
    }
    return picked;
}

/** 原地写入选定的设置值，并同步可选的角色书导出镜像。 */
export function setBookEntrySettings(book, id, values) {
    const key = String(id);
    if (!record(book?.entries) || !own(book.entries, key)) throw new Error('设置条目不存在，请重新载入世界书。');
    const picked = pickSettings(values || {}, Object.keys(values || {}));
    const entry = { ...book.entries[key], ...picked };
    book.entries[key] = entry;
    syncOriginal(book, key, entry, picked, 'settings');
    return entry;
}

// 定点名单：对齐 Novel Auto Generator 的世界书命名，匹配名字与主要关键词。
// 条目名常见形态：`主角:爱芮`、`角色 - 雷电将军`、`波可娜·费雷尼 (Pulchra Fellini)`，
// 尾巴偶尔带 `〔2 楼 · 回复 211/247〕` 这类元数据，比较前都要剥掉。
export const BUILTIN_CATEGORIES = Object.freeze(['角色', '主角', '配角', '地点', '组织', '道具', '玩法', '章节剧情', '角色内心', '剧情大纲', '文风配置']);
const BUILTIN_WORK_PREFIXES = new Set(['原神', 'genshin', 'genshinimpact']);
const OPEN_BRACKETS = '(（[［{｛【〔〖「『《〈<＜';
const CLOSE_BRACKETS = ')）]］}｝】〕〗」』》〉>＞';

export function unifyName(value) {
    let text = '';
    for (const character of String(value ?? '').normalize('NFKC')) {
        if (OPEN_BRACKETS.includes(character)) text += '(';
        else if (CLOSE_BRACKETS.includes(character)) text += ')';
        else text += character;
    }
    return text.toLowerCase();
}

/** 去掉标点、符号、空格与间隔号，保留字母、数字和汉字（与生成器 compact 一致）。 */
export function compactName(value) {
    return unifyName(value).replace(/[\p{P}\p{S}\p{Cf}\p{Z}\s]+/gu, '');
}

export function workKeysOf(workNames) {
    return [...new Set((Array.isArray(workNames) ? workNames : []).map(compactName).filter(Boolean))].sort((a, b) => b.length - a.length);
}

function splitBrackets(value) {
    let text = '';
    for (const character of String(value ?? '').normalize('NFKC')) {
        if (OPEN_BRACKETS.includes(character)) text += '(';
        else if (CLOSE_BRACKETS.includes(character)) text += ')';
        else text += character;
    }
    let outside = '', current = '', depth = 0;
    const groups = [];
    for (const character of text) {
        if (character === '(') { if (depth > 0) current += character; depth++; }
        else if (character === ')' && depth > 0) {
            depth--;
            if (depth === 0) { groups.push(current); current = ''; }
            else current += character;
        } else if (depth > 0) current += character;
        else outside += character;
    }
    if (depth > 0) outside += current;
    return { outside, groups };
}

/** 拆成「作品名 + 角色名 +（形态）」；只去掉已登记的作品名，括号里的内容保留为备注。 */
export function parseScopedName(value, workKeys = []) {
    const { outside, groups } = splitBrackets(value);
    const workSet = new Set(workKeys);
    const compacted = groups.map(compactName).filter(Boolean);
    const notes = compacted.filter(note => !workSet.has(note));
    let work = compacted.find(note => workSet.has(note)) || '';
    let role = compactName(outside);
    for (const key of workKeys) {
        if (role.length > key.length && role.startsWith(key)) { role = role.slice(key.length); work ||= key; break; }
    }
    if (workSet.has(role)) { work ||= role; role = ''; }
    if (!role && notes.length) role = notes.shift();
    return { role, notes, key: role + notes.join(''), work };
}

/** 生成器的条目名带前缀：`主角:爱芮`、`角色 - 雷电将军`。取回名字本身。 */
export function splitCategoryPrefix(comment, workKeys = []) {
    const text = String(comment ?? '').trim();
    if (!text) return '';
    const categories = new Set(BUILTIN_CATEGORIES);
    const knownPrefix = left => {
        const key = compactName(left);
        return categories.has(left) || BUILTIN_WORK_PREFIXES.has(key) || workKeys.includes(key);
    };
    // 冒号前缀只在左侧是已知分类或作品名时剥离。
    // 条目本身导出的是纯名字，所以不猜：`Re:Zero` 这类名字保持完整。
    for (const separator of [':', '：']) {
        const at = text.indexOf(separator);
        if (at <= 0) continue;
        const left = text.slice(0, at).trim(), right = text.slice(at + 1).trim();
        if (right && knownPrefix(left)) return right;
    }
    const spaced = text.indexOf(' - ');
    if (spaced > 0) {
        const right = text.slice(spaced + 3).trim();
        if (right) return right;
    }
    for (const separator of ['-', '—', '·', '・']) {
        const at = text.indexOf(separator);
        if (at <= 0) continue;
        const left = text.slice(0, at).trim(), right = text.slice(at + separator.length).trim();
        if (!right) continue;
        if (knownPrefix(left)) return right;
    }
    return '';
}

/** 供展示/复制用的条目名：去掉分类前缀和「〔2 楼 · 回复 211/247〕」这类元数据。 */
export function cleanEntryName(comment, workKeys = []) {
    const base = splitCategoryPrefix(comment, workKeys) || String(comment ?? '').trim();
    if (!base) return '';
    const { outside, groups } = splitBrackets(base);
    const aliases = groups.filter(group => !/\d/.test(group)).map(group => '(' + group + ')');
    const text = (outside.trim() + (aliases.length ? ' ' + aliases.join(' ') : '')).trim();
    return text || String(comment ?? '').trim();
}

/** 一个名字的全部写法：主名 + 括号里非数字的别名段（英文名、曾用名）。 */
function labelVariants(text) {
    const variants = new Set();
    const { outside, groups } = splitBrackets(text);
    const main = compactName(outside);
    if (main) variants.add(main);
    for (const group of groups) {
        if (/\d/.test(group)) continue;
        for (const part of group.split(/[\/／|｜]+/)) {
            const key = compactName(part);
            if (key) variants.add(key);
        }
    }
    return variants;
}

function nameWithoutPrefixes(name, workKeys) {
    let base = name, suffix;
    while ((suffix = splitCategoryPrefix(base, workKeys))) base = suffix;
    return base;
}

function exactNameKeys(name, workKeys) {
    const base = nameWithoutPrefixes(name, workKeys);
    return [...labelVariants(base), parseScopedName(base, workKeys).key, compactName(name)].filter(Boolean);
}

// 带间隔号的中文全名可以用首段查找。完整姓名之间仍按各自全名比较。
function shortNameKey(name, workKeys) {
    const base = nameWithoutPrefixes(name, workKeys);
    const { outside } = splitBrackets(base);
    const match = outside.trim().match(/^([\p{Script=Han}]{2,3})\s*[·・‧]\s*\p{Script=Han}{2,}(?:\s*[·・‧]\s*\p{Script=Han}{2,})*$/u);
    return match?.[1] || '';
}

/** 条目可用于精确比较的键：完整名、去前缀的主名、括号里的别名和主要关键词。 */
export function entryNameCandidates(entry, workKeys = []) {
    const candidates = new Set();
    const sources = [];
    if (typeof entry?.comment === 'string' && entry.comment.trim()) sources.push(entry.comment);
    for (const key of (Array.isArray(entry?.key) ? entry.key : [])) {
        if (typeof key === 'string' && key.trim()) sources.push(key);
    }
    for (const source of sources) {
        for (const key of exactNameKeys(source, workKeys)) candidates.add(key);
    }
    return candidates;
}

/** 命中返回匹配方式，未命中返回空串。只比名字，不做包含匹配。 */
export function scopeMatch(entry, names, workKeys = []) {
    if (!names?.length || !entry) return '';
    const candidates = entryNameCandidates(entry, workKeys);
    if (!candidates.size) return '';
    const shortTitle = shortNameKey(entry.comment, workKeys);
    for (const raw of names) {
        const keys = exactNameKeys(raw, workKeys);
        if (keys.some(key => candidates.has(key))) return '名称一致';
        const shortQuery = shortNameKey(raw, workKeys);
        if ((shortTitle && keys.includes(shortTitle)) || (shortQuery && shortQuery !== shortTitle && candidates.has(shortQuery))) return '简称匹配';
    }
    return '';
}

/** 名单支持作品别名、分隔符拆分，以及整行 JSON 字符串字面名。 */
export function parseNameList(text, { includeGroups = false } = {}) {
    const groups = [], works = [];
    for (const line of String(text ?? '').split(/[\n\r]+/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('"')) {
            try {
                const literal = JSON.parse(trimmed);
                if (typeof literal === 'string') {
                    if (literal.trim()) groups.push([literal.trim()]);
                    continue;
                }
            } catch { /* 按普通名单行处理。 */ }
        }
        const declared = trimmed.match(/^(?:作品别名|作品|work)\s*[:：]\s*(.+)$/i);
        if (declared) {
            for (const group of declared[1].split(/[、,，;；]/)) {
                for (const alias of group.split('=')) if (alias.trim()) works.push(alias.trim());
            }
            continue;
        }
        for (const item of trimmed.split(/[、,，;；|｜]+/)) {
            const aliases = item.split(/[=＝]+/).map(name => name.trim()).filter(Boolean);
            if (aliases.length) groups.push(aliases);
        }
    }
    const result = { names: [...new Set(groups.flat())], works: [...new Set(works)] };
    return includeGroups ? { ...result, groups } : result;
}

function rosterIndex(book, workKeys, includeKeywords = true) {
    const exact = new Map(), short = new Map();
    const add = (index, key, id) => {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(id);
    };
    for (const [id, entry] of Object.entries(book.entries)) {
        const names = includeKeywords ? entry : { comment: entry.comment };
        for (const key of entryNameCandidates(names, workKeys)) add(exact, key, id);
        const shortTitle = shortNameKey(entry.comment, workKeys);
        if (shortTitle) add(short, shortTitle, id);
    }
    return { exact, short };
}

function rosterHits(index, keys, shortKeys = []) {
    const hits = new Set();
    for (const key of new Set(keys)) {
        for (const id of index.exact.get(key) || []) hits.add(id);
        for (const id of index.short.get(key) || []) hits.add(id);
    }
    for (const key of new Set(shortKeys)) {
        const fullNames = new Set(index.short.get(key));
        for (const id of index.exact.get(key) || []) if (!fullNames.has(id)) hits.add(id);
    }
    return hits;
}

export function buildRosterUpdate(oldBook, newBook, groups, mode, {
    workKeys = [], manualPairs = [], unpairedOld = new Set(), unpairedNew = new Set(),
} = {}) {
    const sourceIndex = rosterIndex(newBook, workKeys);
    const targetIndex = rosterIndex(oldBook, workKeys);
    const targetTitles = rosterIndex(oldBook, workKeys, false);
    const targetSignatures = new Set(Object.values(oldBook.entries).map(keySignature).filter(Boolean));
    const sourceSignatureCounts = new Map();
    for (const source of Object.values(newBook.entries)) {
        const signature = keySignature(source);
        if (signature) sourceSignatureCounts.set(signature, (sourceSignatureCounts.get(signature) || 0) + 1);
    }
    const overrides = new Map(manualPairs.map(pair => [pair.newId, pair.oldId]));
    const manualOwners = new Map(manualPairs.map(pair => [pair.oldId, pair.newId]));
    const entries = new Map(), review = [], missing = [];
    for (const aliases of groups) {
        const name = aliases.join(' / ');
        const keys = aliases.flatMap(alias => exactNameKeys(alias, workKeys));
        const shortKeys = aliases.map(alias => shortNameKey(alias, workKeys)).filter(Boolean);
        const sources = rosterHits(sourceIndex, keys, shortKeys);
        if (!sources.size) { missing.push(name); continue; }
        if (sources.size > 1) { review.push(`${name}（母本有多个匹配条目）`); continue; }
        const newId = sources.values().next().value;
        if (!entries.has(newId)) entries.set(newId, { name, keys: new Set(), shortKeys: new Set() });
        for (const key of keys) entries.get(newId).keys.add(key);
        for (const key of shortKeys) entries.get(newId).shortKeys.add(key);
    }

    const matched = [], additions = [], claims = new Map();
    for (const [newId, item] of entries) {
        const source = newBook.entries[newId];
        const sourceShort = shortNameKey(source.comment, workKeys);
        // Once a full name is resolved, its short form can find a bare title but never another full name.
        const shortKeys = new Set(item.shortKeys);
        if (sourceShort) shortKeys.add(sourceShort);
        const keys = [...item.keys, ...entryNameCandidates({ comment: source.comment }, workKeys)].filter(key => !shortKeys.has(key));
        const namedTargets = rosterHits(targetTitles, keys, shortKeys);
        // A source keyword matching a target title is evidence of a possible alias.
        const keywordKeys = [...entryNameCandidates({ key: source.key }, workKeys)].filter(key => !shortKeys.has(key));
        for (const oldId of rosterHits(targetTitles, keywordKeys)) namedTargets.add(oldId);
        const targets = rosterHits(targetIndex, keys, shortKeys);
        for (const oldId of namedTargets) targets.add(oldId);
        if (overrides.has(newId)) {
            targets.clear();
            targets.add(overrides.get(newId));
        }
        if (unpairedNew.has(newId) || [...targets].some(id => unpairedOld.has(id))) {
            review.push(`${item.name}（已手动解除配对）`);
        } else if ([...targets].some(id => manualOwners.has(id) && manualOwners.get(id) !== newId)) {
            review.push(`${item.name}（目标条目已有其他手动配对）`);
        } else if (targets.size > 1) {
            review.push(`${item.name}（目标书有多个匹配条目）`);
        } else if (!targets.size) {
            const signature = keySignature(source);
            if (sourceSignatureCounts.get(signature) === 1 && targetSignatures.has(signature)) {
                review.push(`${item.name}（目标书有主关键词完全相同、标题不同的条目）`);
            } else additions.push(newId);
        } else {
            const oldId = targets.values().next().value;
            if (!overrides.has(newId) && !namedTargets.has(oldId) && oldBook.entries[oldId].comment?.trim()) {
                review.push(`${item.name}（目标条目只有关键词命中，标题不同）`);
                continue;
            }
            matched.push({ oldId, newId, checked: true });
            claims.set(oldId, (claims.get(oldId) || 0) + 1);
        }
    }

    const pairs = matched.filter(pair => {
        if (claims.get(pair.oldId) === 1) return true;
        review.push(`${entries.get(pair.newId).name}（与另一角色匹配到同一目标条目）`);
        return false;
    });
    const replace = [], unchanged = [];
    for (const pair of pairs) {
        const names = pairChanged(oldBook, newBook, pair, mode) ? replace : unchanged;
        names.push(entries.get(pair.newId).name);
    }
    const result = buildUpdate(oldBook, newBook, pairs, mode, { merge: true, additions, approvedNew: additions });
    return {
        result, replace, unchanged, review, missing,
        copy: result.addedPairs.map(pair => entries.get(pair.newId).name),
    };
}

export function scopedEntries(book, names, workKeys = []) {
    if (!names?.length || !book) return [];
    return Object.entries(book.entries).filter(([, entry]) => scopeMatch(entry, names, workKeys)).map(([id]) => id);
}

export function unmatchedNames(book, names, workKeys = []) {
    if (!names?.length || !book) return [...(names || [])];
    return names.filter(name => !Object.values(book.entries).some(entry => scopeMatch(entry, [name], workKeys)));
}

/**
 * 显示用排序：把 blockIds 按给定顺序排到最前，其余条目保持原有顺序。
 * 只影响插件列表的显示，不写回世界书；名单清空或匹配断开即恢复原顺序。
 */
/**
 * 置顶块：已配对的条目，加上（有定点名单时）名单命中的条目，顺序按 entries 的现有顺序。
 * 名单为空时只认配对，不能把整本都当成命中。
 */
export function pinBlock(entries, pairs, side, scopedIds = []) {
    const scoped = new Set((scopedIds || []).map(String));
    const pairByNew = new Map((pairs || []).map(pair => [String(pair.newId), pair]));
    const block = [];
    for (const { id } of entries) {
        const pair = pairByNew.get(String(id));
        if (!pair && !scoped.has(String(id))) continue;
        if (side === 'new') block.push(String(id));
        else if (pair) block.push(String(pair.oldId));
    }
    return block;
}

export function orderWithPinned(entries, blockIds) {
    const rank = new Map();
    for (const id of blockIds) {
        const key = String(id);
        if (!rank.has(key)) rank.set(key, rank.size);
    }
    return entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => {
            const left = rank.has(String(a.entry.id)) ? rank.get(String(a.entry.id)) : Number.POSITIVE_INFINITY;
            const right = rank.has(String(b.entry.id)) ? rank.get(String(b.entry.id)) : Number.POSITIVE_INFINITY;
            if (left === right) return a.index - b.index;
            return left - right;
        })
        .map(item => item.entry);
}

// 名单只限制来源范围；与整本匹配共用相同的身份和冲突判定。
export function autoMatchScoped(oldBook, newBook, names, workKeys = []) {
    if (!names?.length) return autoMatch(oldBook, newBook);
    return matchEntries(oldBook, newBook, entry => scopeMatch(entry, names, workKeys));
}
