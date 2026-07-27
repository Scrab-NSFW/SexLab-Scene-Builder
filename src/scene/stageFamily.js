/**
 * Pose-family helpers for clustered graph layout / filtering.
 * Names look like: "Lovemaking: Reverse Embrace Idle|pb:1|ds:1"
 * or transitions: "Lovemaking: Go to Squatting Handjob|pb:1|ds:1"
 */

const MULTI_WORD_FAMILIES = [
  ['Reverse', 'Embrace'],
  ['Mating', 'Press'],
  ['Standing', 'Embrace'],
];

const SINGLE_WORD_FAMILIES = new Set([
  'Squatting',
  'Kneeling',
  'Standing',
  'Sitting',
  'Straddling',
  'Missionary',
  'Cowgirl',
  'Cuddling',
  'Devour',
  'Lying',
  'Prone',
  'Doggy',
]);

/** Abbreviation tokens used in "Go to RE …" style transition names. */
const FAMILY_ALIASES = {
  RE: 'Reverse Embrace',
  MP: 'Mating Press',
  SE: 'Standing Embrace',
};

/**
 * Strip pack prefix and playback tags from a stage display name.
 * Preserves a trailing `[disambiguator]` used for duplicate OStim titles.
 * @param {string} name
 * @returns {string}
 */
export function cleanStageName(name) {
  let n = String(name || '');
  const disambigMatch = n.match(/\s*\[[^\]]+\]\s*$/);
  const disambig = disambigMatch ? disambigMatch[0].trim() : '';
  if (disambigMatch) n = n.slice(0, -disambigMatch[0].length);
  n = n.replace(/^[^:]+:\s*/, ''); // "Lovemaking: " or similar pack prefix
  n = n.replace(/\|pb:.*$/i, '');
  n = n.trim();
  return disambig ? `${n} ${disambig}` : n;
}

/**
 * Resolve a pose family label from a cleaned stage name (no pack/pb tags).
 * @param {string} cleaned
 * @returns {string}
 */
export function familyFromCleanName(cleaned) {
  const n = String(cleaned || '').trim();
  if (!n) return 'Other';

  const goTo = n.match(/^Go to\s+(.+)$/i);
  if (goTo) {
    return familyFromCleanName(goTo[1]);
  }

  const parts = n.replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Other';

  const alias = FAMILY_ALIASES[parts[0].toUpperCase()];
  if (alias) return alias;

  for (const words of MULTI_WORD_FAMILIES) {
    if (
      parts.length >= words.length &&
      words.every((w, i) => parts[i].toLowerCase() === w.toLowerCase())
    ) {
      return words.join(' ');
    }
  }

  // "Reverse Foo" without Embrace → still Reverse Embrace if second token looks related
  if (parts[0] === 'Reverse' && parts[1] && parts[1] !== 'Embrace') {
    return 'Reverse Embrace';
  }

  if (SINGLE_WORD_FAMILIES.has(parts[0])) {
    return parts[0];
  }

  return parts[0] || 'Other';
}

/**
 * @param {string} stageName
 * @returns {string} family label
 */
export function poseFamily(stageName) {
  return familyFromCleanName(cleanStageName(stageName));
}

/** @param {object|string} stageOrName */
export function isTransitionStage(stageOrName) {
  if (stageOrName && typeof stageOrName === 'object') {
    const tags = stageOrName.tags || [];
    if (
      tags.some(
        (t) =>
          String(t).toLowerCase() === 'transition' ||
          /^ostim_dest:/i.test(String(t))
      )
    ) {
      return true;
    }
    return /^Go to\s+/i.test(cleanStageName(stageOrName.name || ''));
  }
  return /^Go to\s+/i.test(cleanStageName(stageOrName));
}

/**
 * Disambiguate duplicate stage titles in-place (common in OStim transitions).
 * Returns true if any name changed.
 */
export function disambiguateDuplicateStageNames(stages = []) {
  const byName = new Map();
  for (const s of stages) {
    if (!s) continue;
    const n = s.name || '';
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(s);
  }
  let changed = false;
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    for (const s of list) {
      const tags = s.tags || [];
      const dest = tags.find((t) => /^ostim_dest:/i.test(String(t)));
      const oid = tags.find((t) => /^ostim_id:/i.test(String(t)));
      let suf = '';
      if (dest) suf = String(dest).replace(/^ostim_dest:/i, '');
      else if (oid) suf = String(oid).replace(/^ostim_id:/i, '');
      else suf = String(s.id || '').slice(0, 8);
      if (!suf) continue;
      const bracket = `[${suf}]`;
      if (s.name.includes(bracket)) continue;
      // Insert before |pb: tags so cleanStageName can keep the suffix.
      if (/\|pb:/i.test(s.name)) {
        s.name = s.name.replace(/(\|pb:)/i, ` ${bracket}$1`);
      } else {
        s.name = `${s.name} ${bracket}`;
      }
      changed = true;
    }
  }
  return changed;
}

/**
 * Label helper for a single stage (reads already-disambiguated names, or
 * computes a suffix when duplicates are still present).
 */
export function uniqueStageLabel(stage, stages = []) {
  const name = stage?.name || '';
  if (!name || !stages?.length) return name || 'Untitled';
  const same = stages.filter((s) => s?.name === name);
  if (same.length < 2) return name;
  const tags = stage.tags || [];
  const dest = tags.find((t) => /^ostim_dest:/i.test(String(t)));
  const oid = tags.find((t) => /^ostim_id:/i.test(String(t)));
  const suf = dest
    ? String(dest).replace(/^ostim_dest:/i, '')
    : oid
      ? String(oid).replace(/^ostim_id:/i, '')
      : String(stage.id || '').slice(0, 8);
  if (!suf) return name;
  const bracket = `[${suf}]`;
  if (name.includes(bracket)) return name;
  if (/\|pb:/i.test(name)) {
    return name.replace(/(\|pb:)/i, ` ${bracket}$1`);
  }
  return `${name} ${bracket}`;
}

/**
 * Prefer idle / hub naming when ranking candidates.
 * @param {string} stageName
 */
export function isHubName(stageName) {
  const n = cleanStageName(stageName);
  return /\bIdle\b/i.test(n) || /\bEmbrace\b/i.test(n) && !isTransitionStage(stageName);
}

/**
 * Map nodeId → family using a name getter.
 * @param {string[]} nodeIds
 * @param {(id: string) => string} getName
 * @returns {Map<string, string>}
 */
export function buildFamilyMap(nodeIds, getName) {
  const map = new Map();
  for (const id of nodeIds) {
    map.set(id, poseFamily(getName(id) || id));
  }
  return map;
}

export const LARGE_SCENE_NODE_THRESHOLD = 40;
