export const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keyed = a => Array.isArray(a) && a.every(x => object(x) && typeof x.id === 'string') && new Set(a.map(x => x.id)).size === a.length;
const safeKey = k => !['__proto__', 'prototype', 'constructor'].includes(k);
export function diff(base, next, path = []) {
  if (equal(base, next)) return [];
  if (object(base) && object(next)) return [...new Set([...Object.keys(base), ...Object.keys(next)])].flatMap(k => {
    if (!safeKey(k)) throw new Error('Invalid key');
    return diff(base[k], next[k], [...path, k]);
  });
  if (keyed(base) && keyed(next)) {
    const a = new Map(base.map(x => [x.id, x])), b = new Map(next.map(x => [x.id, x]));
    return [...new Set([...a.keys(), ...b.keys()])].flatMap(id => diff(a.get(id), b.get(id), [...path, '@' + id]));
  }
  return [{ path, beforeExists: base !== undefined, before: clone(base), afterExists: next !== undefined, value: clone(next) }];
}
export function readAt(state, path) {
  let value = state;
  for (const k of path) {
    if (typeof k !== 'string' || !safeKey(k)) throw new Error('Invalid path');
    if (k.startsWith('@')) {
      if (!Array.isArray(value)) return undefined;
      value = value.find(x => x && x.id === k.slice(1));
    } else {
      if (!object(value) || !Object.hasOwn(value, k)) return undefined;
      value = value[k];
    }
  }
  return value;
}
function setAt(state, path, value, exists) {
  if (!path.length) return exists ? clone(value) : {};
  let node = state;
  for (const k of path.slice(0, -1)) {
    node = k.startsWith('@') ? (Array.isArray(node) ? node.find(x => x.id === k.slice(1)) : undefined) : node?.[k];
    if (!node || typeof node !== 'object') throw new Error('부모 항목이 삭제되었습니다.');
  }
  const key = path.at(-1);
  if (key.startsWith('@')) {
    if (!Array.isArray(node)) throw new Error('Invalid array path');
    const i = node.findIndex(x => x.id === key.slice(1));
    if (exists && (!object(value) || value.id !== key.slice(1))) throw new Error('Invalid item id');
    if (exists && i < 0) node.push(clone(value));
    else if (exists) node[i] = clone(value);
    else if (i >= 0) node.splice(i, 1);
  } else if (exists) node[key] = clone(value);
  else delete node[key];
  return state;
}
export function applyChanges(state, ops, force = false) {
  let result = clone(state || {});
  const conflicts = [];
  for (const op of ops) {
    const current = readAt(result, op.path);
    const matchesBefore = (current !== undefined) === op.beforeExists && equal(current, op.before);
    const alreadyApplied = (current !== undefined) === op.afterExists && equal(current, op.value);
    if (!force && !matchesBefore && !alreadyApplied) { conflicts.push(op.path); continue; }
    try { result = setAt(result, op.path, op.value, op.afterExists); }
    catch { conflicts.push(op.path); }
  }
  return { state: result, conflicts };
}
export function validChanges(ops) {
  return Array.isArray(ops) && ops.length <= 4000 && ops.every(op => object(op) &&
    Array.isArray(op.path) && op.path.length > 0 && op.path.length <= 20 &&
    ['food', 'foodPresets', 'records', 'gear', 'extra'].includes(op.path[0]) &&
    op.path.every(k => typeof k === 'string' && k.length <= 300 && safeKey(k)) &&
    typeof op.beforeExists === 'boolean' && typeof op.afterExists === 'boolean');
}
export function normalizeState(state = {}) {
  return { food: state.food || { trips: {} }, foodPresets: state.foodPresets || [],
    records: state.records || { upcoming: [], history: [] }, gear: state.gear || { items: [], checklists: {} },
    extra: { presets: [], trips: {}, recipes: [], favorites: [], ...(state.extra || {}) } };
}
export function parseTable(text) {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === delimiter) { row.push(cell); cell = ''; }
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(x => x.trim())) rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('따옴표가 닫히지 않은 셀이 있습니다.');
  row.push(cell); if (row.some(x => x.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('제목 행과 장비 행을 함께 붙여넣어 주세요.');
  const headers = rows.shift().map(x => x.trim());
  const indexes = ['항목', '제조사', '모델명', '가격', '수량', '중고가'].map(h => headers.indexOf(h));
  if (indexes.slice(0, 5).some(x => x < 0)) throw new Error('항목·제조사·모델명·가격·수량 열이 필요합니다.');
  const number = (raw, nullable) => {
    if (!String(raw || '').trim()) return nullable ? null : 1;
    const clean = String(raw).replace(/[₩원,\s]/g, '');
    const n = Number(clean);
    if (!Number.isFinite(n) || n < 0) throw new Error('가격 또는 수량이 올바르지 않습니다.');
    return n;
  };
  let category = '', manufacturer = ''; const seen = new Set();
  return rows.flatMap((r, i) => {
    if (r[indexes[0]]?.trim()) category = r[indexes[0]].trim();
    if (r[indexes[1]]?.trim()) manufacturer = r[indexes[1]].trim();
    const name = r[indexes[2]]?.trim(); if (!name) return [];
    const item = { category, manufacturer, name, price: number(r[indexes[3]], true), quantity: number(r[indexes[4]], false), usedPrice: number(r[indexes[5]], true) };
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error(String(i + 2) + '행 수량은 1 이상의 정수여야 합니다.');
    const key = JSON.stringify([category, manufacturer, name]);
    if (seen.has(key)) throw new Error(String(i + 2) + '행 장비가 중복됩니다: ' + name);
    seen.add(key); return [item];
  });
}
