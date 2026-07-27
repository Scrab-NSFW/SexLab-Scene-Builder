import { Modal, Progress, Typography } from 'antd';

/**
 * Blocking progress UI for long import/export jobs (driven by `on_job_progress`).
 */
export default function JobProgressModal({
  open,
  title = 'Working…',
  message = '',
  current = null,
  total = null,
  error = null,
}) {
  const hasTotal = Number.isFinite(total) && total > 0;
  const cur = Number.isFinite(current) ? Math.max(0, current) : 0;
  const percent = hasTotal
    ? Math.min(100, Math.round((100 * cur) / total))
    : 100;

  return (
    <Modal
      open={!!open}
      title={title}
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={null}
      centered
      destroyOnClose
    >
      <Progress
        percent={percent}
        status={error ? 'exception' : 'active'}
        showInfo={hasTotal || !!error}
      />
      <Typography.Paragraph
        type={error ? 'danger' : 'secondary'}
        style={{ marginTop: 12, marginBottom: 0 }}
      >
        {error || message || 'Please wait…'}
      </Typography.Paragraph>
    </Modal>
  );
}
