import { useMemo, useState } from 'react';
import { Tree, Typography, Input, Empty, Tag, Space } from 'antd';
import { cleanStageName } from '../scene/stageFamily';

/**
 * IDE-style outline derived from the primary spanning forest.
 * Read-only navigation — click centers the canvas selection.
 */
export default function GraphNavOutline({
  outline = [],
  selectedIds = [],
  onSelectNode,
  isDark = false,
  pathIds = [],
}) {
  const [filter, setFilter] = useState('');
  const selected = selectedIds?.[0];
  const pathSet = useMemo(() => new Set(pathIds || []), [pathIds]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return outline;

    const matchNode = (node) => {
      const title = (node.title || '').toLowerCase();
      const fam = (node.family || '').toLowerCase();
      const selfHit =
        title.includes(q) || fam.includes(q) || String(node.id).toLowerCase().includes(q);
      const kids = (node.children || []).map(matchNode).filter(Boolean);
      if (selfHit || kids.length) {
        return { ...node, children: kids.length ? kids : node.children };
      }
      return null;
    };
    return outline.map(matchNode).filter(Boolean);
  }, [outline, filter]);

  const treeData = useMemo(() => {
    const toData = (node) => ({
      key: node.id,
      title: (
        <Space size={4} wrap={false} style={{ maxWidth: '100%' }}>
          <Typography.Text
            ellipsis={{ tooltip: node.title }}
            style={{
              maxWidth: 160,
              fontWeight: pathSet.has(node.id) ? 600 : 400,
              color: pathSet.has(node.id)
                ? undefined
                : isDark
                  ? 'rgba(255,255,255,0.75)'
                  : undefined,
            }}
          >
            {node.title || cleanStageName(node.id)}
          </Typography.Text>
          {node.extraEntries > 0 && (
            <Tag
              style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}
              color="default"
            >
              +{node.extraEntries}
            </Tag>
          )}
        </Space>
      ),
      children: (node.children || []).map(toData),
    });
    return filtered.map(toData);
  }, [filtered, pathSet, isDark]);

  const defaultExpanded = useMemo(() => {
    const keys = [];
    const walk = (nodes, depth) => {
      for (const n of nodes || []) {
        if (depth < 2) keys.push(n.id);
        walk(n.children, depth + 1);
      }
    };
    walk(outline, 0);
    return keys;
  }, [outline]);

  if (!outline.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No navigation tree"
        style={{ padding: 12 }}
      />
    );
  }

  return (
    <div className="graph-nav-outline" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Input
        size="small"
        allowClear
        placeholder="Filter outline…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <Tree
          treeData={treeData}
          selectedKeys={selected ? [selected] : []}
          defaultExpandedKeys={defaultExpanded}
          onSelect={(keys) => {
            const id = keys?.[0];
            if (id && onSelectNode) onSelectNode(String(id));
          }}
          showLine={{ showLeafIcon: false }}
          blockNode
          style={{ background: 'transparent' }}
        />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 11, marginTop: 6 }}>
        +N = other inbound links (not in browse tree)
      </Typography.Text>
    </div>
  );
}
