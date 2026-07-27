import { useMemo, useState } from 'react';
import {
  Button,
  Dropdown,
  Empty,
  Input,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  MoreOutlined,
  PlusOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons';

/**
 * Searchable flat scene list (replaces nested Ant Menu).
 */
export default function SceneListPanel({
  scenes = [],
  activeSceneId,
  collapsed,
  onNewScene,
  onSelectScene,
  onDeleteScene,
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...scenes].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), undefined, {
        sensitivity: 'base',
      })
    );
    if (!q) return list;
    return list.filter((s) => {
      const name = String(s.name || '').toLowerCase();
      const id = String(s.id || '').toLowerCase();
      if (name.includes(q) || id.includes(q)) return true;
      return (s.stages || []).some((st) => {
        const sn = String(st.name || '').toLowerCase();
        if (sn.includes(q)) return true;
        return (st.tags || []).some((t) => {
          const tag = String(t || '');
          if (tag.toLowerCase().startsWith('ostim_id:')) {
            return tag.slice('ostim_id:'.length).toLowerCase().includes(q);
          }
          return false;
        });
      });
    });
  }, [scenes, query]);

  if (collapsed) {
    return (
      <div className="scene-list-collapsed">
        <Tooltip title="New Scene" placement="right">
          <Button
            type="text"
            icon={<PlusOutlined />}
            onClick={onNewScene}
            block
          />
        </Tooltip>
        {filtered.slice(0, 12).map((scene) => (
          <Tooltip key={scene.id} title={scene.name || scene.id} placement="right">
            <Button
              type={scene.id === activeSceneId ? 'primary' : 'text'}
              ghost={scene.id === activeSceneId}
              icon={
                scene.has_warnings ? (
                  <WarningOutlined style={{ color: '#e57373' }} />
                ) : (
                  <ExperimentOutlined />
                )
              }
              onClick={() => onSelectScene(scene)}
              block
            />
          </Tooltip>
        ))}
      </div>
    );
  }

  return (
    <div className="scene-list-panel">
      <div className="scene-list-toolbar">
        <Button type="primary" icon={<PlusOutlined />} onClick={onNewScene} block>
          New Scene
        </Button>
        <Input
          allowClear
          size="small"
          prefix={<SearchOutlined />}
          placeholder="Search scenes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="scene-list-search"
        />
        <Typography.Text type="secondary" className="scene-list-count">
          {filtered.length}
          {filtered.length !== scenes.length ? ` / ${scenes.length}` : ''} scene
          {scenes.length === 1 ? '' : 's'}
        </Typography.Text>
      </div>
      <div className="scene-list-scroll">
        {filtered.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={scenes.length ? 'No matches' : 'No scenes yet'}
            style={{ marginTop: 24 }}
          />
        ) : (
          filtered.map((scene) => {
            const active = scene.id === activeSceneId;
            const stageCount = scene.stages?.length ?? 0;
            return (
              <div
                key={scene.id}
                className={`scene-list-row${active ? ' is-active' : ''}`}
                onClick={() => onSelectScene(scene)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectScene(scene);
                  }
                }}
              >
                <span className="scene-list-icon">
                  {scene.has_warnings ? (
                    <WarningOutlined style={{ color: '#e57373' }} />
                  ) : (
                    <ExperimentOutlined />
                  )}
                </span>
                <span className="scene-list-meta">
                  <span className="scene-list-name" title={scene.name || scene.id}>
                    {scene.name || 'Untitled'}
                  </span>
                  <span className="scene-list-sub">
                    {stageCount} stage{stageCount === 1 ? '' : 's'}
                  </span>
                </span>
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      {
                        key: 'edit',
                        icon: <EditOutlined />,
                        label: 'Open',
                        onClick: ({ domEvent }) => {
                          domEvent.stopPropagation();
                          onSelectScene(scene);
                        },
                      },
                      {
                        key: 'delete',
                        icon: <DeleteOutlined />,
                        label: 'Delete',
                        danger: true,
                        onClick: ({ domEvent }) => {
                          domEvent.stopPropagation();
                          onDeleteScene(scene);
                        },
                      },
                    ],
                  }}
                >
                  <Button
                    type="text"
                    size="small"
                    className="scene-list-more"
                    icon={<MoreOutlined />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Dropdown>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
