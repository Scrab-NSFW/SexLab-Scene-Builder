import {
  NODE_WIDTH,
  NODE_HEIGHT,
  parsePortRef,
  portArgsOnNode,
} from './SceneNode';

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeFileStem(name) {
  const stem = String(name || 'scene')
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return stem.slice(0, 80) || 'scene';
}

function edgeStroke(edge, isDark) {
  const stroke =
    edge.attr('line/stroke') ||
    edge.getAttrs()?.line?.stroke ||
    null;
  if (stroke) return stroke;
  return isDark ? '#e5e5e5' : '#111111';
}

function isBackStroke(stroke) {
  const s = String(stroke || '').toLowerCase();
  return s.includes('c2410c') || s.includes('fb923c') || s.includes('orange');
}

/** Port attachment from node origin + port id (SVG fallback). */
function portPoint(pos, portId, size = null) {
  const w = size?.width || NODE_WIDTH;
  const h = size?.height || NODE_HEIGHT;
  const ins = size?.inCount || 1;
  const outs = size?.outCount || 1;
  const ref = parsePortRef(portId);
  const args = portArgsOnNode(ref.side, ref.role, ref.index, ins, outs, w, h);
  return { x: pos.x + args.x, y: pos.y + args.y };
}

function collectGraphSnapshot(graph, { isDark = false, onlyVisible = false } = {}) {
  const nodes = graph.getNodes().map((node) => {
    const pos = node.getPosition();
    const size = typeof node.getSize === 'function' ? node.getSize() : null;
    const stage = node.prop('stage') || {};
    const portalName = node.prop('displayName') || node.prop('portalStageName');
    const folder = node.prop('portalFolder');
    const name = node.prop('isPortal')
      ? `→ ${folder || '?'}: ${portalName || node.id}`
      : stage.name || node.prop('name') || node.id;
    return {
      id: node.id,
      name,
      x: pos.x,
      y: pos.y,
      width: Number(size?.width) || NODE_WIDTH,
      height: Number(size?.height) || NODE_HEIGHT,
      isStart: !!node.prop('isStart'),
      isOrgasm: !!node.prop('isOrgasm'),
      fixedLen: !!node.prop('fixedLen'),
    };
  });

  const edges = graph.getEdges().map((edge) => {
    const hidden =
      (typeof edge.isVisible === 'function' && edge.isVisible() === false) ||
      edge.getProp?.('visible') === false ||
      edge.visible === false;
    if (onlyVisible && hidden) return null;
    const source = edge.getSourceNode();
    const target = edge.getTargetNode();
    if (!source || !target) return null;
    const sp = source.getPosition();
    const tp = target.getPosition();
    const stroke = edgeStroke(edge, isDark);
    const vertices = (edge.getVertices() || []).map((v) => ({
      x: v.x,
      y: v.y,
    }));
    let start;
    let end;
    try {
      const spPt = typeof edge.getSourcePoint === 'function' ? edge.getSourcePoint() : null;
      const tpPt = typeof edge.getTargetPoint === 'function' ? edge.getTargetPoint() : null;
      if (spPt && Number.isFinite(spPt.x) && Number.isFinite(spPt.y)) {
        start = { x: spPt.x, y: spPt.y };
      }
      if (tpPt && Number.isFinite(tpPt.x) && Number.isFinite(tpPt.y)) {
        end = { x: tpPt.x, y: tpPt.y };
      }
    } catch (_) { /* fall through */ }
    if (!start || !end) {
      const srcPort = edge.getSource?.()?.port || 'out';
      const tgtPort = edge.getTarget?.()?.port || 'in';
      // Prefer the node's stored absolute port args (exact for resized nodes).
      const portXY = (node, pos, portId) => {
        const p = node.getPort?.(portId);
        if (p?.args && Number.isFinite(p.args.x) && Number.isFinite(p.args.y)) {
          return { x: pos.x + p.args.x, y: pos.y + p.args.y };
        }
        return portPoint(pos, portId, node.getSize?.());
      };
      start = start || portXY(source, sp, srcPort);
      end = end || portXY(target, tp, tgtPort);
    }
    const kind = isBackStroke(stroke) ? 'back' : 'forward';
    return {
      id: edge.id,
      source: source.id,
      target: target.id,
      kind,
      stroke,
      strokeWidth: Number(edge.attr('line/strokeWidth')) || (kind === 'back' ? 2 : 1.75),
      points: [start, ...vertices, end],
      vertices,
    };
  }).filter(Boolean);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const expand = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const n of nodes) {
    expand(n.x, n.y);
    expand(n.x + n.width, n.y + n.height);
  }
  for (const e of edges) {
    for (const p of e.points) expand(p.x, p.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 800;
    maxY = 600;
  }

  const pad = 64;
  return {
    nodes,
    edges,
    bounds: {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    },
  };
}

