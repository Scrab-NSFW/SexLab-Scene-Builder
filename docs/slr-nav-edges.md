# .slr v5 navigation edges + DestRef + sosBend

**Status:** Implemented in SLSB + SexLab++  
**Package version:** `5` (v≤4 still load; missing fields use defaults)

## Position (v5)

After existing v4 fields (`event`, `climax`, `offset`, `strips`, `tags`):

| Field | Encoding | Meaning |
|-------|----------|---------|
| `sosBend` | `i8` | SoS bend −9…9 (`0` = neutral). From SLSB `Position.schlong`. |

Legacy ≤4: bend = `0`. The discarded v3 leftover `i8` is **not** treated as bend.

## Graph vertex (v5)

1. Vertex stage id (8 bytes)
2. `u64` edge count
3. For each edge, in order:

| Field | Encoding | Meaning |
|-------|----------|---------|
| `sceneId` | 8 ASCII | Absolute destination scene (same-scene edges write **this** scene’s id) |
| `stageId` | 8 ASCII | Destination stage |
| `priority` | `i32` big-endian | OStim-style nav priority |
| `flags` | `u8` | bit0 = `secondary` (Return / reverse); other bits reserved |
| `label` | `u64` length + UTF-8 | Player-facing branch label |

Legacy v≤4: dest = stage id only (same scene); `priority = 0`, `flags = 0`, `label =` target `navtext`.

## SexLabRegistry Papyrus (nav UI)

| Function | Returns |
|----------|---------|
| `GetNumBranches(id, stage)` | Outgoing edge count |
| `BranchTo(id, stage, n)` | Destination **stage** id |
| `GetBranchScene(id, stage, n)` | Destination **scene** id |
| `GetBranchPriority` / `GetBranchFlags` / `GetBranchLabel` | Edge meta |
| `GetSchlong(id, stage, n)` | Position `sosBend` for actor slot `n` |

**Nav UI contract**

1. `GetNumBranches` for the active stage.
2. Build `{ n, label, priority, flags, sceneId, stageId }`.
3. Sort by `priority` descending (dim secondary when `flags & 1`).
4. On pick: if `sceneId` ≠ active scene → `ResetScene(sceneId)` then start `stageId`; else advance within scene.

## Auto-advance

`SelectNextAdjacentIndex`:

- Skip unresolved edges (missing pack / bind failure).
- Prefer **same-scene** edges when any exist.
- Prefer non-secondary, then highest priority; tag weights within that set.

## Load / bind (SexLab++)

Decode stores string ids without requiring the target in the current scene. After all `.slr` packages load, `Library::BindGraphEdges` resolves pointers. Unresolved edges stay null and are skipped at play time.

## SLSB authoring

- Project JSON: `dest[]` is `{ scene, stage }` (`DestRef`); legacy string stage ids migrate on load.
- OStim import: in-component edges are local DestRefs; in-project cross-component `ostim_nav` targets become cross-scene DestRefs; true external hubs stay tags.
- Looping poses: `fixed_len = 0`. Parallel `edges[]` for priority / flags / label.
