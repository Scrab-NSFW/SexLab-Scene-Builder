import { useEffect, useRef } from 'react';
import Icon, { EditOutlined, CopyOutlined, CloseOutlined, WarningOutlined, ArrowRightOutlined, HeartFilled } from '@ant-design/icons';
import { register } from "@antv/x6-react-shape";
import { uniqueStageLabel } from './stageFamily';
import './SceneNode.css'

const NODE_HEIGHT = 112;
const NODE_WIDTH = 240;
const START_COLOR = 'rgb(0, 88, 0)';

function makeColor(r, g, b, a = 1) {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function FixedLength(props) {
  const fixedLen_svg = () => (
    <svg viewBox="112 176 800 672" width="1em" height="1em" fill="currentColor">
      <path d="M 180 176 h -60 c -4.4 0 -8 3.6 -8 8 v 656 c 0 4.4 3.6 8 8 8 h 60 c 4.4 0 8 -3.6 8 -8 V 184 c 0 -4.4 -3.6 -8 -8 -8 z m 724 0 h -60 c -4.4 0 -8 3.6 -8 8 v 656 c 0 4.4 3.6 8 8 8 h 60 c 4.4 0 8 -3.6 8 -8 V 184 c 0 -4.4 -3.6 -8 -8 -8 z M 785.3 504.3 L 657.7 403.6 a 7.23 7.23 0 0 0 -11.7 5.7 V 476 H 238 V 548 h 407.3 v 62.8 c 0 6 7 9.4 11.7 5.7 l 127.5 -100.8 c 3.8 -2.9 3.8 -8.5 0.2 -11.4 z" />
    </svg>
  );
  return (
    <Icon component={fixedLen_svg} {...props} />
  )
}

/** 2nd icon mouseenter never fires in X6 FO — hit-test on mousemove instead. */
function StatusIconRow({ items }) {
  const tipElRef = useRef(null);
  const rowRef = useRef(null);

  useEffect(() => () => {
    tipElRef.current?.remove();
    tipElRef.current = null;
  }, []);

  if (!items.length) return null;

  const hideTip = () => {
    if (tipElRef.current) tipElRef.current.style.display = 'none';
  };

  const showTip = (title, el) => {
    const r = el.getBoundingClientRect();
    let tipEl = tipElRef.current;
    if (!tipEl) {
      tipEl = window.document.createElement('div');
      tipEl.className = 'node-status-floating-tip';
      tipEl.setAttribute('role', 'tooltip');
      window.document.body.appendChild(tipEl);
      tipElRef.current = tipEl;
    }
    tipEl.textContent = title;
    tipEl.style.left = `${r.left + r.width / 2}px`;
    tipEl.style.top = `${r.top}px`;
    tipEl.style.display = 'block';
  };

  const updateFromPoint = (clientX, clientY) => {
    const row = rowRef.current;
    if (!row) return;
    const spans = row.querySelectorAll('.node-status-icon');
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        showTip(s.getAttribute('aria-label'), s);
        return;
      }
    }
  };

  return (
    <div
      ref={rowRef}
      className="node-attribute-icons"
      onMouseLeave={hideTip}
      onMouseMove={(e) => updateFromPoint(e.clientX, e.clientY)}
    >
      {items.map(({ title, icon }) => (
        <span
          key={title}
          className="node-status-icon"
          aria-label={title}
        >
          {icon}
        </span>
      ))}
    </div>
  );
}

function NodeCtrlBtn({ label, onClick, danger, children }) {
  const tipElRef = useRef(null);
  useEffect(() => () => {
    tipElRef.current?.remove();
    tipElRef.current = null;
  }, []);

  const hideTip = () => {
    if (tipElRef.current) tipElRef.current.style.display = 'none';
  };
  const showTip = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let tipEl = tipElRef.current;
    if (!tipEl) {
      tipEl = window.document.createElement('div');
      tipEl.className = 'node-status-floating-tip';
      tipEl.setAttribute('role', 'tooltip');
      window.document.body.appendChild(tipEl);
      tipElRef.current = tipEl;
    }
    tipEl.textContent = label;
    tipEl.style.left = `${r.left + r.width / 2}px`;
    tipEl.style.top = `${r.top}px`;
    tipEl.style.display = 'block';
  };

  return (
    <button
      type="button"
      className={`node-ctrl-btn${danger ? ' node-ctrl-btn-danger' : ''}`}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={showTip}
      onMouseLeave={hideTip}
    >
      {children}
    </button>
  );
}

