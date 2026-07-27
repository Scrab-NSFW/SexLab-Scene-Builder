import { destStage } from '../common/destRef';
import {
  NODE_WIDTH,
  NODE_HEIGHT,
  outPortId,
  inPortId,
  parsePortRef,
  portArgsOnNode,
  nodeHeightForDegree,
  nodeWidthForKind,
} from './SceneNode';
import {
  STAGE_EDGE_SHAPEID,
  ROUNDED_CONNECTOR,
  forwardEdgeAttrs,
  backEdgeAttrs,
} from './SceneEdge';

const ORIGIN = 40;
const MAX_STAGES_PER_ROW = 5;
const MAX_PER_COLUMN = 8;
/** Clearance past the node edge before the first bend. */
const STUB = 72;
const STUB_STEP = 16;
const LANE_GAP = 64;
const BACK_LANE_GAP = 88;
const TOP_LANE_GAP = 70;
const SUBCOL_GAP = 72;
/** Min orth segment so X6 rounded corners (r≈20) look clean. */
const MIN_SEG = 56;

function LanePool(start, gap) {
  let next = 0;
  return {
    take() {
      const v = start + next * gap;
      next += 1;
      return v;
    },
  };
}

/** True when all nodes share one origin or form a degenerate column/row. */
export function graphCoordsStacked(sceneGraph) {
  const positions = Object.values(sceneGraph || {}).map(({ x, y }) => ({
    x: Number(x) || 0,
    y: Number(y) || 0,
  }));
  if (positions.length < 2) return false;
  const first = positions[0];
  if (positions.every((p) => p.x === first.x && p.y === first.y)) return true;
  const sameX = positions.every((p) => p.x === first.x);
  const sameY = positions.every((p) => p.y === first.y);
  return sameX || sameY;
}

function buildAdjacency(sceneGraph, nodeIds) {
  const idSet = new Set(nodeIds);
  const outgoing = new Map();
  const incoming = new Map();
  nodeIds.forEach((id) => {
    outgoing.set(id, []);
    incoming.set(id, []);
  });
  nodeIds.forEach((id) => {
    const dest = (sceneGraph[id]?.dest || []).map(destStage).filter((d) => idSet.has(d));
    outgoing.set(id, dest);
    dest.forEach((d) => incoming.get(d).push(id));
  });
  return { outgoing, incoming };
}

function assignRanks(outgoing, nodeIds, rootId) {
  const start = nodeIds.includes(rootId) ? rootId : nodeIds[0];
  const ranks = new Map();
  const queue = start ? [start] : [];
  if (start) ranks.set(start, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const dest of outgoing.get(id) || []) {
      if (!ranks.has(dest)) {
        ranks.set(dest, ranks.get(id) + 1);
        queue.push(dest);
      }
    }
  }
  const orphans = nodeIds.filter((id) => !ranks.has(id));
  return { ranks, orphans };
}

