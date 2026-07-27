import React, { useState, useRef, useEffect, lazy, Suspense, useMemo } from "react";
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow } from '@tauri-apps/api/window'
import ReactDOM from "react-dom/client";
import { useImmer } from "use-immer";
import { FileDoneOutlined, TagsOutlined, SaveOutlined, TeamOutlined, LinkOutlined, PlayCircleOutlined, ApartmentOutlined } from '@ant-design/icons';
import { Input, Button, Tooltip, InputNumber, Card, Layout, Row, Col, Tabs, notification, Collapse, ConfigProvider, Select, Spin, Space, Typography } from 'antd';

import { tagsSFW, tagsNSFW, tagsOStimActions } from "./common/Tags"
const PositionField = lazy(() => import("./stage/PositionField"));
const TagTree = lazy(() => import("./components/TagTree"));
import OstimFolderField from "./components/OstimFolderField";
import OstimNavFields from "./components/OstimNavFields";
import CrossSceneLinkFields from "./components/CrossSceneLinkFields";
import {
  resolveNavEditorRows,
  tagsWithOstimNavs,
  readableNavTextFromRows,
} from "./common/ostimNav";
import {
  stageOstimIdFromTags,
  tagsWithOstimId,
} from "./scene/graphFocus";
import { destStage, makeDest } from "./common/destRef";
import "./stage.css";
import "./App.css";
// import "./Dark.css";
import { getAppTheme } from "./common/theme";
import { applyRootDarkClass, readOsDarkMode, writeStoredDarkMode } from "./common/darkMode";
import {
  normalizeAssetLibrary,
  rememberAssetValues,
} from "./common/assetLibrary";

const { Header, Content } = Layout;
const { TextArea } = Input;

let root = null;
document.addEventListener('DOMContentLoaded', async () => {
  const load = ({ scene, stage, positions, dark, asset_library, graph, scene_catalog }) => {
    console.log("Scene ID:", scene, "Stage:", stage);
    const stagePositions = stage.positions || [];
    const scenePositions = positions || [];
    const n = Math.max(stagePositions.length, scenePositions.length);
    const blankInfo = () => ({
      sex: { male: true, female: false, futa: false },
      race: 'Human',
      scale: 1.0,
      submissive: false,
      vampire: false,
      dead: false,
      add_cum: 0,
    });
    const blankPos = () => ({
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
      open_mouth: false,
      silent: false,
      strap_on: false,
      look_up: 0,
      look_left: 0,
      animation_index: null,
      expression_override: '',
      equip_objects: '',
    });
    const merged = Array.from({ length: n }, (_, i) => ({
      position: stagePositions[i] || blankPos(),
      info: scenePositions[i] || blankInfo(),
    }));
    const initialDark = typeof dark === 'boolean' ? dark : readOsDarkMode();
    writeStoredDarkMode(initialDark);
    applyRootDarkClass(initialDark);
    const assetLibrary = normalizeAssetLibrary(asset_library);
    if (!root) root = ReactDOM.createRoot(document.getElementById("root"));
    root.render(
      <React.StrictMode>
        <Editor
          key={`Editor-${stage.id}`}
          _sceneId={scene}
          _stage={{ ...stage, positions: merged.map((m) => m.position) }}
          _positions={merged}
          _initialDark={initialDark}
          _assetLibrary={assetLibrary}
          _graph={graph || {}}
          _sceneCatalog={scene_catalog || []}
        />
      </React.StrictMode>
    );
  }
  // Keep listening so a re-focused existing editor can receive a fresh payload.
  await listen('on_data_received', ({ payload }) => {
    window.sessionStorage.setItem('origin_data', JSON.stringify(payload));
    load(payload);
  });
  await emit('on_request_data');
});

function makePositionTab(p, i) {
  return { key: `PTab${i}`, position: p.position, info: p.info }
}