function StageNode({ node, graph }) {
  const isPortal = !!node.prop('isPortal');
  if (isPortal) {
    const folder = node.prop('portalFolder') || '?';
    const targetName = node.prop('portalStageName') || node.prop('displayName') || '';
    const isScenePortal = !!node.prop('portalSceneId');
    const jump = () => graph.emit('node:portalJump', { node });
    return (
      <div
        className="stage-content stage-portal"
        onDoubleClick={jump}
        style={{
          backgroundColor: makeColor(15, 118, 110, 0.18),
          borderColor: 'rgba(15, 118, 110, 0.65)',
          borderStyle: 'dashed',
          cursor: 'pointer',
          minHeight: 64,
        }}
        title={isScenePortal ? 'Open other scene' : 'Open other folder canvas'}
      >
        <div className="node-header">
          <StatusIconRow
            items={[
              {
                title: isScenePortal ? 'Other scene' : 'Other folder',
                icon: (
                  <span style={{ fontSize: 10, fontWeight: 700, color: makeColor(15, 118, 110) }}>
                    →
                  </span>
                ),
              },
            ]}
          />
          <div className="node-controll-button-holder">
            <NodeCtrlBtn
              label={isScenePortal ? 'Open scene' : 'Open folder'}
              onClick={jump}
            >
              Open
            </NodeCtrlBtn>
          </div>
        </div>
        <div style={{ fontSize: 10, opacity: 0.7, padding: '0 8px' }}>
          {isScenePortal ? `scene: ${folder}` : folder}
        </div>
        <div className="stage-name">
          <span className="stage-name-label" title={targetName}>{targetName || folder}</span>
        </div>
      </div>
    );
  }

  const stage = node.prop('stage') || {};
  const start = node.prop('isStart');
  const fixedLen = node.prop('fixedLen');
  const isTransition = !!node.prop('isTransition');
  const hubReturns = Number(node.prop('hubReturns') || 0);
  const poseFamilyLabel = node.prop('poseFamily');
  const scene = node.prop('scene') || {};

  const label = uniqueStageLabel(stage, scene.stages || []) || stage.name;
  const navText = stage.extra?.nav_text;
  const orgasm =
    !!node.prop('isOrgasm') ||
    !!(stage.positions && stage.positions.some((pos) => pos.climax || pos.extra?.climax));
  const color = isTransition
    ? makeColor(196, 155, 90, 1)
    : fixedLen
      ? fixedLen < 50
        ? makeColor(255, 175, 175, 1)
        : makeColor(175, 235, 255, 1)
      : undefined;

  const editStage = () => graph.emit("node:edit", { node });
  const cloneStage = () => graph.emit("node:clone", { node });
  const cloneStageTo = () => graph.emit("node:cloneTo", { node });

  return (
    <div
      className={`stage-content${isTransition ? ' stage-transition' : ''}`}
      style={{
        backgroundColor: color,
        borderColor: start ? START_COLOR : isTransition ? 'rgba(120, 80, 20, 0.55)' : undefined,
      }}
    >
      <div className="node-header">
        <StatusIconRow
          items={[
            isTransition
              ? {
                  title: 'Transition stage',
                  icon: (
                    <span style={{ fontSize: 10, fontWeight: 700, color: makeColor(90, 55, 10) }}>
                      T
                    </span>
                  ),
                }
              : null,
            start
              ? {
                  title: 'Start Animation',
                  icon: <ArrowRightOutlined style={{ fontSize: 20, color: makeColor(17, 175, 17) }} />,
                }
              : null,
            orgasm
              ? {
                  title: 'Orgasm Stage',
                  icon: <HeartFilled style={{ fontSize: 20, color: makeColor(255, 20, 147) }} />,
                }
              : null,
            !navText && !start && !isTransition
              ? {
                  title: 'Missing navigation text',
                  icon: <WarningOutlined style={{ fontSize: 20, color: makeColor(255, 0, 0) }} />,
                }
              : null,
            fixedLen && !isTransition
              ? {
                  title: 'Fixed Length',
                  icon: <FixedLength style={{ fontSize: 20, color: makeColor(0, 191, 255) }} />,
                }
              : null,
            hubReturns > 0
              ? {
                  title: `${hubReturns} cross-family return(s) into this hub`,
                  icon: (
                    <span style={{ fontSize: 12, fontWeight: 700, color: makeColor(194, 65, 12) }}>
                      ←{hubReturns}
                    </span>
                  ),
                }
              : null,
          ].filter(Boolean)}
        />
        <div className="node-controll-button-holder">
          <NodeCtrlBtn label="Edit" onClick={editStage}>
            <EditOutlined />
          </NodeCtrlBtn>
          <NodeCtrlBtn label="Clone" onClick={cloneStage}>
            <CopyOutlined />
          </NodeCtrlBtn>
          <NodeCtrlBtn label="Clone to…" onClick={cloneStageTo}>
            <CopyOutlined />
          </NodeCtrlBtn>
          <NodeCtrlBtn label="Mark as root" onClick={() => graph.emit("node:doMarkRoot", { node })}>
            Root
          </NodeCtrlBtn>
          <NodeCtrlBtn label="Delete" danger onClick={() => node.remove()}>
            <CloseOutlined />
          </NodeCtrlBtn>
        </div>
      </div>
      {poseFamilyLabel && !isTransition ? (
        <div style={{ fontSize: 10, opacity: 0.55, padding: '0 8px', marginTop: -2 }}>
          {poseFamilyLabel}
        </div>
      ) : null}
      {!!node.prop('ostimFolder') && !isTransition ? (
        <div
          style={{
            fontSize: 10,
            opacity: 0.7,
            padding: '0 8px',
            marginTop: poseFamilyLabel ? 0 : -2,
            color: makeColor(15, 118, 110),
          }}
          title="OStim pack folder (disk split under scenes/)"
        >
          folder: {node.prop('ostimFolder')}
        </div>
      ) : null}
      {!!node.prop('ostimId') && !isTransition ? (
        <div
          style={{
            fontSize: 10,
            opacity: 0.65,
            padding: '0 8px',
            marginTop: 0,
            fontFamily: 'ui-monospace, monospace',
          }}
          title="OStim ID — JSON filename on export"
        >
          id: {node.prop('ostimId')}
        </div>
      ) : null}
      <div className="stage-name">
        <span className="stage-name-label" title={label || 'Untitled'}>{label || 'Untitled'}</span>
      </div>
    </div>
  );
}

