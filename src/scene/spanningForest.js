/**
 * Spanning forest over primary edges — drives browse layout + outline panel.
 * Editor-only projection; never written to OStim JSON.
 */

import { destStage } from '../common/destRef';
import {
  buildFamilyMap,
  isHubName,
  isTransitionStage,
  cleanStageName,
} from './stageFamily';
import {
  rankGraphEdges,
  SECONDARY_SCORE_CUTOFF,
} from './edgeRanker';
import { NODE_WIDTH, NODE_HEIGHT } from './SceneNode';

const ORIGIN = 40;
const H_GAP = 560;
const V_GAP = 280;
/** Extra space between stacked node bottoms and the next node top.
 * Wide enough to act as an edge passageway (several 14px-staggered lanes). */
const ROW_CLEARANCE = 128;
/** Max siblings stacked in one depth-column before spilling sideways. */
const MAX_BAND_ROWS = 6;

/**
 * Pick forest roots: scene root first, then uncovered hub/idle nodes.
 */
export function pickForestRoots(sceneGraph, rootId, nodeIds, { getName, edgeInfo } = {}) {
  const ids = nodeIds?.length ? nodeIds : Object.keys(sceneGraph || {});
  const nameOf = getName || ((id) => id);
  const idSet = new Set(ids);

  const inPrimary = new Map(ids.map((id) => [id, 0]));
  for (const info of edgeInfo?.values() || []) {
    if (info.rank !== 'primary') continue;
    if (!idSet.has(info.source) || !idSet.has(info.target)) continue;
    inPrimary.set(info.target, (inPrimary.get(info.target) || 0) + 1);
  }

  const roots = [];
  const seen = new Set();
  const push = (id) => {
    if (!id || !idSet.has(id) || seen.has(id)) return;
    seen.add(id);
    roots.push(id);
  };

  push(rootId);

  const scored = ids
    .filter((id) => id !== rootId)
    .map((id) => {
      const name = nameOf(id) || '';
      const out = (sceneGraph[id]?.dest || []).map(destStage).filter((d) => idSet.has(d)).length;
      let score = out * 5;
      if (isHubName(name)) score += 40;
      if (/\bIdle\b/i.test(cleanStageName(name))) score += 50;
      if (isTransitionStage(name)) score -= 100;
      if ((inPrimary.get(id) || 0) === 0) score += 25;
      return { id, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const { id, score } of scored) {
    if (score < 30) break;
    if ((inPrimary.get(id) || 0) === 0 || isHubName(nameOf(id))) {
      push(id);
    }
  }

  if (!roots.length && ids.length) roots.push(ids[0]);
  return roots;
}

/**
 * Build a spanning forest using highest-scoring primary edges (BFS multi-source).
 *
 * @returns {{
 *   edgeInfo: Map,
 *   families: Map<string,string>,
 *   roots: string[],
 *   parent: Map<string, string|null>,
 *   children: Map<string, string[]>,
 *   treeKeys: Set<string>,
 *   ranks: Map<string, number>,
 *   secondaryInbound: Map<string, number>,
 *   outline: Array,
 * }}
 */
export function buildSpanningForest(
  sceneGraph,
  rootId,
  nodeIds,
  { getName, stages = [] } = {}
) {
  const ids = nodeIds?.length ? nodeIds : Object.keys(sceneGraph || {});
  const idSet = new Set(ids);
  const nameOf = getName || ((id) => id);
  const { edgeInfo, families } = rankGraphEdges(sceneGraph, ids, {
    getName: nameOf,
    stages,
  });

  const roots = pickForestRoots(sceneGraph, rootId, ids, {
    getName: nameOf,
    edgeInfo,
  });

  /** @type {Map<string, string|null>} */
  const parent = new Map(ids.map((id) => [id, null]));
  /** @type {Map<string, string[]>} */
  const children = new Map(ids.map((id) => [id, []]));
  const treeKeys = new Set();
  const ranks = new Map();
  const visited = new Set();

  const queue = [];
  for (const r of roots) {
    visited.add(r);
    ranks.set(r, 0);
    queue.push(r);
  }

  while (queue.length) {
    const id = queue.shift();
    const outs = (sceneGraph[id]?.dest || [])
      .map(destStage)
      .filter((d) => idSet.has(d))
      .map((target) => {
        const key = `${id}\0${target}`;
        const info = edgeInfo.get(key);
        return {
          target,
          key,
          score: info?.score ?? -999,
          rank: info?.rank || 'secondary',
        };
      })
      .filter((e) => e.rank === 'primary' || e.score >= SECONDARY_SCORE_CUTOFF)
      .sort((a, b) => b.score - a.score);

    for (const e of outs) {
      if (visited.has(e.target)) continue;
      if (e.score < SECONDARY_SCORE_CUTOFF) continue;
      visited.add(e.target);
      parent.set(e.target, id);
      children.get(id).push(e.target);
      treeKeys.add(e.key);
      ranks.set(e.target, (ranks.get(id) || 0) + 1);
      queue.push(e.target);
    }
  }

  // Orphans: try attach via best inbound primary; else promote to root
  const orphans = ids.filter((id) => !visited.has(id));
  for (const id of orphans) {
    let best = null;
    for (const source of ids) {
      const dests = (sceneGraph[source]?.dest || []).map(destStage);
      if (!dests.includes(id)) continue;
      const info = edgeInfo.get(`${source}\0${id}`);
      if (!info || info.rank !== 'primary') continue;
      if (!visited.has(source)) continue;
      if (!best || info.score > best.score) {
        best = { source, score: info.score, key: `${source}\0${id}` };
      }
    }
    if (best) {
      visited.add(id);
      parent.set(id, best.source);
      children.get(best.source).push(id);
      treeKeys.add(best.key);
      ranks.set(id, (ranks.get(best.source) || 0) + 1);
    } else {
      visited.add(id);
      roots.push(id);
      ranks.set(id, 0);
    }
  }

  for (const [, kids] of children) {
    kids.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }

  const secondaryInbound = new Map(ids.map((id) => [id, 0]));
  for (const source of ids) {
    for (const target of (sceneGraph[source]?.dest || []).map(destStage)) {
      if (!idSet.has(target)) continue;
      const key = `${source}\0${target}`;
      if (treeKeys.has(key)) continue;
      secondaryInbound.set(target, (secondaryInbound.get(target) || 0) + 1);
    }
  }

  const outline = buildOutlineNodes(roots, children, {
    getName: nameOf,
    families,
    secondaryInbound,
    ranks,
    stages,
  });

  return {
    edgeInfo,
    families,
    roots,
    parent,
    children,
    treeKeys,
    ranks,
    secondaryInbound,
    outline,
  };
}

/**
 * Nested outline for the nav panel.
 */
export function buildOutlineNodes(
  roots,
  children,
  { getName, families, secondaryInbound, ranks, stages = [] } = {}
) {
  const nameOf = getName || ((id) => id);
  const stageById = new Map((stages || []).map((s) => [s.id, s]));
  const walk = (id) => {
    const kids = children.get(id) || [];
    const extra = secondaryInbound?.get(id) || 0;
    return {
      key: id,
      id,
      title: cleanStageName(nameOf(id)) || id,
      family: families?.get(id) || 'Other',
      rank: ranks?.get(id) ?? 0,
      extraEntries: extra,
      isTransition: isTransitionStage(stageById.get(id) || nameOf(id)),
      isHub: isHubName(nameOf(id)),
      children: kids.map(walk),
    };
  };
  return roots.map(walk);
}

/**
 * Place nodes like the Lovemaking navigation poster:
 * one band per pose family, LTR by forest depth — packed into columns so
 * large packs (100+) stay roughly viewport-shaped instead of a tall strip.
 *
 * @returns {Map<string,{x:number,y:number}>}
 */
export function layoutFromForest(
  ranks,
  nodeIds,
  {
    orphans = [],
    families = null,
    children = null,
    roots = [],
    getName = null,
    nodeSizes = null,
  } = {}
) {
  const ids = nodeIds?.length ? nodeIds : [...ranks.keys()];
  const nameOf = getName || ((id) => id);
  const large = ids.length > 40;
  const hGap = large ? 520 : H_GAP;
  const vGap = large ? 240 : V_GAP;
  const bandGap = large ? 144 : 128;
  const clearance = large ? 104 : ROW_CLEARANCE;
  const heightOf = (id) =>
    Math.max(NODE_HEIGHT, Number(nodeSizes?.get(id)?.height) || NODE_HEIGHT);
  const positions = new Map();

  const famMap = families || new Map(ids.map((id) => [id, 'Other']));
  const byFamily = new Map();
  for (const id of ids) {
    const f = famMap.get(id) || 'Other';
    if (!byFamily.has(f)) byFamily.set(f, []);
    byFamily.get(f).push(id);
  }

  const rootFamily = roots?.[0] ? famMap.get(roots[0]) : null;
  const childFamilyOrder = [];
  if (children && roots?.length) {
    for (const r of roots) {
      for (const c of children.get(r) || []) {
        const f = famMap.get(c);
        if (f && !childFamilyOrder.includes(f)) childFamilyOrder.push(f);
      }
    }
  }

  const familyNames = [...byFamily.keys()].sort((a, b) => {
    if (a === rootFamily) return -1;
    if (b === rootFamily) return 1;
    const ia = childFamilyOrder.indexOf(a);
    const ib = childFamilyOrder.indexOf(b);
    if (ia >= 0 || ib >= 0) {
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    }
    const da = byFamily.get(a).length;
    const db = byFamily.get(b).length;
    if (db !== da) return db - da;
    return a.localeCompare(b);
  });

  const bands = familyNames.map((family) => {
    const members = [...byFamily.get(family)];
    members.sort((a, b) => {
      const ra = ranks.has(a) ? ranks.get(a) : 999;
      const rb = ranks.has(b) ? ranks.get(b) : 999;
      if (ra !== rb) return ra - rb;
      return nameOf(a).localeCompare(nameOf(b));
    });

    const localRanks = new Map();
    let minR = Infinity;
    for (const id of members) {
      const r = ranks.has(id) ? ranks.get(id) : 0;
      localRanks.set(id, r);
      minR = Math.min(minR, r);
    }
    const base = Number.isFinite(minR) ? minR : 0;
    for (const id of members) {
      localRanks.set(id, localRanks.get(id) - base);
    }

    const byCol = new Map();
    for (const id of members) {
      const col = localRanks.get(id) || 0;
      if (!byCol.has(col)) byCol.set(col, []);
      byCol.get(col).push(id);
    }

    const maxRows = large ? MAX_BAND_ROWS : Math.max(MAX_BAND_ROWS, 10);
    const local = new Map();
    let maxXCol = 0;
    let bandHeight = 0;
    let xCursor = 0;
    for (const depth of [...byCol.keys()].sort((a, b) => a - b)) {
      const colIds = byCol.get(depth);
      const subCols = Math.max(1, Math.ceil(colIds.length / maxRows));
      /** Running Y top per sub-column (height-aware, not fixed vGap). */
      const subY = Array.from({ length: subCols }, () => 0);
      colIds.forEach((id, i) => {
        const sub = Math.floor(i / maxRows);
        const xCol = xCursor + sub;
        const h = heightOf(id);
        local.set(id, { x: xCol * hGap, y: subY[sub] });
        subY[sub] += h + clearance;
        maxXCol = Math.max(maxXCol, xCol);
      });
      bandHeight = Math.max(bandHeight, ...subY, vGap);
      xCursor += subCols;
    }

    return {
      family,
      members,
      local,
      width: (maxXCol + 1) * hGap,
      height: Math.max(bandHeight, vGap),
    };
  });

  const nFam = bands.length;
  const colCount = large
    ? Math.min(3, Math.max(2, Math.ceil(Math.sqrt(nFam))))
    : 1;
  const totalHeight = bands.reduce((s, b) => s + b.height + bandGap, 0);
  const targetColH = totalHeight / colCount;

  /** @type {Array<Array<typeof bands[0]>>} */
  const columns = Array.from({ length: colCount }, () => []);
  const colHeights = Array(colCount).fill(0);
  let colIdx = 0;
  for (const band of bands) {
    if (
      colIdx < colCount - 1 &&
      colHeights[colIdx] > 0 &&
      colHeights[colIdx] + band.height > targetColH * 1.15
    ) {
      colIdx += 1;
    }
    columns[colIdx].push(band);
    colHeights[colIdx] += band.height + bandGap;
  }

  const colWidths = columns.map((col) =>
    Math.max(hGap, ...col.map((b) => b.width), hGap)
  );
  let xOrigin = ORIGIN;
  for (let c = 0; c < columns.length; c++) {
    let yCursor = ORIGIN;
    for (const band of columns[c]) {
      for (const [id, loc] of band.local) {
        positions.set(id, {
          x: xOrigin + loc.x,
          y: yCursor + loc.y,
        });
      }
      yCursor += band.height + bandGap;
    }
    xOrigin += colWidths[c] + hGap * 0.75;
  }

  const missing = [
    ...orphans,
    ...ids.filter((id) => !positions.has(id)),
  ];
  if (missing.length) {
    const maxY = Math.max(
      ORIGIN,
      ...[...positions.entries()].map(([id, p]) => p.y + heightOf(id))
    );
    let y = maxY + bandGap;
    let x = ORIGIN;
    let col = 0;
    missing.forEach((id) => {
      if (positions.has(id)) return;
      const h = heightOf(id);
      positions.set(id, { x, y });
      if (!ranks.has(id)) ranks.set(id, -1);
      col += 1;
      if (col >= 5) {
        col = 0;
        x = ORIGIN;
        y += h + clearance;
      } else {
        x += hGap;
      }
    });
  }

  return positions;
}

/**
 * Path from a forest root to `nodeId` (inclusive), or [] if unknown.
 */
export function pathToNode(nodeId, parent) {
  if (!nodeId || !parent) return [];
  const path = [];
  let cur = nodeId;
  const guard = new Set();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    path.push(cur);
    cur = parent.get(cur);
  }
  return path.reverse();
}
