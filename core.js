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

function isSingleName(name, workKeys) {
    const primary = compoundTitleNames(name, workKeys)[0] ?? nameWithoutPrefixes(name, workKeys);
    const { outside } = splitBrackets(primary);
    return /^\p{Script=Han}$/u.test(compactName(outside));
}

function corroboratingKeyword(key, workKeys) {
    return [...compactName(key)].length > 1 && !isSingleName(key, workKeys);
}

function sharedPrimaryKeyword(source, target, workKeys, single = false) {
    const keys = entry => {
        const exact = new Set(), shortened = new Set();
        for (const raw of entry.key || []) {
            const key = toSimplified(raw.trim());
            if (key && (!single || corroboratingKeyword(key, workKeys))) exact.add(key);
            if (single || !key) continue;
            const [first] = compoundTitleNames(key, workKeys);
            if (first) for (const alias of exactNameKeys(first, workKeys)) exact.add(alias);
            const short = shortNameKey(key, workKeys);
            if (short && !isSingleName(short, workKeys)) shortened.add(short);
            if (/^\p{Script=Han}+$/u.test(key)) exact.add(CHARACTER_NAME_VARIANTS.get(key) ?? key);
        }
        return { exact, shortened };
    };
    const a = keys(source), b = keys(target);
    return [...a.exact].some(key => b.exact.has(key) || b.shortened.has(key))
        || [...a.shortened].some(key => b.exact.has(key));
}

function singleNamePair(source, target, workKeys) {
    return isSingleName(source.comment, workKeys) || isSingleName(target.comment, workKeys);
}

function hasPairEvidence(source, target, workKeys) {
    const single = singleNamePair(source, target, workKeys);
    if (sharedPrimaryKeyword(source, target, workKeys, single)) return true;
    if (single || (keySignature(source) && keySignature(target))) return false;
    return !!source.comment?.trim() && source.comment.trim() === target.comment?.trim();
}

function matchEntries(oldBook, newBook, inScope, workKeys = []) {
    validateBook(oldBook); validateBook(newBook);
    const titles = new Map(), signatures = new Map();
    function uniqueSignatureOwner(entry, owners) {
        if (owners?.size !== 1) return null;
        const [id] = owners;
        return compatibleEntryWorks(entry, oldBook.entries[id], workKeys) ? id : null;
    }
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
            const group = titles.get(name), single = isSingleName(name, workKeys);
            if (group && single) continue;
            const sourceKeys = (signature ? JSON.parse(signature) : []).filter(key => !single || corroboratingKeyword(key, workKeys));
            const byKey = sourceKeys.length ? signatures.get(signature) : undefined;
            const partialScore = (candidate, overlap) => 3 + overlap / (1 + Math.max(sourceKeys.length, group.sizes.get(candidate)));
            let oldId = null, score = 0, exactTie = false;
            if (group) {
                const signatureOwner = uniqueSignatureOwner(entry, byKey);
                const conflict = signatureOwner !== null && !group.ids.has(signatureOwner);
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
                    const missingKeys = !single && (!sourceKeys.length || !group.sizes.get(candidate));
                    // A complete signature elsewhere conflicts with a partial link to this title.
                    if ((!conflict && overlap) || missingKeys) {
                        oldId = candidate; score = overlap ? partialScore(candidate, overlap) : 2;
                    }
                } else if (!score && !exactTie && !conflict && group.ids.size > 1 && signature) {
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
                const candidate = byKey.values().next().value;
                const targetName = oldBook.entries[candidate].comment;
                const sufficient = !isSingleName(targetName, workKeys) || sourceKeys.some(key => corroboratingKeyword(key, workKeys));
                if (sufficient && (!name || !targetName?.trim())) { oldId = candidate; score = 2; }
            }
            resolutions.set(combination, { oldId, score, reason: score >= 3 ? '标题与关键词' : group ? '标题相同' : '关键词相同' });
        }
        const resolved = resolutions.get(combination);
        if (resolved.oldId === null) continue;
        const current = winners.get(resolved.oldId);
        if (!current || resolved.score > current.score) winners.set(resolved.oldId, { ...resolved, newId: id });
        else if (resolved.score === current.score) winners.set(resolved.oldId, { ...current, newId: null });
    }
    const pairs = [...winners.values()].filter(winner => winner.newId !== null)
        .map(({ oldId, newId, reason }) => ({ oldId, newId, checked: true, reason }));
    const usedOld = new Set(pairs.map(pair => pair.oldId)), usedNew = new Set(pairs.map(pair => pair.newId));
    const remaining = Object.entries(newBook.entries).filter(([id, entry]) => entry.comment?.trim() && !usedNew.has(id) && (!inScope || inScope(entry)));
    if (!remaining.length || usedOld.size === Object.keys(oldBook.entries).length) return pairs;

    const sourceTitles = rosterIndex(newBook, workKeys, { target: true, includeKeywords: false });
    const targetTitles = rosterIndex(oldBook, workKeys, { target: true, includeKeywords: false });
    for (const [newId, source] of remaining) {
        const targets = [...titleMatches(targetTitles, source.comment, workKeys)].filter(id => {
            const target = oldBook.entries[id];
            return compatibleEntryWorks(source, target, workKeys)
                && (!singleNamePair(source, target, workKeys) || hasPairEvidence(source, target, workKeys));
        });
        if (targets.length !== 1) continue;
        const [oldId] = targets;
        const target = oldBook.entries[oldId];
        if (usedOld.has(oldId) || !hasPairEvidence(source, target, workKeys)) continue;
        const signatureOwner = uniqueSignatureOwner(source, signatures.get(keySignature(source)));
        if (signatureOwner !== null && signatureOwner !== oldId) continue;
        const sources = [...titleMatches(sourceTitles, target.comment, workKeys)].filter(id => {
            const candidate = newBook.entries[id];
            return compatibleEntryWorks(candidate, target, workKeys)
                && (!singleNamePair(candidate, target, workKeys) || hasPairEvidence(candidate, target, workKeys));
        });
        if (sources.length !== 1 || sources[0] !== newId) continue;
        pairs.push({ oldId, newId, checked: true, reason: '名称与主关键词一致' });
        usedOld.add(oldId);
    }
    return pairs;
}