const SLOT_STEP = 36;
const TRANSITION_WIDTH = 200;
const TRANSITION_HEIGHT = 72;

export function nodeHeightForDegree(inCount, outCount, isTransition = false) {
  const base = isTransition ? TRANSITION_HEIGHT : NODE_HEIGHT;
  const slots = Math.max(1, Number(inCount) || 0, Number(outCount) || 0);
  return base + Math.max(0, slots - 1) * SLOT_STEP;
}

export function nodeWidthForKind(isTransition = false) {
  return isTransition ? TRANSITION_WIDTH : NODE_WIDTH;
}

/** Port id for an outgoing edge on a given side + slot index. */
export function outPortId(side, index = 0) {
  const i = Math.max(0, Number(index) || 0);
  switch (side) {
    case 'left':
      return `outLeft${i}`;
    case 'top':
      return `outTop${i}`;
    case 'bottom':
      return `outBottom${i}`;
    case 'right':
    default:
      return `out${i}`;
  }
}

/** Port id for an incoming edge on a given side + slot index. */
export function inPortId(side, index = 0) {
  const i = Math.max(0, Number(index) || 0);
  switch (side) {
    case 'right':
      return `inRight${i}`;
    case 'top':
      return `inTop${i}`;
    case 'bottom':
      return `inBottom${i}`;
    case 'left':
    default:
      return `in${i}`;
  }
}

/**
 * Parse a port id into { role, side, index }. Accepts legacy unindexed ids
 * (outLeft, inTop, …) as index 0.
 */
