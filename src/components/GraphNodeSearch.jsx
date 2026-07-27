import { useMemo, useState } from 'react';
import { AutoComplete, Input, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { cleanStageName, poseFamily } from '../scene/stageFamily';
import { stageOstimFolder } from '../scene/graphFocus';

/**
 * Simple fuzzy score: subsequence + substring bonus.
 */
export function fuzzyScore(query, text) {
  const q = String(query || '').trim().toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;
  if (t.includes(q)) return 600;
  let ti = 0;
  let score = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    score += 10 - Math.min(9, found - ti);
    ti = found + 1;
  }
  return score + Math.max(0, 40 - (t.length - q.length));
}

/**
 * Fuzzy jump-to-node for large graphs.
 */
export default function GraphNodeSearch({
  stages = [],
  onJump,
  style,
  placeholder = 'Jump to stage…',
}) {
  const [value, setValue] = useState('');

  const options = useMemo(() => {
    const q = value.trim();
    if (!q) return [];
    const scored = [];
    for (const stage of stages) {
      if (!stage?.id) continue;
      const name = stage.name || '';
      const clean = cleanStageName(name);
      const fam = poseFamily(name);
      const folder = stageOstimFolder(stage);
      const oid =
        (stage.tags || []).find((t) => String(t).startsWith('ostim_id:'))?.slice(9) ||
        '';
      const s = Math.max(
        fuzzyScore(q, clean),
        fuzzyScore(q, name),
        fuzzyScore(q, stage.id),
        fuzzyScore(q, fam),
        fuzzyScore(q, folder),
        fuzzyScore(q, oid)
      );
      if (s <= 0) continue;
      scored.push({
        value: stage.id,
        score: s,
        label: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <Typography.Text ellipsis style={{ maxWidth: 280 }}>
              {clean || name || stage.id}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {[fam, folder && `folder:${folder}`, oid].filter(Boolean).join(' · ')}
            </Typography.Text>
          </div>
        ),
      });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ value: v, label }) => ({ value: v, label }));
  }, [stages, value]);

  return (
    <AutoComplete
      size="small"
      value={value}
      options={options}
      style={{ width: 220, ...style }}
      onSearch={setValue}
      onChange={setValue}
      onSelect={(id) => {
        onJump?.(id);
        setValue('');
      }}
      allowClear
      popupMatchSelectWidth={320}
    >
      <Input
        size="small"
        prefix={<SearchOutlined style={{ opacity: 0.45 }} />}
        placeholder={placeholder}
        allowClear
      />
    </AutoComplete>
  );
}
