import { useMemo, useState } from 'react';
import { Select, Typography, Space } from 'antd';
import {
  stageOstimFolder,
  tagsWithOstimFolder,
} from '../scene/graphFocus';

/**
 * Assign pack folder split (`ostim_folder:`) — maps to OStim
 * `scenes/{folder}/…` on export and to virtual canvases in the graph editor.
 */
export default function OstimFolderField({
  tags = [],
  onChange,
  knownFolders = [],
  size = 'middle',
  style,
  allowClear = true,
  placeholder = 'Pack folder (disk split)',
}) {
  const current = stageOstimFolder({ tags });
  const [search, setSearch] = useState('');

  const options = useMemo(() => {
    const names = [
      ...new Set([...knownFolders, ...(current ? [current] : [])]),
    ]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const opts = names.map((f) => ({ value: f, label: f }));
    const typed = String(search || '').trim();
    if (
      typed &&
      !names.some((n) => n.toLowerCase() === typed.toLowerCase())
    ) {
      opts.unshift({
        value: typed,
        label: `Create “${typed}”`,
      });
    }
    return opts;
  }, [knownFolders, current, search]);

  return (
    <Space direction="vertical" size={2} style={{ width: '100%', ...style }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        OStim pack folder
      </Typography.Text>
      <Select
        size={size}
        showSearch
        allowClear={allowClear}
        placeholder={placeholder}
        style={{ width: '100%' }}
        value={current || undefined}
        options={options}
        searchValue={search}
        onSearch={setSearch}
        onChange={(v) => {
          setSearch('');
          onChange?.(tagsWithOstimFolder(tags, v || ''));
        }}
        popupMatchSelectWidth={false}
        filterOption={false}
        notFoundContent={
          search.trim()
            ? `Press to create “${search.trim()}”`
            : 'Type a folder name'
        }
      />
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        Export path: scenes/&lt;folder&gt;/… — same splits packs like Bloo use on
        disk. Type a new name to create one.
      </Typography.Text>
    </Space>
  );
}