export function parsePortRef(portId) {
  const s = String(portId || '');
  let m;
  if ((m = s.match(/^out(\d+)$/))) {
    return { role: 'out', side: 'right', index: Number(m[1]) };
  }
  if ((m = s.match(/^in(\d+)$/))) {
    return { role: 'in', side: 'left', index: Number(m[1]) };
  }
  if ((m = s.match(/^outLeft(\d*)$/))) {
    return { role: 'out', side: 'left', index: Number(m[1] || 0) };
  }
  if ((m = s.match(/^outTop(\d*)$/))) {
    return { role: 'out', side: 'top', index: Number(m[1] || 0) };
  }
  if ((m = s.match(/^outBottom(\d*)$/))) {
    return { role: 'out', side: 'bottom', index: Number(m[1] || 0) };
  }
  if ((m = s.match(/^inRight(\d*)$/))) {
    return { role: 'in', side: 'right', index: Number(m[1] || 0) };
  }
  if ((m = s.match(/^inTop(\d*)$/))) {
    return { role: 'in', side: 'top', index: Number(m[1] || 0) };
  }
  if ((m = s.match(/^inBottom(\d*)$/))) {
    return { role: 'in', side: 'bottom', index: Number(m[1] || 0) };
  }
  return { role: 'out', side: 'right', index: 0 };
}

/**
 * Local (node-relative) coords for a port. In and out on the same face never
 * share a point: each face packs both roles into unique slots along that edge.
 */
export function portArgsOnNode(
  side,
  role,
  index,
  inCount,
  outCount,
  width,
  height
) {
  const ins = Math.max(1, Number(inCount) || 1);
  const outs = Math.max(1, Number(outCount) || 1);
  const i = Math.max(0, Number(index) || 0);
  const w = width || NODE_WIDTH;
  const h = height || NODE_HEIGHT;

  if (side === 'left' || side === 'right') {
    // Left: ins then outs. Right: outs then ins. Guarantees unique Y.
    const total = ins + outs;
    const slot =
      side === 'left'
        ? role === 'in'
          ? i
          : ins + i
        : role === 'out'
          ? i
          : outs + i;
    const y = ((slot + 1) / (total + 1)) * h;
    // Slightly outside the node so FO content doesn't eat port clicks.
    return { x: side === 'left' ? -3 : w + 3, y };
  }

  // Top/bottom: outs then ins along X; slight Y inset so roles never coincide.
  const total = outs + ins;
  const slot = role === 'out' ? i : outs + i;
  const x = ((slot + 1) / (total + 1)) * w;
  if (side === 'top') {
    return { x, y: role === 'out' ? 1 : 4 };
  }
  return { x, y: role === 'out' ? h - 1 : h - 4 };
}

const PORT_DOT = {
  r: 6.5,
  magnet: true,
  strokeWidth: 1.75,
};

/** Visible ComfyUI-style connection dots (left = in, right = out). */
const PORT_IN_VISIBLE = {
  ...PORT_DOT,
  stroke: '#1d4ed8',
  fill: '#93c5fd',
};

const PORT_OUT_VISIBLE = {
  ...PORT_DOT,
  stroke: '#15803d',
  fill: '#86efac',
};

/** Free slot for a new link — muted but visible so empty stages still show connectors. */
const PORT_SPARE_IN = {
  ...PORT_DOT,
  strokeWidth: 1.5,
  stroke: '#93c5fd',
  fill: '#dbeafe',
  opacity: 0.85,
};

const PORT_SPARE_OUT = {
  ...PORT_DOT,
  strokeWidth: 1.5,
  stroke: '#86efac',
  fill: '#dcfce7',
  opacity: 0.85,
};

/** Layout-only magnets — hit target without cluttering the node. */
const PORT_HIDDEN = {
  r: 6,
  magnet: true,
  stroke: 'transparent',
  fill: 'transparent',
  strokeWidth: 0,
};

/**
 * @param {number} inCount total in slots (used + spare)
 * @param {number} outCount total out slots (used + spare)
 * @param {number} width
 * @param {number} height
 * @param {{ usedIn?: number, usedOut?: number }} [usage]
 */
