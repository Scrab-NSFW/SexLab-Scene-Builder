/**
 * Virtual folder canvases: mount one ostim_folder subset at a time.
 * Cross-folder links become portal nodes + bridge edges (IR stays whole-scene).
 * Cross-scene DestRefs become scene portals (same teal dashed stubs).
 */

import { destScene, destStage } from '../common/destRef';

export const PORTAL_PREFIX = '__slsb_portal__:';
export const SCENE_PORTAL_PREFIX = '__slsb_scene_portal__:';

/** @param {string} id */
export function isFolderPortalNodeId(id) {
  return typeof id === 'string' && id.startsWith(PORTAL_PREFIX);
}

/** @param {string} id */
export function isScenePortalNodeId(id) {
  return typeof id === 'string' && id.startsWith(SCENE_PORTAL_PREFIX);
}

/** @param {string} id */
export function isPortalNodeId(id) {
  return isFolderPortalNodeId(id) || isScenePortalNodeId(id);
}

/** @param {string} stageId */
export function portalIdForStage(stageId) {
  return `${PORTAL_PREFIX}${stageId}`;
}

/** @param {string} sceneId @param {string} stageId */
export function scenePortalId(sceneId, stageId) {
  return `${SCENE_PORTAL_PREFIX}${sceneId}:${stageId}`;
}

/** @param {string} portalId */
export function stageIdFromPortal(portalId) {
  if (isFolderPortalNodeId(portalId)) {
    return portalId.slice(PORTAL_PREFIX.length);
  }
  if (isScenePortalNodeId(portalId)) {
    const rest = portalId.slice(SCENE_PORTAL_PREFIX.length);
    const idx = rest.indexOf(':');
    if (idx < 0) return rest;
    return rest.slice(idx + 1);
  }
  return null;
}

/** @param {string} portalId */
export function sceneIdFromPortal(portalId) {
  if (!isScenePortalNodeId(portalId)) return null;
  const rest = portalId.slice(SCENE_PORTAL_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx < 0) return null;
  return rest.slice(0, idx);
}

/**
 * After transition collapse, restrict the pose graph to one folder and
 * replace cross-folder endpoints with portal stubs.
 *
 * @param {{
 *   poseGraph: Record<string, { dest?: string[], x?: number, y?: number }>,
 *   poseEdges: Array<{ source: string, target: string, viaStageId?: string|null, viaName?: string|null }>,
 *   folderFilter: string,
 *   folderMap: Map<string, string> | null,
 *   getName?: (id: string) => string,
 * }} args
 */
