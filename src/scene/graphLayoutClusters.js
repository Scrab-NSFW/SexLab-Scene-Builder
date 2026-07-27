import { destStage } from '../common/destRef';
import { NODE_WIDTH, NODE_HEIGHT } from './SceneNode';
import {
  isTransitionStage,
  isHubName,
  buildFamilyMap,
  LARGE_SCENE_NODE_THRESHOLD,
} from './stageFamily';

export { LARGE_SCENE_NODE_THRESHOLD };

const ORIGIN = 48;
const CLUSTER_COLS = 3;
const CLUSTER_PAD_X = 140;
const CLUSTER_PAD_Y = 160;
/** Horizontal step between node origins — must leave a clear corridor for edges. */
const INNER_H_GAP = 600; // NODE_WIDTH(240) + ~360px gutter
const INNER_V_GAP = 280; // NODE_HEIGHT(112) + ~168px gutter
const TRANS_V_GAP = 220;
const MAX_INNER_COLS = 3;
const LABEL_BAND = 48;

function degreeMaps(sceneGraph, nodeIds) {
  const idSet = new Set(nodeIds);
  const outD = new Map();
  const inD = new Map();
  nodeIds.forEach((id) => {
    outD.set(id, 0);
    inD.set(id, 0);
  });
  nodeIds.forEach((id) => {
    const dest = (sceneGraph[id]?.dest || []).map(destStage).filter((d) => idSet.has(d));
    outD.set(id, dest.length);
    dest.forEach((d) => inD.set(d, (inD.get(d) || 0) + 1));
  });
  return { outD, inD };
}

