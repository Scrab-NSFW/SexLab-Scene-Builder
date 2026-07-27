import { useEffect, useState } from 'react';
import { Modal, Checkbox, Space, Typography } from 'antd';

const STORAGE_KEY = 'slsb-export-formats';

const DEFAULTS = {
  slsb: true,
  slal: true,
  ostim: false,
};

function readStoredFormats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      slsb: !!parsed.slsb,
      slal: !!parsed.slal,
      ostim: !!parsed.ostim,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function storeFormats(formats) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(formats));
  } catch {
    /* ignore */
  }
}

/**
 * Choose which pack formats to write in one Export pass.
 * Defaults favor SexLab (SLSB + SLAL); OStim is opt-in.
 */
export default function ExportFormatsModal({ open, onCancel, onExport }) {
  const [formats, setFormats] = useState(readStoredFormats);

  useEffect(() => {
    if (open) setFormats(readStoredFormats());
  }, [open]);

  const any = formats.slsb || formats.slal || formats.ostim;

  return (
    <Modal
      title="Export pack"
      open={open}
      onCancel={onCancel}
      okText="Export…"
      okButtonProps={{ disabled: !any }}
      onOk={() => {
        storeFormats(formats);
        onExport?.(formats);
      }}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        Choose formats to write under the folder you pick. SexLab packs are the
        default; enable OStim when you also need Standalone scene JSON.
      </Typography.Paragraph>
      <Space direction="vertical" size={8}>
        <Checkbox
          checked={formats.slsb}
          onChange={(e) =>
            setFormats((prev) => ({ ...prev, slsb: e.target.checked }))
          }
        >
          SLSB (SexLab P+ / .slr)
        </Checkbox>
        <Checkbox
          checked={formats.slal}
          onChange={(e) =>
            setFormats((prev) => ({ ...prev, slal: e.target.checked }))
          }
        >
          SLAL Pack
        </Checkbox>
        <Checkbox
          checked={formats.ostim}
          onChange={(e) =>
            setFormats((prev) => ({ ...prev, ostim: e.target.checked }))
          }
        >
          OStim
        </Checkbox>
      </Space>
      {formats.slsb && formats.slal ? (
        <Typography.Paragraph
          type="secondary"
          style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}
        >
          SLSB and SLAL are written into separate SLSB/ and SLAL/ subfolders
          (their AnimList formats conflict in one tree).
        </Typography.Paragraph>
      ) : null}
    </Modal>
  );
}
