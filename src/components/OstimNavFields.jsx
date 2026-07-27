import { useMemo, useState } from 'react';
import {
  Card,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
  Tooltip,
  Button,
  Empty,
} from 'antd';
import { DeleteOutlined, SwapOutlined } from '@ant-design/icons';
import { ostimIconSelectOptions } from '../common/ostimIcons';
import { suggestAssetOptions, rememberAssetValues } from '../common/assetLibrary';

/**
 * Per-destination OStim navigation metadata (description, priority, icon, border).
 * Writes `ostim_nav:{prio}:{dest}:{desc}:{icon}:{border}` tags via onChange.
 */
export default function OstimNavFields({
  rows = [],
  onChange,
  assetLibrary,
  stages = [],
  onRemove,
  onRetarget,
  onAddReturn,
}) {
  const [iconSearch, setIconSearch] = useState({});
  const iconOptions = useMemo(() => {
    const vanilla = ostimIconSelectOptions();
    const fromLib = suggestAssetOptions(assetLibrary, 'icons').map((value) => ({
      value,
      label: value,
    }));
    const seen = new Set(vanilla.map((o) => String(o.value).toLowerCase()));
    const extra = fromLib.filter((o) => !seen.has(String(o.value).toLowerCase()));
    return [...extra, ...vanilla];
  }, [assetLibrary]);

  const stageOptions = useMemo(
    () =>
      (stages || []).map((s) => ({
        value: s.id,
        label: s.name || s.id,
      })),
    [stages]
  );

  const patchRow = (index, patch) => {
    const next = rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
    onChange?.(next);
  };

  if (!rows.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Link this stage to others on the graph to edit OStim icons and priorities."
        style={{ margin: '12px 0' }}
      />
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {rows.map((row, i) => (
        <Card
          key={`${row.dest}-${row.stageId || 'ext'}-${i}`}
          size="small"
          title={
            <Space size={8} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
              <Space size={8} wrap>
                <Typography.Text strong>{row.label || row.dest}</Typography.Text>
                {row.external ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    (external)
                  </Typography.Text>
                ) : null}
              </Space>
              <Space size={4}>
                {onAddReturn && row.stageId && !row.external ? (
                  <Tooltip title="Add return link from destination back to this stage">
                    <Button
                      type="text"
                      size="small"
                      icon={<SwapOutlined />}
                      onClick={() => onAddReturn(i, row)}
                    />
                  </Tooltip>
                ) : null}
                {onRemove ? (
                  <Tooltip title="Remove this navigation">
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => onRemove(i, row)}
                    />
                  </Tooltip>
                ) : null}
              </Space>
            </Space>
          }
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                OStim ID (JSON filename)
              </Typography.Text>
              {row.external || !row.stageId ? (
                <Input
                  value={row.dest || ''}
                  placeholder="Destination OStim id"
                  onChange={(e) => {
                    const dest = e.target.value.replace(/:/g, '_').trim();
                    if (onRetarget) onRetarget(i, { ...row, dest, external: true });
                    else patchRow(i, { dest, label: dest || row.label });
                  }}
                />
              ) : (
                <Select
                  style={{ width: '100%' }}
                  showSearch
                  value={row.stageId || undefined}
                  options={stageOptions}
                  optionFilterProp="label"
                              onChange={(stageId) => {
                    const st = (stages || []).find((s) => s.id === stageId);
                    const dest =
                      st?.ostim_id ||
                      (st?.tags || [])
                        .find((t) => String(t).startsWith('ostim_id:'))
                        ?.slice('ostim_id:'.length) ||
                      stageId;
                    if (onRetarget) {
                      onRetarget(i, {
                        ...row,
                        stageId,
                        dest,
                        label: st?.name || dest,
                        external: false,
                      });
                    } else {
                      patchRow(i, {
                        stageId,
                        dest,
                        label: st?.name || dest,
                      });
                    }
                  }}
                />
              )}
              <Typography.Text
                type="secondary"
                copyable={row.dest ? { text: row.dest } : false}
                style={{ fontSize: 11 }}
              >
                {row.dest || '—'}
              </Typography.Text>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Description
              </Typography.Text>
              <Input
                value={row.description || ''}
                maxLength={80}
                placeholder="Player-facing label (e.g. Kiss)"
                onChange={(e) =>
                  patchRow(i, {
                    description: e.target.value.replace(/:/g, ' '),
                  })
                }
              />
            </div>
            <Space wrap style={{ width: '100%' }} size={12}>
              <div style={{ minWidth: 120 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Priority
                </Typography.Text>
                <InputNumber
                  style={{ width: '100%' }}
                  value={row.priority}
                  step={100}
                  onChange={(v) =>
                    patchRow(i, {
                      priority: Number.isFinite(v) ? v : 1000,
                    })
                  }
                />
              </div>
              <div style={{ minWidth: 140, flex: 1 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Border (hex)
                </Typography.Text>
                <Input
                  value={row.border || ''}
                  placeholder="e.g. ff6699"
                  maxLength={8}
                  onChange={(e) =>
                    patchRow(i, {
                      border: e.target.value.replace(/^#/, '').replace(/:/g, ''),
                    })
                  }
                  addonBefore="#"
                />
              </div>
            </Space>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Icon{' '}
                <Tooltip title="Path under Interface/OStim/icons/ (without .dds). Pick a vanilla icon or type a custom pack path.">
                  <Button type="link" size="small" style={{ padding: 0 }}>
                    ?
                  </Button>
                </Tooltip>
              </Typography.Text>
              <Select
                showSearch
                allowClear
                style={{ width: '100%' }}
                placeholder="OStim/…"
                value={row.icon || undefined}
                options={iconOptions}
                searchValue={iconSearch[i] || ''}
                onSearch={(v) => setIconSearch((prev) => ({ ...prev, [i]: v }))}
                onChange={(v) => {
                  setIconSearch((prev) => ({ ...prev, [i]: '' }));
                  if (v) rememberAssetValues('icons', v);
                  patchRow(i, { icon: v || '' });
                }}
                filterOption={(input, option) => {
                  const q = String(input || '').toLowerCase();
                  if (!q) return true;
                  const val = String(option?.value || '').toLowerCase();
                  const lab = String(option?.label || '').toLowerCase();
                  return val.includes(q) || lab.includes(q);
                }}
                popupMatchSelectWidth={false}
                notFoundContent={
                  (iconSearch[i] || '').trim() ? (
                    <Button
                      type="link"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        const v = (iconSearch[i] || '').trim();
                        setIconSearch((prev) => ({ ...prev, [i]: '' }));
                        rememberAssetValues('icons', v);
                        patchRow(i, { icon: v });
                      }}
                    >
                      Use custom “{(iconSearch[i] || '').trim()}”
                    </Button>
                  ) : (
                    'No icons'
                  )
                }
              />
            </div>
          </Space>
        </Card>
      ))}
    </Space>
  );
}