function pickHub(memberIds, getName, outD, inD, rootId) {
  if (memberIds.includes(rootId)) return rootId;
  let best = memberIds[0];
  let bestScore = -1;
  for (const id of memberIds) {
    const name = getName(id) || '';
    const deg = (outD.get(id) || 0) + (inD.get(id) || 0);
    let score = deg * 10;
    if (isHubName(name)) score += 50;
    if (/\bIdle\b/i.test(name)) score += 40;
    if (isTransitionStage(name)) score -= 30;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/**
 * Place nodes in labeled family clusters on a 2D grid.
 *
 * @param {object} sceneGraph
 * @param {string} rootId
 * @param {string[]} nodeIds
 * @param {{ getName?: (id: string) => string }} [opts]
 * @returns {{
 *   positions: Map<string,{x:number,y:number}>,
 *   families: Map<string,string>,
 *   clusters: Array<{ family: string, hubId: string, members: string[], x: number, y: number, width: number, height: number }>,
 *   hubReturnCounts: Map<string, number>,
 * }}
 */
export function layoutFamilyClusters(
  sceneGraph,
  rootId,
  nodeIds,
  { getName, nodeSizes = null } = {}
) {
  const ids = nodeIds?.length ? nodeIds : Object.keys(sceneGraph || {});
  const nameOf = getName || ((id) => id);
  const families = buildFamilyMap(ids, nameOf);
  const { outD, inD } = degreeMaps(sceneGraph, ids);
  // Nodes grow taller with port count — fixed row steps made them overlap.
  const heightOf = (id) =>
    Math.max(NODE_HEIGHT, Number(nodeSizes?.get(id)?.height) || NODE_HEIGHT);

  /** @type {Map<string, string[]>} */
  const byFamily = new Map();
  for (const id of ids) {
    const f = families.get(id) || 'Other';
    if (!byFamily.has(f)) byFamily.set(f, []);
    byFamily.get(f).push(id);
  }

  const rootFamily = families.get(rootId) || null;
  const familyNames = [...byFamily.keys()].sort((a, b) => {
    if (a === rootFamily) return -1;
    if (b === rootFamily) return 1;
    const da = byFamily.get(a).length;
    const db = byFamily.get(b).length;
    if (db !== da) return db - da;
    return a.localeCompare(b);
  });

  const positions = new Map();
  const clusters = [];

  const clusterLayouts = familyNames.map((family) => {
    const members = byFamily.get(family);
    const hubId = pickHub(members, nameOf, outD, inD, rootId);
    const transitions = members.filter((id) => isTransitionStage(nameOf(id)));
    const poses = members.filter(
      (id) => id !== hubId && !isTransitionStage(nameOf(id))
    );
    const ordered = [
      hubId,
      ...poses.sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
      ...transitions.sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
    ];

    const innerPositions = new Map();
    innerPositions.set(hubId, { x: 0, y: 0 });

    const rest = ordered.filter((id) => id !== hubId);
    const poseRest = rest.filter((id) => !isTransitionStage(nameOf(id)));
    const transRest = rest.filter((id) => isTransitionStage(nameOf(id)));

    // Advance each column by the actual node height (+ gutter), not a fixed step.
    const poseGutter = INNER_V_GAP - NODE_HEIGHT;
    const poseColY = Array(MAX_INNER_COLS + 1).fill(0);
    poseRest.forEach((id, i) => {
      const col = (i % MAX_INNER_COLS) + 1;
      innerPositions.set(id, {
        x: col * INNER_H_GAP,
        y: poseColY[col],
      });
      poseColY[col] += heightOf(id) + poseGutter;
    });

    const transGutter = TRANS_V_GAP - NODE_HEIGHT;
    const transY0 =
      Math.max(
        INNER_V_GAP,
        heightOf(hubId) + poseGutter,
        ...poseColY
      ) + 24;
    const transColY = Array(MAX_INNER_COLS + 1).fill(transY0);
    transRest.forEach((id, i) => {
      const col = i % (MAX_INNER_COLS + 1);
      innerPositions.set(id, {
        x: col * (INNER_H_GAP * 0.85),
        y: transColY[col],
      });
      transColY[col] += heightOf(id) + transGutter;
    });

    let maxX = NODE_WIDTH;
    let maxY = NODE_HEIGHT;
    for (const [id, pos] of innerPositions) {
      maxX = Math.max(maxX, pos.x + NODE_WIDTH);
      maxY = Math.max(maxY, pos.y + heightOf(id));
    }

    return {
      family,
      hubId,
      members: ordered,
      innerPositions,
      width: maxX + 40,
      height: maxY + 56,
    };
  });

  const assignments = clusterLayouts.map((cl, index) => ({
    cl,
    col: index % CLUSTER_COLS,
  }));
  const colHeights = Array(CLUSTER_COLS).fill(0);
  assignments.forEach((a, index) => {
    if (index >= CLUSTER_COLS) {
      let best = 0;
      for (let c = 1; c < CLUSTER_COLS; c++) {
        if (colHeights[c] < colHeights[best]) best = c;
      }
      a.col = best;
    }
    a.rowY = colHeights[a.col];
    colHeights[a.col] += a.cl.height + LABEL_BAND + CLUSTER_PAD_Y;
  });

  const colWidths = Array(CLUSTER_COLS).fill(400);
  assignments.forEach((a) => {
    colWidths[a.col] = Math.max(colWidths[a.col], a.cl.width);
  });
  const colX = [];
  let xRun = ORIGIN;
  for (let c = 0; c < CLUSTER_COLS; c++) {
    colX[c] = xRun;
    xRun += colWidths[c] + CLUSTER_PAD_X;
  }

  assignments.forEach(({ cl, col, rowY }) => {
    const clusterX = colX[col];
    const clusterY = ORIGIN + rowY;
    for (const [id, loc] of cl.innerPositions) {
      positions.set(id, {
        x: clusterX + loc.x,
        y: clusterY + LABEL_BAND + loc.y,
      });
    }
    clusters.push({
      family: cl.family,
      hubId: cl.hubId,
      members: cl.members,
      x: clusterX,
      y: clusterY,
      width: colWidths[col],
      height: cl.height + LABEL_BAND,
    });
  });

  const hubReturnCounts = new Map();
  for (const cl of clusters) {
    hubReturnCounts.set(cl.hubId, 0);
  }
  const idSet = new Set(ids);
  for (const id of ids) {
    const dests = (sceneGraph[id]?.dest || []).map(destStage).filter((d) => idSet.has(d));
    const srcFam = families.get(id);
    for (const d of dests) {
      const dstFam = families.get(d);
      if (srcFam !== dstFam && hubReturnCounts.has(d)) {
        hubReturnCounts.set(d, hubReturnCounts.get(d) + 1);
      }
    }
  }

  return { positions, families, clusters, hubReturnCounts };
}

/**
 * Decide which edges should be drawn for a given visibility mode.
 *
 * @param {'family'|'neighborhood'|'all'|'primary'} mode
 * @param {object} sceneGraph
 * @param {string[]} nodeIds
 * @param {Map<string,string>} families
 * @param {{
 *   focusNodeIds?: string[],
 *   ranks?: Map<string,number>,
 *   treeKeys?: Set<string>,
 *   edgeInfo?: Map<string, { rank?: string }>,
 * }} [opts]
 * @returns {Set<string>} keys `${source}\0${target}`
 */
export function visibleEdgeKeys(
  mode,
  sceneGraph,
  nodeIds,
  families,
  { focusNodeIds = [], ranks = null, treeKeys = null, edgeInfo = null } = {}
) {
  const idSet = new Set(nodeIds);
  const keys = new Set();
  const focus = new Set(focusNodeIds.filter(Boolean));
  void ranks;

  for (const source of nodeIds) {
    const dests = (sceneGraph[source]?.dest || []).map(destStage).filter((d) => idSet.has(d));
    for (const target of dests) {
      const key = `${source}\0${target}`;
      // Always show every edge touching the focused node(s).
      if (focus.size && (focus.has(source) || focus.has(target))) {
        keys.add(key);
        continue;
      }
      if (mode === 'all') {
        keys.add(key);
        continue;
      }
      if (mode === 'neighborhood') {
        // No focus → nothing (focus case handled above).
        continue;
      }
      if (mode === 'primary') {
        const inTree = treeKeys ? treeKeys.has(key) : false;
        const rankedPrimary = edgeInfo?.get(key)?.rank === 'primary';
        if (inTree || rankedPrimary) keys.add(key);
        continue;
      }
      const sf = families.get(source);
      const tf = families.get(target);
      if (sf && tf && sf === tf) keys.add(key);
    }
  }

  return keys;
}

/**
 * Build connection rows for the table view.
 * Kinds: primary / secondary (semantic), plus cycle / cross when applicable.
 */
export function buildConnectionRows(
  sceneGraph,
  nodeIds,
  { getName, families, ranks, edgeInfo = null, treeKeys = null } = {}
) {
  const idSet = new Set(nodeIds);
  const nameOf = getName || ((id) => id);
  const fam = families || buildFamilyMap(nodeIds, nameOf);
  const pairSet = new Set();
  for (const source of nodeIds) {
    for (const target of (sceneGraph[source]?.dest || []).map(destStage).filter((d) => idSet.has(d))) {
      pairSet.add(`${source}\0${target}`);
    }
  }
  void ranks;
  const rows = [];
  for (const source of nodeIds) {
    const dests = (sceneGraph[source]?.dest || []).map(destStage).filter((d) => idSet.has(d));
    for (const target of dests) {
      const key = `${source}\0${target}`;
      const sf = fam.get(source) || 'Other';
      const tf = fam.get(target) || 'Other';
      const info = edgeInfo?.get(key);
      let kind = info?.rank === 'secondary' ? 'secondary' : 'primary';
      if (pairSet.has(`${target}\0${source}`)) kind = 'cycle';
      else if (sf !== tf && kind === 'primary') kind = 'cross';
      if (info?.rank === 'secondary') kind = 'secondary';
      const srcName = nameOf(source) || source;
      rows.push({
        key,
        source,
        target,
        sourceName: srcName,
        targetName: nameOf(target) || target,
        sourceFamily: sf,
        targetFamily: tf,
        kind,
        inTree: treeKeys ? treeKeys.has(key) : false,
        score: info?.score ?? 0,
        fixedLen: isTransitionStage(srcName),
      });
    }
  }
  return rows;
}

/**
 * Family-band layout is handled by layoutFromForest. Keep cluster helper
 * available but off by default — forest bands match the nav poster better.
 */
export function shouldUseClusterLayout(_nodeCount) {
  return false;
}