function wrapLabel(text, maxChars = 28) {
  const s = String(text || '');
  if (s.length <= maxChars) return [s];
  const words = s.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

/**
 * Build a standalone SVG of the current graph (full content bbox, not viewport).
 * React/HTML stage nodes are redrawn as labeled rects so the file stays readable.
 */
export function buildCanvasSvg(graph, { sceneName = 'Scene', isDark = false, onlyVisible = false } = {}) {
  const snap = collectGraphSnapshot(graph, { isDark, onlyVisible });
  const { nodes, edges, bounds } = snap;
  const bg = isDark ? '#1a1a1a' : '#f7f7f7';
  const nodeFill = isDark ? '#2a2a2a' : '#ffffff';
  const nodeStroke = isDark ? '#888' : '#333';
  const textFill = isDark ? '#f0f0f0' : '#111';
  const muted = isDark ? '#aaa' : '#555';
  const startStroke = '#0a7a0a';
  const backStroke = isDark ? '#fb923c' : '#c2410c';
  const forwardStroke = isDark ? '#e5e5e5' : '#111111';

  const backCount = edges.filter((e) => e.kind === 'back').length;
  const forwardCount = edges.length - backCount;

  const edgePaths = edges
    .map((e) => {
      const d = e.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
        .join(' ');
      const marker = e.kind === 'back' ? 'url(#arrow-back)' : 'url(#arrow-fwd)';
      return `  <path d="${d}" fill="none" stroke="${escapeXml(e.stroke)}" stroke-width="${e.strokeWidth}" stroke-linejoin="round" stroke-linecap="round" marker-end="${marker}" data-kind="${e.kind}" data-source="${escapeXml(e.source)}" data-target="${escapeXml(e.target)}" />`;
    })
    .join('\n');

  const nodeShapes = nodes
    .map((n) => {
      const lines = wrapLabel(n.name);
      const stroke = n.isStart ? startStroke : nodeStroke;
      const sw = n.isStart ? 3 : 1.5;
      const labelY = n.y + 28;
      const text = lines
        .map(
          (line, i) =>
            `    <text x="${(n.x + n.width / 2).toFixed(1)}" y="${(labelY + i * 16).toFixed(1)}" text-anchor="middle" font-size="13" font-family="Segoe UI, sans-serif" fill="${textFill}">${escapeXml(line)}</text>`
        )
        .join('\n');
      const badges = [];
      if (n.isStart) badges.push('start');
      if (n.isOrgasm) badges.push('climax');
      if (n.fixedLen) badges.push('fixed');
      const badge =
        badges.length > 0
          ? `    <text x="${(n.x + n.width / 2).toFixed(1)}" y="${(n.y + n.height - 14).toFixed(1)}" text-anchor="middle" font-size="11" font-family="Segoe UI, sans-serif" fill="${muted}">${escapeXml(badges.join(' · '))}</text>`
          : '';
      const idLine = `    <text x="${(n.x + n.width / 2).toFixed(1)}" y="${(n.y + n.height - (badges.length ? 30 : 14)).toFixed(1)}" text-anchor="middle" font-size="10" font-family="ui-monospace, monospace" fill="${muted}">${escapeXml(n.id)}</text>`;
      return `  <g data-node="${escapeXml(n.id)}">
    <rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" ry="8" fill="${nodeFill}" stroke="${stroke}" stroke-width="${sw}" />
${text}
${idLine}
${badge}
  </g>`;
    })
    .join('\n');

  const legendX = bounds.x + 12;
  const legendY = bounds.y + 12;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width.toFixed(0)}" height="${bounds.height.toFixed(0)}" viewBox="${bounds.x.toFixed(1)} ${bounds.y.toFixed(1)} ${bounds.width.toFixed(1)} ${bounds.height.toFixed(1)}">
  <title>${escapeXml(sceneName)} — stage graph</title>
  <desc>${nodes.length} stages, ${edges.length} edges (${forwardCount} forward, ${backCount} back). Exported from SexLab Scene Builder.</desc>
  <defs>
    <marker id="arrow-fwd" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${forwardStroke}" />
    </marker>
    <marker id="arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${backStroke}" />
    </marker>
  </defs>
  <rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="${bg}" />
  <g font-family="Segoe UI, sans-serif" font-size="12" fill="${textFill}">
    <text x="${legendX}" y="${legendY + 14}" font-weight="600">${escapeXml(sceneName)}</text>
    <text x="${legendX}" y="${legendY + 32}" fill="${muted}">${nodes.length} nodes · ${edges.length} edges</text>
    <line x1="${legendX}" y1="${legendY + 48}" x2="${legendX + 28}" y2="${legendY + 48}" stroke="${forwardStroke}" stroke-width="2" />
    <text x="${legendX + 36}" y="${legendY + 52}">forward (${forwardCount})</text>
    <line x1="${legendX}" y1="${legendY + 68}" x2="${legendX + 28}" y2="${legendY + 68}" stroke="${backStroke}" stroke-width="2.5" />
    <text x="${legendX + 36}" y="${legendY + 72}">back / return (${backCount})</text>
  </g>
  <g id="edges">
${edgePaths}
  </g>
  <g id="nodes">
${nodeShapes}
  </g>
</svg>
`;
}

/** Layout snapshot JSON for debugging large scenes. */
export function buildCanvasLayoutJson(graph, { sceneName = 'Scene', isDark = false, onlyVisible = false } = {}) {
  const snap = collectGraphSnapshot(graph, { isDark, onlyVisible });
  return JSON.stringify(
    {
      scene: sceneName,
      exportedAt: new Date().toISOString(),
      nodeCount: snap.nodes.length,
      edgeCount: snap.edges.length,
      bounds: snap.bounds,
      nodes: snap.nodes,
      edges: snap.edges.map(({ id, source, target, kind, stroke, strokeWidth, vertices, points }) => ({
        id,
        source,
        target,
        kind,
        stroke,
        strokeWidth,
        vertices,
        points,
      })),
    },
    null,
    2
  );
}

export function defaultGraphExportName(sceneName, ext = 'svg') {
  return `${sanitizeFileStem(sceneName)}_graph.${ext}`;
}
