import { useMemo } from 'react';
import { Button, Empty, List, Typography } from 'antd';
import { destScene, destStage } from '../common/destRef';

/**
 * Outbound DestRefs leaving the active scene (cross-scene / cross-pack).
 */
export default function OutboundLinksPanel({
  scene,
  sceneCatalog = [],
  onOpenStage,
}) {
  const rows = useMemo(() => {
    if (!scene?.graph || !scene?.id) return [];
    const nameByScene = new Map(
      (sceneCatalog || []).map((s) => [s.id, s.name || s.id])
    );
    const stageName = (sceneId, stageId) => {
      const sc =
        sceneId === scene.id
          ? scene
          : (sceneCatalog || []).find((s) => s.id === sceneId);
      return sc?.stages?.find((st) => st.id === stageId)?.name || stageId;
    };
    const out = [];
    for (const [fromId, node] of Object.entries(scene.graph)) {
      for (const d of node?.dest || []) {
        const toScene = destScene(d, scene.id);
        if (!toScene || toScene === scene.id) continue;
        const toStage = destStage(d);
        const fromStage = scene.stages?.find((s) => s.id === fromId);
        out.push({
          key: `${fromId}->${toScene}:${toStage}`,
          fromId,
          fromName: fromStage?.name || fromId,
          toScene,
          toSceneName: nameByScene.get(toScene) || toScene,
          toStage,
          toStageName: stageName(toScene, toStage),
        });
      }
    }
    out.sort((a, b) => a.fromName.localeCompare(b.fromName));
    return out;
  }, [scene, sceneCatalog]);

  if (!scene) return null;

  return (
    <div className="outbound-links-panel">
      <Typography.Text strong style={{ fontSize: 12 }}>
        Outbound links
      </Typography.Text>
      <Typography.Paragraph
        type="secondary"
        style={{ fontSize: 11, marginBottom: 8 }}
      >
        Cross-scene DestRefs from this scene. Edit in the stage editor → Links.
      </Typography.Paragraph>
      {rows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No cross-scene links"
          style={{ margin: '8px 0' }}
        />
      ) : (
        <List
          size="small"
          dataSource={rows}
          renderItem={(item) => (
            <List.Item
              style={{ padding: '4px 0' }}
              actions={[
                <Button
                  key="open"
                  type="link"
                  size="small"
                  onClick={() => onOpenStage?.(item.fromId)}
                >
                  Edit
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <span style={{ fontSize: 12 }}>
                    {item.fromName} → {item.toSceneName}
                  </span>
                }
                description={
                  <span className="mono-id" style={{ fontSize: 11 }}>
                    {item.toStageName} ({item.toStage})
                  </span>
                }
              />
            </List.Item>
          )}
        />
      )}
    </div>
  );
}

/** Count DestRefs that leave any scene in the pack. */
export function countCrossSceneLinks(scenes = []) {
  let n = 0;
  for (const scene of scenes) {
    const sid = scene?.id;
    if (!sid || !scene.graph) continue;
    for (const node of Object.values(scene.graph)) {
      for (const d of node?.dest || []) {
        const toScene = destScene(d, sid);
        if (toScene && toScene !== sid) n += 1;
      }
    }
  }
  return n;
}

export function projectLooksLikeOstim(scenes = []) {
  return scenes.some((s) =>
    (s.tags || [])
      .concat(...(s.stages || []).map((st) => st.tags || []))
      .some((t) => String(t).startsWith('ostim_'))
  );
}
