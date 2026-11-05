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

export function autoMatch(oldBook, newBook) {
    validateBook(oldBook); validateBook(newBook);
    const titles = new Map(), keys = new Map();
    function index(map, key, id) {
        if (!key) return;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(id);
    }
    for (const [id, entry] of Object.entries(oldBook.entries)) {
        index(titles, entry.comment?.trim(), id);
        index(keys, keySignature(entry), id);
    }
    const proposals = [], claims = new Map(), resolutions = new Map();
    for (const [id, entry] of Object.entries(newBook.entries)) {
        const name = entry.comment?.trim() || '', signature = keySignature(entry);
        const combination = JSON.stringify([name, signature]);
        if (!resolutions.has(combination)) {
            const byTitle = titles.get(name), byKey = keys.get(signature);
            let oldId = null;
            if (byTitle?.size && byKey?.size) {
                const [small, large] = byTitle.size <= byKey.size ? [byTitle, byKey] : [byKey, byTitle];
                // Only uniqueness matters. Stop at two matches; never build a cross-product.
                for (const candidate of small) if (large.has(candidate)) {
                    if (oldId !== null) { oldId = null; break; }
                    oldId = candidate;
                }
            } else {
                const only = byTitle?.size ? byTitle : byKey;
                if (only?.size === 1) oldId = only.values().next().value;
            }
            resolutions.set(combination, { oldId, reason: byTitle?.size && byKey?.size ? '标题与关键词' : byTitle?.size ? '标题相同' : '关键词相同' });
        }
        const resolved = resolutions.get(combination);
        if (resolved.oldId === null) continue;
        proposals.push({ oldId: resolved.oldId, newId: id, checked: true, reason: resolved.reason });
        claims.set(resolved.oldId, (claims.get(resolved.oldId) || 0) + 1);
    }
    return proposals.filter(pair => claims.get(pair.oldId) === 1);
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
    const result = new Map(), paired = new Set(pairs.map(p => p.newId));
    const oldTitles = new Set(), oldKeys = new Set(), signatures = new Set();
    for (const entry of Object.values(oldBook.entries)) {
        if (entry.comment?.trim()) oldTitles.add(entry.comment.trim());
        for (const key of entry.key || []) if (key.trim()) oldKeys.add(key.trim());
        signatures.add(entrySignature(entry));
    }
    const identityCounts = new Map();
    for (const entry of Object.values(newBook.entries)) {
        const identity = JSON.stringify([entry.comment?.trim() || '', keySignature(entry)]);
        if (!identityCounts.has(identity)) identityCounts.set(identity, new Set());
        identityCounts.get(identity).add(entrySignature(entry));
    }
    for (const [id, entry] of Object.entries(newBook.entries)) {
        const name = entry.comment?.trim() || '', keys = (entry.key || []).map(x => x.trim()).filter(Boolean);
        const signature = entrySignature(entry);
        let state;
        if (paired.has(id)) state = 'paired';
        else if (signatures.has(signature)) state = 'duplicate';
        else if ((!name && !keys.length) || oldTitles.has(name) || keys.some(k => oldKeys.has(k)) || identityCounts.get(JSON.stringify([name, keySignature(entry)])).size > 1) state = 'review';
        else state = 'new';
        result.set(id, state);
        // Identical incoming copies are represented once, never added twice by bulk selection.
        signatures.add(signature);
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
    original.content = entry.content;
    if (mode === 'content') return;
    for (const [key, dest] of Object.entries(originalFields)) if (own(source, key)) original[dest] = clone(entry[key]);
    if (record(entry.extensions)) original.extensions = merge(original.extensions || {}, entry.extensions);
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
    const additions = options.additions || [];
    if (additions.length && !options.merge) throw new Error('请切换到融合模式后再新增条目。');
    let updated = 0, skipped = 0, added = 0;
    for (const pair of pairs) {
        const { oldId, newId } = pair;
        if (!own(oldBook.entries, oldId) || !own(newBook.entries, newId)) throw new Error('配对中的条目不存在，请重新载入世界书。');
        if (usedOld.has(oldId) || usedNew.has(newId)) throw new Error('配对重复，已停止替换。');
        usedOld.add(oldId); usedNew.add(newId);
        if (!pair.checked) continue;
        const oldEntry = oldBook.entries[oldId], source = newBook.entries[newId];
        const entry = replacement(oldEntry, source, mode);
        if (canonical(entry) === canonical(oldEntry)) { skipped++; continue; }
        next.entries[oldId] = entry;
        syncOriginal(next, oldId, entry, source, mode);
        updated++;
    }
    const addedPairs = [];
    if (options.merge && additions.length) {
        const states = classifyIncoming(oldBook, newBook, pairs), approved = new Set(options.approvedNew || []);
        const seen = new Set(Object.values(next.entries).map(entrySignature)), requested = new Set(), used = new Set(Object.keys(next.entries));
        const portableSources = new Map((Array.isArray(newBook.originalData?.entries) ? newBook.originalData.entries : []).map(entry => [String(entry.id ?? entry.uid), entry]));
        let uid = 0;
        let total = used.size;
        let displayIndex = Math.ceil(Object.entries(next.entries).reduce((m, [id, entry]) => Math.max(m, Number.isFinite(entry.displayIndex) ? entry.displayIndex : Number(id)), -1));
        for (const newId of additions) {
            if (!own(newBook.entries, newId)) throw new Error('待新增条目已不存在，请重新载入。');
            if (requested.has(newId)) throw new Error('新增条目被重复选择，已停止融合。');
            requested.add(newId);
            if (usedNew.has(newId)) throw new Error('已配对条目不能同时作为新条目加入，请先解除配对。');
            if (states.get(newId) === 'review' && !approved.has(newId)) throw new Error('存在待处理条目，请先配对或标记为新增。');
            const source = newBook.entries[newId], signature = entrySignature(source);
            if (states.get(newId) === 'duplicate' || seen.has(signature)) { skipped++; continue; }
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
