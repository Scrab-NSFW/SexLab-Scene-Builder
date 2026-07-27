/**
 * Visual-only edge ranking for browse layout.
 * Never exported to OStim/SLSB — derived from nav_text, names, and families.
 *
 * nav_text format (from OStim import): `prio:ostimDest:desc[:icon:border];...`
 */

import { destStage } from '../common/destRef';
import {
  buildFamilyMap,
  cleanStageName,
  isHubName,
  isTransitionStage,
} from './stageFamily';

/** Score below this → secondary (returns, reverse, weak cross-links). */
export const SECONDARY_SCORE_CUTOFF = 0;

/**
 * @param {string} navText
 * @returns {Array<{ dest: string, priority: number, description: string, icon: string, border: string }>}
 */
function splitn(str, sep, n) {
  const parts = [];
  let rest = String(str);
  for (let i = 0; i < n - 1; i++) {
    const idx = rest.indexOf(sep);
    if (idx < 0) break;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  parts.push(rest);
  return parts;
}

export function parseNavText(navText) {
  const out = [];
  const text = String(navText || '').trim();
  if (!text) return out;
  for (const part of text.split(';')) {
    // Match Rust: prio:dest:desc[:icon:border]
    const bits = splitn(part.trim(), ':', 5);
    if (bits.length < 2) continue;
    const priority = Number.parseInt(bits[0], 10);
    const dest = bits[1];
    if (!dest) continue;
    out.push({
      dest,
      priority: Number.isFinite(priority) ? priority : 0,
      description: bits[2] ?? '',
      icon: bits[3] ?? '',
      border: bits[4] ?? '',
    });
  }
  return out;
}

/**
 * @param {{ tags?: string[], id?: string }} stage
 * @returns {string|null}
 */
export function stageOstimId(stage) {
  if (!stage) return null;
  const tag = (stage.tags || []).find((t) => String(t).startsWith('ostim_id:'));
  if (tag) return tag.slice('ostim_id:'.length);
  return null;
}

/**
 * Build lookup: ostimId → stageId, and stageId → stage.
 * @param {Array<{ id: string, tags?: string[], extra?: { nav_text?: string }, name?: string }>} stages
 */
export function buildStageLookups(stages = []) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  /** @type {Map<string, string>} */
  const ostimToStage = new Map();
  for (const stage of stages) {
    if (!stage?.id) continue;
    byId.set(stage.id, stage);
    const oid = stageOstimId(stage);
    if (oid) ostimToStage.set(oid, stage.id);
  }
  return { byId, ostimToStage };
}

/**
 * Resolve nav meta for edge source→target (stage ids).
 * Matches nav dest (ostim id) from ostim_nav tags or legacy nav_text.
 */
export function navMetaForEdge(sourceStage, targetStage, ostimToStage) {
  if (!sourceStage) return null;
  const entries = navEntriesForStage(sourceStage);
  if (!entries.length) return null;
  const targetOid = stageOstimId(targetStage);
  const targetId = targetStage?.id;
  for (const entry of entries) {
    if (targetOid && entry.dest === targetOid) return entry;
    if (ostimToStage?.get(entry.dest) === targetId) return entry;
    // Fallback: dest accidentally stored as stage id
    if (entry.dest === targetId) return entry;
  }
  return null;
}

/** @param {{ tags?: string[], extra?: { nav_text?: string } }} stage */
export function navEntriesForStage(stage) {
  const fromTags = [];
  for (const tag of stage?.tags || []) {
    const s = String(tag);
    if (s.startsWith('ostim_nav:')) {
      fromTags.push(...parseNavText(s.slice('ostim_nav:'.length)));
    }
  }
  if (fromTags.length) return fromTags;
  return parseNavText(stage?.extra?.nav_text);
}

function looksLikeReturn(meta, sourceName, targetName) {
  if (meta) {
    if (meta.priority <= -999) return true;
    if (/return/i.test(meta.icon || '')) return true;
    if (/^\s*return\b/i.test(meta.description || '')) return true;
  }
  const src = cleanStageName(sourceName);
  const tgt = cleanStageName(targetName);
  if (/\bRev(erse)?\b/i.test(src) && isTransitionStage(sourceName)) return true;
  if (/\bReturn\b/i.test(src) || /\bReturn\b/i.test(tgt)) return true;
  if (/\bPost-?Climax\b/i.test(src) && /\bIdle\b/i.test(tgt)) return true;
  return false;
}

/**
 * Score one directed edge. Higher = more suitable as a browse/layout primary.
 *
 * @param {object} opts
 * @param {string} opts.source
 * @param {string} opts.target
 * @param {Map<string,string>} opts.families
 * @param {(id: string) => string} opts.getName
 * @param {object|null} [opts.meta]
 * @param {boolean} [opts.mutual] — A↔B pair exists
 */
