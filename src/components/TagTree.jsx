import React, { useMemo, useState } from "react";
import { Select, Tag, Modal, Input, Button, Space, Tooltip, message } from 'antd';
import { EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { loadUserTags, rememberUserTags, removeUserTag, renameUserTag } from '../common/userTags';

function tagKey(tag) {
  return String(tag).toLowerCase().replace(/\s+/g, '');
}

/** Managed elsewhere (folder field / nav editor / import ids) — keep but don't list. */
function isManagedTag(tag) {
  const t = String(tag);
  return (
    t.startsWith('ostim_nav:') ||
    t.startsWith('ostim_nav_origin:') ||
    t.startsWith('ostim_id:') ||
    t.startsWith('ostim_folder:') ||
    t.startsWith('ostim_dest:') ||
    t.startsWith('ostim_group:')
  );
}

function TagTree({
  tags,
  onChange,
  tagsSFW = [],
  tagsNSFW = [],
  tagsOStimActions = [],
  ...selectProps
}) {
  const [userTags, setUserTags] = useState(() => loadUserTags());
  const [searchValue, setSearchValue] = useState('');
  const [editingTag, setEditingTag] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const presets = useMemo(
    () => [...tagsSFW, ...tagsNSFW, ...tagsOStimActions],
    [tagsSFW, tagsNSFW, tagsOStimActions]
  );
  const sexlabKeys = useMemo(
    () => new Set([...tagsSFW, ...tagsNSFW].map((tag) => tagKey(tag))),
    [tagsSFW, tagsNSFW]
  );
  /** Bare action type → `action:type` when it does not collide with SFW/NSFW. */
  const actionBareByKey = useMemo(() => {
    const m = new Map();
    for (const tag of tagsOStimActions) {
      const type = String(tag).replace(/^action:/i, '');
      const k = tagKey(type);
      if (!k || sexlabKeys.has(k)) continue;
      m.set(k, tag);
    }
    return m;
  }, [tagsOStimActions, sexlabKeys]);
  const presetByKey = useMemo(
    () => new Map(presets.map((tag) => [tagKey(tag), tag])),
    [presets]
  );
  const presetKeys = useMemo(
    () => new Set(presetByKey.keys()),
    [presetByKey]
  );
  const savedKeys = useMemo(
    () => new Set(userTags.map((tag) => tagKey(tag))),
    [userTags]
  );

  const canonicalize = (tag) => {
    const trimmed = String(tag ?? '').trim();
    if (!trimmed) return '';
    const key = tagKey(trimmed);
    if (presetByKey.has(key)) return presetByKey.get(key);
    if (actionBareByKey.has(key)) return actionBareByKey.get(key);
    return trimmed;
  };

  const canonicalValue = useMemo(
    () =>
      (tags || [])
        .filter((t) => !isManagedTag(t))
        .map(canonicalize)
        .filter(Boolean),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tags, presetByKey, actionBareByKey]
  );

  const yoursOptions = useMemo(() => {
    const byKey = new Map();
    for (const tag of userTags) {
      const trimmed = String(tag ?? '').trim();
      if (!trimmed || isManagedTag(trimmed) || presetKeys.has(tagKey(trimmed)))
        continue;
      byKey.set(tagKey(trimmed), trimmed);
    }
    for (const tag of tags || []) {
      const trimmed = String(tag ?? '').trim();
      if (!trimmed || isManagedTag(trimmed) || presetKeys.has(tagKey(trimmed)))
        continue;
      // Full `action:type:a:t:p` stays visible under Yours.
      byKey.set(tagKey(trimmed), trimmed);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  }, [userTags, tags, presetKeys]);

  const pendingCreate = useMemo(() => {
    const trimmed = searchValue.trim();
    if (!trimmed) return null;
    const key = tagKey(trimmed);
    if (presetKeys.has(key) || actionBareByKey.has(key)) return null;
    if (yoursOptions.some((tag) => tagKey(tag) === key)) return null;
    return trimmed;
  }, [searchValue, presetKeys, actionBareByKey, yoursOptions]);

  const commitTags = (next) => {
    const cleaned = [];
    const seen = new Set();
    for (const tag of next || []) {
      const canonical = canonicalize(tag);
      if (!canonical || isManagedTag(canonical)) continue;
      const key = tagKey(canonical);
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(canonical);
    }
    const managed = (tags || []).filter((t) => isManagedTag(t));
    const merged = [...cleaned, ...managed];
    setUserTags(rememberUserTags(cleaned, presets));
    setSearchValue('');
    onChange(merged);
  };

  const tryCreateFromSearch = () => {
    const trimmed = searchValue.trim();
    if (!trimmed) return false;
    const canonical = canonicalize(trimmed);
    if (canonicalValue.some((tag) => tagKey(tag) === tagKey(canonical))) {
      setSearchValue('');
      return true;
    }
    commitTags([...canonicalValue, canonical]);
    return true;
  };

  const stopRowSelect = (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
  };

  const handleRemoveSaved = (tag, evt) => {
    stopRowSelect(evt);
    Modal.confirm({
      title: 'Remove saved tag?',
      content: `"${tag}" will be removed from your saved custom tags.`,
      okText: 'Remove',
      okType: 'danger',
      onOk: () => {
        setUserTags(removeUserTag(tag));
        const next = (tags || []).filter((t) => tagKey(t) !== tagKey(tag));
        if (next.length !== (tags || []).length) {
          onChange(next);
        }
      },
    });
  };

  const openRename = (tag, evt) => {
    stopRowSelect(evt);
    setEditingTag(tag);
    setEditDraft(tag);
  };

  const applyRename = () => {
    const nextList = renameUserTag(editingTag, editDraft, presets);
    if (!nextList) {
      message.error('Tag name is empty or already used.');
      return;
    }
    setUserTags(nextList);
    const oldKey = tagKey(editingTag);
    const renamed = String(editDraft).trim();
    const next = (tags || []).map((t) =>
      !isManagedTag(t) && tagKey(t) === oldKey ? renamed : t
    );
    if (next.some((t, i) => t !== (tags || [])[i])) {
      onChange(next);
    }
    setEditingTag(null);
    setEditDraft('');
  };

  const options = useMemo(() => {
    const yours = pendingCreate
      ? [...yoursOptions, pendingCreate]
      : yoursOptions;
    const groups = [
      {
        label: 'SFW',
        options: tagsSFW.map((tag) => ({ value: tag, label: tag })),
      },
      {
        label: 'NSFW',
        options: tagsNSFW.map((tag) => ({ value: tag, label: tag })),
      },
    ];
    if (tagsOStimActions.length) {
      groups.push({
        label: 'OStim Actions',
        options: tagsOStimActions.map((tag) => ({
          value: tag,
          label: String(tag).replace(/^action:/i, ''),
        })),
      });
    }
    if (yours.length) {
      groups.push({
        label: 'Yours',
        options: yours.map((tag) => {
          const isPending = pendingCreate && tag === pendingCreate;
          const isSaved = !isPending && savedKeys.has(tagKey(tag));
          if (!isSaved) {
            return { value: tag, label: tag };
          }
          return {
            value: tag,
            label: (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {tag}
                </span>
                <Space size={0} onMouseDown={stopRowSelect} onClick={stopRowSelect}>
                  <Tooltip title="Rename saved tag">
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onMouseDown={stopRowSelect}
                      onClick={(evt) => openRename(tag, evt)}
                    />
                  </Tooltip>
                  <Tooltip title="Remove saved tag">
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onMouseDown={stopRowSelect}
                      onClick={(evt) => handleRemoveSaved(tag, evt)}
                    />
                  </Tooltip>
                </Space>
              </div>
            ),
          };
        }),
      });
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tagsSFW,
    tagsNSFW,
    tagsOStimActions,
    yoursOptions,
    pendingCreate,
    savedKeys,
    tags,
  ]);

  return (
    <>
      <Select
        className="tag-display-field"
        size="large"
        mode="multiple"
        showSearch
        allowClear
        placeholder="Search or create tags"
        value={canonicalValue}
        searchValue={searchValue}
        onSearch={setSearchValue}
        onChange={commitTags}
        options={options}
        optionFilterProp="value"
        maxTagTextLength={20}
        onInputKeyDown={(evt) => {
          if (evt.key === ',') {
            evt.preventDefault();
            tryCreateFromSearch();
            return;
          }
          if (evt.key === 'Enter' && pendingCreate) {
            evt.preventDefault();
            tryCreateFromSearch();
          }
        }}
        tagRender={({ label, value, closable, onClose }) => {
          const raw = String(value);
          const search = raw.toLowerCase();
          const color = raw.toLowerCase().startsWith('action:')
            ? 'geekblue'
            : tagsSFW.find((it) => it.toLowerCase() === search)
              ? 'cyan'
              : tagsNSFW.find((it) => it.toLowerCase() === search)
                ? 'volcano'
                : 'purple';

          const onPreventMouseDown = (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
          };
          return (
            <Tag
              color={color}
              onMouseDown={onPreventMouseDown}
              closable={closable}
              onClose={onClose}
              style={{ margin: 2 }}
            >
              {typeof label === 'string' ? label : value}
            </Tag>
          );
        }}
        {...selectProps}
      />
      <Modal
        title="Rename saved tag"
        open={!!editingTag}
        onCancel={() => {
          setEditingTag(null);
          setEditDraft('');
        }}
        onOk={applyRename}
        okText="Save"
        destroyOnClose
      >
        <Input
          autoFocus
          value={editDraft}
          onChange={(e) => setEditDraft(e.target.value)}
          onPressEnter={applyRename}
          placeholder="Tag name"
        />
      </Modal>
    </>
  );
}

export default TagTree;
