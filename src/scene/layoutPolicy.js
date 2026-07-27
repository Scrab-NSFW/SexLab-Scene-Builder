/**
 * Editor layout coordinates policy (SLSB only — never OStim scene JSON).
 *
 * Layers:
 * 1. Packed positions — Node { x, y } in the SLSB scene graph. Captured into
 *    layoutSnapshotRef when a scene is opened. "Restore positions" snaps back here.
 * 2. Navigation layout — regenerable from the primary spanning forest
 *    ("Arrange navigation layout"). Marks the scene dirty so Store persists
 *    the new SLSB coords.
 * 3. Manual nudges — dragging nodes updates live positions; Store writes them
 *    to the SLSB graph. OStim export ignores x/y.
 *
 * OStim scene JSON has no authoring positions. Do not invent parent pointers
 * or layout fields in exported OStim files.
 */

export const LAYOUT_POLICY = {
  /** Snapshot at open → Restore positions */
  packedSnapshot: 'layoutSnapshotRef',
  /** Arrange button → spanning forest layout */
  navigationArrange: 'arrangeStages',
  /** Persist only via SLSB scene.graph Node.x/y */
  persistIn: 'slsb',
};