export function autoMatch(oldBook, newBook, workKeys = []) {
    return matchEntries(oldBook, newBook, null, workKeys);
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

function isStandaloneShortTitle(title, fullTitle, workKeys) {
    const name = fullNameKey(title, workKeys);
    return /^\p{Script=Han}$/u.test(name) && name === shortNameKey(fullTitle, workKeys);
}

export function classifyIncoming(oldBook, newBook, pairs = [], reviewTargets, reviewReasons, workKeys = []) {
    const result = new Map(), paired = new Set(pairs.map(p => String(p.newId)));
    const primaryNames = new Map(), signatures = new Map();
    const add = (index, key, id) => {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(id);
    };
    for (const [id, entry] of Object.entries(oldBook.entries)) {
        const signature = keySignature(entry);
        if (signature) add(signatures, signature, id);
        for (const key of entry.key || []) {
            if (corroboratingKeyword(key, workKeys) && !/[\\^$*+?\[\]{}|/]/u.test(key)) {
                add(primaryNames, fullNameKey(key, workKeys), id);
            }
        }
    }
    const identityCounts = new Map();
    const targetTitles = rosterIndex(oldBook, workKeys, { target: true, includeKeywords: false });
    for (const entry of Object.values(newBook.entries)) {
        const identity = JSON.stringify([entry.comment?.trim() || '', keySignature(entry)]);
        identityCounts.set(identity, (identityCounts.get(identity) || 0) + 1);
    }
    for (const [id, entry] of Object.entries(newBook.entries)) {
        if (paired.has(id)) { result.set(id, 'paired'); continue; }
        const name = entry.comment?.trim() || '', signature = keySignature(entry);
        const unconfirmedShortNames = new Set();
        const targets = new Set(name ? [...titleMatches(targetTitles, name, workKeys)].filter(targetId => {
            const target = oldBook.entries[targetId];
            if (!singleNamePair(entry, target, workKeys) || (isSingleName(name, workKeys) && isSingleName(target.comment, workKeys))
                || sharedPrimaryKeyword(entry, target, workKeys, true)) return true;
            if (!isStandaloneShortTitle(name, target.comment, workKeys) && !isStandaloneShortTitle(target.comment, name, workKeys)) return false;
            unconfirmedShortNames.add(targetId);
            return true;
        }) : []);
        const fullName = fullNameKey(name, workKeys);
        if (corroboratingKeyword(fullName, workKeys)) {
            for (const targetId of primaryNames.get(fullName) || []) targets.add(targetId);
        }
        if (entry.key?.some(key => corroboratingKeyword(key, workKeys))) {
            for (const targetId of signatures.get(signature) || []) {
                if (!name || !oldBook.entries[targetId].comment?.trim()) targets.add(targetId);
            }
        }
        for (const targetId of targets) {
            if (!compatibleEntryWorks(entry, oldBook.entries[targetId], workKeys)) targets.delete(targetId);
        }
        const duplicate = identityCounts.get(JSON.stringify([name, signature])) > 1;
        const unnamed = !name && !signature;
        result.set(id, targets.size || duplicate || unnamed ? 'review' : 'new');
        if (reviewReasons && targets.size) {
            const examples = new Set([...targets].slice(0, 2).map(targetId => title(oldBook.entries[targetId])));
            const shortReason = [...targets].some(targetId => unconfirmedShortNames.has(targetId)) ? '单字简称缺少主关键词佐证 · ' : '';
            reviewReasons.set(id, `${shortReason}目标书候选 ${targets.size} 条（${[...examples].join('、')}${targets.size > 2 ? '等' : ''}）`);
        } else if (reviewReasons && unnamed) reviewReasons.set(id, '母本缺少标题和主关键词');
        else if (reviewReasons && duplicate) reviewReasons.set(id, '母本有重名且主关键词相同的条目');
        if (reviewTargets) for (const targetId of targets) reviewTargets.add(targetId);
    }
    return result;
}

/** Reuse title matching, with stricter evidence for the entries offered for removal. */
export function consolidationCandidates(oldBook, newBook, newId, workKeys = []) {
    const source = newBook?.entries?.[newId];
    const sourceName = fullNameKey(source?.comment, workKeys);
    if (!oldBook || !sourceName) return [];
    const index = rosterIndex(oldBook, workKeys, { includeKeywords: false });
    const titleCandidates = titleMatches(index, source.comment, workKeys);
    const compoundSource = compoundTitleNames(source.comment, workKeys).length;
    return listEntries(oldBook).filter(({ id, entry }) => {
        if (!titleCandidates.has(id) || !compatibleEntryWorks(source, entry, workKeys)) return false;
        if (sourceName === fullNameKey(entry.comment, workKeys)) return true;
        // Treat a joint entry as distinct when it contains another person's name.
        return !compoundSource && !compoundTitleNames(entry.comment, workKeys).length
            && sharedPrimaryKeyword(source, entry, workKeys, singleNamePair(source, entry, workKeys));
    }).map(({ id }) => id);
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
    position: 'position', depth: 'depth', role: 'role',
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
    const original = givenOriginal || book.originalData.entries.find(x => String(x?.id ?? x?.uid) === id);
    if (!original) return;
    if (mode !== 'settings') original.content = entry.content;
    if (mode === 'content') return;
    const displayIndex = own(entry, 'displayIndex') ? entry.displayIndex : original.extensions?.display_index;
    for (const [key, dest] of Object.entries(originalFields)) if (own(source, key)) original[dest] = clone(entry[key]);
    if (mode !== 'settings' && record(entry.extensions)) original.extensions = merge(original.extensions || {}, entry.extensions);
    for (const [key, dest] of Object.entries(extensionFields)) if (own(source, key)) {
        if (!record(original.extensions)) original.extensions = {};
        original.extensions[dest] = clone(entry[key]);
    }
    if (mode === 'full') {
        if (displayIndex !== undefined) {
            if (!record(original.extensions)) original.extensions = {};
            original.extensions.display_index = clone(displayIndex);
        } else if (record(original.extensions)) delete original.extensions.display_index;
    }
    if (own(source, 'disable')) original.enabled = !entry.disable;
    if (own(source, 'position')) original.position = entry.position === 0 ? 'before_char' : 'after_char';
}

export function buildUpdate(oldBook, newBook, pairs, mode = 'content', options = {}) {
    validateBook(oldBook); validateBook(newBook);
    if (!['content', 'full'].includes(mode)) throw new Error('未知的替换范围。');
    const next = clone(oldBook), usedOld = new Set(), usedNew = new Set();
    const additions = (options.additions || []).map(String);
    if (additions.length && !options.merge) throw new Error('请切换到融合模式后再新增条目。');
    let updated = 0, skipped = 0, added = 0;
    for (const pair of pairs) {
        const oldId = String(pair.oldId), newId = String(pair.newId);
        if (!own(oldBook.entries, oldId) || !own(newBook.entries, newId)) throw new Error('配对中的条目不存在，请重新载入世界书。');
        if (usedOld.has(oldId) || usedNew.has(newId)) throw new Error('配对重复，已停止替换。');
        usedOld.add(oldId); usedNew.add(newId);
        if (pair.checked !== true) continue;
        const oldEntry = oldBook.entries[oldId], source = newBook.entries[newId];
        const entry = replacement(oldEntry, source, mode);
        if (canonical(entry) === canonical(oldEntry)) { skipped++; continue; }
        next.entries[oldId] = entry;
        syncOriginal(next, oldId, entry, source, mode);
        updated++;
    }
    const addedPairs = [];
    if (options.merge && additions.length) {
        const states = classifyIncoming(oldBook, newBook, pairs, undefined, undefined, options.workKeys);
        const approved = new Set((options.approvedNew || []).map(String));
        const seen = new Set(Object.values(next.entries).map(entrySignature)), requested = new Set(), used = new Set(Object.keys(next.entries));
        if (Array.isArray(next.originalData?.entries)) for (const entry of next.originalData.entries) {
            for (const id of [entry?.id, entry?.uid]) if (id !== undefined && /^(0|[1-9]\d*)$/.test(String(id))) used.add(String(id));
        }
        const sourceMirrors = Array.isArray(newBook.originalData?.entries) ? newBook.originalData.entries : [];
        const portableSources = new Map(sourceMirrors.filter(record).map(entry => [String(entry.id ?? entry.uid), entry]));
        let uid = 0;
        let total = Object.keys(next.entries).length;
        let displayIndex = Math.ceil(Object.entries(next.entries).reduce((m, [id, entry]) => Math.max(m, Number.isFinite(entry.displayIndex) ? entry.displayIndex : Number(id)), -1));
        for (const newId of additions) {
            if (!own(newBook.entries, newId)) throw new Error('待新增条目已不存在，请重新载入。');
            if (requested.has(newId)) throw new Error('新增条目被重复选择，已停止融合。');
            requested.add(newId);
            if (usedNew.has(newId)) throw new Error('已配对条目不能同时作为新条目加入，请先解除配对。');
            if (states.get(newId) === 'review' && !approved.has(newId)) throw new Error('存在待处理条目，请先配对或标记为新增。');
            const source = newBook.entries[newId], signature = entrySignature(source);
            if (seen.has(signature)) { skipped++; continue; }
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

function matchedSelection(oldBook, newBook, sourceId, targetIds, workKeys) {
    validateBook(oldBook); validateBook(newBook);
    const isEntryId = id => typeof id === 'string' || typeof id === 'number';
    if (![sourceId, ...targetIds].every(isEntryId)) throw new Error('所选条目编号不正确。');
    const newId = String(sourceId), oldIds = targetIds.map(String);
    if (new Set(oldIds).size !== oldIds.length) throw new Error('所选目标书条目不可重复。');
    if (!own(newBook.entries, newId) || !oldIds.every(id => own(oldBook.entries, id))) {
        throw new Error('所选条目已不存在，请重新载入。');
    }
    const candidates = new Set(consolidationCandidates(oldBook, newBook, newId, workKeys));
    if (!oldIds.every(id => candidates.has(id))) {
        throw new Error('所选条目中存在无法确认与母本同一身份的记录，请重新核对。');
    }
    return { newId, oldIds };
}

function removeMatchedTargets(data, removedOldIds) {
    const removals = new Set(removedOldIds);
    for (const id of removals) delete data.entries[id];
    if (Array.isArray(data.originalData?.entries)) {
        data.originalData.entries = data.originalData.entries.filter(entry => {
            const ids = [entry?.id, entry?.uid].filter(id => id != null).map(String);
            if (!ids.some(id => removals.has(id))) return true;
            if (ids.some(id => own(data.entries, id))) throw new Error('世界书导出记录的编号相互冲突，无法安全移除条目。');
            return false;
        });
    }
    return { data: validateBook(data), removed: removals.size, removedOldIds };
}

export function buildConsolidation(oldBook, newBook, group, mode = 'content', workKeys = []) {
    const { newId: sourceId, oldId: retainedId, duplicateOldIds } = group ?? {};
    if (!Array.isArray(duplicateOldIds) || !duplicateOldIds.length) throw new Error('请至少选择一条要移除的目标书重复条目。');
    const { newId, oldIds } = matchedSelection(oldBook, newBook, sourceId, [retainedId, ...duplicateOldIds], workKeys);
    const [oldId, ...removedOldIds] = oldIds;
    const { data, updated, skipped } = buildUpdate(oldBook, newBook, [{ oldId, newId, checked: true }], mode);
    return { ...removeMatchedTargets(data, removedOldIds), updated, skipped, oldId, newId };
}

export function planBatchConsolidation(oldBook, newBook, {
    workKeys = [], scopeNames = [], pairs = [],
} = {}) {
    validateBook(oldBook); validateBook(newBook);
    const pairBySource = new Map((pairs || []).map(pair => [String(pair.newId), String(pair.oldId)]));
    const rawGroups = [];
    const targetClaims = new Map();
    for (const { id: newId, entry } of listEntries(newBook)) {
        if (scopeNames?.length && !scopeMatch(entry, scopeNames, workKeys)) continue;
        const candidates = consolidationCandidates(oldBook, newBook, newId, workKeys);
        if (candidates.length < 2) continue;
        rawGroups.push({ newId, name: title(entry), candidates });
        for (const oldId of candidates) {
            if (!targetClaims.has(oldId)) targetClaims.set(oldId, []);
            targetClaims.get(oldId).push(newId);
        }
    }
    const groups = [], conflicts = [];
    for (const item of rawGroups) {
        const conflicted = item.candidates.some(oldId => targetClaims.get(oldId).length > 1);
        if (conflicted) {
            conflicts.push(`${item.name}（多个母本条目命中同一目标条目，需人工核对）`);
            continue;
        }
        const pairedOld = pairBySource.get(item.newId);
        const oldId = pairedOld && item.candidates.includes(pairedOld) ? pairedOld : item.candidates[0];
        const duplicateOldIds = item.candidates.filter(id => id !== oldId);
        groups.push({ newId: item.newId, name: item.name, oldId, duplicateOldIds });
    }
    return { groups, conflicts };
}

export function buildBatchConsolidation(oldBook, newBook, groups, mode = 'content', workKeys = []) {
    validateBook(oldBook); validateBook(newBook);
    if (!Array.isArray(groups) || !groups.length) throw new Error('没有可批量合并的重复条目。');
    const seenOld = new Set(), seenNew = new Set();
    const pairs = [], allRemoved = [];
    for (const group of groups) {
        const { newId: sourceId, oldId: retainedId, duplicateOldIds } = group ?? {};
        if (!Array.isArray(duplicateOldIds) || !duplicateOldIds.length) throw new Error('批量合并分组缺少待移除的重复条目。');
        const { newId, oldIds } = matchedSelection(oldBook, newBook, sourceId, [retainedId, ...duplicateOldIds], workKeys);
        if (seenNew.has(newId)) throw new Error('母本条目在批量合并中重复出现。');
        seenNew.add(newId);
        for (const id of oldIds) {
            if (seenOld.has(id)) throw new Error('同一目标条目被多个合并分组重复引用，已停止合并。');
            seenOld.add(id);
        }
        const [oldId, ...removedOldIds] = oldIds;
        pairs.push({ oldId, newId, checked: true });
        allRemoved.push(...removedOldIds);
    }
    const { data, updated, skipped } = buildUpdate(oldBook, newBook, pairs, mode);
    return { ...removeMatchedTargets(data, allRemoved), updated, skipped, mergedGroups: groups.length };
}

export function planBatchMatchedDeletion(oldBook, newBook, {
    sourceIds = [], workKeys = [], pairs = [],
} = {}) {
    validateBook(oldBook); validateBook(newBook);
    const ids = [...new Set((sourceIds || []).map(String))];
    if (!ids.length) throw new Error('请先在母本勾选要删除的基准条目，或填写定点名单。');
    const pairBySource = new Map((pairs || []).map(pair => [String(pair.newId), String(pair.oldId)]));
    const groups = [], missing = [], removedSet = new Set();
    for (const newId of ids) {
        if (!own(newBook.entries, newId)) throw new Error('母本基准条目已不存在，请重新载入。');
        const source = newBook.entries[newId];
        const matched = new Set(consolidationCandidates(oldBook, newBook, newId, workKeys));
        const pairedOld = pairBySource.get(newId);
        if (pairedOld && own(oldBook.entries, pairedOld) && compatibleEntryWorks(source, oldBook.entries[pairedOld], workKeys)) {
            matched.add(pairedOld);
        }
        const oldIds = [...matched];
        if (!oldIds.length) {
            missing.push(title(source));
            continue;
        }
        groups.push({ newId, name: title(source), oldIds });
        for (const id of oldIds) removedSet.add(id);
    }
    return { groups, removedOldIds: [...removedSet], missing };
}

export function buildBatchMatchedDeletion(oldBook, newBook, groups, workKeys = []) {
    validateBook(oldBook); validateBook(newBook);
    if (!Array.isArray(groups) || !groups.length) throw new Error('没有可批量删除的目标条目。');
    const removedSet = new Set();
    for (const group of groups) {
        const { newId, oldIds } = group ?? {};
        if (!own(newBook.entries, String(newId))) throw new Error('母本基准条目已不存在，请重新载入。');
        if (!Array.isArray(oldIds) || !oldIds.length) continue;
        for (const id of oldIds) {
            const oldId = String(id);
            if (!own(oldBook.entries, oldId)) throw new Error('待删除的目标条目已不存在，请重新载入。');
            if (!compatibleEntryWorks(newBook.entries[String(newId)], oldBook.entries[oldId], workKeys)) {
                throw new Error('所选条目与母本作品标签不一致，已停止删除。');
            }
            removedSet.add(oldId);
        }
    }
    if (!removedSet.size) throw new Error('没有可批量删除的目标条目。');
    return removeMatchedTargets(clone(oldBook), [...removedSet]);
}

export function planTargetSelfDuplicates(oldBook, { workKeys = [] } = {}) {
    validateBook(oldBook);
    const buckets = new Map();
    for (const { id, entry } of listEntries(oldBook)) {
        const nameKey = fullNameKey(entry.comment, workKeys);
        if (!nameKey) continue;
        const work = explicitEntryWork(entry, workKeys) || '';
        const bucketKey = `${work}\0${nameKey}`;
        if (!buckets.has(bucketKey)) buckets.set(bucketKey, { name: title(entry), ids: [] });
        buckets.get(bucketKey).ids.push(id);
    }
    const groups = [];
    for (const { name, ids } of buckets.values()) {
        if (ids.length < 2) continue;
        groups.push({ name, oldId: ids[0], duplicateOldIds: ids.slice(1) });
    }
    return { groups, removedCount: groups.reduce((sum, g) => sum + g.duplicateOldIds.length, 0) };
}

export function buildTargetSelfConsolidation(oldBook, groups) {
    validateBook(oldBook);
    if (!Array.isArray(groups) || !groups.length) throw new Error('没有可清理的内部重复条目。');
    const retained = new Set(), removed = new Set();
    for (const group of groups) {
        const oldId = String(group?.oldId ?? '');
        if (!own(oldBook.entries, oldId)) throw new Error('待保留的目标条目已不存在，请重新扫描。');
        retained.add(oldId);
        for (const id of group?.duplicateOldIds || []) {
            const dupId = String(id);
            if (!own(oldBook.entries, dupId)) throw new Error('待删除的目标条目已不存在，请重新扫描。');
            if (retained.has(dupId)) throw new Error('同一条目不能同时保留和删除。');
            removed.add(dupId);
        }
    }
    if (!removed.size) throw new Error('没有可清理的内部重复条目。');
    return removeMatchedTargets(clone(oldBook), [...removed]);
}

/** 轻量行级差异对比，返回 [{ type: 'same' | 'del' | 'add', text }]。 */
export function diffLines(oldText, newText) {
    const a = String(oldText ?? '').split(/\r?\n/);
    const b = String(newText ?? '').split(/\r?\n/);
    if (a.length === 1 && b.length === 1 && a[0] === b[0]) return [{ type: 'same', text: a[0] }];
    // 超大文本回退为首尾公共前缀+整体替换，避免手机端 O(N*M) 内存抖动
    if (a.length * b.length > 160000) {
        let head = 0;
        while (head < a.length && head < b.length && a[head] === b[head]) head++;
        let tail = 0;
        while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
        const out = [];
        for (let i = 0; i < head; i++) out.push({ type: 'same', text: a[i] });
        for (let i = head; i < a.length - tail; i++) out.push({ type: 'del', text: a[i] });
        for (let i = head; i < b.length - tail; i++) out.push({ type: 'add', text: b[i] });
        for (let i = a.length - tail; i < a.length; i++) out.push({ type: 'same', text: a[i] });
        return out;
    }
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
        else { out.push({ type: 'add', text: b[j] }); j++; }
    }
    while (i < m) out.push({ type: 'del', text: a[i++] });
    while (j < n) out.push({ type: 'add', text: b[j++] });
    return out;
}

export function buildMatchedDeletion(oldBook, newBook, group, workKeys = []) {
    const { newId, oldIds } = group ?? {};
    if (!Array.isArray(oldIds) || !oldIds.length) throw new Error('请至少选择一条要移除的目标书条目。');
    const { oldIds: removedOldIds } = matchedSelection(oldBook, newBook, newId, oldIds, workKeys);
    return removeMatchedTargets(clone(oldBook), removedOldIds);
}

export function buildDirectDeletion(oldBook, oldIds) {
    validateBook(oldBook);
    const isEntryId = id => typeof id === 'string' || typeof id === 'number';
    if (!Array.isArray(oldIds) || !oldIds.length) throw new Error('请至少选择一条要移除的目标书条目。');
    if (!oldIds.every(isEntryId)) throw new Error('所选条目编号不正确。');
    const removedOldIds = oldIds.map(String);
    if (new Set(removedOldIds).size !== removedOldIds.length) throw new Error('所选目标书条目不可重复。');
    if (!removedOldIds.every(id => own(oldBook.entries, id))) throw new Error('所选条目已不存在，请重新载入。');
    return removeMatchedTargets(clone(oldBook), removedOldIds);
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
    { key: 'disable', label: '禁用条目', kind: 'boolean' },
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
        if (!field || !['set', 'add'].includes(row.mode)) continue;
        if (row.mode === 'add' && field.kind !== 'number') continue;
        let value;
        if (field.kind === 'boolean') {
            if (![true, false, 'true', 'false'].includes(row.value)) throw new Error(`请选择「${field.label}」的开关值。`);
            value = row.value === true || row.value === 'true';
        } else {
            const text = typeof row.value === 'number' || typeof row.value === 'string' ? String(row.value).trim() : '';
            value = Number(text);
            if (!text || !Number.isSafeInteger(value)) throw new Error(`请为「${field.label}」填写整数。`);
            if (field.kind === 'enum' && !field.options.some(option => option.value === value)) {
                throw new Error(`请选择「${field.label}」的有效值。`);
            }
        }
        patch[field.key] = { mode: row.mode, value };
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
const BUILTIN_WORK_PREFIXES = new Map([
    ['原神', '原神'], ['genshin', '原神'], ['genshinimpact', '原神'],
    ['星穹铁道', '星穹铁道'], ['崩坏星穹铁道', '星穹铁道'], ['honkaistarrail', '星穹铁道'], ['starrail', '星穹铁道'],
    ['绝区零', '绝区零'], ['zenlesszonezero', '绝区零'],
    ['崩坏3', '崩坏3'], ['崩坏三', '崩坏3'], ['崩坏3rd', '崩坏3'], ['honkaiimpact3rd', '崩坏3'],
]);
const CHARACTER_NAME_VARIANTS = new Map([['哥伦比亚', '哥伦比娅']]);
const OPEN_BRACKETS = '(（[［{｛【〔〖「『《〈<＜';
const CLOSE_BRACKETS = ')）]］}｝】〕〗」』》〉>＞';
const TRADITIONAL_TO_SIMPLIFIED = new Map(
    ('萬万 與与 專专 業业 東东 絲丝 兩两 嚴严 喪丧 個个 臨临 為为 麗丽 舉举 義义 烏乌 樂乐 喬乔 習习 鄉乡 '
    + '書书 買买 亂乱 爭争 於于 亞亚 產产 親亲 億亿 僅仅 僕仆 從从 儀仪 價价 優优 傳传 傷伤 倫伦 偽伪 體体 '
    + '餘余 俠侠 偵侦 側侧 偶偶 傑杰 備备 傢家 儲储 黨党 蘭兰 關关 興兴 養养 內内 軍军 農农 馮冯 衝冲 決决 '
    + '況况 凍冻 凝凝 凱凯 別别 制制 劇剧 劉刘 劍剑 功功 勞劳 動动 務务 勝胜 勳勋 勵励 勸劝 勻匀 區区 醫医 '
    + '華华 協协 單单 賣卖 衛卫 卻却 廠厂 壓压 厭厌 厲厉 參参 雙双 發发 變变 疊叠 葉叶 號号 司司 吃吃 嚇吓 '
    + '呂吕 聽听 啟启 吳吴 響响 哲哲 喚唤 問问 嗎吗 嗚呜 嘆叹 嘔呕 嘗尝 嘯啸 國国 圍围 圓圆 圖图 堅坚 場场 '
    + '墮堕 壯壮 聲声 處处 夢梦 奪夺 奮奋 妝妆 婦妇 媒媒 媽妈 學学 孫孙 寧宁 實实 審审 寫写 寬宽 寵宠 寶宝 '
    + '將将 尊尊 尋寻 對对 導导 爾尔 尷尴 屆届 屍尸 屬属 島岛 嶽岳 嵐岚 幣币 師师 帳帐 帶带 幫帮 廣广 廳厅 '
    + '開开 異异 張张 強强 彈弹 歸归 當当 錄录 徹彻 恆恒 悅悦 悉悉 惡恶 態态 慘惨 慣惯 慮虑 慶庆 憂忧 憑凭 '
    + '憲宪 憶忆 應应 懶懒 懷怀 懸悬 懼惧 戀恋 戰战 戲戏 戶户 掃扫 掌掌 掛挂 採采 據据 擠挤 擴扩 擺摆 擾扰 '
    + '擁拥 擇择 擊击 擋挡 擔担 敵敌 數数 斷断 時時 時时 顯显 晝昼 曉晓 曆历 會会 條条 來来 楊杨 極极 構构 '
    + '標标 模模 樣样 樹树 橋桥 機机 橫横 櫻樱 檢检 欄栏 權权 歡欢 歐欧 歲岁 歷历 殘残 殺杀 毀毁 氣气 決决 '
    + '沒没 沖冲 淺浅 測测 溫温 準准 溝沟 溪溪 滅灭 滑滑 滾滚 滿满 漁渔 漢汉 漫漫 漲涨 漸渐 潔洁 潛潜 澤泽 '
    + '濃浓 濟济 濕湿 濤涛 濫滥 濱滨 燈灯 災灾 點点 烏乌 燒烧 煙烟 煩烦 熱热 燃燃 愛爱 爺爷 牽牵 犧牺 狀状 '
    + '獨独 獅狮 獄狱 獵猎 獸兽 獻献 現现 環环 璽玺 產产 畫画 異异 當当 療疗 監监 盡尽 盤盘 盧卢 眾众 睜睁 '
    + '確确 碼码 禮礼 禪禅 離离 種种 稱称 穩稳 窮穷 競竞 筆笔 節节 範范 築筑 簡简 類类 精精 紅红 約约 級级 '
    + '紀纪 純纯 紙纸 紛纷 細细 紳绅 紹绍 終终 組组 結结 絕绝 絞绞 統统 絲丝 經经 綠绿 維维 綱纲 網网 綿绵 '
    + '緊紧 線线 緣缘 編编 緩缓 緬缅 緯纬 練练 縛缚 縣县 縫缝 縮缩 縱纵 總总 績绩 繁繁 織织 繞绕 繪绘 繼继 '
    + '續续 羅罗 罰罚 義义 習习 聯联 聰聪 職职 腦脑 腳脚 脫脱 臉脸 與与 舊旧 艦舰 艾艾 蒼苍 蘇苏 華华 菲菲 '
    + '萬万 葉叶 著著 藍蓝 藏藏 藝艺 藥药 蘭兰 處处 虛虚 號号 蟲虫 術术 衛卫 衝冲 裝装 裡里 補补 製制 複复 '
    + '褲裤 覆覆 見见 觀观 規规 視视 覽览 覺觉 解解 觸触 言言 訂订 計计 訊讯 討讨 訓训 託托 記记 設设 許许 '
    + '訴诉 診诊 註注 証证 評评 詞词 詢询 試试 詩诗 話话 該该 詳详 誇夸 認认 誓誓 誕诞 語语 誠诚 誤误 說说 '
    + '誰谁 課课 調调 談谈 請请 論论 諸诸 諾诺 謀谋 謂谓 講讲 謝谢 證证 識识 譜谱 警警 議议 護护 讀读 變变 '
    + '讓让 豐丰 貝贝 貞贞 負负 財财 貢贡 貧贫 貨货 貪贪 貫贯 責责 貴贵 買买 費费 貼贴 賀贺 資资 賈贾 賊贼 '
    + '賓宾 賞赏 賠赔 賢賢 賢贤 賣卖 賦赋 質质 賭赌 賴赖 賺赚 購购 賽赛 贈赠 贊赞 贏赢 趙赵 趕赶 躍跃 車车 '
    + '軌轨 軍军 軒轩 軟软 輕轻 載载 較较 輔辅 輛辆 輝辉 輩辈 輪轮 輯辑 輸输 轉转 辭辞 辦办 辨辩 農农 連连 '
    + '進进 遠远 違违 適适 選选 遺遗 還还 邁迈 邊边 邏逻 鄰邻 鄧邓 鄭郑 醫医 釋释 金金 針针 釣钓 鈴铃 銀银 '
    + '銅铜 銘铭 銳锐 錯错 錢钱 錦锦 錫锡 鍋锅 鍛锻 鍵键 鍾钟 鎮镇 鏡镜 長长 門门 閃闪 閉闭 開开 閑闲 間间 '
    + '閣阁 閱阅 關关 陣阵 陰阴 陳陈 陸陆 陽阳 隆隆 隊队 階阶 際际 隨随 險险 隱隐 隻只 雄雄 雅雅 集集 雙双 '
    + '雜杂 雞鸡 離离 難难 雲云 雷雷 電电 需需 霧雾 露露 霸霸 靈灵 靜静 韋韦 韓韩 音音 韻韵 響响 頁页 頂顶 '
    + '項项 順顺 須须 預预 領领 頗颇 頻频 顆颗 題题 額额 顏颜 願愿 類类 顧顾 顯显 風风 飄飘 飛飞 飯饭 飲饮 '
    + '飾饰 飽饱 餅饼 養养 餐餐 餘余 館馆 馬马 駁驳 駐驻 駕驾 驗验 騎骑 騙骗 騷骚 驅驱 驕骄 驚惊 體体 髮发 '
    + '鬆松 鬼鬼 魂魂 魔魔 魚鱼 魯鲁 鮮鲜 鳥鸟 鳳凤 鳴鸣 鴻鸿 麗丽 麥麦 黃黄 黎黎 點点 黨党 齊齐 龍龙 龜龟')
        .split(/\s+/).filter(pair => pair.length === 2 && pair[0] !== pair[1]).map(pair => [pair[0], pair[1]])
);
function toSimplified(text) {
    let out = '';
    for (const ch of String(text ?? '')) out += TRADITIONAL_TO_SIMPLIFIED.get(ch) ?? ch;
    return out;
}

export function unifyName(value) {
    let text = '';
    for (const character of toSimplified(String(value ?? '').normalize('NFKC'))) {
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

function entryPrefix(comment, workKeys) {
    const text = String(comment ?? '').trim();
    for (const match of text.matchAll(/ - |[:：\-—·・‧]/gu)) {
        const left = text.slice(0, match.index).trim(), right = text.slice(match.index + match[0].length).trim();
        if (!left || !right) continue;
        const key = compactName(left);
        if (match[0] === ' - ' || BUILTIN_CATEGORIES.includes(left) || BUILTIN_WORK_PREFIXES.has(key) || workKeys.includes(key)) {
            return { key, right };
        }
    }
    return null;
}

/** 生成器的条目名带前缀：`主角:爱芮`、`角色 - 雷电将军`。取回名字本身。 */
export function splitCategoryPrefix(comment, workKeys = []) {
    return entryPrefix(comment, workKeys)?.right ?? '';
}

function explicitEntryWork(entry, workKeys) {
    let name = entry.comment, prefix;
    while ((prefix = entryPrefix(name, workKeys))) {
        const work = BUILTIN_WORK_PREFIXES.get(prefix.key);
        if (work) return work;
        name = prefix.right;
    }
    const { groups } = splitBrackets(name);
    return groups.map(group => BUILTIN_WORK_PREFIXES.get(compactName(group))).find(Boolean);
}

export function compatibleEntryWorks(source, target, workKeys = []) {
    const sourceWork = explicitEntryWork(source, workKeys);
    if (!sourceWork) return true;
    const targetWork = explicitEntryWork(target, workKeys);
    return !targetWork || targetWork === sourceWork;
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
function labelVariants(text, workKeys) {
    const variants = new Set();
    const { outside, groups } = splitBrackets(text);
    const main = compactName(outside);
    if (main) variants.add(main);
    for (const group of groups) {
        if (/\d/.test(group) || BUILTIN_WORK_PREFIXES.has(compactName(group)) || workKeys.includes(compactName(group))) continue;
        for (const part of group.split(/[\/／|｜]+/)) {
            const key = compactName(part);
            if (key && !BUILTIN_WORK_PREFIXES.has(key) && !workKeys.includes(key)) variants.add(key);
        }
    }
    return variants;
}

function nameWithoutPrefixes(name, workKeys) {
    let base = name, suffix;
    while ((suffix = splitCategoryPrefix(base, workKeys))) base = suffix;
    return base;
}

function normalizeCharacterName(name, workKeys) {
    const base = String(nameWithoutPrefixes(name, workKeys) ?? '');
    const [first, ...rest] = base.split(/(?=[·・‧(（])/u);
    const canonical = CHARACTER_NAME_VARIANTS.get(compactName(first));
    return canonical ? canonical + rest.join('') : base;
}

function exactNameKeys(name, workKeys) {
    const compound = compoundTitleNames(name, workKeys);
    if (compound.length) return [compoundNameKey(compound, workKeys)];
    const base = normalizeCharacterName(name, workKeys);
    return [...labelVariants(base, workKeys), parseScopedName(base, workKeys).key, compactName(name)]
        .filter(Boolean).map(key => CHARACTER_NAME_VARIANTS.get(key) ?? key);
}

// 带间隔号的中文全名可以用首段查找。完整姓名之间仍按各自全名比较。
function shortNameKey(name, workKeys) {
    const base = normalizeCharacterName(name, workKeys);
    const { outside } = splitBrackets(base);
    const match = outside.trim().match(/^(\p{Script=Han}+)(?:\s*[·・‧]\s*\p{Script=Han}+)+$/u);
    return match?.[1] || '';
}

function compoundTitleNames(title, workKeys) {
    const { outside } = splitBrackets(nameWithoutPrefixes(title, workKeys));
    const names = outside.split(/[、，,]/u).map(name => name.trim());
    return names.length > 1 && names.every(name => /^\p{Script=Han}+(?:\s*[·・‧]\s*\p{Script=Han}+)*$/u.test(name))
        ? names : [];
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
        const keys = titleMatchKeys(raw, workKeys);
        if (keys.some(key => candidates.has(key))) return '名称一致';
        const shortQuery = shortNameKey(raw, workKeys);
        const canUseShortQuery = shortQuery && shortQuery !== shortTitle && candidates.has(shortQuery)
            && ([...shortQuery].length > 1 || isSingleName(entry.comment, workKeys));
        if ((shortTitle && keys.includes(shortTitle)) || canUseShortQuery) return '简称匹配';
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

function rosterIndex(book, workKeys, { includeKeywords = true, target = false } = {}) {
    const exact = new Map(), short = new Map(), singleTitles = new Set();
    const add = (index, key, id) => {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(id);
    };
    for (const [id, entry] of Object.entries(book.entries)) {
        const key = includeKeywords ? (entry.key || []).filter(key => !target || corroboratingKeyword(key, workKeys)) : [];
        const [primary, ...secondary] = compoundTitleNames(entry.comment, workKeys);
        const names = { comment: primary ?? entry.comment, key };
        for (const key of entryNameCandidates(names, workKeys)) add(exact, key, id);
        if (primary) add(exact, compoundNameKey([primary, ...secondary], workKeys), id);
        if (isSingleName(entry.comment, workKeys)) singleTitles.add(id);
        const shortTitle = shortNameKey(names.comment, workKeys);
        if (shortTitle) add(short, shortTitle, id);
        if (primary && target && includeKeywords) {
            // Companion names are candidate evidence only, never the entry's primary identity.
            for (const name of secondary) {
                for (const key of new Set(exactNameKeys(name, workKeys))) add(exact, key, id);
            }
        }
    }
    return { exact, short, singleTitles };
}

function rosterHits(index, keys, shortKeys = []) {
    const hits = new Set();
    for (const key of new Set(keys)) {
        for (const id of index.exact.get(key) || []) hits.add(id);
        for (const id of index.short.get(key) || []) hits.add(id);
    }
    for (const key of new Set(shortKeys)) {
        const fullNames = new Set(index.short.get(key));
        for (const id of index.exact.get(key) || []) {
            if (!fullNames.has(id) && ([...key].length > 1 || index.singleTitles.has(id))) hits.add(id);
        }
    }
    return hits;
}

function titleMatches(index, title, workKeys) {
    const [primary, ...secondary] = compoundTitleNames(title, workKeys);
    const name = primary ?? title;
    const short = shortNameKey(name, workKeys);
    const keys = titleMatchKeys(name, workKeys);
    if (primary) keys.push(compoundNameKey([primary, ...secondary], workKeys));
    return rosterHits(index, keys, short ? [short] : []);
}

function compoundNameKey(names, workKeys) {
    return JSON.stringify(names.map(name => compactName(normalizeCharacterName(name, workKeys))));
}

function fullNameKey(name, workKeys) {
    const compound = compoundTitleNames(name, workKeys);
    return compound.length ? compoundNameKey(compound, workKeys)
        : compactName(splitBrackets(normalizeCharacterName(name, workKeys)).outside);
}

function titleMatchKeys(title, workKeys) {
    const keys = exactNameKeys(title, workKeys);
    return isSingleName(title, workKeys) || [...compactName(title)].length === 1 ? keys : keys.filter(key => [...key].length > 1);
}

export function matchRosterEntries(oldBook, newBook, groups, {
    workKeys = [], manualPairs = [], unpairedOld = new Set(), unpairedNew = new Set(),
} = {}) {
    const sourceIndex = rosterIndex(newBook, workKeys);
    const targetIndex = rosterIndex(oldBook, workKeys, { target: true });
    const targetTitles = rosterIndex(oldBook, workKeys, { target: true, includeKeywords: false });
    const targetSignatures = new Map();
    for (const [id, entry] of Object.entries(oldBook.entries)) {
        const signature = keySignature(entry);
        if (!signature) continue;
        if (!targetSignatures.has(signature)) targetSignatures.set(signature, []);
        targetSignatures.get(signature).push(id);
    }
    const sourceSignatureCounts = new Map();
    for (const source of Object.values(newBook.entries)) {
        const signature = keySignature(source);
        if (signature) sourceSignatureCounts.set(signature, (sourceSignatureCounts.get(signature) || 0) + 1);
    }
    const overrides = new Map(manualPairs.map(pair => [pair.newId, pair.oldId]));
    const manualOwners = new Map(manualPairs.map(pair => [pair.oldId, pair.newId]));
    const entries = new Map(), review = [], missing = [];
    const reviewRows = { new: new Set(), old: new Set() };
    const reviewReasons = new Map();
    const allowsWork = (entry, works) => {
        if (!works.size) return true;
        const work = explicitEntryWork(entry, workKeys);
        return !work || works.has(work);
    };
    const addReview = (message, sources, targets = []) => {
        review.push(message);
        const targetIds = [...targets];
        const examples = [...new Set(targetIds.slice(0, 2).map(id => title(oldBook.entries[id])))];
        const reason = examples.length ? `${message} · 目标候选：${examples.join('、')}${targetIds.length > 2 ? '等' : ''}` : message;
        for (const id of sources) {
            reviewRows.new.add(id);
            if (!reviewReasons.has(id)) reviewReasons.set(id, reason);
        }
        for (const id of targets) reviewRows.old.add(id);
    };
    for (const aliases of groups) {
        const name = aliases.join(' / ');
        const keys = aliases.flatMap(alias => titleMatchKeys(alias, workKeys));
        const shortKeys = aliases.map(alias => shortNameKey(alias, workKeys)).filter(Boolean);
        const requestedWorks = new Set(aliases.map(comment => explicitEntryWork({ comment }, workKeys)).filter(Boolean));
        let sources = new Set([...rosterHits(sourceIndex, keys, shortKeys)].filter(id => allowsWork(newBook.entries[id], requestedWorks)));
        if (!sources.size) { missing.push(name); continue; }
        const queryTargets = () => [...rosterHits(targetIndex, keys, shortKeys)].filter(id => {
            const target = oldBook.entries[id];
            return allowsWork(target, requestedWorks)
                && [...sources].some(sourceId => compatibleEntryWorks(newBook.entries[sourceId], target, workKeys));
        });
        if (aliases.every(alias => isSingleName(alias, workKeys))) {
            const targets = queryTargets();
            const corroborated = new Set([...sources].filter(id => {
                if (overrides.has(id)) return true;
                const source = newBook.entries[id];
                if (targets.length) return targets.some(oldId =>
                    compatibleEntryWorks(source, oldBook.entries[oldId], workKeys)
                    && sharedPrimaryKeyword(source, oldBook.entries[oldId], workKeys, true)
                );
                const keywords = entryNameCandidates({ key: source.key }, workKeys);
                return keys.some(key => keywords.has(key));
            }));
            if (!corroborated.size) {
                addReview(`${name}（单字简称缺少主关键词佐证）`, sources, targets);
                continue;
            }
            sources = corroborated;
        }
        if (sources.size > 1) {
            const manuallyResolved = [...sources].filter(id => overrides.has(id));
            if (manuallyResolved.length === 1) sources = new Set(manuallyResolved);
            else {
                addReview(`${name}（母本有多个匹配条目）`, sources, queryTargets());
                continue;
            }
        }
        const newId = sources.values().next().value;
        if (!entries.has(newId)) entries.set(newId, { name, keys: new Set(), shortKeys: new Set(), works: new Set() });
        const item = entries.get(newId);
        for (const key of keys) item.keys.add(key);
        for (const key of shortKeys) item.shortKeys.add(key);
        for (const work of requestedWorks) item.works.add(work);
    }

    const matched = [], additions = [], claims = new Map();
    for (const [newId, item] of entries) {
        const source = newBook.entries[newId];
        const primaryTitle = compoundTitleNames(source.comment, workKeys)[0] ?? source.comment;
        const sourceShort = shortNameKey(primaryTitle, workKeys);
        // Once a full name is resolved, its short form can find a bare title but never another full name.
        const shortKeys = new Set(item.shortKeys);
        if (sourceShort) shortKeys.add(sourceShort);
        const keys = [...item.keys, ...titleMatchKeys(primaryTitle, workKeys), ...titleMatchKeys(source.comment, workKeys)]
            .filter(key => !shortKeys.has(key));
        const namedTargets = rosterHits(targetTitles, keys, shortKeys);
        // An inferred short name can match a target title. A keyword alone must carry an explicit name.
        const targets = rosterHits(targetIndex, keys);
        for (const oldId of namedTargets) targets.add(oldId);
        const eligibleTarget = id => allowsWork(oldBook.entries[id], item.works)
            && compatibleEntryWorks(source, oldBook.entries[id], workKeys);
        for (const id of targets) if (!eligibleTarget(id)) targets.delete(id);
        const signature = keySignature(source);
        const identicalKeywords = (targetSignatures.get(signature) || []).filter(eligibleTarget);
        const keywordOwner = identicalKeywords.length === 1 ? identicalKeywords[0] : null;
        if ([...targets].some(id => namedTargets.has(id) && hasPairEvidence(source, oldBook.entries[id], workKeys))) {
            for (const id of targets) if (!namedTargets.has(id) && id !== keywordOwner) targets.delete(id);
        }
        if (overrides.has(newId)) {
            targets.clear();
            targets.add(overrides.get(newId));
        } else if (targets.size) {
            const supported = new Set([...targets].filter(id => {
                const target = oldBook.entries[id];
                return !singleNamePair(source, target, workKeys) || hasPairEvidence(source, target, workKeys);
            }));
            if (!supported.size) {
                addReview(`${item.name}（单字简称缺少主关键词佐证）`, [newId], targets);
                continue;
            }
            for (const id of targets) if (!supported.has(id)) targets.delete(id);
        }
        if (unpairedNew.has(newId) || [...targets].some(id => unpairedOld.has(id))) {
            addReview(`${item.name}（已手动解除配对）`, [newId], targets);
        } else if ([...targets].some(id => manualOwners.has(id) && manualOwners.get(id) !== newId)) {
            addReview(`${item.name}（目标条目已有其他手动配对）`, [newId], targets);
        } else if (targets.size > 1) {
            addReview(`${item.name}（目标书有多个匹配条目）`, [newId], targets);
        } else if (!targets.size) {
            const unnamed = identicalKeywords.filter(id => !source.comment?.trim() || !oldBook.entries[id].comment?.trim());
            if (sourceSignatureCounts.get(signature) === 1 && unnamed.length
                && source.key?.some(key => corroboratingKeyword(key, workKeys))) {
                addReview(`${item.name}（缺少标题，主关键词完全相同）`, [newId], unnamed);
            } else additions.push(newId);
        } else {
            const oldId = targets.values().next().value;
            if (!overrides.has(newId) && !namedTargets.has(oldId) && oldBook.entries[oldId].comment?.trim()) {
                addReview(`${item.name}（目标条目只有关键词命中，标题不同）`, [newId], targets);
                continue;
            }
            if (!overrides.has(newId) && !hasPairEvidence(source, oldBook.entries[oldId], workKeys)) {
                addReview(`${item.name}（名称命中，主关键词缺少共同依据）`, [newId], targets);
                continue;
            }
            if (!overrides.has(newId) && keySignature(oldBook.entries[oldId]) && keywordOwner !== null && keywordOwner !== oldId) {
                addReview(`${item.name}（标题与完整主关键词指向不同条目）`, [newId], [oldId, keywordOwner]);
                continue;
            }
            matched.push({ oldId, newId, checked: true, reason: '名单匹配' });
            claims.set(oldId, (claims.get(oldId) || 0) + 1);
        }
    }

    const reservedTargets = new Set(reviewRows.old);
    const pairs = matched.filter(pair => {
        if (overrides.has(pair.newId)) return true;
        const name = entries.get(pair.newId).name;
        if (claims.get(pair.oldId) > 1) {
            addReview(`${name}（与另一角色匹配到同一目标条目）`, [pair.newId], [pair.oldId]);
        } else if (reviewRows.new.has(pair.newId) || reservedTargets.has(pair.oldId)) {
            addReview(`${name}（名单中的其他名称或候选指向此配对）`, [pair.newId], [pair.oldId]);
        } else return true;
        return false;
    });
    for (const { oldId } of manualPairs) reviewRows.old.delete(oldId);
    for (const pair of pairs) {
        reviewRows.new.delete(pair.newId);
        reviewReasons.delete(pair.newId);
    }
    const approvedAdditions = additions.filter(id => !reviewRows.new.has(id));
    const states = new Map([...reviewRows.new].map(id => [id, 'review']));
    for (const { newId } of pairs) states.set(newId, 'paired');
    for (const id of approvedAdditions) states.set(id, 'new');
    return { pairs, additions: approvedAdditions, states, namesById: new Map([...entries].map(([id, item]) => [id, item.name])), review, reviewRows, reviewReasons, missing };
}

export function buildRosterUpdate(oldBook, newBook, groups, mode, options) {
    return buildResolvedRosterUpdate(oldBook, newBook, matchRosterEntries(oldBook, newBook, groups, options), mode, options?.workKeys);
}

export function buildResolvedRosterUpdate(oldBook, newBook, { pairs, additions, namesById, review, missing }, mode, workKeys) {
    const replace = [], unchanged = [];
    for (const pair of pairs) {
        const name = namesById.get(pair.newId);
        if (!pairChanged(oldBook, newBook, pair, mode)) { unchanged.push(name); continue; }
        const targetTitle = oldBook.entries[pair.oldId].comment;
        replace.push(compoundTitleNames(targetTitle, workKeys).length ? `${name} → 「${targetTitle}」（更新整条）` : name);
    }
    const result = buildUpdate(oldBook, newBook, pairs, mode, { merge: true, additions, approvedNew: additions, workKeys });
    return {
        result, replace, unchanged, review, missing,
        copy: result.addedPairs.map(pair => namesById.get(pair.newId)),
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
 * 置顶块先排已勾选的配对，再排待核对，最后排其他配对和名单命中。
 */
export function pinBlock(entries, pairs, side, scopedIds = [], isChecked = pair => pair.checked === true, reviewIds = []) {
    const scoped = new Set((scopedIds || []).map(String));
    const pairByNew = new Map((pairs || []).map(pair => [String(pair.newId), pair]));
    const checked = [], other = [];
    for (const { id } of entries) {
        const pair = pairByNew.get(String(id));
        if (!pair && !scoped.has(String(id))) continue;
        if (side === 'old' && !pair) continue;
        const group = pair && isChecked(pair) ? checked : other;
        group.push(String(side === 'new' ? id : pair.oldId));
    }
    return [...new Set([...checked, ...reviewIds, ...other])];
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
    if (!names?.length) return autoMatch(oldBook, newBook, workKeys);
    return matchEntries(oldBook, newBook, entry => scopeMatch(entry, names, workKeys), workKeys);
}