export function buildPortItems(
  inCount,
  outCount,
  width,
  height,
  { usedIn = null, usedOut = null } = {}
) {
  const ins = Math.max(1, Number(inCount) || 1);
  const outs = Math.max(1, Number(outCount) || 1);
  const usedI = usedIn == null ? ins : Math.max(0, Number(usedIn) || 0);
  const usedO = usedOut == null ? outs : Math.max(0, Number(usedOut) || 0);
  const items = [];
  for (let i = 0; i < outs; i++) {
    const spare = i >= usedO;
    items.push({
      id: outPortId('right', i),
      group: 'out',
      args: portArgsOnNode('right', 'out', i, ins, outs, width, height),
      attrs: { circle: spare ? PORT_SPARE_OUT : PORT_OUT_VISIBLE },
    });
    items.push({
      id: outPortId('left', i),
      group: 'outSide',
      args: portArgsOnNode('left', 'out', i, ins, outs, width, height),
    });
    items.push({
      id: outPortId('top', i),
      group: 'outSide',
      args: portArgsOnNode('top', 'out', i, ins, outs, width, height),
    });
    items.push({
      id: outPortId('bottom', i),
      group: 'outSide',
      args: portArgsOnNode('bottom', 'out', i, ins, outs, width, height),
    });
  }
  for (let i = 0; i < ins; i++) {
    const spare = i >= usedI;
    items.push({
      id: inPortId('left', i),
      group: 'in',
      args: portArgsOnNode('left', 'in', i, ins, outs, width, height),
      attrs: { circle: spare ? PORT_SPARE_IN : PORT_IN_VISIBLE },
    });
    items.push({
      id: inPortId('right', i),
      group: 'inSide',
      args: portArgsOnNode('right', 'in', i, ins, outs, width, height),
    });
    items.push({
      id: inPortId('top', i),
      group: 'inSide',
      args: portArgsOnNode('top', 'in', i, ins, outs, width, height),
    });
    items.push({
      id: inPortId('bottom', i),
      group: 'inSide',
      args: portArgsOnNode('bottom', 'in', i, ins, outs, width, height),
    });
  }
  return items;
}

export function applyNodeSlots(
  node,
  {
    inCount = 1,
    outCount = 1,
    usedIn = null,
    usedOut = null,
    isTransition = false,
  } = {}
) {
  if (!node) return;
  const w = nodeWidthForKind(isTransition);
  const h = nodeHeightForDegree(inCount, outCount, isTransition);
  node.prop('isTransition', isTransition);
  node.resize(w, h);
  node.prop(
    'ports/items',
    buildPortItems(inCount, outCount, w, h, { usedIn, usedOut })
  );
}

register({
  shape: "stage_node",
  width: NODE_WIDTH,
  height: NODE_HEIGHT,
  ports: {
    groups: {
      out: {
        markup: [{ tagName: 'circle', selector: 'circle' }],
        attrs: {
          circle: PORT_OUT_VISIBLE,
        },
        position: { name: 'absolute' },
      },
      outSide: {
        markup: [{ tagName: 'circle', selector: 'circle' }],
        attrs: {
          circle: PORT_HIDDEN,
        },
        position: { name: 'absolute' },
      },
      in: {
        markup: [{ tagName: 'circle', selector: 'circle' }],
        attrs: {
          circle: PORT_IN_VISIBLE,
        },
        position: { name: 'absolute' },
      },
      inSide: {
        markup: [{ tagName: 'circle', selector: 'circle' }],
        attrs: {
          circle: PORT_HIDDEN,
        },
        position: { name: 'absolute' },
      },
    },
    items: buildPortItems(1, 1, NODE_WIDTH, NODE_HEIGHT),
  },
  effect: [
    'name',
    'stage',
    'scene',
    'isOrgasm',
    'fixedLen',
    'isStart',
    'hubReturns',
    'poseFamily',
    'ostimFolder',
    'ostimId',
    'isTransition',
    'isPortal',
    'portalFolder',
    'portalStageName',
    'portalStageId',
    'portalSceneId',
    'displayName',
  ],
  component: StageNode,
});

export { NODE_WIDTH, NODE_HEIGHT, SLOT_STEP, TRANSITION_WIDTH, TRANSITION_HEIGHT };

/** @deprecated Use outPortId(side, index). Kept for index-0 fallbacks. */
export const OUT_PORT_BY_SIDE = {
  right: 'out0',
  left: 'outLeft0',
  top: 'outTop0',
  bottom: 'outBottom0',
};
/** @deprecated Use inPortId(side, index). Kept for index-0 fallbacks. */
export const IN_PORT_BY_SIDE = {
  left: 'in0',
  right: 'inRight0',
  top: 'inTop0',
  bottom: 'inBottom0',
};