export function scoreEdge({
  source,
  target,
  families,
  getName,
  meta = null,
  mutual = false,
  stageById = null,
}) {
  const sourceName = getName(source) || source;
  const targetName = getName(target) || target;
  const srcStage = stageById?.get(source);
  const tgtStage = stageById?.get(target);
  let score = 50;

  if (looksLikeReturn(meta, sourceName, targetName)) {
    score -= 1000;
  }

  const sf = families.get(source);
  const tf = families.get(target);
  if (sf && tf && sf === tf) score += 200;
  else score -= 120;

  if (meta) {
    if (meta.priority >= 3000) score += 160;
    else if (meta.priority >= 2000) score += 120;
    else if (meta.priority >= 1000) score += 80;
    else if (meta.priority > 0) score += 40;
    else if (meta.priority < 0 && meta.priority > -999) score -= 80;
  }

  // Intensity / numbered progression within a family
  const num = (n) => {
    const m = cleanStageName(n).match(/\b(\d+)\s*$/);
    return m ? Number(m[1]) : null;
  };
  const sn = num(sourceName);
  const tn = num(targetName);
  if (sn != null && tn != null && tn === sn + 1 && sf === tf) score += 100;
  if (sn != null && tn != null && tn < sn && sf === tf) score -= 80;

  if (isTransitionStage(tgtStage || targetName)) score += 25;
  if (
    isTransitionStage(srcStage || sourceName) &&
    !isTransitionStage(tgtStage || targetName)
  ) {
    score += 40;
  }

  if (isHubName(sourceName) && !isHubName(targetName)) score += 30;
  if (!isHubName(sourceName) && isHubName(targetName) && !looksLikeReturn(meta, sourceName, targetName)) {
    score -= 40;
  }

  if (mutual && looksLikeReturn(meta, sourceName, targetName)) score -= 50;

  return score;
}

/**
 * Rank every graph edge primary | secondary.
 *
 * @returns {{
 *   edgeInfo: Map<string, { source: string, target: string, score: number, rank: 'primary'|'secondary', meta: object|null, kind: string }>,
 *   families: Map<string,string>,
 * }}
 */
export function rankGraphEdges(sceneGraph, nodeIds, { getName, stages = [] } = {}) {
  const ids = nodeIds?.length ? nodeIds : Object.keys(sceneGraph || {});
  const idSet = new Set(ids);
  const nameOf = getName || ((id) => id);
  const families = buildFamilyMap(ids, nameOf);
  const { byId, ostimToStage } = buildStageLookups(stages);

  const pairSet = new Set();
  for (const source of ids) {
    for (const target of (sceneGraph[source]?.dest || []).map(destStage)) {
      if (idSet.has(target)) pairSet.add(`${source}\0${target}`);
    }
  }

  /** @type {Map<string, { source: string, target: string, score: number, rank: 'primary'|'secondary', meta: object|null, kind: string }>} */
  const edgeInfo = new Map();

  for (const source of ids) {
    const dests = (sceneGraph[source]?.dest || []).map(destStage).filter((d) => idSet.has(d));
    for (const target of dests) {
      const key = `${source}\0${target}`;
      const mutual = pairSet.has(`${target}\0${source}`);
      const meta = navMetaForEdge(byId.get(source), byId.get(target), ostimToStage);
      const score = scoreEdge({
        source,
        target,
        families,
        getName: nameOf,
        meta,
        mutual,
        stageById: byId,
      });
      const sf = families.get(source);
      const tf = families.get(target);
      let kind = 'forward';
      if (score < SECONDARY_SCORE_CUTOFF) kind = 'back';
      else if (sf && tf && sf !== tf) kind = 'cross';
      else if (mutual) kind = 'cycle';

      edgeInfo.set(key, {
        source,
        target,
        score,
        rank: score >= SECONDARY_SCORE_CUTOFF ? 'primary' : 'secondary',
        meta,
        kind,
      });
    }
  }

  for (const [key, info] of edgeInfo) {
    const revKey = `${info.target}\0${info.source}`;
    const rev = edgeInfo.get(revKey);
    if (!rev) continue;
    if (info.rank === 'primary' && rev.rank === 'primary') {
      if (info.score < rev.score) {
        info.rank = 'secondary';
        info.kind = 'back';
      } else if (rev.score < info.score) {
        rev.rank = 'secondary';
        rev.kind = 'back';
      } else if (info.source > info.target) {
        info.rank = 'secondary';
        info.kind = 'back';
      }
    }
  }

  return { edgeInfo, families };
}

/**
 * Keys of edges classified primary.
 * @param {Map<string, { rank: string }>} edgeInfo
 */
export function primaryEdgeKeys(edgeInfo) {
  const keys = new Set();
  for (const [key, info] of edgeInfo) {
    if (info.rank === 'primary') keys.add(key);
  }
  return keys;
}
