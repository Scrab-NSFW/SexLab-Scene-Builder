import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Tabs,
  List,
  Button,
  Input,
  Space,
  Typography,
  Segmented,
  Popconfirm,
  Empty,
  Tag,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import {
  emptyAssetLibrary,
  loadGlobalAssetLibrary,
  normalizeAssetLibrary,
  saveGlobalAssetLibrary,
} from '../common/assetLibrary';

const KINDS = [
  { key: 'events', label: 'HKX / events' },
  { key: 'anim_objects', label: 'Anim objects' },
  { key: 'equip_objects', label: 'Equip objects' },
  { key: 'icons', label: 'Icons' },
];

/**
 * Browse / delete entries in the project library or global autocomplete history.
 */
export default function AssetLibraryModal({
  open,
  onClose,
  projectLibrary,
  onReplaceProject,
}) {
  const [scope, setScope] = useState('project'); // project | global
  const [kind, setKind] = useState('events');
  const [query, setQuery] = useState('');
  const [globalLib, setGlobalLib] = useState(() => loadGlobalAssetLibrary());
  const [draftProject, setDraftProject] = useState(() =>
    normalizeAssetLibrary(projectLibrary)
  );

  useEffect(() => {
    if (!open) return;
    setGlobalLib(loadGlobalAssetLibrary());
    setDraftProject(normalizeAssetLibrary(projectLibrary));
    setQuery('');
  }, [open, projectLibrary]);

  const activeLib = scope === 'project' ? draftProject : globalLib;
  const items = activeLib?.[kind] || [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((v) => String(v).toLowerCase().includes(q));
  }, [items, query]);

  const commitProject = (next) => {
    const normalized = normalizeAssetLibrary(next);
    setDraftProject(normalized);
    onReplaceProject?.(normalized);
  };

  const commitGlobal = (next) => {
    const saved = saveGlobalAssetLibrary(normalizeAssetLibrary(next));
    setGlobalLib(saved);
  };

  const removeOne = (value) => {
    const key = String(value).toLowerCase();
    const next = {
      ...activeLib,
      [kind]: (activeLib[kind] || []).filter(
        (v) => String(v).toLowerCase() !== key
      ),
    };
    if (scope === 'project') commitProject(next);
    else commitGlobal(next);
  };

  const clearKind = () => {
    const next = { ...activeLib, [kind]: [] };
    if (scope === 'project') commitProject(next);
    else commitGlobal(next);
  };

  const clearAll = () => {
    const next = emptyAssetLibrary();
    if (scope === 'project') commitProject(next);
    else commitGlobal(next);
  };

  const counts = KINDS.map((k) => ({
    ...k,
    n: (activeLib?.[k.key] || []).length,
  }));

  return (
    <Modal
      title="Asset library"
      open={open}
      onCancel={onClose}
      footer={[
        <Popconfirm
          key="clear-all"
          title={
            scope === 'project'
              ? 'Clear the entire project library?'
              : 'Clear all global autocomplete history?'
          }
          okText="Clear all"
          okButtonProps={{ danger: true }}
          onConfirm={clearAll}
        >
          <Button danger>Clear all</Button>
        </Popconfirm>,
        <Button key="close" type="primary" onClick={onClose}>
          Close
        </Button>,
      ]}
      width={640}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Autocomplete names for behavior files, anim/equip objects, and OStim
          icons. Project entries come from this pack (import / positions). Global
          history only stores names you type or pick, for reuse in new projects.
        </Typography.Paragraph>

        <Segmented
          block
          value={scope}
          onChange={setScope}
          options={[
            {
              value: 'project',
              label: `This project (${KINDS.reduce(
                (n, k) => n + (draftProject[k.key]?.length || 0),
                0
              )})`,
            },
            {
              value: 'global',
              label: `Global history (${KINDS.reduce(
                (n, k) => n + (globalLib[k.key]?.length || 0),
                0
              )})`,
            },
          ]}
        />

        <Tabs
          activeKey={kind}
          onChange={setKind}
          items={counts.map((k) => ({
            key: k.key,
            label: (
              <span>
                {k.label}{' '}
                <Tag style={{ marginInlineStart: 4 }}>{k.n}</Tag>
              </span>
            ),
          }))}
        />

        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Input.Search
            allowClear
            placeholder="Filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 280 }}
          />
          <Popconfirm
            title={`Clear all ${KINDS.find((k) => k.key === kind)?.label || ''}?`}
            okText="Clear"
            okButtonProps={{ danger: true }}
            disabled={!items.length}
            onConfirm={clearKind}
          >
            <Button danger disabled={!items.length}>
              Clear this list
            </Button>
          </Popconfirm>
        </Space>

        {filtered.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={items.length ? 'No matches' : 'Nothing here yet'}
          />
        ) : (
          <List
            size="small"
            bordered
            style={{ maxHeight: 360, overflow: 'auto' }}
            dataSource={filtered}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button
                    key="del"
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    aria-label={`Remove ${item}`}
                    onClick={() => removeOne(item)}
                  />,
                ]}
              >
                <Typography.Text
                  copyable={{ text: item }}
                  style={{ wordBreak: 'break-all' }}
                >
                  {item}
                </Typography.Text>
              </List.Item>
            )}
          />
        )}
      </Space>
    </Modal>
  );
}
