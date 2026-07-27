import React, { useMemo, useState } from 'react';
import { Button, Input, Select, Space, Typography } from 'antd';
import { makeDest, destScene, destStage } from '../common/destRef';

/** Absolute DestRef edges to other scenes / packs (Extra tab). */
export default function CrossSceneLinkFields({
  scene,
  stageId,
  allScenes = [],
  onChangeGraph,
}) {
  const [targetSceneId, setTargetSceneId] = useState('');
  const [targetStageId, setTargetStageId] = useState('');
  const [manualScene, setManualScene] = useState('');
  const [manualStage, setManualStage] = useState('');

  const otherScenes = useMemo(
    () => (allScenes || []).filter((s) => s.id && s.id !== scene?.id),
    [allScenes, scene?.id]
  );

  const targetStages = useMemo(() => {
    const s = otherScenes.find((x) => x.id === targetSceneId);
    return s?.stages || [];
  }, [otherScenes, targetSceneId]);

  const crossLinks = useMemo(() => {
    const node = scene?.graph?.[stageId];
    const own = scene?.id || '';
    return (node?.dest || []).filter((d) => {
      const sc = destScene(d, own);
      return sc && sc !== own;
    });
  }, [scene, stageId]);

  const addLink = (sc, st) => {
    if (!sc || !st || !scene?.id || !stageId || !onChangeGraph) return;
    const g = structuredClone(scene.graph || {});
    if (!g[stageId]) g[stageId] = { dest: [], x: 40, y: 40 };
    const dest = makeDest(sc, st);
    const exists = (g[stageId].dest || []).some(
      (d) => destStage(d) === st && destScene(d, scene.id) === sc
    );
    if (!exists) {
      g[stageId] = {
        ...g[stageId],
        dest: [...(g[stageId].dest || []), dest],
      };
      onChangeGraph(g);
    }
  };

  const removeLink = (sc, st) => {
    if (!onChangeGraph) return;
    const g = structuredClone(scene.graph || {});
    if (!g[stageId]) return;
    g[stageId] = {
      ...g[stageId],
      dest: (g[stageId].dest || []).filter(
        (d) => !(destStage(d) === st && destScene(d, scene.id) === sc)
      ),
    };
    onChangeGraph(g);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="small">
      <Typography.Text type="secondary">
        DestRef branch to another scene or pack (8-char ids). Same-scene links use the graph
        canvas.
      </Typography.Text>
      {crossLinks.length > 0 && (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          {crossLinks.map((d) => {
            const sc = destScene(d, scene.id);
            const st = destStage(d);
            return (
              <Space key={`${sc}:${st}`} wrap>
                <Typography.Text code>
                  {sc} → {st}
                </Typography.Text>
                <Button size="small" danger onClick={() => removeLink(sc, st)}>
                  Remove
                </Button>
              </Space>
            );
          })}
        </Space>
      )}
      {otherScenes.length > 0 && (
        <Space wrap>
          <Select
            style={{ minWidth: 180 }}
            placeholder="Scene"
            value={targetSceneId || undefined}
            options={otherScenes.map((s) => ({
              value: s.id,
              label: s.name || s.id,
            }))}
            onChange={(v) => {
              setTargetSceneId(v);
              setTargetStageId('');
            }}
            allowClear
          />
          <Select
            style={{ minWidth: 180 }}
            placeholder="Stage"
            value={targetStageId || undefined}
            options={targetStages.map((s) => ({
              value: s.id,
              label: s.name || s.id,
            }))}
            onChange={setTargetStageId}
            disabled={!targetSceneId}
            allowClear
          />
          <Button
            type="primary"
            disabled={!targetSceneId || !targetStageId}
            onClick={() => addLink(targetSceneId, targetStageId)}
          >
            Add
          </Button>
        </Space>
      )}
      <Space wrap>
        <Input
          style={{ width: 120 }}
          placeholder="Scene id"
          maxLength={8}
          value={manualScene}
          onChange={(e) => setManualScene(e.target.value)}
        />
        <Input
          style={{ width: 120 }}
          placeholder="Stage id"
          maxLength={8}
          value={manualStage}
          onChange={(e) => setManualStage(e.target.value)}
        />
        <Button
          disabled={manualScene.length !== 8 || manualStage.length !== 8}
          onClick={() => {
            addLink(manualScene, manualStage);
            setManualScene('');
            setManualStage('');
          }}
        >
          Add by id
        </Button>
      </Space>
    </Space>
  );
}
