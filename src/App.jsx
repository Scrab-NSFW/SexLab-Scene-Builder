import { useState, useEffect, useRef, useMemo } from "react";
import { useImmer } from "use-immer";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { Graph, Shape } from '@antv/x6'
import { History } from "@antv/x6-plugin-history";
import { Menu, Layout, Card, Input, Space, Button, Empty, Modal, Tooltip, notification, Divider, Switch, Checkbox, Row, Col, InputNumber, Select, ConfigProvider, Dropdown, Segmented, Typography, Alert } from 'antd'
import {
  ExperimentOutlined, PlusOutlined, ExclamationCircleOutlined, QuestionCircleOutlined, DiffOutlined, ZoomInOutlined, ZoomOutOutlined,
  DeleteOutlined, DoubleLeftOutlined, DoubleRightOutlined, PicCenterOutlined, CompressOutlined, PushpinOutlined, DragOutlined, WarningOutlined,
  ApartmentOutlined, DownloadOutlined, UndoOutlined, UnorderedListOutlined, FilterOutlined, EyeOutlined
} from '@ant-design/icons';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import './ResizableSidebar.css';
const { Header, Content, Footer, Sider } = Layout;
const { confirm } = Modal;
import { STAGE_EDGE, STAGE_EDGE_SHAPEID, forwardEdgeAttrs, viaEdgeAttrs, edgeHoverLinePatch, edgeLabelConfig } from "./scene/SceneEdge"
import { Furnitures } from "./common/Furniture";
import { destListIncludes, destStage, makeDest } from "./common/destRef";
import "./scene/SceneNode"
import { applyNodeSlots } from "./scene/SceneNode"
import { isTransitionStage, uniqueStageLabel, disambiguateDuplicateStageNames } from "./scene/stageFamily"
import {
  graphCoordsStacked,
  planToEdgeConfig,
  applyEdgePlan,
  SPARE_PORT_SLOTS,
} from "./scene/graphLayout"
import {
  computeGraphPresentation,
  applyEdgeVisibility,
  resolveVisibleKeys,
  applyNodeFocusDim,
  applyEdgeSelectionEmphasis,
  sceneGraphSignature,
} from "./scene/graphPresentation"
import {
  buildFolderMap,
  folderFilterOptions,
  folderStageCounts,
  neighborhoodIds,
  stageOstimFolder,
  stageOstimIdFromTags,
  tagsWithOstimFolder,
  isOstimPlumbingTag,
  LARGE_SCENE_STAGE_WARN,
} from "./scene/graphFocus"
import {
  isPortalNodeId,
  folderViewStageIds,
  stageIdFromPortal,
  sceneIdFromPortal,
} from "./scene/folderView"
import {
  loadGlobalAssetLibrary,
  normalizeAssetLibrary,
  emptyAssetLibrary,
} from "./common/assetLibrary"
import {
  expandCanvasToStoredGraph,
  shortTransitionLabel,
} from "./scene/transitionCollapse"
import {
  buildCanvasSvg,
  buildCanvasLayoutJson,
  defaultGraphExportName,
} from "./scene/exportCanvasSvg"
import { connectionsToCsv } from "./components/GraphConnectionsTable"
import GraphNavOutline from "./components/GraphNavOutline"
import GraphNodeSearch from "./components/GraphNodeSearch"
import OstimFolderField from "./components/OstimFolderField"
import SceneListPanel from "./components/SceneListPanel"
import OutboundLinksPanel, {
  countCrossSceneLinks,
  projectLooksLikeOstim,
} from "./components/OutboundLinksPanel"
import HelpConceptsDrawer from "./components/HelpConceptsDrawer"
import ExportFormatsModal from "./components/ExportFormatsModal"
import { LARGE_SCENE_NODE_THRESHOLD } from "./scene/graphLayoutClusters"
import { pathToNode } from "./scene/spanningForest"
import "./App.css";
// import "./Dark.css";
import ScenePosition from "./scene/ScenePosition";
import { getAppTheme } from "./common/theme";
import { applyRootDarkClass, readOsDarkMode, writeStoredDarkMode } from "./common/darkMode";
import { tagsSFW, tagsNSFW, tagsOStimActions } from "./common/Tags"
import TagTree from "./components/TagTree";
import JobProgressModal from "./components/JobProgressModal";
import AssetLibraryModal from "./components/AssetLibraryModal";
import { stashStageNavContext, parseOstimNavTags, tagsWithOstimNavs } from "./common/ostimNav";
import { stageOstimId } from "./scene/edgeRanker";
import { remove } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";

const ZOOM_OPTIONS = { minScale: 0.25, maxScale: 5 };
const AUTHORING_FOCUS_KEY = 'slsb-authoring-focus';

function readStoredAuthoringFocus() {
  try {
    const v = localStorage.getItem(AUTHORING_FOCUS_KEY);
    if (v === 'sexlab' || v === 'ostim' || v === 'all') return v;
  } catch (_) { /* ignore */ }
  return null;
}

function graphGridArgs(dark) {
  return [
    {
      thickness: 1,
      color: dark ? 'rgba(255,255,255,0.08)' : '#d0d0d4',
    },
    {
      color: dark ? 'rgba(255,255,255,0.16)' : 'rgba(33, 35, 48, 0.18)',
      thickness: dark ? 1 : 1.25,
      factor: 8,
    },
  ];
}