function orderByBarycenter(byLevel, outgoing, incoming) {
  const orderIndex = new Map();
  const syncOrder = () => {
    orderIndex.clear();
    for (const [, ids] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
      ids.forEach((id, i) => orderIndex.set(id, i));
    }
  };
  const avg = (ids) => {
    const vals = ids.map((id) => orderIndex.get(id)).filter((v) => v !== undefined);
    if (!vals.length) return Number.POSITIVE_INFINITY;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  syncOrder();
  for (let pass = 0; pass < 4; pass++) {
    for (const [lv, ids] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
      if (lv === 0) continue;
      ids.sort((a, b) => avg(incoming.get(a) || []) - avg(incoming.get(b) || []));
      byLevel.set(lv, ids);
    }
    syncOrder();
    for (const [lv, ids] of [...byLevel.entries()].sort((a, b) => b[0] - a[0])) {
      ids.sort((a, b) => avg(outgoing.get(a) || []) - avg(outgoing.get(b) || []));
      byLevel.set(lv, ids);
    }
    syncOrder();
  }
}

function placeNodes(byLevel, orphans, nodeIds, ranks, nodeSizes = null) {
  // Folder-sized scenes (typical after OStim split) get generous gutters so
  // orth edges stay readable; mega-scenes stay a bit denser.
  const large = nodeIds.length > 40;
  const hGap = large ? 540 : 580;
  const vGap = large ? 250 : 280;
  const clearance = large ? 64 : 80;
  const maxCol = large ? MAX_PER_COLUMN : Math.max(MAX_PER_COLUMN, 12);
  const heightOf = (id) =>
    Math.max(NODE_HEIGHT, Number(nodeSizes?.get(id)?.height) || NODE_HEIGHT);

  const ordered = [];
  for (const [, ids] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    ordered.push(...ids);
  }
  ordered.push(...orphans);

  const linear =
    orphans.length === 0 &&
    [...byLevel.values()].every((ids) => ids.length <= 1);

  const positions = new Map();

  if (linear && ordered.length > MAX_STAGES_PER_ROW) {
    const rowY = [];
    ordered.forEach((id, i) => {
      const row = Math.floor(i / MAX_STAGES_PER_ROW);
      const col = i % MAX_STAGES_PER_ROW;
      if (rowY[row] == null) {
        rowY[row] =
          row === 0
            ? ORIGIN
            : rowY[row - 1] +
              Math.max(
                ...ordered
                  .slice((row - 1) * MAX_STAGES_PER_ROW, row * MAX_STAGES_PER_ROW)
                  .map((oid) => heightOf(oid)),
                NODE_HEIGHT
              ) +
              clearance;
      }
      positions.set(id, {
        x: ORIGIN + col * hGap,
        y: rowY[row],
      });
    });
    return { positions, hGap, vGap };
  }

  let xCursor = ORIGIN;
  for (const [, ids] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const subCols = Math.max(1, Math.ceil(ids.length / maxCol));
    const subY = Array.from({ length: subCols }, () => ORIGIN);
    ids.forEach((id, i) => {
      const sub = Math.floor(i / maxCol);
      positions.set(id, {
        x: xCursor + sub * (NODE_WIDTH + SUBCOL_GAP),
        y: subY[sub],
      });
      subY[sub] += heightOf(id) + clearance;
    });
    xCursor += Math.max(hGap, subCols * (NODE_WIDTH + SUBCOL_GAP) + 80);
  }

  if (orphans.length) {
    const maxY = Math.max(
      ORIGIN,
      ...[...positions.entries()].map(([id, p]) => p.y + heightOf(id)),
      0
    );
    const orphanY = maxY + vGap;
    const orphanRowY = [orphanY];
    orphans.forEach((id, i) => {
      const row = Math.floor(i / MAX_STAGES_PER_ROW);
      const col = i % MAX_STAGES_PER_ROW;
      if (orphanRowY[row] == null) {
        const prevIds = orphans.slice(
          (row - 1) * MAX_STAGES_PER_ROW,
          row * MAX_STAGES_PER_ROW
        );
        orphanRowY[row] =
          orphanRowY[row - 1] +
          Math.max(...prevIds.map((oid) => heightOf(oid)), NODE_HEIGHT) +
          clearance;
      }
      positions.set(id, {
        x: ORIGIN + col * hGap,
        y: orphanRowY[row],
      });
      if (!ranks.has(id)) ranks.set(id, -1);
    });
  }

  return { positions, hGap, vGap };
}

function portY(pos, size) {
  const h = size?.height || NODE_HEIGHT;
  return pos.y + h / 2;
}

function portX(pos, size) {
  const w = size?.width || NODE_WIDTH;
  return pos.x + w / 2;
}

function sizeOf(nodeSizes, id) {
  return (
    nodeSizes?.get(id) || {
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      inCount: 1,
      outCount: 1,
    }
  );
}

function slotAxisPoint(pos, size, portId) {
  const ref = parsePortRef(portId);
  const w = size?.width || NODE_WIDTH;
  const h = size?.height || NODE_HEIGHT;
  const args = portArgsOnNode(
    ref.side,
    ref.role,
    ref.index,
    size?.inCount || 1,
    size?.outCount || 1,
    w,
    h
  );
  return { x: pos.x + args.x, y: pos.y + args.y, ...ref };
}

/**
 * Prefer vertical sides when cards overlap in X; LTR/RTL otherwise.
 */
function chooseSides(sp, tp, ss, ts) {
  const dx = portX(tp, ts) - portX(sp, ss);
  const dy = portY(tp, ts) - portY(sp, ss);
  const sw = ss?.width || NODE_WIDTH;
  const tw = ts?.width || NODE_WIDTH;
  const avgW = (sw + tw) / 2;
  const overlapX =
    Math.min(sp.x + sw, tp.x + tw) - Math.max(sp.x, tp.x);
  const stacked =
    Math.abs(dy) > NODE_HEIGHT * 0.55 &&
    (overlapX > avgW * 0.25 || Math.abs(dx) < avgW * 1.05);
  if (stacked) {
    return {
      outSide: dy >= 0 ? 'bottom' : 'top',
      inSide: dy >= 0 ? 'top' : 'bottom',
      stacked: true,
    };
  }
  return {
    outSide: dx >= 0 ? 'right' : 'left',
    inSide: dx >= 0 ? 'left' : 'right',
    stacked: false,
  };
}

/** Stub just outside a node side, anchored to a unique per-edge port. */
function sideStub(pos, side, stub, along = 0, role = 'out', size = null, portOverride = null) {
  const s = size || {
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    inCount: 1,
    outCount: 1,
  };
  const port =
    portOverride ||
    (role === 'out' ? outPortId(side, 0) : inPortId(side, 0));
  const anchor = slotAxisPoint(pos, s, port);
  const w = s.width || NODE_WIDTH;
  const h = s.height || NODE_HEIGHT;
  switch (side) {
    case 'left':
      return { x: pos.x - stub, y: anchor.y + along, port };
    case 'right':
      return { x: pos.x + w + stub, y: anchor.y + along, port };
    case 'top':
      return { x: anchor.x + along, y: pos.y - stub, port };
    case 'bottom':
      return { x: anchor.x + along, y: pos.y + h + stub, port };
    default:
      return { x: pos.x + w + stub, y: anchor.y + along, port };
  }
}

function assignSlotPorts(edges, getName) {
  const nameOf = getName || ((id) => id);
  /** @type {Map<string, string[]>} */
  const outs = new Map();
  /** @type {Map<string, string[]>} */
  const inns = new Map();
  for (const e of edges) {
    if (!outs.has(e.source)) outs.set(e.source, []);
    if (!inns.has(e.target)) inns.set(e.target, []);
    outs.get(e.source).push(e.target);
    inns.get(e.target).push(e.source);
  }
  for (const [, list] of outs) {
    list.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }
  for (const [, list] of inns) {
    list.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }
  /** @type {Map<string, { out: string, in: string, outIndex: number, inIndex: number }>} */
  const slots = new Map();
  for (const e of edges) {
    const oi = Math.max(0, outs.get(e.source).indexOf(e.target));
    const ii = Math.max(0, inns.get(e.target).indexOf(e.source));
    slots.set(`${e.source}\0${e.target}`, {
      out: `out${oi}`,
      in: `in${ii}`,
      outIndex: oi,
      inIndex: ii,
    });
  }
  return slots;
}

function routeBetweenStubs(exit, enter, outSide, inSide, midPrefer) {
  const ex = exit.x;
  const ey = exit.y;
  const ix = enter.x;
  const iy = enter.y;
  const outVert = outSide === 'top' || outSide === 'bottom';
  const inVert = inSide === 'top' || inSide === 'bottom';

  /** Keep orth mid-bend between the stubs — outside = bow-tie / reverse jog. */
  const clampMid = (mid, a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo < 4) return (a + b) / 2;
    const margin = Math.min(12, (hi - lo) * 0.2);
    const raw = mid != null ? mid : (a + b) / 2;
    return Math.min(Math.max(raw, lo + margin), hi - margin);
  };

  if (outVert && inVert) {
    // Vertices must stay on the ports' X — averaging them made X6 draw
    // diagonals from the real ports through nodes.
    if (Math.abs(ex - ix) < 8) {
      return simplifyOrtho([
        { x: ex, y: ey },
        { x: ix, y: iy },
      ]);
    }
    if (Math.abs(ey - iy) < 8) {
      return simplifyOrtho([
        { x: ex, y: ey },
        { x: ix, y: iy },
      ]);
    }
    const midY = clampMid(midPrefer, ey, iy);
    return simplifyOrtho([
      { x: ex, y: ey },
      { x: ex, y: midY },
      { x: ix, y: midY },
      { x: ix, y: iy },
    ]);
  }

  if (!outVert && !inVert) {
    if (Math.abs(ey - iy) < 8) {
      return simplifyOrtho([
        { x: ex, y: ey },
        { x: ix, y: iy },
      ]);
    }
    const midX = clampMid(midPrefer, ex, ix);
    return simplifyOrtho([
      { x: ex, y: ey },
      { x: midX, y: ey },
      { x: midX, y: iy },
      { x: ix, y: iy },
    ]);
  }

  if (outVert) {
    return simplifyOrtho([
      { x: ex, y: ey },
      { x: ex, y: iy },
      { x: ix, y: iy },
    ]);
  }
  return simplifyOrtho([
    { x: ex, y: ey },
    { x: ix, y: ey },
    { x: ix, y: iy },
  ]);
}

