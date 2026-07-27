import { cleanStageName, isTransitionStage } from './stageFamily';
import { isPortalNodeId } from './folderView';
import { destScene, destStage, makeDest, normalizeDest } from '../common/destRef';

export function shortTransitionLabel(name) {
  const cleaned = cleanStageName(name || '');
  return cleaned.replace(/^Go to\s+/i, '') || cleaned || 'transition';
}

function pushDest(next, s, t) {
  if (!s || !t || !next[s]) return;
  const stageId = destStage(t) || (typeof t === 'string' ? t : '');
  if (!stageId) return;
  if ((next[s].dest || []).some((d) => destStage(d) === stageId && !destScene(d))) {
    return;
  }
  if ((next[s].dest || []).some((d) => destStage(d) === stageId)) return;
  next[s].dest.push(typeof t === 'string' ? t : normalizeDest(t, ''));
}

function applyExpandedEdge(next, s, t, via) {
  if (!s || !t || !next[s]) return;
  if (via && next[via]) {
    pushDest(next, s, via);
    pushDest(next, via, t);
    const sp = next[s];
    const tp = next[t];
    if (sp && tp) {
      next[via].x = (sp.x + tp.x) / 2;
      next[via].y = (sp.y + tp.y) / 2;
    }
  } else {
    pushDest(next, s, t);
  }
}

/**
 * @param {object} sceneGraph
 * @param {{ stages?: object[], getName?: (id: string) => string, enabled?: boolean }} [opts]
 */
export function buildCollapseProjection(
  sceneGraph,
  { stages = [], getName = null, enabled = true } = {}
) {
  const stageById = new Map((stages || []).map((s) => [s.id, s]));
  const ids = Object.keys(sceneGraph || {});
  const idSet = new Set(ids);
  const nameOf = (id) => getName?.(id) || stageById.get(id)?.name || id;

  const inbound = new Map(ids.map((id) => [id, []]));
  for (const s of ids) {
    for (const d of sceneGraph[s]?.dest || []) {
      const t = destStage(d);
      if (!t || !idSet.has(t)) continue;
      if (!inbound.has(t)) inbound.set(t, []);
      inbound.get(t).push(s);
    }
  }

  const isTrans = (id) =>
    isTransitionStage(stageById.get(id) || nameOf(id));

  /** @type {Set<string>} */
  const hiddenIds = new Set();
  /** @type {Array<{ source: string, target: string, viaStageId: string|null, viaName: string|null }>} */
  const poseEdges = [];
  /** @type {Map<string, string>} */
  const viaByPoseEdge = new Map();

  if (!enabled) {
    for (const s of ids) {
      for (const d of sceneGraph[s]?.dest || []) {
        const t = destStage(d);
        if (!t || !idSet.has(t)) continue;
        poseEdges.push({
          source: s,
          target: t,
          viaStageId: null,
          viaName: null,
        });
      }
    }
    return {
      hiddenIds,
      poseEdges,
      poseGraph: sceneGraph,
      visibleIds: ids,
      viaByPoseEdge,
    };
  }

  for (const id of ids) {
    if (!isTrans(id)) continue;
    const outs = (sceneGraph[id]?.dest || [])
      .map(destStage)
      .filter((t) => t && idSet.has(t));
    const ins = inbound.get(id) || [];
    if (outs.length !== 1 || ins.length !== 1) continue;
    const a = ins[0];
    const c = outs[0];
    if (!ids.includes(a) || !ids.includes(c)) continue;
    if (isTrans(a) || isTrans(c)) continue;
    hiddenIds.add(id);
    const key = `${a}\0${c}`;
    viaByPoseEdge.set(key, id);
    poseEdges.push({
      source: a,
      target: c,
      viaStageId: id,
      viaName: nameOf(id),
    });
  }

  for (const s of ids) {
    if (hiddenIds.has(s)) continue;
    for (const d of sceneGraph[s]?.dest || []) {
      const t = destStage(d);
      if (!t || !idSet.has(t) || hiddenIds.has(t)) continue;
      const key = `${s}\0${t}`;
      if (viaByPoseEdge.has(key)) continue;
      poseEdges.push({
        source: s,
        target: t,
        viaStageId: null,
        viaName: null,
      });
    }
  }

  const visibleIds = ids.filter((id) => !hiddenIds.has(id));
  const poseGraph = {};
  for (const id of visibleIds) {
    const dest = [];
    for (const e of poseEdges) {
      if (e.source === id) dest.push(e.target);
    }
    poseGraph[id] = {
      ...(sceneGraph[id] || {}),
      dest: [...new Set(dest)],
    };
  }

  return {
    hiddenIds,
    poseEdges,
    poseGraph,
    visibleIds,
    viaByPoseEdge,
  };
}

