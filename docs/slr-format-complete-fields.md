# New `.slr` format: complete position fields + `sosBend`

**Status:** Accepted for `.slr` v5 (Path 1)  
**Audience:** SLSB / SexLab++ maintainers  

v5 Position records carry **`sosBend`** so SoS bend survives Registry load. Cross-scene / cross-pack graph edges (`DestRef`) ship in the **same** v5 bump — see [slr-nav-edges.md](slr-nav-edges.md).

---

## Accepted layout (Path 1)

Binary Position v5 = v4 fields + `i8 sosBend` after tags:

`event` → `climax` → `offset` → `strips` → `tags` → **`sosBend`**

| Field | Notes |
|-------|--------|
| **`sosBend` (`i8`)** | −9…9; SLSB `Position.schlong`, SLAL `sos`, OStim `sosBend` |
| Other extras (`add_cum`, mouth, …) | Deferred (Path 2) — not in v5 |

SexLab++: read when `version >= 5`; apply `SOSBend{n}` on stage enter / change. Legacy ≤4 → bend `0`.

Historical note: v3 read a discarded `int8` after strips; that byte is **not** migrated to `sosBend`.

---

## Field inventory

### In v5 `.slr` Position

`event` (first only) · `climax` · `offset` · `strips` · `tags` · **`sosBend`**

### Still JSON-only (for now)

`anim_obj`, full `event[]`, `add_cum`, `open_mouth`, `silent`, `strap_on`, OStim-only look/expression/equip fields.

---

## Considerations (locked)

1. Wire name conceptually `sosBend`; SLSB field remains `schlong`.
2. Clamp −9…9 on write; `0` = unset / neutral.
3. SLP+ applies bend via `SOSBend{n}` animation events (same as today’s hard-coded `SOSBend0`).
4. Creatures / non-SoS: write `0`; runtime may no-op.

Path 2 / TLV extensibility remain out of scope until maintainers want another bump.