function classifyEdge(sourceRank, targetRank) {
  // Provisional — planEdges reclassifies by geometry.
  if (sourceRank < 0 || targetRank < 0) {
    if (targetRank >= 0 && sourceRank < 0) return 'forward';
    if (sourceRank >= 0 && targetRank < 0) return 'back';
    return 'same';
  }
  if (targetRank > sourceRank) return 'forward';
  if (targetRank < sourceRank) return 'back';
  return 'same';
}

/** Route kind from node placement. */
function geometricRouteKind(sp, tp) {
  const dx = tp.x - sp.x;
  const dy = tp.y - sp.y;
  if (dx < -NODE_WIDTH * 0.2) return 'back';
  if (Math.abs(dx) < 48 && Math.abs(dy) < NODE_HEIGHT * 0.35) return 'same';
  if (Math.abs(dx) < 48 && dy < 0) return 'back';
  return 'forward';
}

function collectEdges(outgoing, ranks) {
  const edges = [];
  for (const [source, dests] of outgoing) {
    for (const target of dests) {
      const sr = ranks.has(source) ? ranks.get(source) : -1;
      const tr = ranks.has(target) ? ranks.get(target) : -1;
      edges.push({
        source,
        target,
        kind: classifyEdge(sr, tr),
        sourceRank: sr,
        targetRank: tr,
      });
    }
  }
  return edges;
}

function indexBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function pairBounds(sp, tp, ss, ts) {
  const sw = ss?.width || NODE_WIDTH;
  const sh = ss?.height || NODE_HEIGHT;
  const tw = ts?.width || NODE_WIDTH;
  const th = ts?.height || NODE_HEIGHT;
  return {
    minX: Math.min(sp.x, tp.x),
    maxX: Math.max(sp.x + sw, tp.x + tw),
    minY: Math.min(sp.y, tp.y),
    maxY: Math.max(sp.y + sh, tp.y + th),
  };
}

function simplifyOrtho(pts) {
  if (!pts?.length) return [];
  const out = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    const prev = out[out.length - 1];
    if (Math.abs(cur.x - prev.x) < 1 && Math.abs(cur.y - prev.y) < 1) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const horiz = Math.abs(a.y - prev.y) < 1 && Math.abs(prev.y - cur.y) < 1;
      const vert = Math.abs(a.x - prev.x) < 1 && Math.abs(prev.x - cur.x) < 1;
      if (horiz || vert) {
        out[out.length - 1] = { x: cur.x, y: cur.y };
        continue;
      }
    }
    out.push({ x: cur.x, y: cur.y });
  }
  return out;
}

/** U under the pair; never first-moves left into the source. */
function underU(exitX, exitY, enterX, enterY, laneY, sidePrefer) {
  const floorY = Math.max(laneY, Math.max(exitY, enterY) + MIN_SEG);
  if (Math.abs(exitX - enterX) < MIN_SEG) {
    const sideX =
      sidePrefer != null
        ? Math.max(sidePrefer, exitX + MIN_SEG, enterX + MIN_SEG)
        : Math.max(exitX, enterX) + MIN_SEG;
    return simplifyOrtho([
      { x: exitX, y: exitY },
      { x: sideX, y: exitY },
      { x: sideX, y: enterY },
      { x: enterX, y: enterY },
    ]);
  }
  return simplifyOrtho([
    { x: exitX, y: exitY },
    { x: exitX, y: floorY },
    { x: enterX, y: floorY },
    { x: enterX, y: enterY },
  ]);
}

function overU(exitX, exitY, enterX, enterY, laneY, sidePrefer) {
  const ceilY = Math.min(laneY, Math.min(exitY, enterY) - MIN_SEG);
  if (Math.abs(exitX - enterX) < MIN_SEG) {
    const sideX =
      sidePrefer != null
        ? Math.max(sidePrefer, exitX + MIN_SEG, enterX + MIN_SEG)
        : Math.max(exitX, enterX) + MIN_SEG;
    return simplifyOrtho([
      { x: exitX, y: exitY },
      { x: sideX, y: exitY },
      { x: sideX, y: enterY },
      { x: enterX, y: enterY },
    ]);
  }
  return simplifyOrtho([
    { x: exitX, y: exitY },
    { x: exitX, y: ceilY },
    { x: enterX, y: ceilY },
    { x: enterX, y: enterY },
  ]);
}