export function buildFolderViewProjection({
  poseGraph,
  poseEdges,
  folderFilter,
  folderMap,
  getName = null,
} = {}) {
  const nameOf = (id) => getName?.(id) || id;
  if (!folderFilter || folderFilter === 'all') {
    const ids = Object.keys(poseGraph || {});
    return {
      active: false,
      poseGraph,
      poseEdges: (poseEdges || []).map((e) => ({
        ...e,
        bridgeTargetId: null,
        bridgeSourceId: null,
        bridgeFolder: null,
        kind: e.viaStageId ? 'via' : 'forward',
      })),
      visibleIds: ids,
      realIds: ids,
      portalMeta: new Map(),
    };
  }

  const inView = (id) => (folderMap?.get(id) || '') === folderFilter;
  const visibleReal = Object.keys(poseGraph || {}).filter(inView);
  /** @type {Map<string, { stageId: string, folder: string, name: string, sceneId?: string, kind?: string }>} */
  const portalMeta = new Map();
  /** @type {Array<object>} */
  const newEdges = [];
  /** @type {Map<string, string[]>} */
  const destMap = new Map(visibleReal.map((id) => [id, []]));

  const ensurePortal = (stageId) => {
    const pid = portalIdForStage(stageId);
    if (!portalMeta.has(pid)) {
      portalMeta.set(pid, {
        stageId,
        folder: folderMap?.get(stageId) || '(other)',
        name: nameOf(stageId),
        kind: 'folder',
      });
    }
    if (!destMap.has(pid)) destMap.set(pid, []);
    return pid;
  };

  for (const e of poseEdges || []) {
    const sIn = inView(e.source);
    const tIn = inView(e.target);
    if (sIn && tIn) {
      newEdges.push({
        ...e,
        bridgeTargetId: null,
        bridgeSourceId: null,
        bridgeFolder: null,
        kind: e.viaStageId ? 'via' : 'forward',
      });
      destMap.get(e.source).push(e.target);
    } else if (sIn && !tIn) {
      const pid = ensurePortal(e.target);
      const folder = portalMeta.get(pid).folder;
      newEdges.push({
        source: e.source,
        target: pid,
        viaStageId: e.viaStageId || null,
        viaName: e.viaName || null,
        bridgeTargetId: e.target,
        bridgeSourceId: null,
        bridgeFolder: folder,
        kind: 'bridge',
      });
      destMap.get(e.source).push(pid);
    } else if (!sIn && tIn) {
      const pid = ensurePortal(e.source);
      const folder = portalMeta.get(pid).folder;
      newEdges.push({
        source: pid,
        target: e.target,
        viaStageId: e.viaStageId || null,
        viaName: e.viaName || null,
        bridgeTargetId: null,
        bridgeSourceId: e.source,
        bridgeFolder: folder,
        kind: 'bridge',
      });
      destMap.get(pid).push(e.target);
    }
  }

  let maxX = 40;
  let minY = 40;
  for (const id of visibleReal) {
    const p = poseGraph[id];
    maxX = Math.max(maxX, (Number(p?.x) || 40) + 240);
    minY = Math.min(minY, Number(p?.y) || 40);
  }

  /** @type {Record<string, { dest: string[], x: number, y: number }>} */
  const newGraph = {};
  for (const id of visibleReal) {
    newGraph[id] = {
      dest: [...new Set(destMap.get(id) || [])],
      x: Number(poseGraph[id]?.x) || 40,
      y: Number(poseGraph[id]?.y) || 40,
    };
  }

  const byFolder = new Map();
  for (const [pid, meta] of portalMeta) {
    if (!byFolder.has(meta.folder)) byFolder.set(meta.folder, []);
    byFolder.get(meta.folder).push(pid);
  }

  let folderCol = 0;
  for (const [, pids] of [...byFolder.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    pids.sort((a, b) =>
      (portalMeta.get(a)?.name || a).localeCompare(portalMeta.get(b)?.name || b)
    );
    pids.forEach((pid, i) => {
      newGraph[pid] = {
        dest: [...new Set(destMap.get(pid) || [])],
        x: maxX + 40 + folderCol * 210,
        y: minY + i * 88,
      };
    });
    folderCol += 1;
  }

  return {
    active: true,
    poseGraph: newGraph,
    poseEdges: newEdges,
    visibleIds: [...visibleReal, ...portalMeta.keys()],
    realIds: visibleReal,
    portalMeta,
  };
}

/**
 * Project absolute DestRefs that leave the active scene into teal portal stubs.
 * Keeps IR untouched; editor-only view (same idea as folder portals).
 */
export function injectCrossScenePortals({
  poseGraph,
  poseEdges,
  portalMeta,
  sceneGraph,
  owningSceneId,
  sceneCatalog = [],
} = {}) {
  if (!owningSceneId || !sceneGraph) {
    return {
      poseGraph,
      poseEdges,
      portalMeta: portalMeta || new Map(),
      visibleIds: Object.keys(poseGraph || {}),
      realIds: Object.keys(poseGraph || {}).filter((id) => !isPortalNodeId(id)),
    };
  }

  const catalogById = new Map((sceneCatalog || []).map((s) => [s.id, s]));
  /** @type {Map<string, any>} */
  const meta = new Map(portalMeta || []);
  /** @type {Record<string, { dest: any[], x: number, y: number }>} */
  const newGraph = {};
  for (const [id, node] of Object.entries(poseGraph || {})) {
    newGraph[id] = {
      dest: [...(node?.dest || [])],
      x: Number(node?.x) || 40,
      y: Number(node?.y) || 40,
    };
  }
  const newEdges = [...(poseEdges || [])];
  const edgeKeys = new Set(newEdges.map((e) => `${e.source}\0${e.target}`));

  for (const [fromId, node] of Object.entries(sceneGraph || {})) {
    if (!newGraph[fromId] || isPortalNodeId(fromId)) continue;
    for (const d of node.dest || []) {
      const toStage = destStage(d);
      const toScene = destScene(d, owningSceneId);
      if (!toStage || !toScene || toScene === owningSceneId) continue;

      const pid = scenePortalId(toScene, toStage);
      const sc = catalogById.get(toScene);
      const stageName =
        sc?.stages?.find((st) => st.id === toStage)?.name || toStage;
      const sceneName = sc?.name || toScene;

      if (!meta.has(pid)) {
        meta.set(pid, {
          stageId: toStage,
          folder: sceneName,
          name: stageName,
          sceneId: toScene,
          kind: 'scene',
        });
      }
      if (!newGraph[pid]) {
        newGraph[pid] = { dest: [], x: 40, y: 40 };
      }
      if (!(newGraph[fromId].dest || []).includes(pid)) {
        newGraph[fromId].dest.push(pid);
      }
      const ek = `${fromId}\0${pid}`;
      if (!edgeKeys.has(ek)) {
        edgeKeys.add(ek);
        newEdges.push({
          source: fromId,
          target: pid,
          viaStageId: null,
          viaName: null,
          bridgeTargetId: toStage,
          bridgeSourceId: null,
          bridgeFolder: sceneName,
          bridgeSceneId: toScene,
          kind: 'bridge',
        });
      }
    }
  }

  const realIds = Object.keys(newGraph).filter((id) => !isPortalNodeId(id));
  let maxX = 40;
  let minY = 40;
  for (const id of realIds) {
    const p = newGraph[id];
    maxX = Math.max(maxX, (Number(p?.x) || 40) + 240);
    minY = Math.min(minY, Number(p?.y) || 40);
  }

  const scenePortals = [...meta.keys()]
    .filter(isScenePortalNodeId)
    .sort(
      (a, b) =>
        (meta.get(a)?.folder || '').localeCompare(meta.get(b)?.folder || '') ||
        (meta.get(a)?.name || '').localeCompare(meta.get(b)?.name || '')
    );
  scenePortals.forEach((pid, i) => {
    newGraph[pid] = {
      dest: [...(newGraph[pid]?.dest || [])],
      x: maxX + 80,
      y: minY + i * 100,
    };
  });

  return {
    poseGraph: newGraph,
    poseEdges: newEdges,
    portalMeta: meta,
    visibleIds: Object.keys(newGraph),
    realIds,
  };
}

/**
 * Place portal stubs beside the real nodes that link to them (not in a
 * far top-right corridor). Mutates `positions`. Call after real-node layout
 * and before edge routing.
 *
 * @param {Map<string, {x:number,y:number}>} positions
 * @param {{
 *   portalMeta?: Map<string, any>,
 *   poseEdges?: Array<{ source: string, target: string }>,
 *   nodeSizes?: Map<string, { width?: number, height?: number }> | null,
 *   portalWidth?: number,
 *   portalHeight?: number,
 * }} [opts]
 */
export function placePortalNodes(
  positions,
  {
    portalMeta = null,
    poseEdges = [],
    nodeSizes = null,
    portalWidth = 240,
    portalHeight = 72,
  } = {}
) {
  if (!positions || !portalMeta?.size) return;

  const sizeOf = (id) => {
    const s = nodeSizes?.get(id);
    return {
      w: Number(s?.width) || 240,
      h: Number(s?.height) || 112,
    };
  };

  /** @type {Map<string, Array<{ id: string, x: number, y: number, w: number, h: number }>>} */
  const anchors = new Map();
  for (const e of poseEdges || []) {
    const sPortal = isPortalNodeId(e.source);
    const tPortal = isPortalNodeId(e.target);
    if (sPortal === tPortal) continue;
    const pid = sPortal ? e.source : e.target;
    const realId = sPortal ? e.target : e.source;
    const p = positions.get(realId);
    if (!p) continue;
    const sz = sizeOf(realId);
    if (!anchors.has(pid)) anchors.set(pid, []);
    anchors.get(pid).push({
      id: realId,
      x: p.x,
      y: p.y,
      w: sz.w,
      h: sz.h,
    });
  }

  // Wide enough for an entry stub + a staggered approach gutter (bridge
  // routes need ~28px stub + lane offsets without clipping the last column).
  const gapX = 128;
  const gapY = 20;
  const realBoxes = [];
  for (const [id, p] of positions) {
    if (isPortalNodeId(id) || !p) continue;
    const sz = sizeOf(id);
    realBoxes.push({
      x: p.x,
      y: p.y,
      w: sz.w,
      h: sz.h,
    });
  }

  const overlapsBox = (x, y, w, h, boxes) => {
    for (const b of boxes) {
      if (x < b.x + b.w + 12 && x + w + 12 > b.x && y < b.y + b.h + 12 && y + h + 12 > b.y) {
        return true;
      }
    }
    return false;
  };

  /** Group portals that share the same primary anchor so they stack neatly. */
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  const sortedPids = [...portalMeta.keys()].sort(
    (a, b) =>
      String(portalMeta.get(a)?.folder || '').localeCompare(
        String(portalMeta.get(b)?.folder || '')
      ) ||
      String(portalMeta.get(a)?.name || '').localeCompare(
        String(portalMeta.get(b)?.name || '')
      )
  );

  for (const pid of sortedPids) {
    const list = anchors.get(pid) || [];
    let gkey = 'orphan';
    if (list.length) {
      // Prefer the leftmost (usually hub/source) anchor as the stack key.
      const primary = [...list].sort(
        (a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id)
      )[0];
      gkey = primary.id;
    }
    if (!groups.has(gkey)) groups.set(gkey, []);
    groups.get(gkey).push(pid);
  }

  let orphanCol = 0;
  /** @type {Array<{ x: number, y: number, w: number, h: number }>} */
  const placedPortals = [];

  for (const [gkey, pids] of groups) {
    const union = [];
    for (const pid of pids) {
      for (const a of anchors.get(pid) || []) union.push(a);
    }

    let baseX;
    let baseY;
    if (union.length) {
      baseX = Math.max(...union.map((a) => a.x + a.w)) + gapX;
      const mids = union.map((a) => a.y + a.h / 2).sort((a, b) => a - b);
      baseY = mids[Math.floor(mids.length / 2)] - portalHeight / 2;
      // Keep the stack starting near the primary hub when all links share one source.
      if (gkey !== 'orphan') {
        const hub = positions.get(gkey);
        const hubSz = sizeOf(gkey);
        if (hub) {
          baseX = hub.x + hubSz.w + gapX;
          baseY = hub.y;
          // If the next real column is too close, park past the whole graph
          // but keep Y aligned with the hub (avoids top-right corridor + long edges).
          const hubRight = hub.x + hubSz.w;
          const nextCol = realBoxes
            .filter((b) => b.x >= hubRight + 20)
            .sort((a, b) => a.x - b.x || a.y - b.y)[0];
          if (nextCol && nextCol.x - hubRight < portalWidth + gapX + 48) {
            baseX =
              Math.max(...realBoxes.map((b) => b.x + b.w), hubRight) + gapX;
          }
        }
      }
    } else {
      let maxX = 40;
      let minY = 40;
      for (const b of realBoxes) {
        maxX = Math.max(maxX, b.x + b.w);
        minY = Math.min(minY, b.y);
      }
      baseX = maxX + 80 + orphanCol * (portalWidth + gapX);
      baseY = minY;
      orphanCol += 1;
    }

    pids.forEach((pid, i) => {
      let x = baseX;
      let y = baseY + i * (portalHeight + gapY);
      // Nudge down/right if we would cover a real stage.
      let guard = 0;
      while (
        guard < 40 &&
        (overlapsBox(x, y, portalWidth, portalHeight, realBoxes) ||
          overlapsBox(x, y, portalWidth, portalHeight, placedPortals))
      ) {
        y += portalHeight + gapY;
        guard += 1;
        if (guard === 20) {
          x += portalWidth + gapX;
          y = baseY;
        }
      }
      positions.set(pid, { x, y });
      placedPortals.push({ x, y, w: portalWidth, h: portalHeight });
    });
  }
}

/**
 * Short orth path for portal/bridge edges (avoids global under-lane detours).
 * @returns {{ vertices: Array<{x:number,y:number}>, sourcePort: string, targetPort: string }}
 */
function bridgeSegmentHitsRect(a, b, r) {
  const eps = 0.5;
  if (Math.abs(a.y - b.y) < eps) {
    const y = a.y;
    if (y < r.y - eps || y > r.y + r.height + eps) return false;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return maxX > r.x + eps && minX < r.x + r.width - eps;
  }
  if (Math.abs(a.x - b.x) < eps) {
    const x = a.x;
    if (x < r.x - eps || x > r.x + r.width + eps) return false;
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return maxY > r.y + eps && minY < r.y + r.height - eps;
  }
  return false;
}

function bridgePathClear(pts, obstacles) {
  if (!obstacles?.length) return true;
  for (let i = 0; i < pts.length - 1; i++) {
    for (const o of obstacles) {
      if (bridgeSegmentHitsRect(pts[i], pts[i + 1], o)) return false;
    }
  }
  return true;
}

/**
 * Short orth path for portal/bridge edges. Obstacle-aware: tries the gutter
 * before the target, the mid gutter, the gutter after the source, then a
 * double-jog through a clear horizontal corridor between node rows.
 * @returns {{ vertices: Array<{x:number,y:number}>, sourcePort: string, targetPort: string }}
 */
export function simpleBridgeRoute(
  sp,
  tp,
  ss,
  ts,
  slotIndex = 0,
  { outY = null, inY = null, inSlot = 0, obstacles = [], lane = 0 } = {}
) {
  const stub = 28;
  const slot = Math.max(0, Number(slotIndex) || 0);
  const sh = Math.max(24, Number(ss?.h) || 112);
  const th = Math.max(24, Number(ts?.h) || 112);
  // Callers should pass the real port anchors; the fallbacks only approximate.
  const oy = outY ?? sp.y + Math.min(sh - 8, Math.max(20, 28 + slot * 20));
  const iy = inY ?? tp.y + th * 0.5;
  const exitX = sp.x + (Number(ss?.w) || 240);
  const enterX = tp.x;
  const laneOff = Math.max(0, Number(lane) || 0) * 14;
  const ports = {
    sourcePort: `out${slot}`,
    targetPort: `in${Math.max(0, Number(inSlot) || 0)}`,
  };

  const zAt = (gx) => [
    { x: exitX, y: oy },
    { x: gx, y: oy },
    { x: gx, y: iy },
    { x: enterX, y: iy },
  ];
  const midX = Math.round((exitX + enterX) / 2) + laneOff;

  // Backward (portal left of source) is rare — keep the plain mid Z.
  if (enterX - exitX < stub * 2 + 16) {
    return { ...ports, vertices: zAt(midX) };
  }

  const gxEarly = exitX + stub + laneOff;
  const gxLate = enterX - stub - laneOff;
  for (const gx of [gxLate, midX, gxEarly]) {
    if (gx <= exitX + 8 || gx >= enterX - 8) continue;
    const path = zAt(gx);
    if (bridgePathClear(path, obstacles)) {
      return { ...ports, vertices: path };
    }
  }

  // Both port Ys are blocked across the span: jog through a clear horizontal
  // corridor between the node rows sitting in the way.
  if (gxLate > gxEarly + 8) {
    const blockers = (obstacles || []).filter(
      (o) => o.x < gxLate && o.x + o.width > gxEarly
    );
    /** Merge blocker Y intervals, then route through the gaps. */
    const spans = blockers
      .map((o) => [o.y - 10, o.y + o.height + 10])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([...s]);
    }
    const corridors = [];
    for (let i = 0; i < merged.length - 1; i++) {
      const gap = merged[i + 1][0] - merged[i][1];
      if (gap >= 28) corridors.push((merged[i][1] + merged[i + 1][0]) / 2);
    }
    if (merged.length) {
      corridors.push(merged[0][0] - 24 - laneOff);
      corridors.push(merged[merged.length - 1][1] + 24 + laneOff);
    }
    const midYPref = (oy + iy) / 2;
    corridors.sort((a, b) => Math.abs(a - midYPref) - Math.abs(b - midYPref));
    for (const cyBase of corridors) {
      // Staggered first so parallel bridges don't share one corridor line.
      const cyCandidates = laneOff
        ? [cyBase + laneOff, cyBase + laneOff / 2, cyBase]
        : [cyBase];
      for (const cy of cyCandidates) {
        const path = [
          { x: exitX, y: oy },
          { x: gxEarly, y: oy },
          { x: gxEarly, y: cy },
          { x: gxLate, y: cy },
          { x: gxLate, y: iy },
          { x: enterX, y: iy },
        ];
        if (bridgePathClear(path, obstacles)) {
          return { ...ports, vertices: path };
        }
      }
    }
  }

  return { ...ports, vertices: zAt(midX) };
}

/**
 * Stage ids that belong to the active folder view (for graph sync merge).
 * @param {Map<string, string>|null} folderMap
 * @param {string} folderFilter
 * @param {string[]} allStageIds
 */
export function folderViewStageIds(folderMap, folderFilter, allStageIds) {
  if (!folderFilter || folderFilter === 'all') return null;
  return (allStageIds || []).filter(
    (id) => (folderMap?.get(id) || '') === folderFilter
  );
}
