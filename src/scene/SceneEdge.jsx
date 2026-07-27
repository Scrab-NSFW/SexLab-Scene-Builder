import { Graph } from '@antv/x6'

/** Keep radius ≤ half of the shortest planned orth segment (~56px). */
export const ROUNDED_CONNECTOR = {
  name: 'rounded',
  args: { radius: 22 },
};

export const EDGE_MARKER = {
  name: 'block',
  width: 14,
  height: 10,
};

export function forwardEdgeAttrs(isDark = false) {
  return {
    line: {
      stroke: isDark ? '#e5e5e5' : '#111111',
      strokeWidth: 1.75,
      targetMarker: { ...EDGE_MARKER },
    },
  };
}

export function backEdgeAttrs(isDark = false) {
  return {
    line: {
      stroke: isDark ? '#fb923c' : '#c2410c',
      strokeWidth: 2,
      targetMarker: { ...EDGE_MARKER },
    },
  };
}

export function viaEdgeAttrs(isDark = false) {
  return {
    line: {
      stroke: isDark ? '#a78bfa' : '#6d28d9',
      strokeWidth: 1.75,
      strokeDasharray: '6 4',
      targetMarker: { ...EDGE_MARKER },
    },
  };
}

/** Cross–virtual-canvas link (other ostim_folder). Distinct from via (purple). */
export function bridgeEdgeAttrs(isDark = false) {
  return {
    line: {
      stroke: isDark ? '#2dd4bf' : '#0f766e',
      strokeWidth: 1.75,
      strokeDasharray: '2 5',
      targetMarker: { ...EDGE_MARKER },
    },
  };
}

/** Thicker via-edge stroke for hover highlight. */
export function viaEdgeHoverLinePatch(isDark = false) {
  return {
    stroke: isDark ? '#c4b5fd' : '#5b21b6',
    strokeWidth: 3.25,
  };
}

/** Thicker bridge-edge stroke for hover highlight. */
export function bridgeEdgeHoverLinePatch(isDark = false) {
  return {
    stroke: isDark ? '#5eead4' : '#115e59',
    strokeWidth: 3.25,
  };
}

/** Forward / primary edges (white or near-black). */
export function forwardEdgeHoverLinePatch(isDark = false) {
  return {
    stroke: isDark ? '#ffffff' : '#000000',
    strokeWidth: 3.25,
  };
}

/** Back / return edges (orange). */
export function backEdgeHoverLinePatch(isDark = false) {
  return {
    stroke: isDark ? '#fdba74' : '#9a3412',
    strokeWidth: 3.5,
  };
}

/** Pick hover stroke for an edge from its data.kind (and via/bridge flags). */
export function edgeHoverLinePatch(edgeData, isDark = false) {
  const data = edgeData || {};
  if (data.bridgeTargetId || data.bridgeSourceId || data.kind === 'bridge') {
    return bridgeEdgeHoverLinePatch(isDark);
  }
  if (data.viaStageId || data.kind === 'via') {
    return viaEdgeHoverLinePatch(isDark);
  }
  if (data.kind === 'back') {
    return backEdgeHoverLinePatch(isDark);
  }
  return forwardEdgeHoverLinePatch(isDark);
}

export function edgeLabelConfig(text, isDark = false) {
  if (!text) return [];
  return [
    {
      attrs: {
        label: {
          text: String(text).slice(0, 28),
          fill: isDark ? '#d4d4d8' : '#3f3f46',
          fontSize: 11,
          fontFamily: 'Segoe UI, sans-serif',
        },
        rect: {
          fill: isDark ? '#27272a' : '#fafafa',
          stroke: isDark ? '#52525b' : '#d4d4d8',
          strokeWidth: 1,
          rx: 3,
          ry: 3,
        },
      },
      position: 0.5,
    },
  ];
}

export const STAGE_EDGE = {
  router: {
    name: 'orth',
    args: {
      padding: 10,
    },
  },
  connector: ROUNDED_CONNECTOR,
  attrs: forwardEdgeAttrs(false),
};

export const STAGE_EDGE_SHAPEID = 'stage_edge';

Graph.registerEdge(
  STAGE_EDGE_SHAPEID,
  STAGE_EDGE,
  true
);