/**
 * Rebuild stored graph from canvas cells while preserving coords and cross-scene DestRefs.
 */
export function expandCanvasToStoredGraph({
  stages,
  prevGraph = {},
  nodes = [],
  edges = [],
  viewStageIds = null,
  sceneId = '',
}) {
  const next = {};
  for (const stage of stages || []) {
    const prev = prevGraph[stage.id] || {};
    next[stage.id] = {
      dest: [],
      x: Number(prev.x) || 40,
      y: Number(prev.y) || 40,
    };
  }

  const nodePos = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, pos] of nodePos) {
    if (isPortalNodeId(id)) continue;
    if (!next[id]) {
      next[id] = { dest: [], x: pos.x, y: pos.y };
    } else {
      next[id].x = pos.x;
      next[id].y = pos.y;
    }
  }

  for (const edge of edges) {
    const via = edge.viaStageId || null;
    if (edge.bridgeTargetId && !isPortalNodeId(edge.source)) {
      applyExpandedEdge(next, edge.source, edge.bridgeTargetId, via);
      continue;
    }
    if (edge.bridgeSourceId && !isPortalNodeId(edge.target)) {
      applyExpandedEdge(next, edge.bridgeSourceId, edge.target, via);
      continue;
    }
    const s = edge.source;
    const t = edge.target;
    if (!s || !t || isPortalNodeId(s) || isPortalNodeId(t)) continue;
    applyExpandedEdge(next, s, t, via);
  }

  const viewSet = viewStageIds?.length ? new Set(viewStageIds) : null;
  if (viewSet) {
    for (const [s, node] of Object.entries(prevGraph || {})) {
      if (!next[s] || viewSet.has(s)) continue;
      for (const t of node.dest || []) {
        pushDest(next, s, t);
      }
    }
  }

  // Cross-scene DestRefs are not drawn on the canvas; keep them across sync.
  if (sceneId) {
    for (const [s, node] of Object.entries(prevGraph || {})) {
      if (!next[s]) continue;
      for (const d of node.dest || []) {
        const sc = destScene(d, sceneId);
        if (!sc || sc === sceneId) continue;
        const abs = makeDest(sc, destStage(d));
        if (
          !(next[s].dest || []).some(
            (x) => destStage(x) === abs.stage && destScene(x, sceneId) === abs.scene
          )
        ) {
          next[s].dest.push(abs);
        }
      }
    }
  }

  return next;
}

/**
 * Degree counts for visible pose graph (for slot sizing).
 * @returns {{ inCount: Map<string, number>, outCount: Map<string, number> }}
 */
export function degreeMaps(poseGraph) {
  const ids = Object.keys(poseGraph || {});
  const inCount = new Map(ids.map((id) => [id, 0]));
  const outCount = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) {
    const dest = (poseGraph[id]?.dest || []).map(destStage).filter(Boolean);
    outCount.set(id, dest.length);
    for (const t of dest) {
      inCount.set(t, (inCount.get(t) || 0) + 1);
    }
  }
  return { inCount, outCount };
}
