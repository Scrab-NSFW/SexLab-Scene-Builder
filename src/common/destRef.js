/**
 * Dest may be a legacy stage-id string or `{ scene, stage }`.
 */

export function destStage(d) {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  return d.stage || '';
}

export function destScene(d, fallbackSceneId = '') {
  if (d == null) return fallbackSceneId || '';
  if (typeof d === 'string') return fallbackSceneId || '';
  return d.scene || fallbackSceneId || '';
}

export function makeDest(sceneId, stageId) {
  return { scene: sceneId || '', stage: stageId || '' };
}

export function destEquals(a, b, fallbackSceneId = '') {
  return (
    destStage(a) === destStage(b) &&
    destScene(a, fallbackSceneId) === destScene(b, fallbackSceneId)
  );
}

export function destListIncludes(list, stageId, sceneId = '') {
  return (list || []).some((d) => {
    if (destStage(d) !== stageId) return false;
    if (!sceneId) return true;
    const ds = destScene(d, sceneId);
    return !ds || ds === sceneId;
  });
}

/** Normalize a dest entry to absolute DestRef using the owning scene id. */
export function normalizeDest(d, owningSceneId) {
  return makeDest(destScene(d, owningSceneId), destStage(d));
}

export function normalizeNodeDests(node, owningSceneId) {
  if (!node) return { dest: [], x: 40, y: 40 };
  return {
    ...node,
    dest: (node.dest || []).map((d) => normalizeDest(d, owningSceneId)),
  };
}