function sideC(exitX, exitY, enterX, enterY, sideX) {
  const sx = Math.max(sideX, exitX + MIN_SEG, enterX + MIN_SEG);
  return simplifyOrtho([
    { x: exitX, y: exitY },
    { x: sx, y: exitY },
    { x: sx, y: enterY },
    { x: enterX, y: enterY },
  ]);
}

/** Ortho Z; falls back to under-U when enterX is not right of exitX. */
function gutterZ(exitX, exitY, enterX, enterY, midX) {
  if (enterX < exitX + MIN_SEG) {
    const floorY = Math.max(exitY, enterY) + MIN_SEG;
    return simplifyOrtho([
      { x: exitX, y: exitY },
      { x: exitX, y: floorY },
      { x: enterX, y: floorY },
      { x: enterX, y: enterY },
    ]);
  }
  const span = enterX - exitX;
  if (span < MIN_SEG * 2) {
    const floorY = Math.max(exitY, enterY) + MIN_SEG;
    return simplifyOrtho([
      { x: exitX, y: exitY },
      { x: exitX, y: floorY },
      { x: enterX, y: floorY },
      { x: enterX, y: enterY },
    ]);
  }
  let mx = midX;
  const lo = exitX + MIN_SEG * 0.5;
  const hi = enterX - MIN_SEG * 0.5;
  if (hi > lo) mx = Math.min(Math.max(mx, lo), hi);
  else mx = (exitX + enterX) / 2;
  if (Math.abs(enterY - exitY) < 8) {
    return simplifyOrtho([
      { x: exitX, y: exitY },
      { x: enterX, y: enterY },
    ]);
  }
  return simplifyOrtho([
    { x: exitX, y: exitY },
    { x: mx, y: exitY },
    { x: mx, y: enterY },
    { x: enterX, y: enterY },
  ]);
}

const OBS_PAD = 22;
/** How far a left/right wrap may run past the pair before we recycle lanes. */
const MAX_SIDE_OUTWARD = 168;
/** Tighter packing for same-column return/forward wraps. */
const COL_LANE_GAP = 32;

function segmentHitsRect(a, b, r) {
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
  // Non-ortho (shouldn't happen): sample the segment so diagonals can't
  // sneak through nodes undetected.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.max(4, Math.ceil((Math.abs(dx) + Math.abs(dy)) / 24));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    if (
      x >= r.x - eps &&
      x <= r.x + r.width + eps &&
      y >= r.y - eps &&
      y <= r.y + r.height + eps
    ) {
      return true;
    }
  }
  return false;
}

function pathLength(pts) {
  if (!pts?.length) return Infinity;
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len +=
      Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
  }
  return len;
}

function pathHitsObstacle(pts, obstacles) {
  if (!pts?.length || !obstacles?.length) return false;
  for (let i = 0; i < pts.length - 1; i++) {
    for (const obs of obstacles) {
      if (segmentHitsRect(pts[i], pts[i + 1], obs)) return true;
    }
  }
  return false;
}

/** Prefer clear paths; among those, shorter. `bias` breaks near-ties. */
function pickBestCandidate(candidates, obstacles) {
  if (!candidates?.length) return null;
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (!c?.path?.length) continue;
    const hits = pathHitsObstacle(c.path, obstacles);
    const score =
      (hits ? 1e9 : 0) + pathLength(c.path) + (c.bias || 0);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best || candidates[0];
}

/** Same-side exit/entry wraps outside the pair. */
function sameSideWrap(exit, enter, side, lanePrefer) {
  if (side === 'right' || side === 'left') {
    const sx =
      side === 'right'
        ? Math.max(lanePrefer, exit.x + MIN_SEG, enter.x + MIN_SEG)
        : Math.min(lanePrefer, exit.x - MIN_SEG, enter.x - MIN_SEG);
    return simplifyOrtho([
      { x: exit.x, y: exit.y },
      { x: sx, y: exit.y },
      { x: sx, y: enter.y },
      { x: enter.x, y: enter.y },
    ]);
  }
  const sy =
    side === 'bottom'
      ? Math.max(lanePrefer, exit.y + MIN_SEG, enter.y + MIN_SEG)
      : Math.min(lanePrefer, exit.y - MIN_SEG, enter.y - MIN_SEG);
  return simplifyOrtho([
    { x: exit.x, y: exit.y },
    { x: exit.x, y: sy },
    { x: enter.x, y: sy },
    { x: enter.x, y: enter.y },
  ]);
}

