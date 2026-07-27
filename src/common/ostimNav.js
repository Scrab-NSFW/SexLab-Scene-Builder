/**
 * OStim navigation metadata stored as stage tags:
 * `ostim_nav:{prio}:{dest}:{desc}:{icon}:{border}`
 * (same encoding as convert.rs / edgeRanker.js)
 */

import { parseNavText, stageOstimId } from '../scene/edgeRanker';

export function encodeOstimNavTag({
  dest,
  priority = 1000,
  description = '',
  icon = '',
  border = '',
}) {
  const prio = Number.isFinite(Number(priority)) ? Number(priority) : 1000;
  const d = String(dest || '').trim();
  if (!d) return null;
  const desc = String(description || '').replace(/:/g, ' ');
  const ic = String(icon || '').trim();
  const bd = String(border || '').trim().replace(/^#/, '');
  let enc = `${prio}:${d}:${desc}`;
  if (ic || bd) {
    enc += `:${ic}:${bd}`;
  }
  return `ostim_nav:${enc}`;
}

/** @param {string[]} tags */
export function parseOstimNavTags(tags) {
  /** @type {ReturnType<typeof parseNavText>} */
  const out = [];
  for (const tag of tags || []) {
    if (typeof tag !== 'string' || !tag.startsWith('ostim_nav:')) continue;
    out.push(...parseNavText(tag.slice('ostim_nav:'.length)));
  }
  return out;
}

/**
 * Replace `ostim_nav:` tags; keep all other tags (including ostim_nav_origin).
 * @param {string[]} tags
 * @param {Array<{ dest: string, priority?: number, description?: string, icon?: string, border?: string }>} navs
 */
export function tagsWithOstimNavs(tags, navs) {
  const kept = (tags || []).filter(
    (t) => typeof t !== 'string' || !t.startsWith('ostim_nav:')
  );
  for (const nav of navs || []) {
    const enc = encodeOstimNavTag(nav);
    if (enc) kept.push(enc);
  }
  return kept;
}

/**
 * Build outbound nav editor rows from scene graph + existing tags.
 * @param {{ graph?: object, stages?: object[] } | null} scene
 * @param {string} stageId
 * @param {string[]} tags
 * @param {object|null|undefined} liveGraph optional override (canvas / fullGraphRef)
 */
export function buildNavEditorRows(scene, stageId, tags, liveGraph) {
  const graph = liveGraph || scene?.graph || {};
  const destIds = graph?.[stageId]?.dest || [];
  const byOstim = new Map();
  for (const n of parseOstimNavTags(tags)) {
    if (n.dest) byOstim.set(n.dest, n);
  }
  const stages = scene?.stages || [];
  const rows = [];
  const seen = new Set();

  for (const id of destIds) {
    const stage = stages.find((s) => s.id === id);
    const oid = stageOstimId(stage) || id;
    const meta = byOstim.get(oid) || byOstim.get(id) || {};
    seen.add(oid);
    seen.add(id);
    rows.push({
      stageId: id,
      dest: oid,
      label: stage?.name || oid,
      priority: meta.priority ?? 1000,
      description: meta.description || '',
      icon: meta.icon || '',
      border: meta.border || '',
    });
  }

  // Orphan nav tags (external destinations not on this canvas).
  for (const [dest, meta] of byOstim) {
    if (seen.has(dest)) continue;
    rows.push({
      stageId: null,
      dest,
      label: dest,
      priority: meta.priority ?? 1000,
      description: meta.description || '',
      icon: meta.icon || '',
      border: meta.border || '',
      external: true,
    });
  }
  return rows;
}

export const NAV_TARGET_STORAGE_KEY = 'slsb.stageNavContext';

/**
 * Stash graph destinations for the stage editor window
 * (localStorage: shared across Tauri webviews).
 * Pass `liveGraph` (e.g. fullGraphRef / syncStoredGraphFromCanvas) — scene.graph
 * is often stale until the scene is saved.
 */
export function stashStageNavContext(scene, stageId, liveGraph) {
  try {
    const rows = buildNavEditorRows(scene, stageId, [], liveGraph).map((r) => ({
      stageId: r.stageId,
      dest: r.dest,
      label: r.label,
    }));
    localStorage.setItem(
      NAV_TARGET_STORAGE_KEY,
      JSON.stringify({
        sceneId: scene?.id || null,
        stageId,
        targets: rows,
      })
    );
  } catch (_) {
    /* ignore */
  }
}

export function loadStageNavContext() {
  try {
    const raw = localStorage.getItem(NAV_TARGET_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Merge graph destinations (stashed when opening the editor) with `ostim_nav:` tags.
 * @param {string} stageId
 * @param {string[]} tags
 */
export function resolveNavEditorRows(stageId, tags) {
  const ctx = loadStageNavContext();
  const targets =
    ctx && String(ctx.stageId) === String(stageId) ? ctx.targets || [] : [];
  const byOstim = new Map();
  for (const n of parseOstimNavTags(tags)) {
    if (n.dest) byOstim.set(n.dest, n);
  }
  const rows = [];
  const seen = new Set();

  for (const t of targets) {
    const dest = t.dest || t.stageId;
    if (!dest) continue;
    const meta =
      byOstim.get(dest) ||
      (t.stageId ? byOstim.get(t.stageId) : null) ||
      {};
    seen.add(dest);
    if (t.stageId) seen.add(t.stageId);
    rows.push({
      stageId: t.stageId || null,
      dest,
      label: t.label || dest,
      priority: meta.priority ?? 1000,
      description: meta.description || '',
      icon: meta.icon || '',
      border: meta.border || '',
      external: false,
    });
  }

  for (const [dest, meta] of byOstim) {
    if (seen.has(dest)) continue;
    rows.push({
      stageId: null,
      dest,
      label: dest,
      priority: meta.priority ?? 1000,
      description: meta.description || '',
      icon: meta.icon || '',
      border: meta.border || '',
      external: true,
    });
  }
  return rows;
}

/** Join unique descriptions (highest priority first) for Extras nav_text summary. */
export function readableNavTextFromRows(rows) {
  const sorted = [...(rows || [])].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
  );
  const seen = new Set();
  const labels = [];
  for (const r of sorted) {
    const d = String(r.description || '').trim();
    if (!d || seen.has(d)) continue;
    seen.add(d);
    labels.push(d);
  }
  return labels.join('; ');
}
