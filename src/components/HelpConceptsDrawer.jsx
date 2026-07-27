import { Drawer, Typography } from 'antd';

const { Paragraph, Title, Text } = Typography;

/**
 * Short in-app concepts help (DestRef, folders, authoring focus).
 */
export default function HelpConceptsDrawer({ open, onClose }) {
  return (
    <Drawer
      title="Scene Builder concepts"
      placement="right"
      width={400}
      open={open}
      onClose={onClose}
      destroyOnClose
    >
      <Title level={5}>Save vs Export</Title>
      <Paragraph>
        <Text strong>Save / Save As</Text> writes the project archive (
        <Text code>.slsb.json</Text>). Stage edits live in that project until you
        export.
      </Paragraph>
      <Paragraph>
        <Text strong>Export…</Text> lets you choose formats (SLSB, SLAL Pack,
        and optionally OStim) and writes them under the folder you pick. When both
        SLSB and SLAL are selected they go into separate subfolders. Re-exporting
        OStim into an existing pack is incremental (changed scene JSON only).
      </Paragraph>

      <Title level={5}>OStim ID vs display name</Title>
      <Paragraph>
        The <Text strong>OStim ID</Text> (<Text code>ostim_id:</Text> tag) becomes
        the JSON filename on export (e.g.{' '}
        <Text code>MLCBedStraddlingCloseKiss.json</Text>). The stage/scene name
        is only for search and UI labels.
      </Paragraph>

      <Title level={5}>Scene vs stage</Title>
      <Paragraph>
        A <Text strong>scene</Text> is a playable cast (actor slots), furniture,
        and a graph of stages. A <Text strong>stage</Text> is one animation pose
        or transition inside that graph.
      </Paragraph>

      <Title level={5}>DestRef</Title>
      <Paragraph>
        Graph edges use absolute destinations{' '}
        <Text code className="mono-id">
          (sceneId, stageId)
        </Text>
        . Same-scene links are drawn on the canvas; cross-scene links are edited
        under stage editor → <Text strong>Links</Text>, and listed as{' '}
        <Text strong>Outbound links</Text> when Authoring focus is OStim or All.
      </Paragraph>

      <Title level={5}>OStim folders</Title>
      <Paragraph>
        On import, each disk folder under <Text code>scenes/</Text> becomes its
        own scene when casts match. Cross-folder navigations become DestRefs.
        The canvas folder filter is a view for scenes that still span multiple
        folders.
      </Paragraph>

      <Title level={5}>Authoring focus</Title>
      <Paragraph>
        <Text strong>SexLab</Text> hides OStim folder chrome.{' '}
        <Text strong>OStim</Text> emphasizes folders and outbound DestRefs.{' '}
        <Text strong>All</Text> shows every control.
      </Paragraph>
    </Drawer>
  );
}