function App() {
  const [isDark, setIsDark] = useState(readOsDarkMode);
  const [collapsed, setCollapsed] = useState(false);  // Sider collapsed?
  const [api, contextHolder] = notification.useNotification();
  const [jobProgress, setJobProgress] = useState(null);
  const jobErrorCloseRef = useRef(null);
  const graphcontainer_ref = useRef(null);
  const [graph, setGraph] = useState(null);
  const [scenes, updateScenes] = useImmer([]);
  const [activeScene, updateActiveScene] = useImmer(null);
  const [packName, setPackName] = useState('');
  const [packAuthor, setPackAuthor] = useState('');
  const [packVersion, setPackVersion] = useState('');
  const [authoringFocus, setAuthoringFocus] = useState(readStoredAuthoringFocus);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [showOutboundPanel, setShowOutboundPanel] = useState(false);
  // Synced from project / import events for autocomplete.
  const [assetLibrary, setAssetLibrary] = useState(() => emptyAssetLibrary());
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [edited, setEditedState] = useState(false);
  const editedRef = useRef(false);
  const setEdited = (v) => {
    const next = !!v;
    editedRef.current = next;
    setEditedState(next);
    if (next) {
      invoke('mark_as_edited');
    }
  };
  const [cloneToOpen, setCloneToOpen] = useState(false);
  const [cloneToStage, setCloneToStage] = useState(null);
  const [cloneToSourceScene, setCloneToSourceScene] = useState(null);
  const [cloneToTargetId, setCloneToTargetId] = useState(null);
  const inEdit = useRef(false);
  const [showAreas, setShowAreas] = useState(false);
  const [graphWorkMode, setGraphWorkMode] = useState('browse'); // browse | edit
  // Edge modes (primary/near/family) retired — folder canvases keep clutter low.
  const [edgeFilterMode, setEdgeFilterMode] = useState('all');
  const [focusNodeIds, setFocusNodeIds] = useState([]);
  const [mapFamilyFilter, setMapFamilyFilter] = useState('all');
  const [mapFolderFilter, setMapFolderFilter] = useState('all');
  /** Folders created in-editor before any stage is tagged yet. */
  const [extraFolders, setExtraFolders] = useState([]);
  /** N-hop neighborhood when a stage is focused; Infinity = no hop dimming. */
  const [focusHops, setFocusHops] = useState(2);
  const [navOutline, setNavOutline] = useState([]);
  const [showOutline, setShowOutline] = useState(true);
  const [pathIds, setPathIds] = useState([]);
  const fullGraphRef = useRef({});
  /** Zoom/fit must wait until #graph has its final flex size (outline / outbound panels). */
  const fitGraphViewRef = useRef((_g, _opts) => {});
  /** After jumping a scene portal, focus this stage once the target scene mounts. */
  const pendingPortalFocusRef = useRef(null);

  const sceneCatalogForGraph = () =>
    (scenes || []).map((s) => ({
      id: s.id,
      name: s.name || '',
      stages: (s.stages || []).map((st) => ({
        id: st.id,
        name: st.name || '',
      })),
    }));

  const stageEditorExtras = (scene) => ({
    graph: fullGraphRef.current || scene?.graph || {},
    sceneCatalog: sceneCatalogForGraph(),
  });
  const graphMetaRef = useRef({
    families: new Map(),
    hubReturnCounts: new Map(),
    clusters: [],
    forest: null,
    folderMap: new Map(),
  });
  const presentationCacheRef = useRef(null);
  const layoutDirtyRef = useRef(false);
  const edgeFilterModeRef = useRef(edgeFilterMode);
  const focusNodeIdsRef = useRef(focusNodeIds);
  const mapFamilyFilterRef = useRef(mapFamilyFilter);
  const mapFolderFilterRef = useRef(mapFolderFilter);
  const focusHopsRef = useRef(focusHops);
  const graphWorkModeRef = useRef(graphWorkMode);
  /** Packed positions at scene open (before arrange) — snap-back target. */
  const layoutSnapshotRef = useRef(null);
  const refreshGraphEdgesRef = useRef(() => {});
  const rebuildGraphPresentationRef = useRef(() => {});
  const scheduleTopologyRebuildRef = useRef(() => {});
  const syncStoredGraphFromCanvasRef = useRef(() => ({}));
  const stashNavForStage = (scene, stageId) => {
    const live =
      syncStoredGraphFromCanvasRef.current?.() ||
      fullGraphRef.current ||
      scene?.graph ||
      {};
    stashStageNavContext(scene, stageId, live);
  };
  const rebuildTimerRef = useRef(null);
  const activeSceneRef = useRef(null);
  /** Per-scene folder → Map<nodeId,{x,y}> so virtual canvas switches stay snappy. */
  const folderLayoutCacheRef = useRef(new Map());
  const jumpToPortalRef = useRef(() => {});
  const insertingTransitionRef = useRef(false);
  const suppressingNodeRemoveRef = useRef(false);
  /** Click-to-connect / rewire: { cellId, portId, role:'out'|'in' } or { fixedCellId, fixedPortId, fixedRole, picking } */
  const connectPendingRef = useRef(null);
  const previewEdgeIdRef = useRef(null);
  const clearConnectPendingRef = useRef(() => {});
  /**
   * Next new stage from the editor should land here.
   * { x, y, connectFrom?: { nodeId, portId, role:'out'|'in' } }
   */
  const pendingStageDropRef = useRef(null);
  /** Set when finishing a click-connect so the same click doesn't start a new rubber-band. */
  const suppressConnectStartUntilRef = useRef(0);
  /** Live copy of graphCtxMenu for pointermove / blank handlers inside the graph setup. */
  const graphCtxMenuRef = useRef(null);
  /** Stable connect-drop payload (survives menu close races). */
  const connectDropIntentRef = useRef(null);
  /** Ignore blank clicks shortly after contextmenu / connect-drop actions. */
  const ignoreBlankClickUntilRef = useRef(0);
  const [graphCtxMenu, setGraphCtxMenu] = useState(null);
  const [connectHint, setConnectHint] = useState(null);

  useEffect(() => {
    activeSceneRef.current = activeScene;
  }, [activeScene]);

  useEffect(() => {
    graphCtxMenuRef.current = graphCtxMenu;
  }, [graphCtxMenu]);

  useEffect(() => {
    edgeFilterModeRef.current = edgeFilterMode;
  }, [edgeFilterMode]);

  useEffect(() => {
    focusNodeIdsRef.current = focusNodeIds;
  }, [focusNodeIds]);

  useEffect(() => {
    mapFamilyFilterRef.current = mapFamilyFilter;
  }, [mapFamilyFilter]);

  useEffect(() => {
    mapFolderFilterRef.current = mapFolderFilter;
  }, [mapFolderFilter]);

  useEffect(() => {
    focusHopsRef.current = focusHops;
  }, [focusHops]);

  useEffect(() => {
    graphWorkModeRef.current = graphWorkMode;
  }, [graphWorkMode]);

  const familyFilterOptions = useMemo(() => {
    const fam = graphMetaRef.current.families;
    if (!fam?.size) return [];
    return [...new Set(fam.values())].sort();
  }, [navOutline, activeScene?.id]);

  const ostimFolderOptions = useMemo(() => {
    const map = buildFolderMap(activeScene?.stages || []);
    const counts = folderStageCounts(map);
    const names = [
      ...new Set([...folderFilterOptions(map), ...extraFolders]),
    ].sort((a, b) => a.localeCompare(b));
    return names.map((f) => ({
      value: f,
      label: `Canvas: ${f} (${counts.get(f) || 0})`,
    }));
  }, [activeScene?.id, activeScene?.stages, extraFolders]);

  const showLargeSceneTip = (activeScene?.stages?.length || 0) >= LARGE_SCENE_STAGE_WARN;
  const showFolderTip =
    ostimFolderOptions.length > 0 && mapFolderFilter !== 'all';

  const resolvedAuthoringFocus =
    authoringFocus || (projectLooksLikeOstim(scenes) ? 'ostim' : 'sexlab');
  const showOstimChrome =
    resolvedAuthoringFocus === 'ostim' || resolvedAuthoringFocus === 'all';
  const setAndStoreAuthoringFocus = (v) => {
    setAuthoringFocus(v);
    try {
      localStorage.setItem(AUTHORING_FOCUS_KEY, v);
    } catch (_) { /* ignore */ }
  };

  const openStageById = (stageId) => {
    const scene = activeSceneRef.current;
    const stage = scene?.stages?.find((s) => s.id === stageId);
    if (!stage || !scene) return;
    stashNavForStage(scene, stage.id);
    invoke('open_stage_editor', {
      sceneId: scene.id,
      positions: scene.positions || [],
      stage,
      existingStageCount: scene.stages?.length || 0,
      templateStage: null,
      ...stageEditorExtras(scene),
    });
  };

  function currentNeighborhoodSet(viewGraph) {
    const focus = focusNodeIdsRef.current || [];
    if (!focus.length) return null;
    const hops = focusHopsRef.current;
    if (!Number.isFinite(hops) || hops < 0) return null;
    return neighborhoodIds(viewGraph || {}, focus, hops);
  }

  function applyCanvasDims(graphInst, families) {
    applyNodeFocusDim(graphInst, {
      families,
      familyFilter: mapFamilyFilterRef.current,
      // Folder is a virtual canvas (subset mount), not a dim filter.
      folderMap: graphMetaRef.current.folderMap,
      folderFilter: 'all',
      // Selection emphasis dims the rest; hop filter is optional extras.
      neighborhoodSet: null,
      selectionIds: focusNodeIdsRef.current,
    });
    applyEdgeSelectionEmphasis(graphInst, focusNodeIdsRef.current);
  }
  function generatePositionId() {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  useEffect(() => {
    const unlisten = listen('toggle_darkmode', (event) => {
      setIsDark(event.payload);
    });
    invoke('get_in_darkmode').then(setIsDark).catch(() => {});
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    writeStoredDarkMode(isDark);
    applyRootDarkClass(isDark);
  }, [isDark]);

  /**
   * Fit/center the graph to the visible #graph host after layout settles.
   * Side panels (Navigation outline, Outbound links) shrink the flex canvas;
   * zooming before that width is stable fits to the wrong viewport.
   */
  const fitGraphView = (targetGraph = graph, opts = {}) => {
    const g = targetGraph;
    if (!g) return;
    const {
      padding = 32,
      maxScale = 1,
      minScale = 0.45,
      retries = 48,
    } = opts;
    let lastW = -1;
    let lastH = -1;
    let stableFrames = 0;
    const tick = (left) => {
      requestAnimationFrame(() => {
        try {
          g.resize();
        } catch (_) {
          /* container may be mid-layout */
        }
        const el = graphcontainer_ref.current || g.container;
        const w = el?.clientWidth || 0;
        const h = el?.clientHeight || 0;
        if (w >= 40 && h >= 40) {
          if (w === lastW && h === lastH) stableFrames += 1;
          else {
            stableFrames = 0;
            lastW = w;
            lastH = h;
          }
        } else {
          stableFrames = 0;
        }
        if (stableFrames < 2 && left > 0) {
          tick(left - 1);
          return;
        }
        try {
          if (g.getNodes?.()?.length) {
            g.zoomToFit({ padding, maxScale, minScale });
            g.centerContent();
            g.getEdges?.().forEach((edge) => {
              const edgeView = g.findViewByCell(edge);
              if (edgeView) edgeView.update();
            });
          }
        } catch (_) {
          /* ignore */
        }
      });
    };
    tick(retries);
  };
  fitGraphViewRef.current = fitGraphView;

  // Re-fit when side panels change the canvas width.
  useEffect(() => {
    if (!graph?.getNodes?.()?.length) return;
    fitGraphViewRef.current?.(graph, { padding: 28 });
  }, [graph, showOutline, showOutboundPanel, showOstimChrome]);

  // Graph
  useEffect(() => {
    const newGraph = new Graph({
      container: graphcontainer_ref.current,
      grid: {
        visible: true,
        size: 20,
        type: 'doubleMesh',
        args: graphGridArgs(isDark),
      },
      panning: true,
      autoResize: true,
      mousewheel: {
        enabled: true,
        minScale: ZOOM_OPTIONS.minScale,
        maxScale: ZOOM_OPTIONS.maxScale,
        // modifiers: ['ctrl']
      },
      connecting: {
        // Drag-from-port disabled — use click-to-connect (toggle) instead.
        allowBlank: false,
        allowMulti: false,
        allowLoop: false,
        allowEdge: false,
        allowPort: true,
        allowNode: false,
        highlight: true,
        snap: { radius: 28 },
        validateMagnet() {
          return false;
        },
        createEdge() {
          return new Shape.Edge({
            shape: STAGE_EDGE_SHAPEID,
            ...STAGE_EDGE,
            attrs: forwardEdgeAttrs(isDark),
          });
        },
      },
      highlighting: {
        magnetAvailable: {
          name: 'stroke',
          args: {
            padding: 3,
            attrs: {
              fill: '#ffffff',
              stroke: '#2563eb',
              'stroke-width': 2.5,
            },
          },
        },
        magnetAdsorbed: {
          name: 'stroke',
          args: {
            padding: 4,
            attrs: {
              fill: '#2563eb',
              stroke: '#1d4ed8',
              'stroke-width': 3,
            },
          },
        },
      },
    })
      .zoomTo(1.0)
      .use(new History({
        enabled: true,
      }));

    const portClickTimerRef = { current: null };

    const portRole = (node, port) => {
      const meta = (node.getPorts?.() || []).find((p) => p.id === port);
      const g = meta?.group || '';
      if (g === 'out') return 'out';
      if (g === 'in') return 'in';
      return null;
    };

    const findEdgesAtPort = (node, port, role) => {
      return newGraph.getConnectedEdges(node).filter((ed) => {
        if (ed.getData?.()?.preview) return false;
        const s = ed.getSource();
        const t = ed.getTarget();
        const data = ed.getData?.() || {};
        if (role === 'out') {
          if (s.cell !== node.id) return false;
          return s.port === port || data.slotOut === port;
        }
        if (t.cell !== node.id) return false;
        return t.port === port || data.slotIn === port;
      });
    };

    const clearConnectPending = ({ restore = false } = {}) => {
      if (portClickTimerRef.current) {
        clearTimeout(portClickTimerRef.current);
        portClickTimerRef.current = null;
      }
      const pending = connectPendingRef.current;
      const id = previewEdgeIdRef.current;
      previewEdgeIdRef.current = null;
      if (id) {
        const pe = newGraph.getCellById(id);
        if (pe) pe.remove();
      }
      if (restore && pending?.restore) {
        const dark = !!document
          .getElementById('root')
          ?.classList.contains('dark-mode');
        const r = pending.restore;
        const via = r.viaStageId;
        newGraph.addEdge({
          shape: STAGE_EDGE_SHAPEID,
          ...STAGE_EDGE,
          source: r.source,
          target: r.target,
          attrs: via ? viaEdgeAttrs(dark) : forwardEdgeAttrs(dark),
          labels: via
            ? edgeLabelConfig(
                r.label || shortTransitionLabel(r.viaName || ''),
                dark
              )
            : [],
          data: {
            viaStageId: via || null,
            viaName: r.viaName || null,
            slotOut: r.slotOut || null,
            slotIn: r.slotIn || null,
          },
        });
        setEdited(true);
        presentationCacheRef.current = null;
        queueMicrotask(() => rebuildGraphPresentationRef.current?.());
      }
      connectPendingRef.current = null;
      setConnectHint(null);
      document.body.classList.remove('slsb-connecting');
    };
    clearConnectPendingRef.current = clearConnectPending;

    const handlePortConnectClick = (node, port) => {
      const role = portRole(node, port);
      if (!role) return;
      const dark = !!document
        .getElementById('root')
        ?.classList.contains('dark-mode');
      const pending = connectPendingRef.current;

      const makePreview = (fromRole, cellId, portId) => {
        const box = newGraph.getCellById(cellId)?.getBBox?.() || node.getBBox();
        const mid = {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        };
        const preview = newGraph.addEdge({
          shape: STAGE_EDGE_SHAPEID,
          ...STAGE_EDGE,
          source:
            fromRole === 'out' ? { cell: cellId, port: portId } : { ...mid },
          target:
            fromRole === 'in' ? { cell: cellId, port: portId } : { ...mid },
          attrs: {
            line: {
              ...forwardEdgeAttrs(dark).line,
              strokeDasharray: '4 4',
              strokeOpacity: 0.65,
              style: { pointerEvents: 'none' },
            },
          },
          data: { preview: true },
          zIndex: 20,
        });
        previewEdgeIdRef.current = preview.id;
      };

      if (!pending) {
        const id = previewEdgeIdRef.current;
        previewEdgeIdRef.current = null;
        if (id) {
          const pe = newGraph.getCellById(id);
          if (pe) pe.remove();
        }
        connectPendingRef.current = { cellId: node.id, portId: port, role };
        setConnectHint(
          role === 'out'
            ? 'Click a stage or its blue input — right-click empty canvas → Create stage here (Esc cancels)'
            : 'Click a stage or its green output — right-click empty canvas → Create stage here (Esc cancels)'
        );
        document.body.classList.add('slsb-connecting');
        makePreview(role, node.id, port);
        return;
      }

      let source;
      let target;
      let viaStageId = pending.viaStageId || null;
      let viaName = pending.viaName || null;
      let label = pending.label || '';
      let slotOut = pending.slotOut || null;
      let slotIn = pending.slotIn || null;

      if (pending.fixedCellId) {
        if (role !== pending.picking) return;
        if (pending.fixedRole === 'out') {
          source = { cell: pending.fixedCellId, port: pending.fixedPortId };
          target = { cell: node.id, port };
          slotOut = slotOut || pending.fixedPortId;
          slotIn = port;
        } else {
          source = { cell: node.id, port };
          target = { cell: pending.fixedCellId, port: pending.fixedPortId };
          slotOut = port;
          slotIn = slotIn || pending.fixedPortId;
        }
      } else if (pending.role === role) {
        const id = previewEdgeIdRef.current;
        previewEdgeIdRef.current = null;
        if (id) {
          const pe = newGraph.getCellById(id);
          if (pe) pe.remove();
        }
        connectPendingRef.current = { cellId: node.id, portId: port, role };
        makePreview(role, node.id, port);
        return;
      } else if (pending.role === 'out' && role === 'in') {
        source = { cell: pending.cellId, port: pending.portId };
        target = { cell: node.id, port };
        slotOut = pending.portId;
        slotIn = port;
      } else if (pending.role === 'in' && role === 'out') {
        source = { cell: node.id, port };
        target = { cell: pending.cellId, port: pending.portId };
        slotOut = port;
        slotIn = pending.portId;
      } else {
        return;
      }

      if (source.cell === target.cell) {
        clearConnectPending({ restore: false });
        return;
      }

      const id = previewEdgeIdRef.current;
      previewEdgeIdRef.current = null;
      if (id) {
        const pe = newGraph.getCellById(id);
        if (pe) pe.remove();
      }
      connectPendingRef.current = null;
      setConnectHint(null);
      document.body.classList.remove('slsb-connecting');
      // Finishing often also hits port:click with pending=null and would start again.
      suppressConnectStartUntilRef.current = Date.now() + 400;

      const created = newGraph.addEdge({
        shape: STAGE_EDGE_SHAPEID,
        ...STAGE_EDGE,
        source,
        target,
        attrs: viaStageId ? viaEdgeAttrs(dark) : forwardEdgeAttrs(dark),
        labels: viaStageId
          ? edgeLabelConfig(
              label || shortTransitionLabel(viaName || ''),
              dark
            )
          : [],
        data: {
          viaStageId: viaStageId || null,
          viaName: viaName || null,
          slotOut: slotOut || null,
          slotIn: slotIn || null,
        },
      });
      if (typeof created?.setVisible === 'function') created.setVisible(true);
      setEdited(true);
      scheduleTopologyRebuildRef.current?.([source.cell, target.cell]);
    };


    newGraph
      .on("node:removed", ({ node }) => {
        if (inEdit.current || suppressingNodeRemoveRef.current) return;
        if (node.prop('isPortal') || isPortalNodeId(node.id)) return;
        updateActiveScene(prev => {
          if (prev.root === node.id) {
            prev.root = null;
          }
          prev.stages = prev.stages.filter(it => it.id !== node.id);
        })
        setEdited(true);
      })
      .on("node:added", (evt) => {
        if (inEdit.current) return;
        setEdited(true);
      })
      .on("node:moved", ({ e, x, y, node, view }) => {
        const box = node.getBBox();
        const views = newGraph.findViewsInArea(box);
        views.forEach(it => {
          if (!it.isEdgeView()) {
            return;
          }
          it.update();
        });
        layoutDirtyRef.current = true;
        if (inEdit.current) return;
        setEdited(true);
      })
      .on("node:mouseup", () => {
        if (!layoutDirtyRef.current) return;
        layoutDirtyRef.current = false;
        presentationCacheRef.current = null;
        queueMicrotask(() => rebuildGraphPresentationRef.current?.());
      })
      .on("edge:dblclick", ({ edge }) => {
        const via = edge.getData?.()?.viaStageId;
        if (!via) return;
        const scene = activeSceneRef.current;
        const stage = scene?.stages?.find((s) => s.id === via);
        if (!stage || !scene) return;
        stashNavForStage(scene, stage.id);
        invoke('open_stage_editor', {
          sceneId: scene.id,
          positions: scene.positions || [],
          stage,
          existingStageCount: scene.stages?.length || 0,
          templateStage: null,
          ...stageEditorExtras(scene),
        });
      })
      .on("edge:mouseenter", ({ edge }) => {
        if (edge.getData?.()?.preview) return;
        const line = edge.attr('line') || {};
        edge.setProp(
          'edgeHoverBase',
          {
            strokeWidth: line.strokeWidth,
            stroke: line.stroke,
          },
          { silent: true }
        );
        const dark = !!document.getElementById('root')?.classList.contains('dark-mode');
        const patch = edgeHoverLinePatch(edge.getData?.() || {}, dark);
        edge.attr('line/strokeWidth', patch.strokeWidth);
        edge.attr('line/stroke', patch.stroke);
      })
      .on("edge:mouseleave", ({ edge }) => {
        const base = edge.prop('edgeHoverBase') || edge.prop('viaHoverBase');
        if (!base) return;
        if (base.strokeWidth != null) edge.attr('line/strokeWidth', base.strokeWidth);
        if (base.stroke != null) edge.attr('line/stroke', base.stroke);
        edge.setProp('edgeHoverBase', null, { silent: true });
        edge.setProp('viaHoverBase', null, { silent: true });
      })
      .on("edge:contextmenu", ({ e, edge }) => {
        e.preventDefault?.();
        e.stopPropagation();
        if (edge.getData?.()?.preview) return;
        const data = edge.getData?.() || {};
        setGraphCtxMenu({
          kind: 'edge',
          x: e.clientX,
          y: e.clientY,
          edgeId: edge.id,
          via: data.viaStageId || null,
          bridgeTargetId: data.bridgeTargetId || null,
          bridgeSourceId: data.bridgeSourceId || null,
          bridgeFolder: data.bridgeFolder || null,
        });
      })
      .on("edge:connected", ({ edge }) => {
        if (inEdit.current || insertingTransitionRef.current) return;
        if (edge.getData?.()?.preview) return;
        setEdited(true);
        // Keep the new edge visible immediately; polish routing shortly after.
        if (typeof edge.setVisible === 'function') edge.setVisible(true);
        scheduleTopologyRebuildRef.current?.([
          edge.getSourceCellId(),
          edge.getTargetCellId(),
        ]);
      })
      .on("node:doMarkRoot", ({ node }) => {
        updateActiveScene(prev => {
          const cell = newGraph.getCellById(prev.root);
          if (cell) { cell.prop('isStart', false); }
          node.prop('isStart', true);
          prev.root = node.id;
        });
        setEdited(true);
      })
      .on("node:clone", ({ node }) => {
        // Prefer live scene/stage data — node props go stale when actors are
        // added/removed from another stage editor in the same animation.
        const live = activeSceneRef.current;
        const belonging = node.prop('scene');
        const scene =
          live && belonging && live.id === belonging.id ? live : belonging;
        const stage =
          scene?.stages?.find((s) => s.id === node.id) || node.prop('stage');
        stashStageNavContext(scene, null, {});
        invoke('open_stage_editor_from', {
          sceneId: scene.id,
          positions: scene.positions || [],
          copyStage: stage,
          existingStageCount: scene.stages?.length || 0,
          ...stageEditorExtras(scene),
        });
      })
      .on("node:cloneTo", ({ node }) => {
        const live = activeSceneRef.current;
        const belonging = node.prop('scene');
        const sourceScene =
          live && belonging && live.id === belonging.id ? live : belonging;
        const stage =
          sourceScene?.stages?.find((s) => s.id === node.id) ||
          node.prop('stage');
        setCloneToStage(stage);
        setCloneToSourceScene(sourceScene);
        setCloneToTargetId(null);
        setCloneToOpen(true);
      })
      .on('node:click', ({ e, node }) => {
        setGraphCtxMenu(null);
        // Port clicks finish via node:port:click; skipping here avoids a
        // double-finish that then starts a new connection from the entry port.
        if (
          connectPendingRef.current &&
          e?.target?.closest?.('.x6-port, .x6-port-body')
        ) {
          return;
        }
        // Finish a pending link by clicking the target node (default spare port).
        const pending = connectPendingRef.current;
        if (
          pending &&
          !pending.fixedCellId &&
          pending.cellId &&
          pending.cellId !== node.id &&
          !(node.prop('isPortal') || isPortalNodeId(node.id))
        ) {
          const wantGroup = pending.role === 'out' ? 'in' : 'out';
          const ports = node.getPorts?.() || [];
          const pick =
            ports.find((p) => p.group === wantGroup) ||
            ports.find((p) =>
              wantGroup === 'in'
                ? String(p.group || '').startsWith('in')
                : String(p.group || '').startsWith('out')
            );
          if (pick?.id) {
            handlePortConnectClick(node, pick.id);
            return;
          }
        }
        if (node.prop('isPortal') || isPortalNodeId(node.id)) {
          queueMicrotask(() => jumpToPortalRef.current?.(node));
          return;
        }
        setFocusNodeIds([node.id]);
        focusNodeIdsRef.current = [node.id];
        const forest = graphMetaRef.current.forest;
        if (forest?.parent) {
          setPathIds(pathToNode(node.id, forest.parent));
        }
        queueMicrotask(() => refreshGraphEdgesRef.current?.());
      })
      .on('node:contextmenu', ({ e, node }) => {
        e.preventDefault?.();
        e.stopPropagation();
        const isPortal = !!(node.prop('isPortal') || isPortalNodeId(node.id));
        setFocusNodeIds(isPortal ? [] : [node.id]);
        if (!isPortal) focusNodeIdsRef.current = [node.id];
        setGraphCtxMenu({
          kind: isPortal ? 'portal' : 'node',
          x: e.clientX,
          y: e.clientY,
          nodeId: node.id,
          portalStageId: node.prop('portalStageId') || stageIdFromPortal(node.id),
          portalFolder: node.prop('portalFolder') || '',
          portalSceneId:
            node.prop('portalSceneId') || sceneIdFromPortal(node.id) || '',
          ostimFolder: node.prop('ostimFolder') || '',
        });
      })
      .on('node:portalJump', ({ node }) => {
        jumpToPortalRef.current?.(node);
      })
      .on('blank:click', () => {
        if (Date.now() < ignoreBlankClickUntilRef.current) return;
        // Keep rubber-band + drop intent while the connect context menu is open.
        if (graphCtxMenuRef.current?.kind === 'connect-drop') return;
        setGraphCtxMenu(null);
        connectDropIntentRef.current = null;
        clearConnectPending({ restore: true });
        if (focusNodeIdsRef.current?.length) {
          setFocusNodeIds([]);
          focusNodeIdsRef.current = [];
          setPathIds([]);
          queueMicrotask(() => refreshGraphEdgesRef.current?.());
        }
      })
      .on('blank:contextmenu', ({ e }) => {
        e.preventDefault?.();
        e.stopPropagation();
        // Avoid the browser's follow-up click canceling the rubber-band link.
        ignoreBlankClickUntilRef.current = Date.now() + 800;
        let graphX = 40;
        let graphY = 40;
        try {
          const local = newGraph.clientToLocal(e.clientX, e.clientY);
          graphX = local.x;
          graphY = local.y;
        } catch (_) { /* ignore */ }
        const pending = connectPendingRef.current;
        // Port was clicked earlier: drop a new stage at the cursor and link it.
        if (
          pending?.cellId &&
          pending?.role &&
          !pending?.fixedCellId &&
          !pending?.picking
        ) {
          // Freeze the preview at the right-click point while the menu is open.
          const previewId = previewEdgeIdRef.current;
          if (previewId) {
            const pe = newGraph.getCellById(previewId);
            if (pe) {
              const local = { x: graphX, y: graphY };
              if (pending.role === 'out' || pending.fixedRole === 'out') {
                pe.setTarget(local);
              } else {
                pe.setSource(local);
              }
            }
          }
          const intent = {
            graphX,
            graphY,
            connectFrom: {
              nodeId: pending.cellId,
              portId: pending.portId,
              role: pending.role,
            },
          };
          connectDropIntentRef.current = intent;
          setGraphCtxMenu({
            kind: 'connect-drop',
            x: e.clientX,
            y: e.clientY,
            ...intent,
          });
          return;
        }
        connectDropIntentRef.current = null;
        setGraphCtxMenu({
          kind: 'blank',
          x: e.clientX,
          y: e.clientY,
          graphX,
          graphY,
        });
      })
      .on('node:port:click', ({ e, node, port }) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        setGraphCtxMenu(null);
        if (!portRole(node, port)) return;

        const run = () => handlePortConnectClick(node, port);
        if (connectPendingRef.current) {
          if (portClickTimerRef.current) {
            clearTimeout(portClickTimerRef.current);
            portClickTimerRef.current = null;
          }
          run();
          return;
        }
        if (Date.now() < suppressConnectStartUntilRef.current) return;
        if (portClickTimerRef.current) clearTimeout(portClickTimerRef.current);
        portClickTimerRef.current = setTimeout(() => {
          portClickTimerRef.current = null;
          if (Date.now() < suppressConnectStartUntilRef.current) return;
          if (connectPendingRef.current) return;
          run();
        }, 220);
      })
      .on('node:port:dblclick', ({ e, node, port }) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        setGraphCtxMenu(null);
        if (portClickTimerRef.current) {
          clearTimeout(portClickTimerRef.current);
          portClickTimerRef.current = null;
        }
        const role = portRole(node, port);
        if (!role) return;

        if (connectPendingRef.current) {
          clearConnectPending({ restore: true });
        }

        let connected = findEdgesAtPort(node, port, role);
        if (!connected.length) {
          const dir = newGraph.getConnectedEdges(node).filter((ed) => {
            if (ed.getData?.()?.preview) return false;
            const s = ed.getSource();
            const t = ed.getTarget();
            return role === 'out' ? s.cell === node.id : t.cell === node.id;
          });
          if (dir.length === 1) connected = dir;
        }
        if (!connected.length) return;

        const edge = connected[0];
        const src = edge.getSource();
        const tgt = edge.getTarget();
        const data = edge.getData?.() || {};
        const via = data.viaStageId || null;
        const viaName = data.viaName || null;
        const label =
          (edge.getLabels?.()?.[0]?.attrs?.label?.text) ||
          shortTransitionLabel(viaName || '');
        const dark = !!document
          .getElementById('root')
          ?.classList.contains('dark-mode');

        // Detach the clicked end; keep the other end fixed for reattach.
        const detachSource = role === 'out';
        const fixedCellId = detachSource ? tgt.cell : src.cell;
        const fixedPortId = detachSource ? tgt.port : src.port;
        const fixedRole = detachSource ? 'in' : 'out';
        const picking = detachSource ? 'out' : 'in';

        edge.remove();
        setEdited(true);

        clearConnectPending({ restore: false });
        connectPendingRef.current = {
          fixedCellId,
          fixedPortId,
          fixedRole,
          picking,
          viaStageId: via,
          viaName,
          label,
          slotOut: data.slotOut || src.port || null,
          slotIn: data.slotIn || tgt.port || null,
          restore: {
            source: { cell: src.cell, port: src.port },
            target: { cell: tgt.cell, port: tgt.port },
            viaStageId: via,
            viaName,
            label,
            slotOut: data.slotOut || null,
            slotIn: data.slotIn || null,
          },
        };
        setConnectHint(
          picking === 'in'
            ? 'Click an input port to reattach (Esc cancels)'
            : 'Click an output port to reattach (Esc cancels)'
        );
        document.body.classList.add('slsb-connecting');
        const box = newGraph.getCellById(fixedCellId)?.getBBox?.() || {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        };
        const loose = {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        };
        const preview = newGraph.addEdge({
          shape: STAGE_EDGE_SHAPEID,
          ...STAGE_EDGE,
          source:
            fixedRole === 'out'
              ? { cell: fixedCellId, port: fixedPortId }
              : { ...loose },
          target:
            fixedRole === 'in'
              ? { cell: fixedCellId, port: fixedPortId }
              : { ...loose },
          attrs: {
            line: {
              ...(via ? viaEdgeAttrs(dark) : forwardEdgeAttrs(dark)).line,
              strokeDasharray: '4 4',
              strokeOpacity: 0.65,
              style: { pointerEvents: 'none' },
            },
          },
          data: { preview: true },
          zIndex: 20,
        });
        previewEdgeIdRef.current = preview.id;
      });

    const onConnectPointerMove = (ev) => {
      // Freeze rubber-band while any graph context menu is open.
      if (graphCtxMenuRef.current) return;
      const id = previewEdgeIdRef.current;
      if (!id || !connectPendingRef.current) return;
      const edge = newGraph.getCellById(id);
      if (!edge) return;
      const local = newGraph.clientToLocal(ev.clientX, ev.clientY);
      const pending = connectPendingRef.current;
      if (pending.fixedRole === 'out' || pending.role === 'out') {
        edge.setTarget(local);
      } else {
        edge.setSource(local);
      }
    };
    const onConnectKeyDown = (ev) => {
      if (ev.key !== 'Escape') return;
      connectDropIntentRef.current = null;
      setGraphCtxMenu(null);
      clearConnectPending({ restore: true });
    };
    window.addEventListener('pointermove', onConnectPointerMove);
    window.addEventListener('keydown', onConnectKeyDown);

    setGraph(newGraph);
    return () => {
      if (portClickTimerRef.current) {
        clearTimeout(portClickTimerRef.current);
        portClickTimerRef.current = null;
      }
      if (rebuildTimerRef.current) {
        clearTimeout(rebuildTimerRef.current);
        rebuildTimerRef.current = null;
      }
      window.removeEventListener('pointermove', onConnectPointerMove);
      window.removeEventListener('keydown', onConnectKeyDown);
      document.body.classList.remove('slsb-connecting');
      newGraph.dispose();
      if (graphcontainer_ref.current) {
        graphcontainer_ref.current.innerHTML = '';
      }
    }
  }, []);

  useEffect(() => {
    if (!graph) return;
    graph.drawGrid({
      type: 'doubleMesh',
      args: graphGridArgs(isDark),
    });
  }, [graph, isDark]);

  useEffect(() => {
    if (!graph) return;

    const editStage = (node) => {
      if (node?.prop?.('isPortal') || isPortalNodeId(node?.id)) {
        jumpToPortalRef.current?.(node);
        return;
      }
      // Live stage from activeScene — node.prop('stage') lags when actors are
      // added via another stage in this animation.
      let stage =
        activeScene?.stages?.find((s) => s.id === node.id) ||
        node.prop('stage');
      console.log("Editing stage", stage, "in scene", activeScene);

      console.assert(activeScene.stages.findIndex(it => it.id === stage.id) > -1, "Editing stage that does not belong to active scene: ", stage, activeScene);
      stashNavForStage(activeScene, stage.id);
      invoke('open_stage_editor', {
        sceneId: activeScene.id,
        positions: activeScene.positions || [],
        stage,
        existingStageCount: activeScene.stages?.length || 0,
        templateStage: null,
        ...stageEditorExtras(activeScene),
      });
    }

    graph
      .on('node:dblclick', ({ node }) => {
        editStage(node);
      })
      .on("node:edit", ({ node }) => {
        editStage(node);
      })
    return () => {
      graph.off('node:dblclick');
      graph.off('node:edit');
    }
  }, [graph, activeScene])

  useEffect(() => {
    const stage_save = listen('on_stage_saved', (event) => {
      const { scene, positions, stage, graph: savedGraph } = event.payload;
      console.log("Saving new stage in ", scene, positions, stage);
      const sceneId = typeof scene === 'string' ? scene : scene?.id ?? scene;
      const updatingActiveScene =
        scenes.length === 0 || activeScene?.id === sceneId;
      let updatedScene = undefined;
      let updatedSceneIdx = -1;
      let node = undefined;
      if (updatingActiveScene) {
        const nodes = graph.getNodes();
        node = nodes.find((n) => n.id === stage.id);
        // Collapsed transitions live as via-edges, not canvas nodes.
        if (!node && !isTransitionStage(stage)) {
          const drop = pendingStageDropRef.current;
          node = addStageToGraph(
            stage,
            Number.isFinite(drop?.x) ? drop.x : undefined,
            Number.isFinite(drop?.y) ? drop.y : undefined
          );
        }
        if (node) updateNodeProps(stage, node, activeScene);
        updatedScene = activeScene;
      } else {
        updatedSceneIdx = scenes.findIndex((it) => it.id === sceneId);
        if (updatedSceneIdx === -1) {
          // Destination missing from the sidebar list (e.g. created but never
          // flushed). Still accept the clone using the editor payload.
          console.warn(
            'Scene not in list; creating from clone payload',
            sceneId,
            scenes
          );
          updatedScene = {
            id: sceneId,
            name: '',
            stages: [],
            root: stage.id,
            graph: {},
            furniture: {
              enabled: false,
              id: '',
              offset: { x: 0, y: 0, z: 0, r: 0 },
            },
            private: false,
            tags: [],
            positions: [],
            has_warnings: false,
          };
        } else {
          updatedScene = scenes[updatedSceneIdx];
        }
      }
      updatedScene = structuredClone(updatedScene);
      if (savedGraph && typeof savedGraph === 'object' && Object.keys(savedGraph).length > 0) {
        updatedScene.graph = savedGraph;
        if (updatingActiveScene) {
          fullGraphRef.current = savedGraph;
        }
      }
      // Inherit active canvas folder when authoring a pack split.
      const canvasFolder = mapFolderFilterRef.current;
      if (
        canvasFolder &&
        canvasFolder !== 'all' &&
        !stageOstimFolder(stage)
      ) {
        stage.tags = tagsWithOstimFolder(stage.tags || [], canvasFolder);
      }
      if (node && !isPortalNodeId(node.id)) {
        node.prop('ostimFolder', stageOstimFolder(stage) || '');
      }
      let editedStageIdx =
        updatedScene.stages?.findIndex((it) => it.id === stage.id) ?? -1;
      if (editedStageIdx === -1) {
        updatedScene.stages = updatedScene.stages || [];
        updatedScene.stages.push(stage);
        if (updatedScene.stages.length === 1) {
          if (node) node.prop('isStart', true);
          updatedScene.root = stage.id;
        }
        const drop = pendingStageDropRef.current;
        // Prefer live canvas topology — activeScene.graph is often stale until save.
        const g = structuredClone(
          fullGraphRef.current || updatedScene.graph || {}
        );
        if (!g[stage.id]) {
          const count = Object.keys(g).length;
          g[stage.id] = {
            dest: [],
            x: Number.isFinite(drop?.x)
              ? drop.x
              : 40 + (count % 4) * 220,
            y: Number.isFinite(drop?.y)
              ? drop.y
              : 40 + Math.floor(count / 4) * 140,
          };
        } else if (Number.isFinite(drop?.x) && Number.isFinite(drop?.y)) {
          g[stage.id] = {
            ...g[stage.id],
            x: drop.x,
            y: drop.y,
            dest: [...(g[stage.id].dest || [])],
          };
        }
        const link = drop?.connectFrom;
        if (link?.nodeId && link.nodeId !== stage.id) {
          if (!g[link.nodeId]) {
            g[link.nodeId] = { dest: [], x: 40, y: 40 };
          } else {
            g[link.nodeId] = {
              ...g[link.nodeId],
              dest: [...(g[link.nodeId].dest || [])],
            };
          }
          if (!g[stage.id].dest) g[stage.id].dest = [];
          if (link.role === 'out') {
            if (!destListIncludes(g[link.nodeId].dest, stage.id)) {
              g[link.nodeId].dest.push(makeDest(updatedScene.id, stage.id));
            }
          } else if (link.role === 'in') {
            if (!destListIncludes(g[stage.id].dest, link.nodeId)) {
              g[stage.id].dest.push(makeDest(updatedScene.id, link.nodeId));
            }
          }
        }
        updatedScene.graph = g;
        if (updatingActiveScene) {
          fullGraphRef.current = g;
        }
        if (!updatedScene.root) {
          updatedScene.root = stage.id;
        }
        pendingStageDropRef.current = null;
      } else {
        updatedScene.stages[editedStageIdx] = stage;
        pendingStageDropRef.current = null;
      }
      updatedScene.positions = positions;
      if (updatingActiveScene) {
        if (activeSceneRef.current?.id === updatedScene.id) {
          activeSceneRef.current = updatedScene;
        }
        updateActiveScene(updatedScene);
        setEdited(true);
        presentationCacheRef.current = null;
        // skipSync: canvas may not have the new edge yet; fullGraphRef is authority.
        queueMicrotask(() =>
          rebuildGraphPresentationRef.current?.({ skipSync: true })
        );
      } else {
        invoke('save_scene', { scene: updatedScene })
          .then(() => {
            updateScenes((prev) => {
              const idx = prev.findIndex((s) => s.id === updatedScene.id);
              if (idx === -1) prev.push(updatedScene);
              else prev[idx] = updatedScene;
            });
            // Do not setEdited(true): the active (source) animation was not
            // modified. save_scene already marks the project dirty in Rust.
            api.success({
              message: 'Stage cloned',
              description: `Added to “${updatedScene.name || 'Untitled'}”. Open that animation to see it.`,
              placement: 'bottomLeft',
            });
          })
          .catch((err) => {
            console.error(err);
            api.error({
              message: 'Failed to save cloned stage',
              description: String(err),
              placement: 'bottomLeft',
            });
          });
      }
    });
    const position_remove = listen('on_position_remove', (event) => {
      const { sceneId, positionIdx } = event.payload;
      console.log("Removing position", positionIdx, "from scene", sceneId);

      const remove_position = (scene) => {
        // Remove from each stage
        scene.stages.forEach(stage => {
          if (positionIdx >= 0 && positionIdx < stage.positions.length) {
            stage.positions = stage.positions.filter((_, idx) => idx !== positionIdx);
          }
        });
        // Remove from scene.positions
        scene.positions = scene.positions.filter((_, idx) => idx !== positionIdx);
        scene.has_warnings = true;
      };
      if (scenes.length === 0 || activeScene.id === sceneId) {
        updateActiveScene(draft => remove_position(draft));
      } else {
        updateScenes(draft => {
          const idx = draft.findIndex(it => it.id === sceneId);
          if (idx === -1) return;
          remove_position(draft[idx]);
        });
      }
    });
    const position_add = listen('on_position_add', (event) => {
      const { sceneId, position } = event.payload;
      console.log("Adding position", position, "to scene", sceneId);

      const add_position = (scene) => {
        // Always clone and assign a unique id
        const newPosition = { ...position.info, id: generatePositionId() };
        scene.stages.forEach(stage => {
          stage.positions.push({ ...position.position, id: generatePositionId() });
        });
        scene.positions.push(newPosition);
        scene.has_warnings = true;
      };

      if (scenes.length === 0 || activeScene.id === sceneId) {
        updateActiveScene(draft => add_position(draft));
      } else {
        updateScenes(draft => {
          const idx = draft.findIndex(it => it.id === sceneId);
          if (idx === -1) return;
          add_position(draft[idx]);
        });
      }
    });
    const position_change = listen('on_position_change', (event) => {
      const { sceneId, stageId, positionIdx, info } = event.payload;
      if (stageId === 0) return // invoked by ScenePosition, skip
      // Skip position change if the scene is not currently active
      // If the stage of an inactive scene is saved, the info will be updated accordingly
      if (scenes.length === 0 || activeScene.id === sceneId) {
        updateActiveScene(draft => {
          // Always clone and assign a unique id
          const newPosition = { ...info, id: generatePositionId() };
          draft.positions[positionIdx] = newPosition;
        });
      }
    });
    return () => {
      console.log("Active before update:", activeScene);
      stage_save.then(res => { res() });
      position_remove.then(res => { res() });
      position_add.then(res => { res() });
      position_change.then(res => { res() });
    }
  }, [graph, activeScene, scenes])

  useEffect(() => {
    if (!graph) return;
    const unlistenJob = listen('on_job_progress', (event) => {
      const p = event.payload || {};
      if (jobErrorCloseRef.current) {
        clearTimeout(jobErrorCloseRef.current);
        jobErrorCloseRef.current = null;
      }
      if (p.done) {
        if (p.error) {
          setJobProgress({
            title: p.title || 'Failed',
            message: p.message || '',
            current: p.current ?? null,
            total: p.total ?? null,
            error: p.error,
          });
          jobErrorCloseRef.current = setTimeout(() => {
            setJobProgress(null);
            jobErrorCloseRef.current = null;
          }, 1800);
          return;
        }
        setJobProgress(null);
        return;
      }
      setJobProgress({
        title: p.title || 'Working…',
        message: p.message || '',
        current: p.current ?? null,
        total: p.total ?? null,
        error: null,
      });
    });
    const applyAssetLibrary = (raw, { seedIfEmpty = false } = {}) => {
      let lib = normalizeAssetLibrary(raw);
      const isEmpty =
        !lib.events.length &&
        !lib.anim_objects.length &&
        !lib.equip_objects.length &&
        !lib.icons.length;
      if (seedIfEmpty && isEmpty) {
        const global = loadGlobalAssetLibrary();
        const hasGlobal =
          global.events.length ||
          global.anim_objects.length ||
          global.equip_objects.length ||
          global.icons.length;
        if (hasGlobal) {
          invoke('set_asset_library', { library: global })
            .then((merged) => {
              setAssetLibrary(normalizeAssetLibrary(merged));
            })
            .catch((err) => console.error('Failed to seed asset library', err));
          setAssetLibrary(global);
          return;
        }
      }
      setAssetLibrary(lib);
    };

    const unlistenLib = listen('on_asset_library_update', (event) => {
      applyAssetLibrary(event.payload);
    });
    const unlistenManageLib = listen('on_manage_asset_library', () => {
      setAssetLibraryOpen(true);
    });
    const unlistenExportDialog = listen('on_export_dialog', () => {
      setExportOpen(true);
    });
    const unlistenSaved = listen('on_project_saved', () => {
      api.success({
        message: 'Project saved',
        description:
          'Wrote the .slsb.json project archive. Use File → Export… to write game packs.',
        placement: 'bottomLeft',
        duration: 5,
      });
    });
    const unlisten = listen('on_project_update', (event) => {
      const payload = event.payload || {};
      const stage_map = payload.scenes ?? payload;
      const scns = [];
      for (const key in stage_map) {
        if (Object.hasOwnProperty.call(stage_map, key)) {
          const element = stage_map[key];
          scns.push(element);
        }
      }
      console.log("Opening new Project with Scenes: ", scns);
      setJobProgress((prev) => {
        // Startup `request_project_update` has no in-flight job — don't flash a modal.
        if (!prev) return null;
        return {
          title: payload.pack_name
            ? `Loading ${payload.pack_name}`
            : prev.title || 'Loading project',
          message: 'Loading scenes into editor…',
          current: null,
          total: null,
          error: null,
        };
      });
      for (const scene of scns) {
        disambiguateDuplicateStageNames(scene.stages || []);
      }
      updateScenes(scns);
      setPackName(payload.pack_name ?? '');
      setPackAuthor(payload.pack_author ?? '');
      setPackVersion(payload.pack_version ?? '');
      // New / empty packs get global history so autocomplete works immediately.
      applyAssetLibrary(payload.asset_library, {
        seedIfEmpty: scns.length === 0,
      });
      setEdited(false);
      if (scns.length) {
        // Show side panels before loading the scene so graph fit uses the
        // final layout width (same as Edit from the sidebar).
        setShowAreas(true);
        setActiveScene(scns[0]);
        const cross = countCrossSceneLinks(scns);
        const ostim = projectLooksLikeOstim(scns);
        if (jobProgress && ostim && scns.length > 1) {
          api.info({
            message: 'OStim pack loaded',
            description: `Imported ${scns.length} scenes (folder split)${
              cross ? `; ${cross} cross-scene link(s)` : ''
            }.`,
            placement: 'bottomLeft',
            duration: 6,
          });
        }
      } else {
        updateActiveScene(null);
        setShowAreas(false);
      }
      // Drop the modal after React has a chance to start mounting the graph.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setJobProgress((prev) =>
            prev?.message === 'Loading scenes into editor…' ? null : prev
          );
        });
      });
    });
    invoke('request_project_update');
    return () => {
      unlistenJob.then((res) => { res(); });
      unlistenLib.then((res) => { res(); });
      unlistenManageLib.then((res) => { res(); });
      unlistenExportDialog.then((res) => { res(); });
      unlistenSaved.then((res) => { res(); });
      unlisten.then((res) => { res(); });
      if (jobErrorCloseRef.current) {
        clearTimeout(jobErrorCloseRef.current);
      }
    }
  }, [graph])

  const clearGraph = () => {
    if (graph.getCellCount() == 0)
      return;

    confirm({
      title: 'Clear Graph',
      icon: <QuestionCircleOutlined />,
      content: 'This will remove all nodes and edges from the current scene. Do you want to continue?',
      onOk() {
        graph.clearCells();
        setEdited(true);
      }
    })
  }

  useEffect(() => {
    if (!graphCtxMenu) return;
    const close = (ev) => {
      if (ev?.target?.closest?.('.graph-ctx-menu')) return;
      if (graphCtxMenu.kind === 'connect-drop') {
        connectDropIntentRef.current = null;
        clearConnectPendingRef.current?.({ restore: true });
      }
      setGraphCtxMenu(null);
    };
    // Defer so the opening contextmenu doesn't immediately close via a leftover click.
    const t = window.setTimeout(() => {
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [graphCtxMenu]);

  const rebuildSoonFromCtx = () => {
    presentationCacheRef.current = null;
    queueMicrotask(() => rebuildGraphPresentationRef.current?.());
  };

  const onEdgeCtxConvert = () => {
    const menu = graphCtxMenu;
    setGraphCtxMenu(null);
    if (!menu || menu.kind === 'node' || menu.kind === 'blank' || menu.kind === 'portal') return;
    if (menu.via || !graph) return;
    const edge = graph.getCellById(menu.edgeId);
    if (!edge || edge.getData?.()?.preview) return;
    insertingTransitionRef.current = true;
    const scene = activeSceneRef.current;
    const source = edge.getSourceCellId();
    const target = edge.getTargetCellId();
    if (!scene || !source || !target) {
      insertingTransitionRef.current = false;
      return;
    }
    const dark = !!document.getElementById('root')?.classList.contains('dark-mode');
    const id = Math.random().toString(36).slice(2, 10);
    const tgtName =
      scene.stages?.find((s) => s.id === target)?.name || 'Pose';
    const short = shortTransitionLabel(tgtName);
    const newStage = {
      id,
      name: `Go to ${short}`,
      positions: JSON.parse(
        JSON.stringify(
          scene.stages?.find((s) => s.id === source)?.positions || []
        )
      ),
      tags: ['transition'],
      extra: { fixed_len: 1, nav_text: short, sound: '' },
    };
    const nextStages = [...(scene.stages || []), newStage];
    if (activeSceneRef.current) {
      activeSceneRef.current = {
        ...activeSceneRef.current,
        stages: nextStages,
      };
    }
    updateActiveScene((prev) => {
      prev.stages = nextStages;
    });
    const data = edge.getData?.() || {};
    edge.setData({
      ...data,
      viaStageId: id,
      viaName: newStage.name,
    });
    edge.attr('line', viaEdgeAttrs(dark).line);
    edge.setLabels(edgeLabelConfig(short, dark));
    insertingTransitionRef.current = false;
    setEdited(true);
    rebuildSoonFromCtx();
  };

  const onEdgeCtxRevert = () => {
    const menu = graphCtxMenu;
    setGraphCtxMenu(null);
    if (!menu?.edgeId || !menu?.via || !graph) return;
    const edge = graph.getCellById(menu.edgeId);
    if (!edge) return;
    const via = menu.via;
    const scene = activeSceneRef.current;
    if (!scene) return;
    const dark = !!document.getElementById('root')?.classList.contains('dark-mode');
    const nextStages = (scene.stages || []).filter((s) => s.id !== via);
    if (activeSceneRef.current) {
      activeSceneRef.current = {
        ...activeSceneRef.current,
        stages: nextStages,
      };
    }
    updateActiveScene((prev) => {
      prev.stages = nextStages;
    });
    const g = { ...(fullGraphRef.current || {}) };
    delete g[via];
    for (const id of Object.keys(g)) {
      g[id] = {
        ...g[id],
        dest: (g[id].dest || []).filter((d) => destStage(d) !== via),
      };
    }
    fullGraphRef.current = g;
    const data = edge.getData?.() || {};
    edge.setData({
      ...data,
      viaStageId: null,
      viaName: null,
    });
    edge.attr('line', forwardEdgeAttrs(dark).line);
    edge.setLabels([]);
    setEdited(true);
    rebuildSoonFromCtx();
  };

  const onEdgeCtxEdit = () => {
    const menu = graphCtxMenu;
    setGraphCtxMenu(null);
    if (!menu?.via) return;
    const scene = activeSceneRef.current;
    const stage = scene?.stages?.find((s) => s.id === menu.via);
    if (!stage || !scene) return;
    stashNavForStage(scene, stage.id);
    invoke('open_stage_editor', {
      sceneId: scene.id,
      positions: scene.positions || [],
      stage,
      existingStageCount: scene.stages?.length || 0,
      templateStage: null,
      ...stageEditorExtras(scene),
    });
  };

  const onEdgeCtxDelete = () => {
    const menu = graphCtxMenu;
    setGraphCtxMenu(null);
    if (!menu?.edgeId || !graph) return;
    const edge = graph.getCellById(menu.edgeId);
    if (!edge) return;
    const via = menu.via;
    const sourceId = edge.getSourceCellId?.() || edge.getSourceCell()?.id;
    const targetId = edge.getTargetCellId?.() || edge.getTargetCell()?.id;
    edge.remove();
    if (via && activeSceneRef.current) {
      const nextStages = (activeSceneRef.current.stages || []).filter(
        (s) => s.id !== via
      );
      activeSceneRef.current = {
        ...activeSceneRef.current,
        stages: nextStages,
      };
      updateActiveScene((prev) => {
        prev.stages = nextStages;
      });
      const g = { ...(fullGraphRef.current || {}) };
      delete g[via];
      for (const id of Object.keys(g)) {
        g[id] = {
          ...g[id],
          dest: (g[id].dest || []).filter((d) => destStage(d) !== via),
        };
      }
      fullGraphRef.current = g;
    }
    // Drop matching ostim_nav tags on the source stage so orphans do not linger.
    if (sourceId && targetId && activeSceneRef.current && !via) {
      const scene = activeSceneRef.current;
      const srcStage = scene.stages?.find((s) => s.id === sourceId);
      const tgtStage = scene.stages?.find((s) => s.id === targetId);
      if (srcStage) {
        const destKeys = new Set(
          [stageOstimId(tgtStage), targetId].filter(Boolean)
        );
        const keptNav = parseOstimNavTags(srcStage.tags || []).filter(
          (n) => n.dest && !destKeys.has(n.dest)
        );
        const nextTags = tagsWithOstimNavs(srcStage.tags || [], keptNav);
        const nextStages = (scene.stages || []).map((s) =>
          s.id === sourceId ? { ...s, tags: nextTags } : s
        );
        activeSceneRef.current = { ...scene, stages: nextStages };
        updateActiveScene((prev) => {
          prev.stages = nextStages;
        });
        const node = graph.getCellById(sourceId);
        if (node) {
          const st = nextStages.find((s) => s.id === sourceId);
          if (st) node.prop('stage', st);
        }
      }
    }
    setEdited(true);
    rebuildSoonFromCtx();
  };

  const onEdgeCtxAddReturn = () => {
    const menu = graphCtxMenu;
    setGraphCtxMenu(null);
    if (!menu?.edgeId || !graph || !activeSceneRef.current) return;
    const edge = graph.getCellById(menu.edgeId);
    if (!edge || menu.via) return;
    const sourceId = edge.getSourceCellId?.() || edge.getSourceCell()?.id;
    const targetId = edge.getTargetCellId?.() || edge.getTargetCell()?.id;
    if (!sourceId || !targetId || sourceId === targetId) return;
    const scene = activeSceneRef.current;
    const g = structuredClone(
      syncStoredGraphFromCanvasRef.current?.() ||
        fullGraphRef.current ||
        scene.graph ||
        {}
    );
    if (!g[targetId]) g[targetId] = { dest: [], x: 40, y: 40 };
    const already = (g[targetId].dest || []).some(
      (d) => destStage(d) === sourceId
    );
    if (!already) {
      g[targetId] = {
        ...g[targetId],
        dest: [...(g[targetId].dest || []), makeDest(scene.id, sourceId)],
      };
      fullGraphRef.current = g;
      updateActiveScene((prev) => {
        prev.graph = g;
      });
      setEdited(true);
      rebuildSoonFromCtx();
    }
  };

  const setActiveScene = async (newscene) => {
    if (!inEdit.current && editedRef.current) {
      confirm({
        title: 'Unsaved changes',
        icon: <ExclamationCircleOutlined />,
        content: `Are you sure you want to continue? Unsaved changes will be lost.`,
        okText: 'Continue without saving',
        onOk() {
          inEdit.current = true;
          setActiveScene(newscene);
        },
        onCancel() { },
      });
      return;
    }
    inEdit.current = true;
    graph.clearCells();

    // OStim packs often reuse the same transition title for different clips.
    if (disambiguateDuplicateStageNames(newscene.stages || [])) {
      setEdited(true);
    }
    updateActiveScene(newscene);

    const sceneGraph = newscene.graph || {};
    const graphIds = Object.keys(sceneGraph);
    const getName = (id) =>
      newscene.stages?.find((s) => s.id === id)?.name || id;
    const large = graphIds.length >= LARGE_SCENE_NODE_THRESHOLD;

    // Snapshot packed coords for "Restore positions" (SLSB layout only — not OStim JSON).
    layoutSnapshotRef.current = new Map(
      graphIds.map((id) => {
        const g = sceneGraph[id] || {};
        return [id, { x: Number(g.x) || 40, y: Number(g.y) || 40 }];
      })
    );

    setGraphWorkMode('browse');
    graphWorkModeRef.current = 'browse';
    setEdgeFilterMode('all');
    edgeFilterModeRef.current = 'all';
    if (large) setShowOutline(true);
    setFocusNodeIds([]);
    focusNodeIdsRef.current = [];
    setPathIds([]);
    setMapFamilyFilter('all');
    mapFamilyFilterRef.current = 'all';
    setFocusHops(2);
    focusHopsRef.current = 2;
    presentationCacheRef.current = null;
    folderLayoutCacheRef.current = new Map();
    setExtraFolders([]);

    const folderMap = buildFolderMap(newscene.stages || []);
    graphMetaRef.current.folderMap = folderMap;
    const folderOpts = folderFilterOptions(folderMap);
    let initialFolder = 'all';
    // Only scope to a folder canvas when the scene still spans multiple folders
    // (cast-merge / legacy packs). Single-folder scenes stay on All — no Canvas UI.
    if (folderOpts.length > 1) {
      let best = folderOpts[0];
      let bestN = 0;
      const counts = new Map();
      for (const f of folderMap.values()) {
        if (!f) continue;
        counts.set(f, (counts.get(f) || 0) + 1);
      }
      for (const f of folderOpts) {
        const n = counts.get(f) || 0;
        if (n > bestN) {
          best = f;
          bestN = n;
        }
      }
      initialFolder = best;
    }
    setMapFolderFilter(initialFolder);
    mapFolderFilterRef.current = initialFolder;

    const stacked = graphCoordsStacked(sceneGraph);
    // Browse defaults to forest arrange when coords are stacked or scene is large.
    const shouldArrange = stacked || large || initialFolder !== 'all';
    const presentation = computeGraphPresentation({
      sceneGraph,
      rootId: newscene.root,
      nodeIds: graphIds,
      getName,
      isDark,
      edgeMode: 'primary',
      focusNodeIds: [],
      familyFilter: 'all',
      folderFilter: initialFolder,
      folderMap,
      preferCluster: false,
      rearrange: shouldArrange,
      useForestLayout: true,
      stages: newscene.stages || [],
      buildRows: false,
      collapseTransitions: true,
      owningSceneId: newscene.id,
      sceneCatalog: sceneCatalogForGraph(),
      existingPositions: shouldArrange
        ? null
        : new Map(
            graphIds.map((id) => {
              const g = sceneGraph[id] || {};
              return [id, { x: Number(g.x) || 40, y: Number(g.y) || 40 }];
            })
          ),
    });

    fullGraphRef.current = structuredClone(sceneGraph);

    graphMetaRef.current = {
      families: presentation.families,
      hubReturnCounts: presentation.hubReturnCounts,
      clusters: presentation.clusters,
      forest: presentation.forest,
      folderMap,
    };
    presentationCacheRef.current = {
      signature: presentation.signature,
      forest: presentation.forest,
      allEdges: presentation.allEdges,
      ranks: presentation.ranks,
      families: presentation.families,
      positions: presentation.positions,
      viewGraph: presentation.folderView?.poseGraph || presentation.collapse?.poseGraph,
      visibleIds: presentation.visibleIds,
    };
    setNavOutline(presentation.outline || []);

    const visibleIds = presentation.visibleIds || graphIds;
    for (const key of visibleIds) {
      const pos = presentation.positions?.get(key) || sceneGraph[key] || { x: 40, y: 40 };
      if (isPortalNodeId(key)) {
        const meta = presentation.portalMeta?.get(key) || {
          stageId: stageIdFromPortal(key),
          folder: '?',
          name: stageIdFromPortal(key),
        };
        const node = graph.addNode({
          shape: 'stage_node',
          id: key,
          x: pos.x,
          y: pos.y,
        });
        node.prop('isPortal', true);
        node.prop('portalFolder', meta.folder);
        node.prop('portalStageName', meta.name);
        node.prop('portalStageId', meta.stageId);
        node.prop('portalSceneId', meta.sceneId || null);
        node.prop('displayName', meta.name);
        const size = presentation.nodeSizes?.get(key);
        applyNodeSlots(node, {
          inCount: size?.inCount ?? 2,
          outCount: size?.outCount ?? 2,
          usedIn: size?.usedIn ?? 1,
          usedOut: size?.usedOut ?? 1,
          // Full stage size — transition sizing put in0 near the top-left of the drawn card.
          isTransition: false,
        });
        continue;
      }
      const stage = newscene.stages.find((s) => s.id === key);
      if (!stage) {
        console.warn('Graph references missing stage', key, newscene);
        continue;
      }
      const node = addStageToGraph(stage, pos.x, pos.y);
      updateNodeProps(stage, node, newscene);
      const size = presentation.nodeSizes?.get(key);
      applyNodeSlots(node, {
        inCount: size?.inCount ?? (presentation.inCount?.get(key) || 0) + SPARE_PORT_SLOTS,
        outCount: size?.outCount ?? (presentation.outCount?.get(key) || 0) + SPARE_PORT_SLOTS,
        usedIn: size?.usedIn ?? (presentation.inCount?.get(key) || 0),
        usedOut: size?.usedOut ?? (presentation.outCount?.get(key) || 0),
        isTransition: !!size?.isTransition,
      });
      node.prop('poseFamily', presentation.families?.get(key) || '');
      node.prop('ostimFolder', folderMap.get(key) || stageOstimFolder(stage));
      node.prop(
        'hubReturns',
        presentation.hubReturnCounts?.get(key) || 0
      );
    }
    const nodes = graph.getNodes();
    const planByPair = new Map(
      (presentation.allEdges || presentation.edges).map((p) => [
        `${p.source}\0${p.target}`,
        p,
      ])
    );
    for (const plan of presentation.allEdges || []) {
      if (!nodes.find((node) => node.id === plan.source)) continue;
      if (!nodes.find((node) => node.id === plan.target)) continue;
      graph.addEdge(planToEdgeConfig(plan));
    }
    applyEdgeVisibility(
      graph,
      initialFolder !== 'all' ? null : presentation.visibleKeys
    );
    applyCanvasDims(graph, presentation.families);
    setEdited(false);
    // Wait until #graph flex width accounts for Navigation / Outbound panels.
    fitGraphViewRef.current?.(graph);
    // Mark edit cycle finished after fit settles a bit.
    requestAnimationFrame(() => {
      inEdit.current = false;
      setEdited(false);
      const pending = pendingPortalFocusRef.current;
      if (pending && pending.sceneId === newscene.id && pending.stageId) {
        pendingPortalFocusRef.current = null;
        queueMicrotask(() => {
          try {
            const cell = graph.getCellById(pending.stageId);
            if (cell) {
              graph.centerCell(cell);
              graph.select(cell);
              setFocusNodeIds([pending.stageId]);
              focusNodeIdsRef.current = [pending.stageId];
            }
          } catch (_) { /* ignore */ }
        });
      }
    });
  }

  const gridSize = 260;

  const syncStoredGraphFromCanvas = () => {
    if (!graph || !activeSceneRef.current) return fullGraphRef.current || {};
    const nodes = graph.getNodes().map((n) => {
      const p = n.getPosition();
      return { id: n.id, x: p.x, y: p.y };
    });
    const folderMap =
      graphMetaRef.current.folderMap ||
      buildFolderMap(activeSceneRef.current.stages || []);
    const viewIds = folderViewStageIds(
      folderMap,
      mapFolderFilterRef.current,
      (activeSceneRef.current.stages || []).map((s) => s.id)
    );
    // Canvas still showing another folder (filter already advanced) — do not
    // treat those cells as authority for the new view's topology.
    if (viewIds?.length) {
      const viewSet = new Set(viewIds);
      const canvasReal = nodes.filter((n) => !isPortalNodeId(n.id));
      const overlap = canvasReal.filter((n) => viewSet.has(n.id)).length;
      if (canvasReal.length > 0 && overlap === 0) {
        return fullGraphRef.current || activeSceneRef.current.graph || {};
      }
    }
    const edges = graph
      .getEdges()
      .filter((e) => !e.getData?.()?.preview)
      .map((e) => {
        const data = e.getData?.() || e.prop('data') || {};
        return {
          source: e.getSourceCellId(),
          target: e.getTargetCellId(),
          viaStageId: data.viaStageId || null,
          bridgeTargetId: data.bridgeTargetId || null,
          bridgeSourceId: data.bridgeSourceId || null,
        };
      });
    const next = expandCanvasToStoredGraph({
      stages: activeSceneRef.current.stages || [],
      prevGraph: fullGraphRef.current || activeSceneRef.current.graph || {},
      nodes,
      edges,
      viewStageIds: viewIds,
      sceneId: activeSceneRef.current.id || '',
    });
    fullGraphRef.current = next;
    return next;
  };

  const buildLiveSceneGraph = () => syncStoredGraphFromCanvas();

  const refreshGraphEdgeVisibility = () => {
    if (!graph || !activeScene) return;
    const sceneGraph = fullGraphRef.current || syncStoredGraphFromCanvas();
    const graphIds = Object.keys(sceneGraph);
    const sig = sceneGraphSignature(sceneGraph);
    const cache = presentationCacheRef.current;

    if (!cache || cache.signature !== sig) {
      rebuildGraphPresentation({ rearrange: false });
      return;
    }

    // Visibility keys must use the pose/view graph (A→C), not stored A→T→C.
    // Falling back to the stored graph hides via-edges on the canvas.
    let viewGraph = cache.viewGraph;
    if (!viewGraph) {
      viewGraph = {};
      graph.getEdges().forEach((edge) => {
        if (edge.getData?.()?.preview) return;
        const s = edge.getSourceCellId();
        const t = edge.getTargetCellId();
        if (!s || !t) return;
        if (!viewGraph[s]) viewGraph[s] = { dest: [] };
        if (!viewGraph[s].dest.includes(t)) viewGraph[s].dest.push(t);
        if (!viewGraph[t]) viewGraph[t] = { dest: viewGraph[t]?.dest || [] };
      });
      for (const id of cache.visibleIds || graphIds) {
        if (!viewGraph[id]) viewGraph[id] = { dest: [] };
      }
      cache.viewGraph = viewGraph;
    }

    const folderMap =
      graphMetaRef.current.folderMap?.size
        ? graphMetaRef.current.folderMap
        : buildFolderMap(activeScene?.stages || []);
    graphMetaRef.current.folderMap = folderMap;
    const folderCanvas =
      mapFolderFilterRef.current && mapFolderFilterRef.current !== 'all';
    const neigh = folderCanvas ? null : currentNeighborhoodSet(viewGraph);

    const { visibleKeys, families } = resolveVisibleKeys({
      sceneGraph: viewGraph,
      nodeIds: cache.visibleIds || Object.keys(viewGraph),
      edgeMode: folderCanvas ? 'all' : edgeFilterModeRef.current,
      focusNodeIds: focusNodeIdsRef.current,
      familyFilter: mapFamilyFilterRef.current,
      folderFilter: 'all',
      folderMap,
      neighborhoodSet: neigh,
      forest: cache.forest,
      ranks: cache.ranks,
    });

    applyEdgeVisibility(graph, folderCanvas ? null : visibleKeys);
    applyCanvasDims(graph, families || cache.families);

    const focus = focusNodeIdsRef.current?.[0];
    if (focus && cache.forest?.parent) {
      setPathIds(pathToNode(focus, cache.forest.parent));
    }
  };

  /**
   * Full path: re-rank, re-route, apply changed edge plans, refresh cache.
   * Call on topology/position changes and Arrange — not on every click.
   * @param {{ rearrange?: boolean, rootId?: string|null, existingPositions?: Map|null, skipSync?: boolean }} [opts]
   *   skipSync: use fullGraphRef as-is (needed when the canvas still shows a
   *   different folder than mapFolderFilterRef — e.g. mid folder-canvas switch).
   */
  const rebuildGraphPresentation = ({
    rearrange = false,
    rootId = null,
    existingPositions: existingPositionsOverride = undefined,
    skipSync = false,
  } = {}) => {
    if (!graph || !activeScene) return;
    const sceneGraph = skipSync
      ? fullGraphRef.current ||
        activeSceneRef.current?.graph ||
        activeScene.graph ||
        {}
      : syncStoredGraphFromCanvas();
    const graphIds = Object.keys(sceneGraph);
    if (!graphIds.length) return;
    const liveScene = activeSceneRef.current || activeScene;
    const liveStages = liveScene.stages || [];
    const getName = (id) =>
      liveStages.find((s) => s.id === id)?.name || id;
    const browse = graphWorkModeRef.current === 'browse';
    const startId =
      rootId ||
      liveScene.root ||
      activeScene.root ||
      graphIds[0];
    const folderMap = buildFolderMap(liveStages);
    graphMetaRef.current.folderMap = folderMap;
    const fromCanvas = new Map(
      graph.getNodes().map((n) => {
        const p = n.getPosition();
        return [n.id, { x: p.x, y: p.y }];
      })
    );
    const existingPositions = rearrange
      ? null
      : existingPositionsOverride !== undefined
        ? existingPositionsOverride
        : fromCanvas;
    const presentation = computeGraphPresentation({
      sceneGraph,
      rootId: startId,
      nodeIds: graphIds,
      getName,
      isDark,
      edgeMode:
        edgeFilterModeRef.current ||
        (browse ? 'primary' : 'all'),
      focusNodeIds: focusNodeIdsRef.current,
      familyFilter: mapFamilyFilterRef.current,
      folderFilter: mapFolderFilterRef.current,
      folderMap,
      neighborhoodSet: null, // filled below once view graph exists
      preferCluster: false,
      rearrange,
      useForestLayout: true,
      stages: liveStages,
      buildRows: false,
      collapseTransitions: true,
      existingPositions,
      owningSceneId: liveScene.id,
      sceneCatalog: sceneCatalogForGraph(),
    });
    const viewForNeigh =
      presentation.folderView?.poseGraph ||
      presentation.collapse?.poseGraph ||
      sceneGraph;
    const folderCanvas =
      mapFolderFilterRef.current && mapFolderFilterRef.current !== 'all';
    // Folder canvases are already a small subset — do not hide edges via
    // neighborhood / primary filters (that left edges "stuck" hidden on switch).
    const neigh = folderCanvas ? null : currentNeighborhoodSet(viewForNeigh);
    if (neigh) {
      const { visibleKeys: filteredKeys } = resolveVisibleKeys({
        sceneGraph: viewForNeigh,
        nodeIds: presentation.visibleIds,
        edgeMode:
          edgeFilterModeRef.current ||
          (browse ? 'primary' : 'all'),
        focusNodeIds: focusNodeIdsRef.current,
        familyFilter: mapFamilyFilterRef.current,
        folderFilter: 'all',
        folderMap,
        neighborhoodSet: neigh,
        forest: presentation.forest,
        ranks: presentation.ranks,
      });
      if (filteredKeys) {
        for (const e of presentation.allEdges || []) {
          if (
            e.kind === 'bridge' ||
            isPortalNodeId(e.source) ||
            isPortalNodeId(e.target)
          ) {
            filteredKeys.add(`${e.source}\0${e.target}`);
          }
        }
      }
      presentation.visibleKeys = filteredKeys;
    } else if (folderCanvas) {
      presentation.visibleKeys = null;
    }

    const wantIds = new Set(presentation.visibleIds || []);
    const hadIds = new Set(graph.getNodes().map((n) => n.id));
    const batch = typeof graph.startBatch === 'function';
    if (batch) graph.startBatch('rebuild-presentation');
    try {
      suppressingNodeRemoveRef.current = true;
      graph.getNodes().forEach((n) => {
        if (!wantIds.has(n.id)) n.remove();
      });
      suppressingNodeRemoveRef.current = false;
      for (const id of wantIds) {
        let node = graph.getCellById(id);
        const pos = presentation.positions?.get(id) || {
          x: sceneGraph[id]?.x || 40,
          y: sceneGraph[id]?.y || 40,
        };
        const newlyRevealed = !hadIds.has(id);
        if (isPortalNodeId(id)) {
          const meta = presentation.portalMeta?.get(id) || {
            stageId: stageIdFromPortal(id),
            folder: '?',
            name: stageIdFromPortal(id),
          };
          if (!node) {
            node = graph.addNode({
              shape: 'stage_node',
              id,
              x: pos.x,
              y: pos.y,
            });
          } else if (rearrange || newlyRevealed) {
            node.setPosition(pos.x, pos.y);
          }
          node.prop('isPortal', true);
          node.prop('portalFolder', meta.folder);
          node.prop('portalStageName', meta.name);
          node.prop('portalStageId', meta.stageId);
          node.prop('portalSceneId', meta.sceneId || null);
          node.prop('displayName', meta.name);
          const size = presentation.nodeSizes?.get(id);
          applyNodeSlots(node, {
            inCount: size?.inCount ?? 2,
            outCount: size?.outCount ?? 2,
            usedIn: size?.usedIn ?? 1,
            usedOut: size?.usedOut ?? 1,
            isTransition: false,
          });
          continue;
        }
        const stage = liveStages.find((s) => s.id === id);
        if (!stage) continue;
        const isT = !!presentation.nodeSizes?.get(id)?.isTransition;
        const curPos = node?.getPosition?.();
        const parkedAtOrigin =
          !!curPos &&
          ((Math.abs(curPos.x - 40) < 1 && Math.abs(curPos.y - 40) < 1) ||
            (Math.abs(curPos.x) < 1 && Math.abs(curPos.y) < 1));
        if (!node) {
          node = addStageToGraph(stage, pos.x, pos.y);
        } else if (rearrange || newlyRevealed || (isT && parkedAtOrigin)) {
          // Newly revealed / origin-parked transition stages must leave the default corner.
          node.setPosition(pos.x, pos.y);
        }
        updateNodeProps(stage, node, liveScene);
        const size = presentation.nodeSizes?.get(id);
        applyNodeSlots(node, {
          inCount: size?.inCount ?? (presentation.inCount?.get(id) || 0) + SPARE_PORT_SLOTS,
          outCount: size?.outCount ?? (presentation.outCount?.get(id) || 0) + SPARE_PORT_SLOTS,
          usedIn: size?.usedIn ?? (presentation.inCount?.get(id) || 0),
          usedOut: size?.usedOut ?? (presentation.outCount?.get(id) || 0),
          isTransition: !!size?.isTransition,
        });
        node.prop('poseFamily', presentation.families?.get(id) || '');
        node.prop('ostimFolder', folderMap.get(id) || stageOstimFolder(stage));
        node.prop(
          'hubReturns',
          presentation.hubReturnCounts?.get(id) || 0
        );
      }

      const planByPair = new Map(
        (presentation.allEdges || []).map((p) => [`${p.source}\0${p.target}`, p])
      );
      const wantedEdgeKeys = new Set(planByPair.keys());
      graph.getEdges().forEach((edge) => {
        const s = edge.getSourceCellId();
        const t = edge.getTargetCellId();
        const key = `${s}\0${t}`;
        const plan = planByPair.get(key);
        if (!plan) {
          edge.remove();
          return;
        }
        applyEdgePlan(edge, plan);
        wantedEdgeKeys.delete(key);
      });
      for (const key of wantedEdgeKeys) {
        const plan = planByPair.get(key);
        if (plan) graph.addEdge(planToEdgeConfig(plan));
      }
    } finally {
      if (batch) graph.stopBatch('rebuild-presentation');
    }

    graphMetaRef.current = {
      families: presentation.families,
      hubReturnCounts: presentation.hubReturnCounts,
      clusters: presentation.clusters,
      forest: presentation.forest,
      folderMap,
    };
    presentationCacheRef.current = {
      signature: presentation.signature,
      forest: presentation.forest,
      allEdges: presentation.allEdges,
      ranks: presentation.ranks,
      families: presentation.families,
      positions: presentation.positions,
      viewGraph: viewForNeigh,
      visibleIds: presentation.visibleIds,
    };
    setNavOutline(presentation.outline || []);

    applyEdgeVisibility(
      graph,
      mapFolderFilterRef.current && mapFolderFilterRef.current !== 'all'
        ? null
        : presentation.visibleKeys
    );
    applyCanvasDims(graph, presentation.families);

    const focus = focusNodeIdsRef.current?.[0];
    if (focus && presentation.forest?.parent) {
      setPathIds(pathToNode(focus, presentation.forest.parent));
    }
  };

  refreshGraphEdgesRef.current = refreshGraphEdgeVisibility;
  rebuildGraphPresentationRef.current = (opts = {}) =>
    rebuildGraphPresentation({ rearrange: false, ...opts });

  const cacheFolderLayout = (sceneId, folder) => {
    if (!graph || !sceneId) return;
    const key = `${sceneId}\0${folder || 'all'}`;
    const map = new Map();
    graph.getNodes().forEach((n) => {
      if (isPortalNodeId(n.id)) return;
      const p = n.getPosition();
      map.set(n.id, { x: p.x, y: p.y });
    });
    folderLayoutCacheRef.current.set(key, map);
  };

  const switchFolderView = (nextFolder, { focusStageId = null } = {}) => {
    if (!graph || !activeSceneRef.current) return;
    const sceneId = activeSceneRef.current.id;
    const prev = mapFolderFilterRef.current;
    // Commit the *current* canvas into the full graph, then remount without
    // syncing again (canvas still has the old folder until rebuild finishes).
    syncStoredGraphFromCanvas();
    cacheFolderLayout(sceneId, prev);
    setMapFolderFilter(nextFolder);
    mapFolderFilterRef.current = nextFolder;
    // Folder subsets are small — show every mounted edge after switch.
    setEdgeFilterMode('all');
    edgeFilterModeRef.current = 'all';
    setFocusNodeIds(focusStageId ? [focusStageId] : []);
    focusNodeIdsRef.current = focusStageId ? [focusStageId] : [];
    const cacheKey = `${sceneId}\0${nextFolder || 'all'}`;
    const cached = folderLayoutCacheRef.current.get(cacheKey);
    presentationCacheRef.current = null;
    rebuildGraphPresentation({
      rearrange: !cached,
      existingPositions: cached || undefined,
      skipSync: true,
    });
    queueMicrotask(() => {
      try {
        if (nextFolder && nextFolder !== 'all') {
          applyEdgeVisibility(graph, null);
        }
        if (focusStageId) {
          const cell = graph.getCellById(focusStageId);
          if (cell) {
            graph.centerCell(cell);
            graph.select(cell);
            return;
          }
        }
        fitGraphViewRef.current?.(graph);
      } catch (_) { /* ignore */ }
    });
  };

  const jumpToPortal = (node) => {
    if (!node) return;
    const stageId =
      node.prop('portalStageId') ||
      stageIdFromPortal(node.id);
    const portalSceneId =
      node.prop('portalSceneId') ||
      sceneIdFromPortal(node.id);
    if (portalSceneId) {
      const target =
        (activeScene?.id === portalSceneId && activeScene) ||
        scenes.find((s) => s.id === portalSceneId);
      if (!target) {
        api.warning({
          message: 'Scene not in project',
          description: `DestRef scene ${portalSceneId} is not loaded.`,
          placement: 'bottomLeft',
        });
        return;
      }
      pendingPortalFocusRef.current = {
        sceneId: portalSceneId,
        stageId,
      };
      if (activeScene?.id === portalSceneId) {
        jumpToNode(stageId);
        pendingPortalFocusRef.current = null;
        return;
      }
      setActiveScene(target);
      setShowAreas(true);
      return;
    }
    const folder =
      node.prop('portalFolder') ||
      graphMetaRef.current.folderMap?.get(stageId) ||
      'all';
    if (!folder || folder === '(other)') {
      switchFolderView('all', { focusStageId: stageId });
      return;
    }
    switchFolderView(folder, { focusStageId: stageId });
  };
  jumpToPortalRef.current = jumpToPortal;

  const promptNewPackFolder = () => {
    let draft = '';
    Modal.confirm({
      title: 'New OStim pack folder',
      content: (
        <Input
          placeholder="e.g. Back, Lay, Standing"
          autoFocus
          onChange={(e) => {
            draft = e.target.value;
          }}
          onPressEnter={(e) => {
            draft = e.target.value;
          }}
        />
      ),
      okText: 'Create & open',
      onOk: () => {
        const name = String(draft || '')
          .trim()
          .replace(/[\\/]/g, '_');
        if (!name) return Promise.reject();
        setExtraFolders((prev) =>
          prev.includes(name) ? prev : [...prev, name]
        );
        switchFolderView(name);
      },
    });
  };

  const assignStagesToFolder = (stageIds, folder) => {
    const ids = new Set((stageIds || []).filter(Boolean));
    const f = String(folder || '').trim();
    if (!ids.size || !f || f === 'all') return;
    updateActiveScene((prev) => {
      for (const stage of prev.stages || []) {
        if (!ids.has(stage.id)) continue;
        stage.tags = tagsWithOstimFolder(stage.tags || [], f);
      }
      graphMetaRef.current.folderMap = buildFolderMap(prev.stages || []);
    });
    setEdited(true);
    setExtraFolders((prev) => (prev.includes(f) ? prev : [...prev, f]));
    queueMicrotask(() => {
      for (const id of ids) {
        const n = graph?.getCellById(id);
        if (n) n.prop('ostimFolder', f);
      }
      // Stay on / open that folder canvas so the stage remains visible.
      if (mapFolderFilterRef.current !== f) {
        switchFolderView(f, { focusStageId: [...ids][0] });
      } else {
        rebuildGraphPresentationRef.current?.();
      }
    });
  };

  const promptMoveStageToFolder = (stageId) => {
    let draft =
      mapFolderFilterRef.current !== 'all'
        ? mapFolderFilterRef.current
        : '';
    Modal.confirm({
      title: 'Move stage to pack folder',
      content: (
        <Input
          list="slsb-ostim-folders"
          placeholder="e.g. Back, Lay, Standing"
          defaultValue={draft}
          autoFocus
          onChange={(e) => {
            draft = e.target.value;
          }}
          onPressEnter={(e) => {
            draft = e.target.value;
          }}
        />
      ),
      okText: 'Assign',
      onOk: () => {
        const name = String(draft || '')
          .trim()
          .replace(/[\\/]/g, '_');
        if (!name) return Promise.reject();
        assignStagesToFolder([stageId], name);
      },
    });
  };

  /** Instant port refresh + deferred routing so new links don't hitch. */
  const scheduleTopologyRebuild = (nodeIds = []) => {
    if (!graph) return;
    syncStoredGraphFromCanvas();
    const usedIn = new Map();
    const usedOut = new Map();
    graph.getNodes().forEach((n) => {
      usedIn.set(n.id, 0);
      usedOut.set(n.id, 0);
    });
    graph.getEdges().forEach((e) => {
      if (e.getData?.()?.preview) return;
      const s = e.getSourceCellId();
      const t = e.getTargetCellId();
      if (s) usedOut.set(s, (usedOut.get(s) || 0) + 1);
      if (t) usedIn.set(t, (usedIn.get(t) || 0) + 1);
    });
    const ids = (nodeIds || []).filter(Boolean);
    const touch = ids.length ? ids : [...usedIn.keys()];
    for (const id of touch) {
      const node = graph.getCellById(id);
      if (!node) continue;
      const ui = usedIn.get(id) || 0;
      const uo = usedOut.get(id) || 0;
      applyNodeSlots(node, {
        inCount: ui + SPARE_PORT_SLOTS,
        outCount: uo + SPARE_PORT_SLOTS,
        usedIn: ui,
        usedOut: uo,
        isTransition: !!node.prop('isTransition'),
      });
    }
    const focus = new Set(ids);
    graph.getEdges().forEach((edge) => {
      if (edge.getData?.()?.preview) {
        if (typeof edge.setVisible === 'function') edge.setVisible(true);
        return;
      }
      const s = edge.getSourceCellId();
      const t = edge.getTargetCellId();
      if (!focus.size || focus.has(s) || focus.has(t)) {
        if (typeof edge.setVisible === 'function') edge.setVisible(true);
        else edge.setProp('visible', true);
      }
    });
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null;
      presentationCacheRef.current = null;
      rebuildGraphPresentation({ rearrange: false });
    }, 48);
  };
  scheduleTopologyRebuildRef.current = scheduleTopologyRebuild;
  syncStoredGraphFromCanvasRef.current = syncStoredGraphFromCanvas;

  const arrangeStages = (rootId = activeScene?.root, markEdited = true) => {
    if (!graph?.getNodes()?.length) return;
    presentationCacheRef.current = null;
    rebuildGraphPresentation({ rearrange: true, rootId });
    fitGraphViewRef.current?.(graph, { padding: 28 });
    if (markEdited) setEdited(true);
  };

  /**
   * Restore node positions from the snapshot taken when the scene was opened
   * (packed SLSB coords). Does not change graph edges. Layout is never part of
   * OStim scene JSON — only SLSB Node {x,y}.
   */
  const restorePackedPositions = (markEdited = true) => {
    if (!graph || !layoutSnapshotRef.current) return;
    const snap = layoutSnapshotRef.current;
    for (const [id, pos] of snap) {
      const node = graph.getCellById(id);
      if (node) node.setPosition(pos.x, pos.y);
    }
    presentationCacheRef.current = null;
    queueMicrotask(() => {
      rebuildGraphPresentationRef.current?.();
      fitGraphViewRef.current?.(graph, { padding: 28 });
    });
    if (markEdited) setEdited(true);
  };

  const jumpToNode = (nodeId) => {
    if (!nodeId || !graph) return;
    const folderMap =
      graphMetaRef.current.folderMap ||
      buildFolderMap(activeSceneRef.current?.stages || []);
    const stageFolder = folderMap.get(nodeId) || '';
    const current = mapFolderFilterRef.current;
    if (
      current &&
      current !== 'all' &&
      stageFolder &&
      stageFolder !== current
    ) {
      switchFolderView(stageFolder, { focusStageId: nodeId });
      return;
    }
    setFocusNodeIds([nodeId]);
    focusNodeIdsRef.current = [nodeId];
    const forest = graphMetaRef.current.forest;
    if (forest?.parent) {
      setPathIds(pathToNode(nodeId, forest.parent));
    }
    // Keep current edge filter; selection emphasis dims unrelated nodes/edges.
    queueMicrotask(() => {
      refreshGraphEdgesRef.current?.();
      const cell = graph.getCellById(nodeId);
      if (cell) {
        try {
          graph.centerCell(cell);
          graph.select(cell);
        } catch (_) { /* ignore */ }
      }
    });
  };

  const applyWorkMode = (mode) => {
    setGraphWorkMode(mode);
    graphWorkModeRef.current = mode;
    if (mode === 'browse') setShowOutline(true);
    queueMicrotask(() => refreshGraphEdgesRef.current?.());
  };

  const exportGraphCanvas = async (format = 'svg') => {
    if (!graph || graph.getCellCount() === 0) {
      api.warning({
        message: 'Nothing to export',
        description: 'Open a scene with stages on the canvas first.',
        placement: 'topRight',
      });
      return;
    }
    const sceneName = activeScene?.name || 'scene';
    const isSvg = format === 'svg';
    const defaultName = defaultGraphExportName(sceneName, isSvg ? 'svg' : 'json');

    let path;
    try {
      path = await save({
        title: isSvg ? 'Export graph SVG' : 'Export graph layout JSON',
        defaultPath: defaultName,
        filters: [
          {
            name: isSvg ? 'SVG graph' : 'Graph layout JSON',
            extensions: isSvg ? ['svg'] : ['json'],
          },
        ],
      });
    } catch (err) {
      api.error({
        message: 'Graph export failed',
        description: String(err),
        placement: 'topRight',
      });
      return;
    }
    if (!path) return;

    await new Promise((r) => setTimeout(r, 0));

    let contents;
    try {
      // Export only currently visible edges (what you see on the Map).
      contents = isSvg
        ? buildCanvasSvg(graph, {
            sceneName,
            isDark,
            onlyVisible: true,
          })
        : buildCanvasLayoutJson(graph, {
            sceneName,
            isDark,
            onlyVisible: true,
          });
    } catch (err) {
      api.error({
        message: 'Graph export failed',
        description: String(err),
        placement: 'topRight',
      });
      return;
    }

    try {
      await invoke('write_export_file', { path, contents });
      api.success({
        message: 'Graph exported',
        description: path,
        placement: 'topRight',
      });
    } catch (err) {
      api.error({
        message: 'Graph export failed',
        description: String(err),
        placement: 'topRight',
      });
    }
  };

  const exportConnectionsTable = async () => {
    if (!graph || !activeScene) {
      api.warning({
        message: 'Nothing to export',
        description: 'Open a scene first.',
        placement: 'topRight',
      });
      return;
    }
    const sceneGraph = buildLiveSceneGraph();
    const getName = (id) =>
      activeScene.stages?.find((s) => s.id === id)?.name || id;
    const presentation = computeGraphPresentation({
      sceneGraph,
      rootId: activeScene.root,
      nodeIds: Object.keys(sceneGraph),
      getName,
      isDark,
      edgeMode: 'all',
      rearrange: false,
      useForestLayout: false,
      stages: activeScene.stages || [],
      buildRows: true,
      owningSceneId: activeScene.id,
      sceneCatalog: sceneCatalogForGraph(),
      existingPositions: new Map(
        Object.entries(sceneGraph).map(([id, n]) => [id, { x: n.x, y: n.y }])
      ),
    });
    const rows = presentation.connectionRows || [];
    const sceneName = activeScene?.name || 'scene';
    const defaultName = defaultGraphExportName(sceneName, 'csv').replace(
      '_graph.csv',
      '_connections.csv'
    );
    let path;
    try {
      path = await save({
        title: 'Export connections CSV',
        defaultPath: defaultName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
    } catch (err) {
      api.error({
        message: 'Export failed',
        description: String(err),
        placement: 'topRight',
      });
      return;
    }
    if (!path) return;
    try {
      await invoke('write_export_file', {
        path,
        contents: connectionsToCsv(rows),
      });
      api.success({
        message: 'Connections exported',
        description: path,
        placement: 'topRight',
      });
    } catch (err) {
      api.error({
        message: 'Export failed',
        description: String(err),
        placement: 'topRight',
      });
    }
  };

  // Place new stages at x/y when provided; otherwise to the right of existing nodes
  const addStageToGraph = (stage, x, y) => {
    let posX = x;
    let posY = y;
    const hasPos = typeof posX === 'number' && typeof posY === 'number';
    if (!hasPos) {
      posX = 40;
      posY = 40;
      const nodes = graph.getNodes();
      if (nodes.length > 0) {
        const positions = nodes.map((n) => n.getPosition());
        const rightmost = positions.reduce((a, b) => (a.x >= b.x ? a : b));
        posX = rightmost.x + gridSize;
        posY = rightmost.y;
        const maxWidth = graph.container?.clientWidth || 800;
        if (posX > maxWidth - gridSize) {
          const maxY = Math.max(...positions.map((p) => p.y));
          posX = 40;
          posY = maxY + gridSize;
        }
      }
    }

    const node = graph.addNode({
      shape: 'stage_node',
      id: stage.id,
      x: posX,
      y: posY,
    });
    // Empty stages have no edges yet — still need visible free ports immediately.
    applyNodeSlots(node, {
      inCount: SPARE_PORT_SLOTS,
      outCount: SPARE_PORT_SLOTS,
      usedIn: 0,
      usedOut: 0,
      isTransition: isTransitionStage(stage),
    });
    return node;
  };

  /** Open stage editor for a new stage; optional canvas drop + port link. */
  const openNewStageEditor = ({
    graphX = null,
    graphY = null,
    connectFrom = null,
  } = {}) => {
    const scene = activeSceneRef.current;
    if (!scene) return;
    const stages = scene.stages || [];
    const folder = mapFolderFilterRef.current;
    const last = stages.length > 0 ? stages[stages.length - 1] : null;
    let templateStage = last;
    if (folder && folder !== 'all') {
      templateStage = {
        id: last?.id || '',
        name: last?.name || '',
        positions: last?.positions || [],
        tags: tagsWithOstimFolder([], folder),
        extra: last?.extra || {},
      };
    }
    if (Number.isFinite(graphX) && Number.isFinite(graphY)) {
      pendingStageDropRef.current = {
        x: graphX,
        y: graphY,
        connectFrom: connectFrom || null,
      };
    } else if (connectFrom) {
      pendingStageDropRef.current = {
        x: undefined,
        y: undefined,
        connectFrom,
      };
    } else {
      pendingStageDropRef.current = null;
    }
    stashNavForStage(scene, null);
    invoke('open_stage_editor', {
      sceneId: scene.id,
      positions: scene.positions || [],
      stage: null,
      existingStageCount: stages.length,
      templateStage,
      ...stageEditorExtras(scene),
    });
  };

  const updateNodeProps = (stage, node, belongingScene) => {
    const isOrgasm = !!(
      stage.positions &&
      stage.positions.some((p) => p.climax || p.extra?.climax)
    );
    node.prop('stage', stage);
    node.prop('scene', belongingScene);
    node.prop('fixedLen', stage.extra.fixed_len);
    node.prop('isStart', belongingScene && belongingScene.root === stage.id);
    node.prop('isOrgasm', isOrgasm);
    node.prop('isTransition', isTransitionStage(stage));
    node.prop(
      'displayName',
      uniqueStageLabel(stage, belongingScene?.stages || [])
    );
    node.prop('ostimId', stageOstimIdFromTags(stage) || '');
  }

  const saveScene = () => {
    let has_warnings = false;
    let doSave = true;
    if (!activeScene.name) {
      api['error']({
        message: 'Missing Name',
        description: 'Add a short, descriptive name to your scene.',
        placement: 'bottomLeft',
        onClick(evt) {
          const elm = document.getElementById('stageNameInputField');
          elm.focus();
        }
      });
      doSave = false;
    }
    const nodes = graph.getNodes();
    const startNode = nodes.find(node => node.id === activeScene.root);
    if (!startNode) {
      api['warning']({
        message: 'Missing Start Animation',
        description: 'Choose the stage which the scene is supposed to start at.',
        placement: 'bottomLeft'
      });
      has_warnings = true;
    } else {
      const dfsGraph = graph.getSuccessors(startNode);
      if (dfsGraph.length + 1 < nodes.length) {
        api['warning']({
          message: 'Unreachable Stages',
          description: 'Scene contains stages which cannot be reached from the start animation',
          placement: 'bottomLeft'
        });
        has_warnings = true;
      }
    }

    if (!doSave || !edited) {
      return;
    }
    // api['success']({
    //   message: 'Saved Scene',
    //   description: `Scene ${activeScene.name} has successfully been saved.`,
    //   placement: 'bottomLeft'
    // });
    const scene = {
      ...activeScene,
      graph: syncStoredGraphFromCanvas(),
      has_warnings,
    };
    invoke('save_scene', { scene }).then(() => {
      console.log("Saved scene", scene);
      updateActiveScene(scene);
      updateScenes(prev => {
        const w = prev.findIndex(it => it.id === scene.id);
        if (w === -1) {
          prev.push(scene);
        } else {
          prev[w] = scene;
        }
      });
      setEdited(false);
      console.log("Saved Scene", scene);
    });
  }

  const onNewScene = async () => {
    const new_anim = await invoke('create_blank_scene');
    try {
      await invoke('save_scene', { scene: new_anim });
      updateScenes((prev) => {
        if (prev.some((s) => s.id === new_anim.id)) return;
        prev.push(new_anim);
      });
    } catch (err) {
      console.error('Failed to register new scene', err);
    }
    setActiveScene(new_anim);
    setShowAreas(true);
    setEdited(true);
  };

  const onSelectScene = (scene) => {
    if (!scene) return;
    setActiveScene(scene);
    setShowAreas(true);
  };

  const onDeleteScene = (scene) => {
    if (!scene) return;
    const id = scene.id;
    confirm({
      title: 'Deleting Scene',
      icon: <ExclamationCircleOutlined />,
      content: `Are you sure you want to delete the scene '${scene.name}'?\n\nThis action cannot be undone.`,
      onOk() {
        try {
          invoke('delete_scene', { id });
          updateScenes((prev) => prev.filter((s) => s.id !== id));
          if (activeScene && activeScene.id === id) {
            updateActiveScene(null);
            setEdited(false);
          }
        } catch (error) {
          console.log(error);
        }
      },
      onCancel() {},
    });
  };

  const blankStagePosition = () => ({
    event: [],
    anim_obj: '',
    offset: { x: 0, y: 0, z: 0, r: 0 },
    strip_data: {
      default: true,
      everything: false,
      nothing: false,
      helmet: false,
      gloves: false,
      boots: false,
    },
    climax: false,
    tags: [],
    schlong: 0,
    add_cum: 0,
  });

  const blankPositionInfo = () => ({
    sex: { male: true, female: false, futa: false },
    race: 'Human',
    scale: 1.0,
    submissive: false,
    vampire: false,
    dead: false,
    add_cum: 0,
    id: generatePositionId(),
  });

  // Clone-to always keeps the source stage's actor count. Destination
  // PositionInfo slots are taken from the source scene (falling back to the
  // target, then blanks) — never shrink a 3-actor stage into a 1-actor anim.
  const prepareCloneToTarget = (stage, sourceScene, targetScene) => {
    const adaptedStage = structuredClone(stage);
    const target = structuredClone(targetScene);
    const sourceInfos = sourceScene?.positions || [];
    const n = adaptedStage.positions?.length ?? 0;
    const nextInfos = [];
    for (let i = 0; i < n; i++) {
      const fromSource = sourceInfos[i];
      const fromTarget = target.positions?.[i];
      if (fromSource) {
        nextInfos.push({
          ...structuredClone(fromSource),
          id: generatePositionId(),
        });
      } else if (fromTarget) {
        nextInfos.push({
          ...structuredClone(fromTarget),
          id: fromTarget.id || generatePositionId(),
        });
      } else {
        nextInfos.push(blankPositionInfo());
      }
    }
    target.positions = nextInfos;
    return { adaptedStage, target };
  };

  const confirmCloneTo = () => {
    if (!cloneToStage || !cloneToTargetId) return;
    const target =
      (activeScene && activeScene.id === cloneToTargetId && activeScene) ||
      scenes.find((s) => s.id === cloneToTargetId);
    if (!target) {
      api.error({ message: 'Target scene not found', placement: 'bottomLeft' });
      return;
    }
    // Prefer the live source stage from the source scene (actor count may have
    // changed after the modal opened).
    const sourceStage =
      cloneToSourceScene?.stages?.find((s) => s.id === cloneToStage.id) ||
      cloneToStage;
    const { adaptedStage, target: targetWithActors } = prepareCloneToTarget(
      sourceStage,
      cloneToSourceScene,
      target
    );
    stashStageNavContext(targetWithActors, null, {});
    invoke('open_stage_editor_from', {
      sceneId: targetWithActors.id,
      positions: targetWithActors.positions || [],
      copyStage: adaptedStage,
      existingStageCount: targetWithActors.stages?.length || 0,
      ...stageEditorExtras(targetWithActors),
    });
    setCloneToOpen(false);
    setCloneToStage(null);
    setCloneToSourceScene(null);
    setCloneToTargetId(null);
  };

  return (
    <ConfigProvider theme={getAppTheme(isDark)}>
      <Layout hasSider style={{ height: '100vh' }}>
        <PanelGroup
          direction="horizontal"
          autoSaveId="slsb-main-horizontal"
          style={{ height: '100%' }}
        >
          {/* Left Panel */}
          <Panel minSize={10} defaultSize={15} maxSize={50} id="left-panel">
            {contextHolder}
            <JobProgressModal
              open={!!jobProgress}
              title={jobProgress?.title}
              message={jobProgress?.message}
              current={jobProgress?.current}
              total={jobProgress?.total}
              error={jobProgress?.error}
            />
            <HelpConceptsDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
            <ExportFormatsModal
              open={exportOpen}
              onCancel={() => setExportOpen(false)}
              onExport={(formats) => {
                setExportOpen(false);
                invoke('start_pack_export', { formats }).catch((err) => {
                  api.error({
                    message: 'Export failed',
                    description: String(err || ''),
                    placement: 'bottomLeft',
                  });
                });
              }}
            />
            <AssetLibraryModal
              open={assetLibraryOpen}
              onClose={() => setAssetLibraryOpen(false)}
              projectLibrary={assetLibrary}
              onReplaceProject={(next) => {
                invoke('replace_asset_library', { library: next })
                  .then((merged) => {
                    const lib = normalizeAssetLibrary(merged);
                    setAssetLibrary(lib);
                  })
                  .catch((err) => {
                    console.error(err);
                    api.error({
                      message: 'Failed to update asset library',
                      description: String(err),
                      placement: 'bottomLeft',
                    });
                  });
              }}
            />
            <Modal
              title="Clone stage to animation"
              open={cloneToOpen}
              onOk={confirmCloneTo}
              onCancel={() => {
                setCloneToOpen(false);
                setCloneToStage(null);
                setCloneToSourceScene(null);
                setCloneToTargetId(null);
              }}
              okButtonProps={{ disabled: !cloneToTargetId }}
              okText="Clone"
              destroyOnClose
            >
              <p style={{ marginBottom: 12 }}>
                Open a copy of this stage in another animation. The cloned stage
                keeps this stage&apos;s actor count; the destination animation
                is expanded to match.
              </p>
              <Select
                style={{ width: '100%' }}
                placeholder="Select animation"
                value={cloneToTargetId}
                onChange={setCloneToTargetId}
                options={(() => {
                  const list = [...scenes];
                  if (
                    activeScene &&
                    !list.some((s) => s.id === activeScene.id)
                  ) {
                    list.push(activeScene);
                  }
                  return list.map((s) => ({
                    value: s.id,
                    label: s.name || s.id || 'Untitled',
                  }));
                })()}
                showSearch
                optionFilterProp="label"
              />
            </Modal>
            <Sider
              className="main-sider"
              collapsible
              collapsed={collapsed}
              onCollapse={(value) => setCollapsed(value)}
              width="100%"
              trigger={null}
            >
              <div className="sider-content">
                <div className="pack-meta-card">
                  <input
                    type="text"
                    placeholder="Package Name"
                    className="sidebar-form"
                    value={packName}
                    onChange={(e) => {
                      const name = e.target.value;
                      setPackName(name);
                      invoke('set_pack_name', { name });
                      setEdited(true);
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Author Name"
                    className="sidebar-form"
                    value={packAuthor}
                    onChange={(e) => {
                      const author = e.target.value;
                      setPackAuthor(author);
                      invoke('set_pack_author', { author });
                      setEdited(true);
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Pack Version"
                    className="sidebar-form"
                    value={packVersion}
                    onChange={(e) => {
                      const version = e.target.value;
                      setPackVersion(version);
                      invoke('set_pack_version', { version });
                      setEdited(true);
                    }}
                  />
                </div>
                <Divider id="sidebar-divider" />
                {!collapsed && (
                  <div className="authoring-focus-wrap">
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      Authoring focus
                    </Typography.Text>
                    <Segmented
                      size="small"
                      block
                      value={resolvedAuthoringFocus}
                      onChange={setAndStoreAuthoringFocus}
                      options={[
                        { value: 'sexlab', label: 'SexLab' },
                        { value: 'ostim', label: 'OStim' },
                        { value: 'all', label: 'All' },
                      ]}
                    />
                  </div>
                )}
                <SceneListPanel
                  scenes={scenes}
                  activeSceneId={activeScene?.id}
                  collapsed={collapsed}
                  onNewScene={onNewScene}
                  onSelectScene={onSelectScene}
                  onDeleteScene={onDeleteScene}
                />
                <div className="sider-help-row">
                  <Button
                    type="link"
                    size="small"
                    icon={<QuestionCircleOutlined />}
                    onClick={() => setHelpOpen(true)}
                  >
                    {collapsed ? '' : 'Help'}
                  </Button>
                </div>
              </div>
            </Sider>
          </Panel>
          {/* End Left Panel */}

          <PanelResizeHandle className="resize-handle" />

          <Panel>
            <PanelGroup direction="vertical" autoSaveId="slsb-main-vertical">
              <Panel defaultSize={50} style={{}}>
                <PanelGroup
                  direction="horizontal"
                  autoSaveId="slsb-graph-tags-horizontal"
                >
                  {/* Graph Area */}
                  <Panel id="graph-panel">
                    <Layout style={{ height: '100%' }}>
                      <Content>
                        {/* hacky workaround because graph doesnt render nodes if I put the graph interface into a child component zzz */}
                        {/* if (activeScene) ... */}
                        <div
                          className="scene-box"
                          style={{ display: !activeScene ? 'none' : undefined }}
                        >
                          <Card
                            className="graph-editor-field a"
                            style={{
                              height: '100%',
                            }}
                            title={
                              activeScene ? (
                                <Space.Compact style={{ width: '98%' }}>
                                  <div
                                    style={
                                      !edited ? { display: 'none' } : {}
                                    }
                                  >
                                    <Tooltip title={'Unsaved changes'}>
                                      <DiffOutlined
                                        style={{
                                          fontSize: '2em',
                                          color: 'red',
                                        }}
                                      />
                                    </Tooltip>
                                  </div>
                                  <Input
                                    size="large"
                                    maxLength={30}
                                    bordered={false}
                                    id="stageNameInputField"
                                    value={activeScene.name}
                                    onChange={(e) => {
                                      updateActiveScene((prev) => {
                                        prev.name = e.target.value;
                                      });
                                      setEdited(true);
                                    }}
                                    onFocus={(e) => e.target.select()}
                                    placeholder="Scene Name"
                                  />
                                </Space.Compact>
                              ) : (
                                <></>
                              )
                            }
                            extra={
                              <Space.Compact block>
                                <Button
                                  onClick={() => openNewStageEditor()}
                                >
                                  Add Stage
                                </Button>
                                <Button onClick={saveScene} type="primary">
                                  Store
                                </Button>
                              </Space.Compact>
                            }
                            // bodyStyle={{ height: 'calc(100% - 190px)' }}
                          >
                            <div className="graph-toolbox">
                              <div className="graph-toolbox-primary">
                                <Space size="small" align="center" wrap={false}>
                                <Tooltip title="Undo" mouseEnterDelay={0.5}>
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={<DoubleLeftOutlined />}
                                    onClick={() => {
                                      if (graph.canUndo()) graph.undo();
                                    }}
                                  />
                                </Tooltip>
                                <Tooltip title="Redo" mouseEnterDelay={0.5}>
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={<DoubleRightOutlined />}
                                    onClick={() => {
                                      if (graph.canRedo()) graph.redo();
                                    }}
                                  />
                                </Tooltip>
                                <Divider type="vertical" />
                                <Tooltip
                                  title="Center content"
                                  mouseEnterDelay={0.5}
                                >
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={<CompressOutlined />}
                                    onClick={() =>
                                      fitGraphViewRef.current?.(graph, {
                                        padding: 28,
                                        retries: 8,
                                      })
                                    }
                                  />
                                </Tooltip>
                                <Tooltip
                                  title="Fit to screen"
                                  mouseEnterDelay={0.5}
                                >
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={<PicCenterOutlined />}
                                    onClick={() =>
                                      fitGraphViewRef.current?.(graph, {
                                        padding: 28,
                                        retries: 8,
                                      })
                                    }
                                  />
                                </Tooltip>
                                <Tooltip
                                  title="Arrange navigation layout (primary spanning tree)"
                                  mouseEnterDelay={0.5}
                                >
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={<ApartmentOutlined />}
                                    onClick={() => arrangeStages()}
                                  />
                                </Tooltip>
                                <Tooltip
                                  title="Restore packed positions from scene open (SLSB coords only)"
                                  mouseEnterDelay={0.5}
                                >
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={<UndoOutlined />}
                                    disabled={!layoutSnapshotRef.current}
                                    onClick={() => restorePackedPositions()}
                                  />
                                </Tooltip>
                                <Divider type="vertical" />
                                <Segmented
                                  size="small"
                                  value={graphWorkMode}
                                  onChange={(v) => applyWorkMode(v)}
                                  options={[
                                    { value: 'browse', label: 'Browse' },
                                    { value: 'edit', label: 'Edit' },
                                  ]}
                                />
                                <Divider type="vertical" />
                                <Tooltip title="Zoom out" mouseEnterDelay={0.5}>
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={<ZoomOutOutlined />}
                                    onClick={() => {
                                      graph.zoomTo(
                                        graph.zoom() * 0.8,
                                        ZOOM_OPTIONS
                                      );
                                    }}
                                  />
                                </Tooltip>
                                <Tooltip title="Zoom in" mouseEnterDelay={0.5}>
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={<ZoomInOutlined />}
                                    onClick={() => {
                                      graph.zoomTo(
                                        graph.zoom() * 1.2,
                                        ZOOM_OPTIONS
                                      );
                                    }}
                                  />
                                </Tooltip>
                                <Tooltip
                                  title="Lock canvas"
                                  mouseEnterDelay={0.5}
                                >
                                  <Switch
                                    size="small"
                                    checkedChildren={<PushpinOutlined />}
                                    unCheckedChildren={<DragOutlined />}
                                    onChange={(checked) => {
                                      graph.togglePanning(!checked);
                                    }}
                                  />
                                </Tooltip>
                                <Tooltip
                                  title="Clear canvas"
                                  mouseEnterDelay={0.5}
                                >
                                  <Button
                                    type="text"
                                    size="small"
                                    danger
                                    icon={<DeleteOutlined />}
                                    onClick={clearGraph}
                                  />
                                </Tooltip>
                                </Space>
                              </div>
                              <div className="graph-toolbox-view">
                                <Space size="small" align="center" wrap>
                                {showOstimChrome && ostimFolderOptions.length > 1 && (
                                  <Select
                                    size="small"
                                    value={mapFolderFilter}
                                    style={{ width: 140 }}
                                    popupMatchSelectWidth={false}
                                    title="Virtual canvas = OStim scenes/{folder}/ (only when a scene spans multiple folders)"
                                    onChange={(v) => switchFolderView(v)}
                                    options={[
                                      {
                                        value: 'all',
                                        label: 'All folders',
                                        title: 'Full component (can be slow)',
                                      },
                                      ...ostimFolderOptions,
                                    ]}
                                  />
                                )}
                                <Dropdown
                                  trigger={['click']}
                                  dropdownRender={() => (
                                    <div className="graph-view-filters">
                                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                        Map filters
                                      </Typography.Text>
                                      <Select
                                        size="small"
                                        value={mapFamilyFilter}
                                        onChange={(v) => {
                                          setMapFamilyFilter(v);
                                          mapFamilyFilterRef.current = v;
                                          queueMicrotask(() =>
                                            refreshGraphEdgesRef.current?.()
                                          );
                                        }}
                                        options={[
                                          { value: 'all', label: 'All families' },
                                          ...familyFilterOptions.map((f) => ({
                                            value: f,
                                            label: f,
                                          })),
                                        ]}
                                      />
                                      {(mapFolderFilter === 'all' ||
                                        !ostimFolderOptions.length) && (
                                        <>
                                          <Typography.Text
                                            type="secondary"
                                            style={{ fontSize: 12 }}
                                          >
                                            Focus hops (All-folders canvas)
                                          </Typography.Text>
                                          <Select
                                            size="small"
                                            value={
                                              Number.isFinite(focusHops)
                                                ? focusHops
                                                : 'all'
                                            }
                                            onChange={(v) => {
                                              const hops =
                                                v === 'all' ? Infinity : Number(v);
                                              setFocusHops(hops);
                                              focusHopsRef.current = hops;
                                              queueMicrotask(() =>
                                                refreshGraphEdgesRef.current?.()
                                              );
                                            }}
                                            options={[
                                              { value: 1, label: '1 hop' },
                                              { value: 2, label: '2 hops' },
                                              { value: 3, label: '3 hops' },
                                              { value: 'all', label: 'Off' },
                                            ]}
                                          />
                                        </>
                                      )}
                                      {focusNodeIds.length > 0 && (
                                        <Button
                                          size="small"
                                          onClick={() => {
                                            setFocusNodeIds([]);
                                            focusNodeIdsRef.current = [];
                                            setPathIds([]);
                                            queueMicrotask(() =>
                                              refreshGraphEdgesRef.current?.()
                                            );
                                          }}
                                        >
                                          Clear focus
                                        </Button>
                                      )}
                                    </div>
                                  )}
                                >
                                  <Tooltip title="Family / focus filters">
                                    <Button
                                      type="text"
                                      size="small"
                                      icon={<FilterOutlined />}
                                    >
                                      Filters
                                    </Button>
                                  </Tooltip>
                                </Dropdown>
                                <GraphNodeSearch
                                  stages={activeScene?.stages || []}
                                  onJump={jumpToNode}
                                />
                                <Tooltip title="Toggle navigation outline" mouseEnterDelay={0.5}>
                                  <Button
                                    type={showOutline ? 'primary' : 'text'}
                                    size="small"
                                    icon={<UnorderedListOutlined />}
                                    onClick={() => setShowOutline((v) => !v)}
                                  />
                                </Tooltip>
                                {showOstimChrome && (
                                  <Tooltip title="List DestRefs (portals on canvas also jump)" mouseEnterDelay={0.5}>
                                    <Button
                                      type={showOutboundPanel ? 'primary' : 'text'}
                                      size="small"
                                      icon={<EyeOutlined />}
                                      onClick={() => setShowOutboundPanel((v) => !v)}
                                    />
                                  </Tooltip>
                                )}
                                <Tooltip
                                  title="Export graph / connections"
                                  mouseEnterDelay={0.5}
                                >
                                  <Dropdown
                                    menu={{
                                      items: [
                                        {
                                          key: 'svg',
                                          label: 'Export visible SVG',
                                          onClick: () => exportGraphCanvas('svg'),
                                        },
                                        {
                                          key: 'json',
                                          label: 'Export visible layout JSON',
                                          onClick: () => exportGraphCanvas('json'),
                                        },
                                        {
                                          key: 'csv',
                                          label: 'Export all connections CSV',
                                          onClick: () => exportConnectionsTable(),
                                        },
                                      ],
                                    }}
                                    trigger={['click']}
                                  >
                                    <Button
                                      type="text"
                                      size="small"
                                      icon={<DownloadOutlined />}
                                    />
                                  </Dropdown>
                                </Tooltip>
                                </Space>
                              </div>
                            </div>
                            {showOstimChrome && showLargeSceneTip && (
                              <Alert
                                type="info"
                                showIcon
                                closable
                                banner
                                style={{ margin: '0 0 4px' }}
                                message={
                                  showFolderTip
                                    ? `Viewing pack folder “${mapFolderFilter}”. Right-click stages/canvas for folder actions. Teal edges → other folders.`
                                    : `Large scene (${activeScene.stages.length} stages). Pick a Canvas folder if available, or use Filters / Browse.`
                                }
                              />
                            )}
                            {showOstimChrome && !showLargeSceneTip && showFolderTip && (
                              <Alert
                                type="info"
                                showIcon
                                closable
                                banner
                                style={{ margin: '0 0 4px' }}
                                message={`Pack folder “${mapFolderFilter}”. Right-click a stage to move folders; right-click empty canvas for Add stage / New folder.`}
                              />
                            )}
                            <div
                              className="graph-container"
                              style={{
                                position: 'relative',
                                display: 'flex',
                                flexDirection: 'row',
                                height: '100%',
                                minHeight: 0,
                              }}
                            >
                              {showOutline && (
                                <div
                                  className="graph-outline-host"
                                  style={{
                                    flex: '0 0 240px',
                                    maxWidth: 280,
                                    minWidth: 180,
                                    borderRight: isDark
                                      ? '1px solid #333'
                                      : '1px solid #e8e8e8',
                                    padding: '8px 8px 4px',
                                    overflow: 'hidden',
                                    display: 'flex',
                                    flexDirection: 'column',
                                  }}
                                >
                                  <Typography.Text
                                    strong
                                    style={{ fontSize: 12, marginBottom: 4 }}
                                  >
                                    Navigation
                                  </Typography.Text>
                                  <GraphNavOutline
                                    outline={navOutline}
                                    selectedIds={focusNodeIds}
                                    pathIds={pathIds}
                                    isDark={isDark}
                                    onSelectNode={jumpToNode}
                                  />
                                </div>
                              )}
                              {showOstimChrome && showOutboundPanel && (
                                <div
                                  className="graph-outline-host outbound-host"
                                  style={{
                                    flex: '0 0 260px',
                                    maxWidth: 300,
                                    minWidth: 200,
                                    borderRight: isDark
                                      ? '1px solid #333'
                                      : '1px solid #e8e8e8',
                                    padding: '8px 8px 4px',
                                    overflow: 'auto',
                                  }}
                                >
                                  <OutboundLinksPanel
                                    scene={activeScene}
                                    sceneCatalog={scenes}
                                    onOpenStage={openStageById}
                                  />
                                </div>
                              )}
                              <div
                                id="graph"
                                ref={graphcontainer_ref}
                                className="graph-canvas-host"
                                style={{
                                  flex: '1 1 auto',
                                  minWidth: 0,
                                  height: '100%',
                                }}
                              />
                              {connectHint && (
                                <div className="graph-connect-hint" role="status">
                                  {connectHint}
                                </div>
                              )}
                              {graphCtxMenu && (
                                <div
                                  className="graph-ctx-menu"
                                  style={{
                                    left: graphCtxMenu.x,
                                    top: graphCtxMenu.y,
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  onContextMenu={(e) => e.preventDefault()}
                                >
                                  <Menu
                                    selectable={false}
                                    items={(
                                      graphCtxMenu.kind === 'blank'
                                        ? [
                                            {
                                              key: 'add-stage',
                                              label: 'Add stage here…',
                                              onClick: () => {
                                                const { graphX, graphY } =
                                                  graphCtxMenu;
                                                setGraphCtxMenu(null);
                                                openNewStageEditor({
                                                  graphX,
                                                  graphY,
                                                });
                                              },
                                            },
                                            {
                                              key: 'new-folder',
                                              label: 'New pack folder…',
                                              onClick: () => {
                                                setGraphCtxMenu(null);
                                                promptNewPackFolder();
                                              },
                                            },
                                            ostimFolderOptions.length
                                              ? {
                                                  key: 'open-folder',
                                                  label: 'Open canvas',
                                                  children: [
                                                    {
                                                      key: 'all',
                                                      label: 'All (slow)',
                                                      onClick: () => {
                                                        setGraphCtxMenu(null);
                                                        switchFolderView('all');
                                                      },
                                                    },
                                                    ...ostimFolderOptions.map(
                                                      (o) => ({
                                                        key: o.value,
                                                        label: o.label.replace(
                                                          /^Canvas:\s*/,
                                                          ''
                                                        ),
                                                        onClick: () => {
                                                          setGraphCtxMenu(null);
                                                          switchFolderView(
                                                            o.value
                                                          );
                                                        },
                                                      })
                                                    ),
                                                  ],
                                                }
                                              : null,
                                          ]
                                        : graphCtxMenu.kind === 'connect-drop'
                                          ? [
                                              {
                                                key: 'create-here',
                                                label: 'Create stage here',
                                                onClick: () => {
                                                  const intent =
                                                    connectDropIntentRef.current ||
                                                    {
                                                      graphX: graphCtxMenu.graphX,
                                                      graphY: graphCtxMenu.graphY,
                                                      connectFrom:
                                                        graphCtxMenu.connectFrom,
                                                    };
                                                  connectDropIntentRef.current =
                                                    null;
                                                  setGraphCtxMenu(null);
                                                  // Keep blank clicks from eating the drop intent.
                                                  ignoreBlankClickUntilRef.current =
                                                    Date.now() + 800;
                                                  clearConnectPendingRef.current?.(
                                                    { restore: false }
                                                  );
                                                  openNewStageEditor({
                                                    graphX: intent.graphX,
                                                    graphY: intent.graphY,
                                                    connectFrom:
                                                      intent.connectFrom,
                                                  });
                                                },
                                              },
                                              {
                                                key: 'cancel-link',
                                                label: 'Cancel',
                                                onClick: () => {
                                                  connectDropIntentRef.current =
                                                    null;
                                                  setGraphCtxMenu(null);
                                                  clearConnectPendingRef.current?.(
                                                    { restore: true }
                                                  );
                                                },
                                              },
                                            ]
                                        : graphCtxMenu.kind === 'portal'
                                          ? [
                                              {
                                                key: 'open',
                                                label: graphCtxMenu.portalSceneId
                                                  ? `Open scene “${graphCtxMenu.portalFolder || '…'}”…`
                                                  : `Open ${graphCtxMenu.portalFolder || 'folder'}…`,
                                                onClick: () => {
                                                  const id =
                                                    graphCtxMenu.nodeId;
                                                  setGraphCtxMenu(null);
                                                  const cell =
                                                    graph.getCellById(id);
                                                  if (cell)
                                                    jumpToPortal(cell);
                                                },
                                              },
                                            ]
                                          : graphCtxMenu.kind === 'node'
                                            ? [
                                                {
                                                  key: 'edit',
                                                  label: 'Edit stage…',
                                                  onClick: () => {
                                                    const id =
                                                      graphCtxMenu.nodeId;
                                                    setGraphCtxMenu(null);
                                                    const cell =
                                                      graph.getCellById(id);
                                                    if (cell)
                                                      graph.emit('node:edit', {
                                                        node: cell,
                                                      });
                                                  },
                                                },
                                                {
                                                  key: 'clone',
                                                  label: 'Clone',
                                                  onClick: () => {
                                                    const id =
                                                      graphCtxMenu.nodeId;
                                                    setGraphCtxMenu(null);
                                                    const cell =
                                                      graph.getCellById(id);
                                                    if (cell)
                                                      graph.emit(
                                                        'node:clone',
                                                        { node: cell }
                                                      );
                                                  },
                                                },
                                                {
                                                  key: 'root',
                                                  label: 'Mark as root',
                                                  onClick: () => {
                                                    const id =
                                                      graphCtxMenu.nodeId;
                                                    setGraphCtxMenu(null);
                                                    const cell =
                                                      graph.getCellById(id);
                                                    if (cell)
                                                      graph.emit(
                                                        'node:doMarkRoot',
                                                        { node: cell }
                                                      );
                                                  },
                                                },
                                                { type: 'divider' },
                                                {
                                                  key: 'move-folder',
                                                  label: 'Move to pack folder…',
                                                  onClick: () => {
                                                    const id =
                                                      graphCtxMenu.nodeId;
                                                    setGraphCtxMenu(null);
                                                    promptMoveStageToFolder(id);
                                                  },
                                                },
                                                mapFolderFilter !== 'all'
                                                  ? {
                                                      key: 'assign-here',
                                                      label: `Assign to “${mapFolderFilter}”`,
                                                      onClick: () => {
                                                        const id =
                                                          graphCtxMenu.nodeId;
                                                        setGraphCtxMenu(null);
                                                        assignStagesToFolder(
                                                          [id],
                                                          mapFolderFilter
                                                        );
                                                      },
                                                    }
                                                  : null,
                                                graphCtxMenu.ostimFolder
                                                  ? {
                                                      key: 'open-own',
                                                      label: `Open canvas “${graphCtxMenu.ostimFolder}”`,
                                                      onClick: () => {
                                                        const id =
                                                          graphCtxMenu.nodeId;
                                                        const folder =
                                                          graphCtxMenu.ostimFolder;
                                                        setGraphCtxMenu(null);
                                                        switchFolderView(
                                                          folder,
                                                          {
                                                            focusStageId: id,
                                                          }
                                                        );
                                                      },
                                                    }
                                                  : null,
                                                ostimFolderOptions.length
                                                  ? {
                                                      key: 'goto-folder',
                                                      label: 'Open canvas',
                                                      children:
                                                        ostimFolderOptions.map(
                                                          (o) => ({
                                                            key: o.value,
                                                            label: o.label.replace(
                                                              /^Canvas:\s*/,
                                                              ''
                                                            ),
                                                            onClick: () => {
                                                              setGraphCtxMenu(
                                                                null
                                                              );
                                                              switchFolderView(
                                                                o.value
                                                              );
                                                            },
                                                          })
                                                        ),
                                                    }
                                                  : null,
                                                {
                                                  key: 'new-folder',
                                                  label: 'New pack folder…',
                                                  onClick: () => {
                                                    setGraphCtxMenu(null);
                                                    promptNewPackFolder();
                                                  },
                                                },
                                                { type: 'divider' },
                                                {
                                                  key: 'delete',
                                                  label: 'Delete',
                                                  danger: true,
                                                  onClick: () => {
                                                    const id =
                                                      graphCtxMenu.nodeId;
                                                    setGraphCtxMenu(null);
                                                    const cell =
                                                      graph.getCellById(id);
                                                    if (cell) cell.remove();
                                                  },
                                                },
                                              ]
                                            : [
                                                // edge (default)
                                                graphCtxMenu.bridgeFolder ||
                                                graphCtxMenu.bridgeTargetId
                                                  ? {
                                                      key: 'open-bridge',
                                                      label: graphCtxMenu.bridgeFolder
                                                        ? `Open “${graphCtxMenu.bridgeFolder}”…`
                                                        : 'Open linked folder…',
                                                      onClick: () => {
                                                        const stageId =
                                                          graphCtxMenu.bridgeTargetId ||
                                                          graphCtxMenu.bridgeSourceId;
                                                        const folder =
                                                          graphCtxMenu.bridgeFolder;
                                                        setGraphCtxMenu(null);
                                                        if (folder)
                                                          switchFolderView(
                                                            folder,
                                                            {
                                                              focusStageId:
                                                                stageId,
                                                            }
                                                          );
                                                      },
                                                    }
                                                  : null,
                                                !graphCtxMenu.via &&
                                                !graphCtxMenu.bridgeTargetId &&
                                                !graphCtxMenu.bridgeSourceId
                                                  ? {
                                                      key: 'add-return',
                                                      label: 'Add return link',
                                                      onClick:
                                                        onEdgeCtxAddReturn,
                                                    }
                                                  : null,
                                                !graphCtxMenu.via &&
                                                !graphCtxMenu.bridgeTargetId &&
                                                !graphCtxMenu.bridgeSourceId
                                                  ? {
                                                      key: 'convert',
                                                      label:
                                                        'Convert to transition',
                                                      onClick:
                                                        onEdgeCtxConvert,
                                                    }
                                                  : null,
                                                graphCtxMenu.via
                                                  ? {
                                                      key: 'edit',
                                                      label: 'Edit transition',
                                                      onClick: onEdgeCtxEdit,
                                                    }
                                                  : null,
                                                graphCtxMenu.via
                                                  ? {
                                                      key: 'revert',
                                                      label:
                                                        'Revert to connection',
                                                      onClick: onEdgeCtxRevert,
                                                    }
                                                  : null,
                                              { type: 'divider' },
                                              {
                                                key: 'delete',
                                                label: 'Delete',
                                                danger: true,
                                                onClick: onEdgeCtxDelete,
                                              },
                                            ]
                                    ).filter(Boolean)}
                                  />
                                </div>
                              )}
                            </div>
                          </Card>
                        </div>
                        {/* else ... */}
                        <Empty
                          style={activeScene ? { display: 'none' } : {}}
                          className="graph-no-scene-placeholder"
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={
                            <div className="empty-scene-steps">
                              <div>No scene loaded</div>
                              <ol>
                                <li>Create or select a scene in the left list</li>
                                <li>Add stages and connect them on the canvas</li>
                                <li>Set actor slots (scene cast) below</li>
                              </ol>
                            </div>
                          }
                        >
                          <Button
                            type="primary"
                            onClick={() => onNewScene()}
                          >
                            New Scene
                          </Button>
                        </Empty>
                        {/* endif */}
                      </Content>
                    </Layout>
                  </Panel>
                  {/* End Graph Area */}

                  <PanelResizeHandle className="resize-handle" />
                  {/* Scene Tags and Furniture area */}
                  {showAreas && (
                    <Panel
                      id="sceneTags-panel"
                      minSize={30}
                      defaultSize={30}
                      maxSize={40}
                    >
                      <Card
                        className="sceneTags-attribute-card"
                        bordered={false}
                        title={'Scene tags'}
                        extra={
                          <Space size={0}>
                            <Tooltip
                              title="Copy scene tags onto every stage (replaces each stage's tags)."
                            >
                              <Button
                                type="text"
                                disabled={
                                  !activeScene ||
                                  !activeScene.stages ||
                                  activeScene.stages.length === 0
                                }
                                onClick={() => {
                                  if (!activeScene?.stages?.length) return;
                                  const hasPlumbing = activeScene.stages.some((s) =>
                                    (s.tags || []).some(isOstimPlumbingTag)
                                  );
                                  const doCopy = () => {
                                    const copied = [...(activeScene.tags || [])];
                                    updateActiveScene((prev) => {
                                      for (const stage of prev.stages) {
                                        const keep = (stage.tags || []).filter(
                                          isOstimPlumbingTag
                                        );
                                        const fromScene = copied.filter(
                                          (t) => !isOstimPlumbingTag(t)
                                        );
                                        stage.tags = [...keep, ...fromScene];
                                      }
                                    });
                                    setEdited(true);
                                  };
                                  if (hasPlumbing) {
                                    Modal.confirm({
                                      title: 'Copy scene tags to stages?',
                                      content:
                                        'OStim pack metadata on stages (folder, id, nav links) will be kept. Other stage tags are replaced by scene tags.',
                                      okText: 'Copy (keep OStim tags)',
                                      onOk: doCopy,
                                    });
                                  } else {
                                    doCopy();
                                  }
                                }}
                              >
                                Copy to stages
                              </Button>
                            </Tooltip>
                            <Tooltip
                              className="tool-tip"
                              title={
                                'Tags shared by all stages in this scene.'
                              }
                            >
                              <Button type="text">Info</Button>
                            </Tooltip>
                          </Space>
                        }
                      >
                        {showOstimChrome && (
                        <div style={{ marginBottom: 12 }}>
                          <OstimFolderField
                            tags={activeScene ? activeScene.tags : []}
                            knownFolders={ostimFolderOptions.map((o) => o.value)}
                            onChange={(tags) => {
                              updateActiveScene((prev) => {
                                prev.tags = tags;
                              });
                              setEdited(true);
                            }}
                            placeholder="Default export folder (fallback)"
                          />
                        </div>
                        )}
                        <TagTree
                          tags={activeScene ? activeScene.tags : []}
                          onChange={(tags) => {
                            updateActiveScene((prev) => {
                              prev.tags = tags;
                            });
                            setEdited(true);
                          }}
                          tagsSFW={activeScene ? tagsSFW : []}
                          tagsNSFW={activeScene ? tagsNSFW : []}
                          tagsOStimActions={activeScene ? tagsOStimActions : []}
                        />
                      </Card>
                      <Card
                        bordered={false}
                        title={'Furniture'}
                        className="furniture-attribute-card"
                        extra={
                          <Tooltip
                            className="tool-tip"
                            title={'Furniture settings for the scene.'}
                          >
                            <Button type="text">Info</Button>
                          </Tooltip>
                        }
                      >
                        <Space size={'large'} direction="vertical">
                          <Select
                            style={{ overflowY: 'auto' }}
                            className="graph-furniture-selection"
                            value={
                              activeScene
                                ? activeScene.furniture.furni_types
                                : []
                            }
                            options={Furnitures}
                            mode="multiple"
                            onSelect={(value) => {
                              if (value === 'None') {
                                updateActiveScene((prev) => {
                                  prev.furniture.furni_types = [value];
                                  return prev;
                                });
                              } else {
                                updateActiveScene((prev) => {
                                  let where =
                                    prev.furniture.furni_types.indexOf('None');
                                  if (where === -1)
                                    prev.furniture.furni_types.push(value);
                                  else
                                    prev.furniture.furni_types[where] = value;
                                  prev.furniture.allow_bed = false;
                                  return prev;
                                });
                              }
                              setEdited(true);
                            }}
                            onDeselect={(value) => {
                              updateActiveScene((prev) => {
                                prev.furniture.furni_types =
                                  prev.furniture.furni_types.filter(
                                    (it) => it !== value
                                  );
                                if (prev.furniture.furni_types.length === 0) {
                                  prev.furniture.furni_types = ['None'];
                                }
                                return prev;
                              });
                              setEdited(true);
                            }}
                          />
                          <Checkbox
                            onChange={(e) => {
                              updateActiveScene((prev) => {
                                prev.furniture.allow_bed = e.target.checked;
                              });
                              setEdited(true);
                            }}
                            checked={
                              activeScene && activeScene.furniture.allow_bed
                            }
                            disabled={
                              activeScene &&
                              !activeScene.furniture.furni_types.includes(
                                'None'
                              )
                            }
                          >
                            Allow Bed
                          </Checkbox>
                          <Input
                            addonBefore="OStim type"
                            placeholder="optional override (e.g. singlebed, wall)"
                            style={{ display: showOstimChrome ? undefined : 'none' }}
                            value={
                              (activeScene && activeScene.furniture.ostim_type) || ''
                            }
                            onChange={(e) => {
                              updateActiveScene((prev) => {
                                prev.furniture.ostim_type = e.target.value;
                                return prev;
                              });
                              setEdited(true);
                            }}
                          />
                          <Checkbox
                            onChange={(e) => {
                              updateActiveScene((prev) => {
                                prev.private = e.target.checked;
                              });
                              setEdited(true);
                            }}
                            checked={activeScene && activeScene.private}
                          >
                            Private
                          </Checkbox>
                          <Row gutter={[12, 12]} justify={'space-evenly'}>
                            <Col>
                              <InputNumber
                                addonBefore={'X'}
                                controls
                                decimalSeparator=","
                                precision={1}
                                step={0.1}
                                value={
                                  activeScene
                                    ? activeScene.furniture.offset.x
                                      ? activeScene.furniture.offset.x
                                      : undefined
                                    : undefined
                                }
                                onChange={(e) => {
                                  updateActiveScene((prev) => {
                                    prev.furniture.offset.x = e;
                                  });
                                  setEdited(true);
                                }}
                                placeholder="0.0"
                              />
                            </Col>
                            <Col>
                              <InputNumber
                                addonBefore={'Y'}
                                controls
                                decimalSeparator=","
                                precision={1}
                                step={0.1}
                                value={
                                  activeScene && activeScene.furniture.offset.y
                                    ? activeScene.furniture.offset.y
                                    : undefined
                                }
                                onChange={(e) => {
                                  updateActiveScene((prev) => {
                                    prev.furniture.offset.y = e;
                                  });
                                  setEdited(true);
                                }}
                                placeholder="0.0"
                              />
                            </Col>
                            <Col>
                              <InputNumber
                                addonBefore={'Z'}
                                controls
                                decimalSeparator=","
                                precision={1}
                                step={0.1}
                                value={
                                  activeScene
                                    ? activeScene.furniture.offset.z
                                      ? activeScene.furniture.offset.z
                                      : undefined
                                    : undefined
                                }
                                onChange={(e) => {
                                  updateActiveScene((prev) => {
                                    prev.furniture.offset.z = e;
                                  });
                                  setEdited(true);
                                }}
                                placeholder="0.0"
                              />
                            </Col>
                            <Col>
                              <InputNumber
                                addonBefore={'°'}
                                controls
                                decimalSeparator=","
                                precision={1}
                                step={0.1}
                                min={0.0}
                                max={359.9}
                                value={
                                  (activeScene &&
                                    activeScene.furniture.offset.r) ||
                                  undefined
                                }
                                onChange={(e) => {
                                  updateActiveScene((prev) => {
                                    prev.furniture.offset.r = e;
                                  });
                                  setEdited(true);
                                }}
                                placeholder="0.0"
                              />
                            </Col>
                          </Row>
                        </Space>
                      </Card>
                    </Panel>
                  )}
                  {/* Scene Tags and Furniture area */}
                </PanelGroup>
              </Panel>

              <PanelResizeHandle className="resize-handle-horizontal" />

              {/* Bottom Positions Field */}
              {showAreas && (
                <Panel
                  minSize={15}
                  maxSize={50}
                  id="scenePositions"
                  style={{ minHeight: '150px' }}
                  defaultSize={25}
                >
                  <Card
                    className="sceneTagsPositions-card"
                    bordered={false}
                    title="Actor slots"
                    extra={
                      <Tooltip
                        className="tool-tip"
                        title={
                          'Scene cast — who can fill each slot across all stages in this scene.'
                        }
                      >
                        <Button type="text">Info</Button>
                      </Tooltip>
                    }
                  >
                    <Space direction="horizontal" style={{ width: '100%' }}>
                      <div className="scene-positions-list">
                        {activeScene &&
                        activeScene.positions &&
                        activeScene.positions.length > 0 ? (
                          activeScene.positions.map((pos, idx) => (
                            <Col key={pos.id || idx} span={24}>
                              <ScenePosition
                                position={pos}
                                onChange={(newPos) => {
                                  updateActiveScene((draft) => {
                                    draft.positions[idx] = {
                                      ...newPos,
                                      id: pos.id || generatePositionId(),
                                    };
                                  });
                                  emit('on_position_change', {
                                    sceneId: activeScene.id,
                                    stageId: 0,
                                    positionIdx: idx,
                                    info: { ...newPos },
                                  });
                                  setEdited(true);
                                }}
                              />
                            </Col>
                          ))
                        ) : (
                          <Col
                            span={24}
                            style={{ padding: 12, textAlign: 'center' }}
                          >
                            <div className="scene-positions-empty">
                              No positions yet — use "Add Stage" or add a
                              position from the stage editor.
                            </div>
                          </Col>
                        )}
                      </div>
                    </Space>
                  </Card>
                </Panel>
              )}
              {/* Bottom Positions Field */}
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </Layout>
    </ConfigProvider>
  );
}

export default App;