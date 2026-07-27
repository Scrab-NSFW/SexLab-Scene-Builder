const STORAGE_KEY = 'slsb.assetLibrary';
/** Soft cap for typed cross-project history only (not pack catalogs). */
const MAX_PER_LIST = 1000;

/** @typedef {{ events: string[], anim_objects: string[], equip_objects: string[], icons: string[] }} AssetLibrary */

function emptyLibrary() {
  return { events: [], anim_objects: [], equip_objects: [], icons: [] };
}

function normalizeStem(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\.hkx$/i, '')
    .replace(/\.(dds|png|svg)$/i, '');
}

function pushUnique(list, raw) {
  const trimmed = normalizeStem(raw);
  if (!trimmed) return false;
  const key = trimmed.toLowerCase();
  if (list.some((e) => String(e).toLowerCase() == key)) return false;
  list.push(trimmed);
  return true;
}

/** Insert or move to end so the soft cap keeps most-recently-used names. */
function touchUnique(list, raw) {
  const trimmed = normalizeStem(raw);
  if (!trimmed) return false;
  const key = trimmed.toLowerCase();
  const idx = list.findIndex((e) => String(e).toLowerCase() === key);
  if (idx >= 0) list.splice(idx, 1);
  list.push(trimmed);
  return true;
}

function sortList(list) {
  return [...list].sort((a, b) =>
    String(a).toLowerCase().localeCompare(String(b).toLowerCase())
  );
}

function capList(list) {
  if (list.length <= MAX_PER_LIST) return list;
  return list.slice(list.length - MAX_PER_LIST);
}

/** @returns {AssetLibrary} */
export function loadGlobalAssetLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return emptyLibrary();
    return {
      events: Array.isArray(parsed.events)
        ? parsed.events.filter((t) => typeof t === 'string' && t.trim())
        : [],
      anim_objects: Array.isArray(parsed.anim_objects)
        ? parsed.anim_objects.filter((t) => typeof t === 'string' && t.trim())
        : [],
      equip_objects: Array.isArray(parsed.equip_objects)
        ? parsed.equip_objects.filter((t) => typeof t === 'string' && t.trim())
        : [],
      icons: Array.isArray(parsed.icons)
        ? parsed.icons.filter((t) => typeof t === 'string' && t.trim())
        : [],
    };
  } catch {
    return emptyLibrary();
  }
}

/** @param {AssetLibrary} lib */
export function saveGlobalAssetLibrary(lib) {
  const next = {
    events: capList([...(lib.events || [])]),
    anim_objects: capList([...(lib.anim_objects || [])]),
    equip_objects: capList([...(lib.equip_objects || [])]),
    icons: capList([...(lib.icons || [])]),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

/**
 * Merge into global typed history (MRU). Do not pass full project libraries.
 * @param {Partial<AssetLibrary>} incoming
 */
export function mergeGlobalAssetLibrary(incoming = {}) {
  const cur = loadGlobalAssetLibrary();
  for (const e of incoming.events || []) touchUnique(cur.events, e);
  for (const e of incoming.anim_objects || []) touchUnique(cur.anim_objects, e);
  for (const e of incoming.equip_objects || []) touchUnique(cur.equip_objects, e);
  for (const e of incoming.icons || []) touchUnique(cur.icons, e);
  return saveGlobalAssetLibrary(cur);
}

/**
 * Union of project + global libraries for autocomplete options.
 * @param {Partial<AssetLibrary>|null|undefined} project
 * @param {'events'|'anim_objects'|'equip_objects'|'icons'} kind
 */
export function suggestAssetOptions(project, kind) {
  const global = loadGlobalAssetLibrary();
  const list = [];
  for (const e of project?.[kind] || []) pushUnique(list, e);
  for (const e of global[kind] || []) pushUnique(list, e);
  return sortList(list);
}

/**
 * Remember values into global typed history (MRU).
 * @param {'events'|'anim_objects'|'equip_objects'|'icons'} kind
 * @param {string|string[]} values
 */
export function rememberAssetValues(kind, values) {
  const arr = Array.isArray(values) ? values : [values];
  const patch = emptyLibrary();
  for (const v of arr) {
    if (kind === 'events') pushUnique(patch.events, v);
    else if (kind === 'icons') pushUnique(patch.icons, v);
    else if (kind === 'anim_objects') {
      for (const tok of String(v || '').split(/[,\s]+/)) {
        pushUnique(patch.anim_objects, tok);
      }
    } else if (kind === 'equip_objects') {
      for (const tok of String(v || '').split(/[,\s]+/)) {
        pushUnique(patch.equip_objects, tok);
      }
    }
  }
  return mergeGlobalAssetLibrary(patch);
}

export function emptyAssetLibrary() {
  return emptyLibrary();
}

/**
 * Normalize a Rust/JS payload into AssetLibrary shape.
 * @param {any} raw
 * @returns {AssetLibrary}
 */
export function normalizeAssetLibrary(raw) {
  if (!raw || typeof raw !== 'object') return emptyLibrary();
  return {
    events: Array.isArray(raw.events) ? [...raw.events] : [],
    anim_objects: Array.isArray(raw.anim_objects) ? [...raw.anim_objects] : [],
    equip_objects: Array.isArray(raw.equip_objects)
      ? [...raw.equip_objects]
      : [],
    icons: Array.isArray(raw.icons) ? [...raw.icons] : [],
  };
}