function Editor({ _sceneId, _stage, _positions, _initialDark, _assetLibrary, _graph, _sceneCatalog }) {
  const [isDark, setIsDark] = useState(() =>
    typeof _initialDark === 'boolean' ? _initialDark : readOsDarkMode()
  );
  const [api, contextHolder] = notification.useNotification();
  const [assetLibrary, setAssetLibrary] = useState(() =>
    normalizeAssetLibrary(_assetLibrary)
  );
  const [graph, setGraph] = useState(() => _graph || {});
  const sceneCatalog = _sceneCatalog || [];

  const [name, setName] = useState(_stage.name);
  const [positions, updatePositions] = useImmer(_positions.map((p, i) => { return makePositionTab(p, i) }));
  const [activePosition, setActivePosition] = useState(positions[0].key);
  const positionIdx = useRef(_positions.length);
  const [tags, setTags] = useState(_stage.tags || []);
  const [fixedLen, setFixedLen] = useState(() => {
    const n = Number(_stage.extra?.fixed_len);
    return Number.isFinite(n) ? n : 0;
  });
  const [navText, setNavText] = useState(_stage.extra?.nav_text || '');
  const [sound, setSound] = useState(_stage.extra?.sound || '');
  const [navRows, setNavRows] = useState(() =>
    resolveNavEditorRows(_stage.id, _stage.tags || [])
  );
  const [raceKeys, setRaceKeys] = useState([]);
  const hasOstimPlumbing = (tags || []).some(
    (t) =>
      String(t).startsWith('ostim_') || String(t).startsWith('action:')
  );
  const showOstimTab = hasOstimPlumbing || navRows.length > 0;

  const applyNavRows = (rows) => {
    setNavRows(rows);
    setTags((prev) => tagsWithOstimNavs(prev, rows));
    // Pose Extras box is a derived summary only; transitions keep inbound nav_text.
    const isTransition = (tags || []).some(
      (t) => String(t).toLowerCase() === 'transition'
    );
    if (!isTransition) {
      setNavText(readableNavTextFromRows(rows));
    }
  };

  const syncGraphFromNavRows = (rows) => {
    setGraph((prev) => {
      const g = structuredClone(prev || {});
      if (!g[_stage.id]) g[_stage.id] = { dest: [], x: 40, y: 40 };
      const crossKept = (g[_stage.id].dest || []).filter((d) => {
        const sc = typeof d === 'object' ? d.scene : '';
        return sc && sc !== _sceneId;
      });
      const localDests = rows
        .filter((r) => r.stageId && !r.external)
        .map((r) => makeDest(_sceneId, r.stageId));
      // Keep external ostim destinations as local stage-id strings when they
      // match an in-scene stage; otherwise leave only cross-scene DestRefs.
      g[_stage.id] = {
        ...g[_stage.id],
        dest: [...localDests, ...crossKept],
      };
      return g;
    });
  };

  const removeNavRow = (index, row) => {
    const next = navRows.filter((_, i) => i !== index);
    applyNavRows(next);
    if (row?.stageId) {
      setGraph((prev) => {
        const g = structuredClone(prev || {});
        if (!g[_stage.id]) return g;
        g[_stage.id] = {
          ...g[_stage.id],
          dest: (g[_stage.id].dest || []).filter(
            (d) => destStage(d) !== row.stageId
          ),
        };
        return g;
      });
    } else {
      syncGraphFromNavRows(next);
    }
  };

  const retargetNavRow = (index, nextRow) => {
    const prev = navRows[index];
    const next = navRows.map((r, i) => (i === index ? nextRow : r));
    applyNavRows(next);
    setGraph((gPrev) => {
      const g = structuredClone(gPrev || {});
      if (!g[_stage.id]) g[_stage.id] = { dest: [], x: 40, y: 40 };
      let dests = [...(g[_stage.id].dest || [])];
      if (prev?.stageId) {
        dests = dests.filter((d) => destStage(d) !== prev.stageId);
      }
      if (nextRow.stageId && !nextRow.external) {
        const exists = dests.some((d) => destStage(d) === nextRow.stageId);
        if (!exists) dests.push(makeDest(_sceneId, nextRow.stageId));
      }
      g[_stage.id] = { ...g[_stage.id], dest: dests };
      return g;
    });
  };

  const addReturnNav = (_index, row) => {
    if (!row?.stageId || row.stageId === _stage.id) return;
    setGraph((prev) => {
      const g = structuredClone(prev || {});
      if (!g[row.stageId]) g[row.stageId] = { dest: [], x: 40, y: 40 };
      const exists = (g[row.stageId].dest || []).some(
        (d) => destStage(d) === _stage.id
      );
      if (!exists) {
        g[row.stageId] = {
          ...g[row.stageId],
          dest: [...(g[row.stageId].dest || []), makeDest(_sceneId, _stage.id)],
        };
      }
      return g;
    });
    api.success({
      message: 'Return link added',
      description: `Linked ${row.label || row.dest} → this stage. Save both stages’ graph from the canvas if you edit the other side’s OStim metadata.`,
      placement: 'bottomLeft',
      duration: 5,
    });
  };

  const setOstimId = (value) => {
    setTags((prev) => tagsWithOstimId(prev, value));
  };

  useEffect(() => {
    invoke('get_race_keys')
      .then((result) => setRaceKeys(Array.isArray(result) ? result : []))
      .catch(() => setRaceKeys([]));
  }, []);

  useEffect(() => {
    const unlisten = listen('on_asset_library_update', (event) => {
      setAssetLibrary(normalizeAssetLibrary(event.payload));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen('toggle_darkmode', (event) => {
      setIsDark(event.payload);
    });
    invoke('get_in_darkmode').then(setIsDark);
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    writeStoredDarkMode(isDark);
    applyRootDarkClass(isDark);
  }, [isDark]);


  useEffect(() => {
    const position_remove = listen('on_position_remove', (event) => {
      const { sceneId, positionIdx } = event.payload;
      if (sceneId !== _sceneId) return;
      updatePositions(p => { p.splice(positionIdx, 1) });
    });
    const position_add = listen('on_position_add', (event) => {
      const { sceneId, position } = event.payload;
      if (sceneId !== _sceneId) return;
      updatePositions(prev => { prev.push(position) });
    });
    const position_change = listen('on_position_change', (event) => {
      const { sceneId, stageId, positionIdx, info } = event.payload;
      if (sceneId !== _sceneId || stageId === _stage.id) return;
      console.log("Position Change Event:", info);
      updatePositions(p => { p[positionIdx].info = info });
    });
    return () => {
      position_remove.then(res => { res() });
      position_add.then(res => { res() });
      position_change.then(res => { res() });
    }
  }, []);

  function saveAndReturn() {
    let positionArg = [];
    let positionsInfo = [];
    let missingHkx = [];
    for (let i = 0; i < positions.length; i++) {
      const { position: stage_p, info: scene_p } = positions[i];
      if (!stage_p.event?.[0]) {
        missingHkx.push(i + 1);
      }
      if (!scene_p.sex.male && !scene_p.sex.female && !scene_p.sex.futa) {
        api.error({
          message: 'Missing Sex',
          description: `Position ${i + 1} has no sex assigned. Every position should be compatible with at least one sex.`,
          placement: 'bottomLeft',
        });
        return;
      }
      const animRaw = Array.isArray(stage_p.anim_obj)
        ? stage_p.anim_obj.filter(Boolean).join(' ')
        : String(stage_p.anim_obj ?? '');
      positionArg.push({
        ...stage_p,
        event: Array.isArray(stage_p.event) ? stage_p.event : [],
        anim_obj: animRaw
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .join(','),
      });
      positionsInfo.push(scene_p);
    }
    if (missingHkx.length) {
      api.warning({
        message: 'Saved without .hkx',
        description: `Position ${missingHkx.join(', ')} has no anim event — OK for graph/folder testing. Add a behavior file before SexLab/FNIS export.`,
        placement: 'bottomLeft',
        duration: 6,
      });
    }
    for (const pos of positionArg) {
      rememberAssetValues('events', pos.event || []);
      rememberAssetValues('anim_objects', pos.anim_obj || '');
      rememberAssetValues('equip_objects', pos.equip_objects || '');
    }
    const stageTags = tagsWithOstimNavs(tags, navRows);
    const isTransition = (stageTags || []).some(
      (t) => String(t).toLowerCase() === 'transition'
    );
    // SexLab navtext = inbound edge label (transitions). Pose outbound lists stay in ostim_nav tags.
    const stageNavText = isTransition
      ? navText || ''
      : navRows.length
        ? ''
        : navText || '';
    const stage = {
      id: _stage.id,
      name,
      positions: positionArg,
      tags: stageTags,
      extra: {
        fixed_len: fixedLen || 0.0,
        nav_text: stageNavText,
        sound: sound || '',
      },
    };
    console.log("Saving Stage... ", _sceneId, positionsInfo, stage);
    invoke('stage_save_and_close', {
      scene: _sceneId,
      positions: positionsInfo,
      stage,
      graph,
    });
  }

  const saveAndReturnRef = useRef(saveAndReturn);
  saveAndReturnRef.current = saveAndReturn;

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        getCurrentWindow()
          .close()
          .catch((err) => console.error('Failed to close stage editor', err));
        return;
      }
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) {
        return;
      }
      const target = e.target;
      const tag = target?.tagName?.toLowerCase();
      // Keep Enter for multiline fields and Ant Select tag entry.
      if (tag === 'textarea') return;
      if (target?.closest?.('.ant-select')) return;
      e.preventDefault();
      saveAndReturnRef.current();
    };
    // Capture so Escape is not swallowed by Ant Select/dropdowns first.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const onPositionTabEdit = (targetKey, action) => {
    if (action === 'add') {
      invoke('make_position').then((res) => {
        const next = makePositionTab(res, positionIdx.current++);
        emit('on_position_add', { sceneId: _sceneId, position: next }).then(() => {
          setActivePosition(next.key);
        });
      });
    } else {
      const id = positions.findIndex(v => v.key === targetKey);
      if (activePosition === targetKey) {
        const newidx = id > 0 ? id - 1 : 1;
        setActivePosition(positions[newidx].key);
      }
      emit('on_position_remove', { sceneId: _sceneId, positionIdx: id });
    }
  };

  const positionsCollapsed = useMemo(() => [
    {
      key: '1',
      label: 'Tags',
      extra: <TagsOutlined />,
      children:
        <div className="tag-display-box">
          <OstimFolderField
            tags={tags}
            onChange={setTags}
            style={{ marginBottom: 12 }}
          />
          <Suspense fallback={<Spin />}>
            <TagTree
              tags={tags}
              onChange={setTags}
              tagsSFW={tagsSFW}
              tagsNSFW={tagsNSFW}
              tagsOStimActions={tagsOStimActions}
            />
          </Suspense>
        </div>
    },
    {
      key: '2',
      label: 'Stage animation',
      extra: <TeamOutlined />,
      children:
        <Tabs
          type="editable-card"
          activeKey={activePosition}
          hideAdd={positions.length > 4}
          destroyInactiveTabPane
          onEdit={onPositionTabEdit}
          onChange={(e) => {
            setActivePosition(e);
          }}
          items={positions.map((p, i) => {
            return {
              label: `Position ${i + 1}`,
              closable: positions.length > 1,
              key: p.key,
              children: (
                <div className="position">
                  <Suspense fallback={<Spin />}>
                    <PositionField
                      position={p.position}
                      info={p.info}
                      raceKeys={raceKeys}
                      assetLibrary={assetLibrary}
                      onChange={(newPosition, newInfo) => {
                        updatePositions((draft) => {
                          draft[i].position = newPosition;
                          draft[i].info = newInfo;
                        });
                        emit('on_position_change', {
                          sceneId: _sceneId,
                          stageId: _stage.id,
                          positionIdx: i,
                          info: newInfo,
                        });
                      }}
                    />
                  </Suspense>
                </div>
              ),
            };
          })}
        />
    },
    {
      key: '3',
      label: 'Links & playback',
      extra: <FileDoneOutlined />,
      children: (
        <Tabs
          size="small"
          defaultActiveKey="links"
          items={[
            {
              key: 'links',
              label: (
                <span>
                  <LinkOutlined /> Links
                </span>
              ),
              children: (
                <>
                  <Card
                    style={{ marginBottom: 8 }}
                    title={navRows.length ? 'Nav summary' : 'Same-scene navtext'}
                    extra={
                      <Tooltip
                        title={
                          navRows.length
                            ? 'Read-only summary of OStim descriptions (not written to .slr). Transition stages use this as the SexLab via-edge / navtext label.'
                            : 'Short player-facing description for this branch. Same-scene graph edges are drawn on the canvas.'
                        }
                      >
                        <Button type="text">Info</Button>
                      </Tooltip>
                    }
                  >
                    <TextArea
                      className="extra-navinfo-textarea"
                      maxLength={100}
                      showCount
                      rows={3}
                      style={{ resize: 'none', width: '100%' }}
                      placeholder="e.g. bow down"
                      value={navText}
                      readOnly={navRows.length > 0}
                      onChange={(e) => setNavText(e.target.value)}
                    />
                  </Card>
                  <Card title="Cross-scene links">
                    <CrossSceneLinkFields
                      scene={{ id: _sceneId, graph }}
                      stageId={_stage.id}
                      allScenes={sceneCatalog}
                      onChangeGraph={setGraph}
                    />
                  </Card>
                </>
              ),
            },
            {
              key: 'playback',
              label: (
                <span>
                  <PlayCircleOutlined /> Playback
                </span>
              ),
              children: (
                <Row gutter={[8, 8]}>
                  <Col span={12}>
                    <Card title="Fixed Duration">
                      <InputNumber
                        className="extra-duration-input"
                        controls
                        precision={0}
                        step={10}
                        min={0}
                        value={Number.isFinite(fixedLen) ? fixedLen : 0}
                        onChange={(v) =>
                          setFixedLen(Number.isFinite(v) ? v : 0)
                        }
                        placeholder="0"
                        addonAfter="ms"
                        style={{ width: '100%' }}
                      />
                    </Card>
                  </Col>
                  <Col span={12}>
                    <Card title="Sound (SLAL only)">
                      <Select
                        allowClear
                        placeholder="Unset"
                        style={{ width: '100%' }}
                        value={sound || undefined}
                        onChange={(v) => setSound(v || '')}
                        options={[
                          { value: 'Squishing', label: 'Squishing' },
                          { value: 'Sucking', label: 'Sucking' },
                          { value: 'SexMix', label: 'SexMix' },
                          { value: 'none', label: 'none' },
                          { value: 'NoSound', label: 'NoSound' },
                        ]}
                      />
                    </Card>
                  </Col>
                </Row>
              ),
            },
            ...(showOstimTab
              ? [
                  {
                    key: 'ostim',
                    label: (
                      <span>
                        <ApartmentOutlined /> OStim
                      </span>
                    ),
                    children: (
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <Card title="OStim identity">
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            OStim ID (JSON filename)
                          </Typography.Text>
                          <Input
                            value={stageOstimIdFromTags({ tags }) || ''}
                            placeholder="e.g. MLCBedStraddlingCloseKiss"
                            onChange={(e) => setOstimId(e.target.value)}
                            style={{ marginBottom: 8 }}
                          />
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            Becomes the .json filename on export. Display name
                            (stage title) is separate.
                          </Typography.Text>
                        </Card>
                        <Card
                          title="OStim navigation"
                          extra={
                            <Tooltip title="Per outbound link metadata stored as ostim_nav: tags (OStim JSON export).">
                              <Button type="text">Info</Button>
                            </Tooltip>
                          }
                        >
                          <Typography.Paragraph
                            type="secondary"
                            style={{ fontSize: 12, marginBottom: 8 }}
                          >
                            Links here are authored in the project; Export writes{' '}
                            <Typography.Text code>
                              {'{ostim_id}.json'}
                            </Typography.Text>
                            .
                          </Typography.Paragraph>
                          <OstimNavFields
                            rows={navRows}
                            onChange={applyNavRows}
                            assetLibrary={assetLibrary}
                            stages={
                              sceneCatalog.find((s) => s.id === _sceneId)
                                ?.stages || []
                            }
                            onRemove={removeNavRow}
                            onRetarget={retargetNavRow}
                            onAddReturn={addReturnNav}
                          />
                        </Card>
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ], [
    tags,
    positions,
    activePosition,
    raceKeys,
    navText,
    navRows,
    showOstimTab,
    sound,
    fixedLen,
    graph,
    sceneCatalog,
    assetLibrary,
    _sceneId,
    _stage.id,
    _stage.extra,
  ]);

  return (
    <ConfigProvider theme={getAppTheme(isDark)}>
      <Layout style={{ minHeight: '100vh' }}>
        {contextHolder}
        <Header className="stage-header">
          <Row align="middle" justify="space-between" wrap={false} style={{ width: '100%' }} gutter={12}>
            <Col flex="auto" style={{ minWidth: 0 }}>
              <Input
                id="stage-namefield-input"
                className="stage-namefield"
                size="large"
                bordered={false}
                value={name}
                onChange={(e) => setName(e.target.value)}
                defaultValue={_stage.name}
                placeholder={'Stage Name'}
                onFocus={(e) => e.target.select()}
                title={name}
              />
            </Col>
            <Col flex="none">
              <Button type="text" icon={<SaveOutlined />} onClick={saveAndReturn}>
                Save
              </Button>
            </Col>
          </Row>
        </Header>
        <Content className="stage-body">
          <Collapse items={positionsCollapsed} defaultActiveKey={['2']} />
        </Content>
      </Layout>
    </ConfigProvider>
  )
}

export default Editor;
