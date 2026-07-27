import { destStage } from '../common/destRef';
/**
 * Large-graph focus helpers: OStim folder tags + N-hop neighborhoods.
 * Folder tags also drive virtual canvases (see folderView.js) which mount a
 * subset of nodes; Scene.graph stays intact either way.
 *
 * Pack "splits" on disk are `scenes/{folder}/…json`. We store that as
 * `ostim_folder:{folder}` on each stage for virtual canvases + OStim export.
 */

export const OSTIM_FOLDER_PREFIX = 'ostim_folder:';
export const OSTIM_ID_PREFIX = 'ostim_id:';

/** True for tags that are SLSB↔OStim plumbing, not gameplay tags. */
export function isOstimPlumbingTag(tag) {
  const t = String(tag || '');
  return (
    t.startsWith('ostim_folder:') ||
    t.startsWith('ostim_id:') ||
    t.startsWith('ostim_group:') ||
    t.startsWith('ostim_nav:') ||
    t.startsWith('ostim_nav_origin:') ||
    t.startsWith('ostim_dest:') ||
    t.startsWith('ostim_speed:') ||
    t.startsWith('action:')
  );
}

/** @param {{ tags?: string[] } | null | undefined} stage */
export function stageOstimFolder(stage) {
  const tags = stage?.tags;
  if (!Array.isArray(tags)) return '';
  for (const t of tags) {
    if (typeof t === 'string' && t.startsWith(OSTIM_FOLDER_PREFIX)) {
      const f = t.slice(OSTIM_FOLDER_PREFIX.length).trim();
      if (f) return f;
    }
  }
  return '';
}

/** @param {{ tags?: string[] } | null | undefined} stage */
export function stageOstimIdFromTags(stage) {
  const tags = stage?.tags;
  if (!Array.isArray(tags)) return '';
  for (const t of tags) {
    if (typeof t === 'string' && t.startsWith(OSTIM_ID_PREFIX)) {
      const id = t.slice(OSTIM_ID_PREFIX.length).trim();
      if (id) return id;
    }
  }
  return '';
}

/**
 * Set or clear `ostim_id:` on a tags array (immutable).
 * @param {string[]} tags
 * @param {string} ostimId empty = remove
 * @returns {string[]}
 */
export function tagsWithOstimId(tags, ostimId) {
  const next = (tags || []).filter(
    (t) => typeof t !== 'string' || !t.startsWith(OSTIM_ID_PREFIX)
  );
  const id = String(ostimId || '').trim().replace(/:/g, '_');
  if (id) next.push(`${OSTIM_ID_PREFIX}${id}`);
  return next;
}

/**
 * Set or clear `ostim_folder:` on a tags array (immutable).
 * @param {string[]} tags
 * @param {string} folder  empty = remove
 * @returns {string[]}
 */
export function tagsWithOstimFolder(tags, folder) {
  const next = (tags || []).filter(
    (t) => typeof t !== 'string' || !t.startsWith(OSTIM_FOLDER_PREFIX)
  );
  const f = String(folder || '').trim();
  if (f) next.push(`${OSTIM_FOLDER_PREFIX}${f}`);
  return next;
}

/**
 * @param {object} stage
 * @param {string} folder
 * @returns {object}
 */
export function stageWithOstimFolder(stage, folder) {
  if (!stage) return stage;
  return { ...stage, tags: tagsWithOstimFolder(stage.tags || [], folder) };
}

/**
 * @param {Array<{ id: string, tags?: string[] }>} stages
 * @returns {Map<string, string>} stageId → folder (empty if none)
 */
export function buildFolderMap(stages) {
  const map = new Map();
  for (const s of stages || []) {
    if (!s?.id) continue;
    map.set(s.id, stageOstimFolder(s));
  }
  return map;
}

/**
 * Unique non-empty folder names for filter UI.
 * @param {Map<string, string>} folderMap
 */
export function folderFilterOptions(folderMap) {
  const set = new Set();
  for (const f of folderMap?.values() || []) {
    if (f) set.add(f);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {Map<string, string>} folderMap
 * @returns {Map<string, number>}
 */
export function folderStageCounts(folderMap) {
  const counts = new Map();
  for (const f of folderMap?.values() || []) {
    if (!f) continue;
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  return counts;
}

/**
 * Undirected N-hop neighborhood around focus node ids in a dest-list graph.
 * @param {Record<string, { dest?: string[] }>} sceneGraph
 * @param {string[]} focusIds
 * @param {number} hops  0 = only focus; Infinity / negative = all nodes
 * @returns {Set<string>}
 */
export function neighborhoodIds(sceneGraph, focusIds, hops) {
  const seeds = (focusIds || []).filter(Boolean);
  const allIds = Object.keys(sceneGraph || {});
  if (!seeds.length) return new Set(allIds);
  if (!Number.isFinite(hops) || hops < 0) return new Set(allIds);

  /** @type {Map<string, string[]>} */
  const undirected = new Map();
  for (const id of allIds) undirected.set(id, []);
  for (const [s, node] of Object.entries(sceneGraph || {})) {
    for (const t of (node?.dest || []).map(destStage).filter(Boolean)) {
      if (!undirected.has(s)) undirected.set(s, []);
      if (!undirected.has(t)) undirected.set(t, []);
      undirected.get(s).push(t);
      undirected.get(t).push(s);
    }
  }

  const seen = new Set();
  /** @type {{ id: string, d: number }[]} */
  const q = [];
  for (const id of seeds) {
    if (!undirected.has(id) && !sceneGraph[id]) continue;
    seen.add(id);
    q.push({ id, d: 0 });
  }
  let qi = 0;
  while (qi < q.length) {
    const { id, d } = q[qi++];
    if (d >= hops) continue;
    for (const n of undirected.get(id) || []) {
      if (seen.has(n)) continue;
      seen.add(n);
      q.push({ id: n, d: d + 1 });
    }
  }
  return seen;
}

/** Stage count above which the editor shows a large-graph tip. */
export const LARGE_SCENE_STAGE_WARN = 40;
