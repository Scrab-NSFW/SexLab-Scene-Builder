import { useMemo, useState } from 'react';
import { Table, Input, Select, Space, Tag, Button, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { cleanStageName } from '../scene/stageFamily';

const KIND_COLOR = {
  primary: 'processing',
  secondary: 'default',
  link: 'default',
  cycle: 'orange',
  cross: 'purple',
  // legacy labels if any old rows linger
  forward: 'default',
  back: 'orange',
  same: 'blue',
};

function shortName(name) {
  return cleanStageName(name) || name || '';
}

/**
 * Searchable connections table for large scene graphs.
 * Click a row to jump to that link on the Map.
 */
export default function GraphConnectionsTable({
  rows = [],
  onRowFocus,
  onExport,
  isDark = false,
  compact = false,
}) {
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [familyFilter, setFamilyFilter] = useState('all');

  const families = useMemo(() => {
    const set = new Set();
    rows.forEach((r) => {
      set.add(r.sourceFamily);
      set.add(r.targetFamily);
    });
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false;
      if (
        familyFilter !== 'all' &&
        r.sourceFamily !== familyFilter &&
        r.targetFamily !== familyFilter
      ) {
        return false;
      }
      if (!q) return true;
      const from = shortName(r.sourceName).toLowerCase();
      const to = shortName(r.targetName).toLowerCase();
      return (
        from.includes(q) ||
        to.includes(q) ||
        r.sourceFamily.toLowerCase().includes(q) ||
        r.targetFamily.toLowerCase().includes(q) ||
        r.source.toLowerCase().includes(q) ||
        r.target.toLowerCase().includes(q)
      );
    });
  }, [rows, search, kindFilter, familyFilter]);

  const columns = [
    {
      title: 'From',
      dataIndex: 'sourceName',
      key: 'from',
      ellipsis: true,
      render: (text) => (
        <Typography.Text ellipsis={{ tooltip: text }} style={{ maxWidth: '100%' }}>
          {shortName(text)}
        </Typography.Text>
      ),
    },
    {
      title: 'To',
      dataIndex: 'targetName',
      key: 'to',
      ellipsis: true,
      render: (text) => (
        <Typography.Text ellipsis={{ tooltip: text }} style={{ maxWidth: '100%' }}>
          {shortName(text)}
        </Typography.Text>
      ),
    },
    {
      title: 'Kind',
      dataIndex: 'kind',
      key: 'kind',
      width: compact ? 78 : 96,
      render: (kind) => (
        <Tag color={KIND_COLOR[kind] || 'default'} style={{ marginInlineEnd: 0 }}>
          {kind}
        </Tag>
      ),
    },
    {
      title: 'Family',
      key: 'family',
      width: compact ? 110 : 140,
      ellipsis: true,
      render: (_, row) =>
        row.sourceFamily === row.targetFamily
          ? row.sourceFamily
          : `${row.sourceFamily} → ${row.targetFamily}`,
    },
  ];

  return (
    <div
      className="graph-connections-table"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: compact ? 6 : 8,
        background: isDark ? '#141414' : '#fafafa',
        boxSizing: 'border-box',
      }}
    >
      <Space wrap size={6} style={{ marginBottom: 6 }}>
        <Input.Search
          allowClear
          size="small"
          placeholder="Filter connections…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: compact ? 160 : 220 }}
        />
        <Select
          size="small"
          value={kindFilter}
          onChange={setKindFilter}
          style={{ width: 110 }}
          options={[
            { value: 'all', label: 'All kinds' },
            { value: 'primary', label: 'Primary' },
            { value: 'secondary', label: 'Secondary' },
            { value: 'cycle', label: 'Cycle' },
            { value: 'cross', label: 'Cross' },
          ]}
        />
        <Select
          size="small"
          value={familyFilter}
          onChange={setFamilyFilter}
          style={{ width: compact ? 130 : 170 }}
          options={[
            { value: 'all', label: 'All families' },
            ...families.map((f) => ({ value: f, label: f })),
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {filtered.length}/{rows.length}
        </Typography.Text>
        {onExport && (
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => onExport(filtered)}
          >
            CSV
          </Button>
        )}
      </Space>
      <Typography.Paragraph
        type="secondary"
        style={{ marginBottom: 6, fontSize: 11 }}
      >
        Click a row to open that link on the Map (Near edges).
      </Typography.Paragraph>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Table
          size="small"
          rowKey="key"
          columns={columns}
          dataSource={filtered}
          pagination={{
            pageSize: compact ? 25 : 40,
            showSizeChanger: !compact,
            size: 'small',
          }}
          scroll={{ y: compact ? 160 : 'calc(100% - 40px)' }}
          onRow={(record) => ({
            onClick: () => onRowFocus?.(record),
            style: { cursor: onRowFocus ? 'pointer' : undefined },
          })}
        />
      </div>
    </div>
  );
}

export function connectionsToCsv(rows) {
  const header = [
    'source_id',
    'source_name',
    'source_family',
    'target_id',
    'target_name',
    'target_family',
    'kind',
    'fixed_len',
  ];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.source,
        r.sourceName,
        r.sourceFamily,
        r.target,
        r.targetName,
        r.targetFamily,
        r.kind,
        r.fixedLen ? '1' : '0',
      ]
        .map(escape)
        .join(',')
    );
  }
  return lines.join('\n');
}
