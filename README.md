# SexLab Scene Builder

An UI build with Tauri to create .SLSB files which are used by [SexLab P+](https://github.com/Scrabx3/SexLabpp) to read animation data.

## OStim import: scene grouping

OStim packs are many JSON nodes linked by `navigations` / `destination`. On import, SLSB builds the navigation graph and partitions by **folder-scoped** weakly connected components: only edges whose endpoints share the same `scenes/<folder>/` keep nodes in one editor `Scene`. Cross-folder links become absolute DestRef graph edges (`.slr` v5) so play and export stay intact.

If a cross-folder edge joins nodes with incompatible casts (different actor count / intendedSex), those folder components are **merged** so a scene’s shared `PositionInfo` stays valid.

| Concept | Meaning |
|--------|---------|
| Folder-scoped scene | One SLSB scene per disk-folder connected component (after cast merges) |
| DestRef `(sceneId, stageId)` | Cross-scene / cross-folder hop in the stage graph |
| `ostim_folder:` on a stage | Disk folder; still used for export paths and optional in-scene folder canvas |
| Canvas folder view | Editor subset when a scene still spans multiple folders (rare after import) |
| Vanilla / missing hubs | Stay as `ostim_nav*` tags until a matching scene exists in the project |

## OStim pack folders (authoring)

On disk, packs look like `SKSE/Plugins/OStim/scenes/<Folder>/pose.json`. Prefer per-stage `ostim_folder:` (stage editor or **Set folder** on the canvas). **+ Folder** / canvas Select still work when a scene spans multiple folders. A scene-level `ostim_folder:` tag is only an export fallback when a stage has none.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