/** Facing, same-side, and mixed side pairs; primary listed first. */
function candidateSidePairs(primary, { preferRightWrap = false } = {}) {
  const facing = [
    [primary.outSide, primary.inSide],
    ['right', 'left'],
    ['left', 'right'],
    ['bottom', 'top'],
    ['top', 'bottom'],
  ];
  // Same-column graphs: keep wraps on the content/right gutter, not the
  // empty left margin (which otherwise stacks lanes out to x=-1000+).
  const same = preferRightWrap
    ? [
        ['right', 'right'],
        ['left', 'left'],
        ['bottom', 'bottom'],
        ['top', 'top'],
      ]
    : [
        ['right', 'right'],
        ['left', 'left'],
        ['bottom', 'bottom'],
        ['top', 'top'],
      ];
  const mixed = [
    ['right', 'top'],
    ['right', 'bottom'],
    ['left', 'top'],
    ['left', 'bottom'],
    ['top', 'left'],
    ['top', 'right'],
    ['bottom', 'left'],
    ['bottom', 'right'],
  ];
  const seen = new Set();
  const out = [];
  for (const pair of [...facing, ...same, ...mixed]) {
    const key = `${pair[0]}>${pair[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out;
}

function buildObstacleRects(positions, excludeIds, nodeSizes) {
  const skip = new Set(excludeIds || []);
  const rects = [];
  for (const [id, pos] of positions) {
    if (skip.has(id) || !pos) continue;
    const s = sizeOf(nodeSizes, id);
    rects.push({
      id,
      x: pos.x - OBS_PAD,
      y: pos.y - OBS_PAD,
      width: s.width + OBS_PAD * 2,
      height: s.height + OBS_PAD * 2,
    });
  }
  return rects;
}

function planEdges(rawEdges, positions, { isDark = false, nodeSizes = null, getName = null } = {}) {
  /** @type {Map<string, ReturnType<typeof LanePool>>} */
  const localUnderPools = new Map();
  /** @type {Map<string, ReturnType<typeof LanePool>>} */
  const localOverPools = new Map();
  /** @type {Map<string, ReturnType<typeof LanePool>>} */
  const sideWrapPools = new Map();
  /** Mid X (vertical gutters) and mid Y (horizontal gutters) already taken. */
  /** @type {number[]} */
  const takenGutterMidsX = [];
  /** @type {number[]} */
  const takenGutterMidsY = [];
  /** @type {Map<string, number>} */
  const underAssigned = new Map();
  /** @type {Map<string, number>} */
  const overAssigned = new Map();
  /** @type {Map<string, number>} */
  const gutterAssigned = new Map();
  /** @type {Map<string, number>} */
  const stubOutCount = new Map();
  /** @type {Map<string, number>} */
  const stubInCount = new Map();

  const edgeToken = (source, target) => `${source}\0${target}`;
  const slots = assignSlotPorts(rawEdges, getName);

  const takeLocalUnder = (sp, tp, ss, ts, edgeToken) => {
    const b = pairBounds(sp, tp, ss, ts);
    const key = `u:${Math.round(b.maxY / 48)}:${Math.round((b.minX + b.maxX) / 240)}`;
    if (!localUnderPools.has(key)) {
      localUnderPools.set(key, LanePool(b.maxY + MIN_SEG, BACK_LANE_GAP));
    }
    const pool = localUnderPools.get(key);
    const assignedKey = `${key}\0${edgeToken}`;
    if (underAssigned.has(assignedKey)) return { laneY: underAssigned.get(assignedKey), bounds: b };
    const laneY = pool.take();
    underAssigned.set(assignedKey, laneY);
    return { laneY, bounds: b };
  };

  const takeLocalOver = (sp, tp, ss, ts, edgeToken) => {
    const b = pairBounds(sp, tp, ss, ts);
    const key = `o:${Math.round(b.minY / 48)}:${Math.round((b.minX + b.maxX) / 240)}`;
    if (!localOverPools.has(key)) {
      localOverPools.set(
        key,
        LanePool(Math.max(8, b.minY - MIN_SEG), -TOP_LANE_GAP)
      );
    }
    const pool = localOverPools.get(key);
    const assignedKey = `${key}\0${edgeToken}`;
    if (overAssigned.has(assignedKey)) return { laneY: overAssigned.get(assignedKey), bounds: b };
    const laneY = pool.take();
    overAssigned.set(assignedKey, laneY);
    return { laneY, bounds: b };
  };

  const takeSideWrap = (side, prefer, edgeToken, gap = LANE_GAP) => {
    const key = `s:${side}:${Math.round(prefer / 48)}:${gap}`;
    if (!sideWrapPools.has(key)) {
      sideWrapPools.set(
        key,
        LanePool(prefer, side === 'left' ? -Math.abs(gap) : Math.abs(gap))
      );
    }
    const assignedKey = `${key}\0${edgeToken}`;
    if (gutterAssigned.has(assignedKey)) return gutterAssigned.get(assignedKey);
    let v = sideWrapPools.get(key).take();
    // Recycle when wraps run away into empty margin (single-column returns).
    if (side === 'left' && prefer - v > MAX_SIDE_OUTWARD) {
      const slots = Math.max(1, Math.floor(MAX_SIDE_OUTWARD / Math.abs(gap)));
      const idx = Math.round((prefer - v) / Math.abs(gap));
      v = prefer - (idx % slots) * Math.abs(gap);
    } else if (side === 'right' && v - prefer > MAX_SIDE_OUTWARD) {
      const slots = Math.max(1, Math.floor(MAX_SIDE_OUTWARD / Math.abs(gap)));
      const idx = Math.round((v - prefer) / Math.abs(gap));
      v = prefer + (idx % slots) * Math.abs(gap);
    }
    gutterAssigned.set(assignedKey, v);
    return v;
  };

  /**
   * Global mid spacing so adjacent corridor buckets cannot land ~20px apart.
   * Vertical gutters (right↔left Z) use X; horizontal gutters use Y.
   */
  const takeGutterMid = (prefer, axis, edgeToken) => {
    const assignedKey = `${axis}:${edgeToken}`;
    if (gutterAssigned.has(assignedKey)) return gutterAssigned.get(assignedKey);
    const taken = axis === 'x' ? takenGutterMidsX : takenGutterMidsY;
    let v = prefer;
    for (let n = 0; n < 48; n++) {
      const ok = taken.every((t) => Math.abs(t - v) >= LANE_GAP * 0.9);
      if (ok) break;
      const step = Math.ceil((n + 1) / 2) * LANE_GAP;
      v = prefer + (n % 2 === 0 ? step : -step);
    }
    taken.push(v);
    gutterAssigned.set(assignedKey, v);
    return v;
  };

  const peekStub = (map, id, side) => {
    const key = `${id}:${side}`;
    const i = map.get(key) || 0;
    return { stub: STUB + (i % 5) * STUB_STEP, along: 0, key, i };
  };
  const commitStub = (map, key, i) => {
    map.set(key, i + 1);
  };

  const forwardAttrs = forwardEdgeAttrs(isDark);
  const backAttrs = backEdgeAttrs(isDark);

  const classified = rawEdges.map((edge) => {
    const sp = positions.get(edge.source);
    const tp = positions.get(edge.target);
    if (!sp || !tp) return { ...edge, kind: edge.kind || 'forward' };
    return { ...edge, kind: geometricRouteKind(sp, tp) };
  });

  const sorted = [...classified].sort((a, b) => {
    const kindOrder = { forward: 0, same: 1, back: 2 };
    if (kindOrder[a.kind] !== kindOrder[b.kind]) {
      return kindOrder[a.kind] - kindOrder[b.kind];
    }
    const ax = positions.get(a.source)?.x ?? 0;
    const bx = positions.get(b.source)?.x ?? 0;
    if (ax !== bx) return ax - bx;
    return (positions.get(a.target)?.y ?? 0) - (positions.get(b.target)?.y ?? 0);
  });

  return sorted.map((edge) => {
    const sp = positions.get(edge.source);
    const tp = positions.get(edge.target);
    const ss = sizeOf(nodeSizes, edge.source);
    const ts = sizeOf(nodeSizes, edge.target);
    const slot = slots.get(`${edge.source}\0${edge.target}`) || {
      out: 'out0',
      in: 'in0',
      outIndex: 0,
      inIndex: 0,
    };
    if (!sp || !tp) {
      return {
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        sourcePort: slot.out,
        targetPort: slot.in,
        slotOut: slot.out,
        slotIn: slot.in,
        router: { name: 'orth', args: { padding: 36 } },
        connector: ROUNDED_CONNECTOR,
        vertices: [],
        attrs: forwardAttrs,
      };
    }

    const primarySides = chooseSides(sp, tp, ss, ts);
    const stacked = !!primarySides.stacked;
    // Stacked returns: side wrap on the content gutter reads clearer than
    // top↔bottom Zs (slot X mismatch + mid-lane jogs looked broken).
    const stackedReturn = stacked && edge.kind === 'back';
    if (stackedReturn) {
      primarySides.outSide = 'right';
      primarySides.inSide = 'right';
    }
    // Don't treat endpoints as obstacles — stubs sit just outside them.
    const obstacles = buildObstacleRects(
      positions,
      [edge.source, edge.target],
      nodeSizes
    );
    const attrs = edge.kind === 'back' ? backAttrs : forwardAttrs;
    const bounds = pairBounds(sp, tp, ss, ts);
    const token = edgeToken(edge.source, edge.target);
    let preferRightBase = bounds.maxX + MIN_SEG;
    // Same-column: park wraps past anything sitting in the right gutter
    // (scene portals), instead of fleeing into the empty left margin.
    if (stacked) {
      for (const o of obstacles) {
        if (o.y + o.height < bounds.minY - 8 || o.y > bounds.maxY + 8) continue;
        if (o.x + o.width <= bounds.maxX + 4) continue;
        preferRightBase = Math.max(
          preferRightBase,
          o.x + o.width + COL_LANE_GAP
        );
      }
      // Prefer the mid-gutter between this column and the next (if any),
      // when it's wide enough — shorter than routing past every portal.
      let nextLeft = Infinity;
      for (const o of obstacles) {
        if (o.x <= bounds.maxX + 4) continue;
        if (o.y + o.height < bounds.minY - 8 || o.y > bounds.maxY + 8) continue;
        nextLeft = Math.min(nextLeft, o.x);
      }
      if (Number.isFinite(nextLeft)) {
        const gutterMid = (bounds.maxX + nextLeft) / 2;
        if (nextLeft - bounds.maxX >= MIN_SEG + 16) {
          preferRightBase = Math.min(preferRightBase, gutterMid);
          preferRightBase = Math.max(preferRightBase, bounds.maxX + MIN_SEG * 0.75);
        }
      }
    }
    const preferLeftBase = bounds.minX - MIN_SEG;
    const wrapGap = stacked ? COL_LANE_GAP : LANE_GAP;
    const { laneY: underY } = takeLocalUnder(sp, tp, ss, ts, token);
    const { laneY: overY } = takeLocalOver(sp, tp, ss, ts, token);

    const planForSides = (outSide, inSide) => {
      const outMeta = peekStub(stubOutCount, edge.source, outSide);
      const inMeta = peekStub(stubInCount, edge.target, inSide);
      // Stacked vertical facing: use center ports so the run stays a straight line.
      const vertFacing =
        (outSide === 'top' || outSide === 'bottom') &&
        (inSide === 'top' || inSide === 'bottom');
      const outPort = outPortId(
        outSide,
        stacked && vertFacing ? 0 : slot.outIndex ?? 0
      );
      const inPort = inPortId(
        inSide,
        stacked && vertFacing ? 0 : slot.inIndex ?? 0
      );
      const exit = sideStub(
        sp,
        outSide,
        outMeta.stub,
        outMeta.along,
        'out',
        ss,
        outPort
      );
      const enter = sideStub(
        tp,
        inSide,
        inMeta.stub,
        inMeta.along,
        'in',
        ts,
        inPort
      );
      const same = outSide === inSide;
      let path;
      if (same) {
        const lane =
          outSide === 'right'
            ? takeSideWrap('right', preferRightBase, token, wrapGap)
            : outSide === 'left'
              ? takeSideWrap('left', preferLeftBase, token, wrapGap)
              : outSide === 'bottom'
                ? underY
                : overY;
        path = sameSideWrap(exit, enter, outSide, lane);
      } else {
        const outVert = outSide === 'top' || outSide === 'bottom';
        const midPrefer = outVert
          ? (exit.y + enter.y) / 2
          : (exit.x + enter.x) / 2;
        path = routeBetweenStubs(exit, enter, outSide, inSide, midPrefer);
      }
      return {
        exit,
        enter,
        outSide,
        inSide,
        outMeta,
        inMeta,
        path,
        keepPath: false,
      };
    };

    const sidePairs = candidateSidePairs(primarySides, {
      preferRightWrap: stacked,
    });
    const sidePlans = sidePairs.map(([outSide, inSide], i) => {
      const plan = planForSides(outSide, inSide);
      const isPrimary =
        outSide === primarySides.outSide && inSide === primarySides.inSide;
      let bias = isPrimary ? -40 : 24 + i * 4;
      // Same-column: prefer right gutter; left only as fallback (not -1000 tours).
      if (stacked && (outSide === 'left' || inSide === 'left')) bias += 90;
      if (stacked && outSide === 'right' && inSide === 'right') bias -= 50;
      // Top/bottom facing on stacked returns often looks worse than a side C.
      if (
        stackedReturn &&
        (outSide === 'top' ||
          outSide === 'bottom' ||
          inSide === 'top' ||
          inSide === 'bottom')
      ) {
        bias += 60;
      }
      return { ...plan, bias };
    });

    const ltrPlan =
      sidePlans.find((p) => p.outSide === 'right' && p.inSide === 'right') ||
      sidePlans.find((p) => p.outSide === 'right' && p.inSide === 'left') ||
      sidePlans.find((p) => p.outSide === 'left' && p.inSide === 'right') ||
      sidePlans[0];
    const wrapRight = takeSideWrap(
      'right',
      preferRightBase,
      `w:${token}`,
      wrapGap
    );
    // Full-graph U-wraps are a last resort for stacked columns — they create
    // the long left-margin tours seen in single-column OStim packs.
    const wrapPlans = stacked
      ? [
          {
            ...ltrPlan,
            path: sideC(
              ltrPlan.exit.x,
              ltrPlan.exit.y,
              ltrPlan.enter.x,
              ltrPlan.enter.y,
              wrapRight
            ),
            bias: stackedReturn ? 40 : 180,
            keepPath: true,
          },
        ]
      : [
          {
            ...ltrPlan,
            path: underU(
              ltrPlan.exit.x,
              ltrPlan.exit.y,
              ltrPlan.enter.x,
              ltrPlan.enter.y,
              underY,
              wrapRight
            ),
            bias: 120,
            keepPath: true,
          },
          {
            ...ltrPlan,
            path: overU(
              ltrPlan.exit.x,
              ltrPlan.exit.y,
              ltrPlan.enter.x,
              ltrPlan.enter.y,
              overY,
              wrapRight
            ),
            bias: 124,
            keepPath: true,
          },
          {
            ...ltrPlan,
            path: sideC(
              ltrPlan.exit.x,
              ltrPlan.exit.y,
              ltrPlan.enter.x,
              ltrPlan.enter.y,
              wrapRight
            ),
            bias: 128,
            keepPath: true,
          },
        ];

    const chosen = pickBestCandidate([...sidePlans, ...wrapPlans], obstacles);
    if (!chosen) {
      return {
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        sourcePort: slot.out,
        targetPort: slot.in,
        slotOut: slot.out,
        slotIn: slot.in,
        router: { name: 'orth', args: { padding: 36 } },
        connector: ROUNDED_CONNECTOR,
        vertices: [],
        attrs,
      };
    }

    let finalPath = chosen.path;
    // Only re-lane facing Z routes. U/C wraps already have dedicated under/over/side pools;
    // rewriting them to Z collapses distinct floors onto the same gutters.
    if (chosen.outSide !== chosen.inSide && !chosen.keepPath) {
      const outVert =
        chosen.outSide === 'top' || chosen.outSide === 'bottom';
      const midBase = outVert
        ? (chosen.exit.y + chosen.enter.y) / 2
        : (chosen.exit.x + chosen.enter.x) / 2;
      const midPrefer = takeGutterMid(midBase, outVert ? 'y' : 'x', token);
      const routed = routeBetweenStubs(
        chosen.exit,
        chosen.enter,
        chosen.outSide,
        chosen.inSide,
        midPrefer
      );
      const baseLen = pathLength(chosen.path);
      const routedLen = pathLength(routed);
      // Reject re-lanes that lengthen the path or still look like a reverse jog.
      if (
        !pathHitsObstacle(routed, obstacles) &&
        routedLen <= baseLen * 1.2 + 32
      ) {
        finalPath = routed;
      }
    }

    // Keep full stub→bend→stub orth paths. Collapsing to a single midpoint
    // made X6 draw diagonals through node bodies (and skipped AABB hit tests).

    commitStub(stubOutCount, chosen.outMeta.key, chosen.outMeta.i);
    commitStub(stubInCount, chosen.inMeta.key, chosen.inMeta.i);

    return {
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      sourcePort: chosen.exit.port,
      targetPort: chosen.enter.port,
      slotOut: slot.out,
      slotIn: slot.in,
      outSide: chosen.outSide,
      inSide: chosen.inSide,
      router: { name: 'normal' },
      connector: ROUNDED_CONNECTOR,
      vertices: finalPath,
      attrs,
    };
  });
}

/**
 * Layout nodes LTR by BFS rank and build non-overlapping edge plans.
 * @returns {{ positions: Map<string,{x:number,y:number}>, ranks: Map<string,number>, edges: object[] }}
 */
export function layoutSceneGraph(sceneGraph, rootId, nodeIds, { isDark = false, nodeSizes = null } = {}) {
  const ids = nodeIds?.length ? nodeIds : Object.keys(sceneGraph || {});
  if (!ids.length) {
    return { positions: new Map(), ranks: new Map(), edges: [] };
  }

  const { outgoing, incoming } = buildAdjacency(sceneGraph, ids);
  const { ranks, orphans } = assignRanks(outgoing, ids, rootId);

  const byLevel = new Map();
  for (const [id, lv] of ranks) {
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(id);
  }
  orderByBarycenter(byLevel, outgoing, incoming);

  const { positions } = placeNodes(byLevel, orphans, ids, ranks, nodeSizes);
  const rawEdges = collectEdges(outgoing, ranks);
  const edges = planEdges(rawEdges, positions, { isDark, nodeSizes });

  return { positions, ranks, edges };
}

/** Build an X6 edge config object from a layout plan. */
export function planToEdgeConfig(plan) {
  const cfg = {
    shape: STAGE_EDGE_SHAPEID,
    source: { cell: plan.source, port: plan.sourcePort || 'out0' },
    target: { cell: plan.target, port: plan.targetPort || 'in0' },
    router: plan.router,
    connector: plan.connector,
    vertices: plan.vertices || [],
    attrs: plan.attrs,
    data: {
      viaStageId: plan.viaStageId || null,
      viaName: plan.viaName || null,
      bridgeTargetId: plan.bridgeTargetId || null,
      bridgeSourceId: plan.bridgeSourceId || null,
      bridgeFolder: plan.bridgeFolder || null,
      kind: plan.kind || null,
      slotOut: plan.slotOut || plan.sourcePort || null,
      slotIn: plan.slotIn || plan.targetPort || null,
    },
  };
  if (plan.labels?.length) cfg.labels = plan.labels;
  const line = plan.attrs?.line ? { ...plan.attrs.line } : null;
  if (line) {
    if (line.targetMarker) line.targetMarker = { ...line.targetMarker };
    line.strokeOpacity = 1;
    line.opacity = 1;
    cfg.layerBaseAttrs = { line };
    cfg.layerDim = false;
  }
  return cfg;
}

/** Apply a layout plan onto an existing X6 edge. Returns true if geometry changed. */
export function applyEdgePlan(edge, plan) {
  if (!edge || !plan) return false;
  const prev = edge.getVertices() || [];
  const next = plan.vertices || [];
  const prevSrc = edge.getSource?.() || {};
  const prevTgt = edge.getTarget?.() || {};
  const nextSrcPort = plan.sourcePort || 'out0';
  const nextTgtPort = plan.targetPort || 'in0';
  const vertsChanged =
    prev.length !== next.length ||
    prev.some(
      (p, i) =>
        Math.abs((p.x || 0) - (next[i]?.x || 0)) > 0.5 ||
        Math.abs((p.y || 0) - (next[i]?.y || 0)) > 0.5
    );
  const portsChanged =
    prevSrc.port !== nextSrcPort || prevTgt.port !== nextTgtPort;
  edge.setSource({ cell: plan.source, port: nextSrcPort });
  edge.setTarget({ cell: plan.target, port: nextTgtPort });
  edge.setRouter(plan.router);
  edge.setConnector(plan.connector);
  edge.setVertices(next);
  if (plan.attrs) edge.setAttrs(plan.attrs);
  if (plan.labels) edge.setLabels(plan.labels);
  else edge.setLabels([]);
  edge.setData({
    ...(edge.getData?.() || {}),
    viaStageId: plan.viaStageId || null,
    viaName: plan.viaName || null,
    bridgeTargetId: plan.bridgeTargetId || null,
    bridgeSourceId: plan.bridgeSourceId || null,
    bridgeFolder: plan.bridgeFolder || null,
    kind: plan.kind || null,
    slotOut: plan.slotOut || nextSrcPort || null,
    slotIn: plan.slotIn || nextTgtPort || null,
  });
  // Pristine stroke for layer dim restore (X6 merges attrs; never capture dimmed live attrs).
  const line = plan.attrs?.line ? { ...plan.attrs.line } : { ...(edge.attr('line') || {}) };
  if (line.targetMarker) line.targetMarker = { ...line.targetMarker };
  line.strokeOpacity = 1;
  line.opacity = 1;
  edge.setProp('layerBaseAttrs', { line });
  edge.setProp('layerDim', false);
  return vertsChanged || portsChanged;
}

/**
 * Re-route edges for the current node positions without moving nodes.
 */
export function routeEdgesForPositions(
  sceneGraph,
  rootId,
  nodeIds,
  positions,
  { isDark = false, nodeSizes = null, getName = null } = {}
) {
  const ids = nodeIds?.length ? nodeIds : Object.keys(sceneGraph || {});
  const { outgoing } = buildAdjacency(sceneGraph, ids);
  const { ranks, orphans } = assignRanks(outgoing, ids, rootId);
  orphans.forEach((id) => {
    if (!ranks.has(id)) ranks.set(id, -1);
  });
  const rawEdges = collectEdges(outgoing, ranks);
  return {
    edges: planEdges(rawEdges, positions, { isDark, nodeSizes, getName }),
    ranks,
  };
}

/** Extra free in/out slot so a new link always has a visible attach point. */
export const SPARE_PORT_SLOTS = 1;

export function buildNodeSizes(ids, inCount, outCount, isTransitionFn) {
  const map = new Map();
  for (const id of ids) {
    const usedIn = inCount?.get(id) || 0;
    const usedOut = outCount?.get(id) || 0;
    const ic = usedIn + SPARE_PORT_SLOTS;
    const oc = usedOut + SPARE_PORT_SLOTS;
    const isT = !!isTransitionFn?.(id);
    map.set(id, {
      width: nodeWidthForKind(isT),
      height: nodeHeightForDegree(ic, oc, isT),
      inCount: Math.max(1, ic),
      outCount: Math.max(1, oc),
      usedIn,
      usedOut,
      isTransition: isT,
    });
  }
  return map;
}

export function filterEdgePlans(plans, visibleKeys) {
  if (!visibleKeys) return plans;
  return plans.filter((p) => visibleKeys.has(`${p.source}\0${p.target}`));
}

export function edgeKey(source, target) {
  return `${source}\0${target}`;
}
