import React, { useMemo, useState } from "react";
import { AutoComplete, Button, Card, Checkbox, Col, Input, Row, Select, Space, Tooltip, InputNumber, Dropdown } from "antd";
import RaceSelect from "../components/RaceSelect";
import { rememberAssetValues, suggestAssetOptions } from "../common/assetLibrary";
import './PositionField.css'

const stripOptions = [
  "Default",
  "Everything",
  "Nothing",
  "Helmet",
  "Gloves",
  "Boots",
];
const stripKeyMap = {
  default: "Default",
  everything: "Everything",
  nothing: "Nothing",
  helmet: "Helmet",
  gloves: "Gloves",
  boots: "Boots",
};
const uniqueOptionIndex = 3

const getStrips = (list = {}) => {
  const ret = Object.entries(stripKeyMap)
    .filter(([key]) => list[key])
    .map(([, label]) => label);
  return ret.length ? ret : [stripOptions[0]];
};

const makeStrips = (list = []) => {
  const lowerList = list.map(String);
  return Object.fromEntries(
    Object.entries(stripKeyMap).map(([key, label]) => [key, lowerList.includes(label)])
  );
};

function filterPrefixOptions(candidates, typed) {
  const q = String(typed ?? '').trim().toLowerCase().replace(/\.hkx$/i, '');
  const list = !q
    ? candidates
    : candidates.filter((c) => String(c).toLowerCase().startsWith(q));
  return list.slice(0, 40).map((value) => ({ value }));
}

/** Split multi-token field into leading text + current token for suggestions. */
function splitTrailingToken(raw) {
  const s = String(raw ?? '');
  const m = s.match(/^(.*?)([^\s,]*)$/);
  return { lead: m?.[1] ?? '', token: m?.[2] ?? '' };
}

function HkxAutoComplete({ value, onChange, onCommit, options, placeholder, addonBefore }) {
  const filtered = useMemo(
    () => filterPrefixOptions(options, value),
    [options, value]
  );
  return (
    <AutoComplete
      value={value ?? ''}
      options={filtered}
      onChange={(v) => onChange(String(v ?? '').replace(/\.hkx$/i, ''))}
      onSelect={(v) => {
        const stem = String(v ?? '').replace(/\.hkx$/i, '');
        onChange(stem);
        onCommit?.(stem);
      }}
      onBlur={() => onCommit?.(value)}
      style={{ width: '100%' }}
    >
      <Input addonBefore={addonBefore} addonAfter=".hkx" placeholder={placeholder} />
    </AutoComplete>
  );
}

function TokenAutoComplete({
  value,
  onChange,
  onCommit,
  options,
  placeholder,
  addonBefore,
}) {
  const { lead, token } = splitTrailingToken(value);
  const filtered = useMemo(
    () => filterPrefixOptions(options, token),
    [options, token]
  );
  const commitWhole = (raw) => {
    onCommit?.(raw);
  };
  return (
    <AutoComplete
      value={value ?? ''}
      options={filtered}
      onChange={(v) => onChange(String(v ?? ''))}
      onSelect={(v) => {
        const next = `${lead}${v}`;
        onChange(next);
        commitWhole(next);
      }}
      onBlur={() => commitWhole(value)}
      style={{ width: '100%' }}
    >
      <Input addonBefore={addonBefore} placeholder={placeholder} />
    </AutoComplete>
  );
}

function PositionField({ position, info, onChange, raceKeys: raceKeysProp, assetLibrary }) {
  const [basicAnim, setBasicAnim] = useState(true);
  const [workingAnim, setWorkingAnim] = useState(undefined);
  const [sequenceOpen, setSequenceOpen] = useState(false);
  const raceKeys = Array.isArray(raceKeysProp) ? raceKeysProp : null;

  const eventOptions = useMemo(
    () => suggestAssetOptions(assetLibrary, 'events'),
    [assetLibrary]
  );
  const animObjOptions = useMemo(
    () => suggestAssetOptions(assetLibrary, 'anim_objects'),
    [assetLibrary]
  );
  const equipOptions = useMemo(
    () => suggestAssetOptions(assetLibrary, 'equip_objects'),
    [assetLibrary]
  );

  const rememberEvent = (stem) => {
    if (stem) rememberAssetValues('events', stem);
  };
  const rememberAnimObj = (raw) => {
    if (raw) rememberAssetValues('anim_objects', raw);
  };
  const rememberEquip = (raw) => {
    if (raw) rememberAssetValues('equip_objects', raw);
  };

  const makeSequenceMenu = (events) => {
    let sequences = [];
    for (let i = 1; i < events.length; i++) {
      sequences.push({
        key: i,
        label: (
          <HkxAutoComplete
            value={position.event[i]}
            options={eventOptions}
            onChange={(stem) => {
              let evt = [...position.event];
              if (!stem) evt.splice(i, 1);
              else evt[i] = stem;
              onChange({ ...position, event: evt }, info);
            }}
            onCommit={rememberEvent}
            addonBefore="+"
          />
        ),
      });
    }
    sequences.push({
      key: 'new',
      label: (
        <Space>
          <HkxAutoComplete
            value={workingAnim}
            options={eventOptions}
            onChange={setWorkingAnim}
            onCommit={rememberEvent}
            placeholder="New Behavior File"
            addonBefore="+"
          />
          <Button
            onClick={() => {
              if (!workingAnim) return;
              rememberEvent(workingAnim);
              onChange(
                { ...position, event: [...(position.event || []), workingAnim] },
                info
              );
              setWorkingAnim(undefined);
            }}
          >
            Add
          </Button>
        </Space>
      ),
    });
    return sequences;
  }

  return (
    <div>
      <Row gutter={[2, 2]}>
        <Col span={8}> {/* Race */}
          <Card className="position-attribute-card" title={'Race'}>
            <RaceSelect
              race={info.race}
              raceKeys={raceKeys}
              onSelect={(e) => {
                onChange(position, { ...info, race: e, sex: { ...info.sex, futa: e === 'Human' && info.sex.futa } });
              }}
            />
          </Card>
        </Col>
        <Col span={8}> {/* Sex */}
          <Card
            className="position-attribute-card"
            title={'Sex'}
            extra={
              <Tooltip className="tool-tip"
                title={
                  'The sexes compatible with this position. Tick all that apply.'
                }
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            <Space size={'large'} wrap={true}>
              {['male', 'female', 'futa'].map(attr => (
                <Checkbox
                  key={attr}
                  onChange={e => onChange(position, { ...info, sex: { ...info.sex, [attr]: e.target.checked, } })}
                  disabled={attr === 'futa' && info.race !== 'Human'}
                  checked={info.sex[attr]}
                >
                  {attr.charAt(0).toUpperCase() + attr.slice(1)}
                </Checkbox>
              ))}
            </Space>
          </Card>
        </Col>
        <Col span={8}> {/* SOS Angle */}
          <Card
            className="position-attribute-card"
            title={'SOS Angle'}
            extra={
              <Tooltip className="tool-tip"
                title={
                  'Schlongs of Skyrim bend angle (−9…9). Used for male and futa actors; written to SLAL as sos on export.'
                }
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            <InputNumber
              className="position-schlong-input"
              addonBefore="SOS"
              controls
              precision={0}
              step={1}
              min={-9}
              max={9}
              value={position.schlong ?? 0}
              onChange={(e) => {
                const v = typeof e === 'number' ? Math.max(-9, Math.min(9, e)) : 0;
                onChange({ ...position, schlong: v }, info);
              }}
            />
          </Card>
        </Col>
        <Col span={24}>  {/* Animation (Basic) */}
          <Card
            className="position-attribute-card"
            title={
              <Checkbox
                checked={basicAnim}
                onClick={(e) => setBasicAnim(e.target.checked)}
              >
                Animation {basicAnim ? '(Basic)' : '(Sequence)'}
              </Checkbox>
            }
            extra={
              <Tooltip className="tool-tip"
                title={
                  'The behavior file (.hkx) describing the animation for this position. Without extension.'
                }
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            {basicAnim ? (
              <HkxAutoComplete
                value={position.event[0]}
                options={eventOptions}
                placeholder="Behavior file"
                onChange={(stem) =>
                  onChange({ ...position, event: [stem] }, info)
                }
                onCommit={rememberEvent}
              />
            ) : (
              <Dropdown
                menu={{
                  overlayClassName: 'test12334',
                  items: makeSequenceMenu(position.event),
                }}
                onOpenChange={(open) => setSequenceOpen(open)}
                open={sequenceOpen}
              >
                <div>
                  <HkxAutoComplete
                    value={position.event[0]}
                    options={eventOptions}
                    placeholder="Behavior file"
                    addonBefore="s"
                    onChange={(stem) =>
                      onChange(
                        {
                          ...position,
                          event: [stem, ...position.event.slice(1)],
                        },
                        info
                      )
                    }
                    onCommit={rememberEvent}
                  />
                </div>
              </Dropdown>
            )}
          </Card>
        </Col>
        <Col span={24}> {/* Anim Object */}
          {/* behavior file */}
          <Card
            className="position-attribute-card"
            title={'Anim Object'}
            extra={
              <Tooltip className="tool-tip"
                title={
                  'The anim object(s) associated with this position. Separate multiple with commas or spaces (FNIS-style).'
                }
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            <TokenAutoComplete
              value={
                Array.isArray(position.anim_obj)
                  ? position.anim_obj.filter(Boolean).join(' ')
                  : (position.anim_obj ?? '')
              }
              options={animObjOptions}
              placeholder="Editor ID"
              onChange={(v) =>
                onChange({ ...position, anim_obj: v }, info)
              }
              onCommit={rememberAnimObj}
            />
          </Card>
        </Col>
        <Col xs={12} lg={12} xl={6}> {/* Data */}
          <Card
            className="position-attribute-card"
            title={'Data'}
            extra={
              <Tooltip className="tool-tip"
                title={
                  'Extra Data used to further specify the actor filling this position. Hover options for more info.'
                }
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            <Row gutter={[8, 16]} justify={'space-between'}>
              {[
                { attr: 'submissive', title: 'Passive/Taker/Bottom position.' },
                { attr: 'vampire', title: 'Actor is a vampire.' },
                { attr: 'dead', title: 'Actor is unconscious/dead.' },
              ].map(({ attr, title }) => (
                <Col key={attr}>
                  <Tooltip title={title}>
                    {/* div here is necessary to avoid 'findDOMNode is depreciated' error */}
                    <div>
                      <Checkbox
                        onChange={e => onChange(
                          position,
                          { ...info, [attr]: e.target.checked }
                        )}
                        checked={info[attr]}
                      >
                        {attr.charAt(0).toUpperCase() + attr.slice(1)}
                      </Checkbox>
                    </div>
                  </Tooltip>
                </Col>
              ))}
              <Col>
                <Tooltip className="tool-tip" title={'Actor climaxes during this stage.'}>
                  <div>
                    <Checkbox
                      checked={position.climax}
                      onChange={(e) => onChange({ ...position, climax: e.target.checked }, info)}
                    >
                      Climax
                    </Checkbox>
                  </div>
                </Tooltip>
              </Col>
              <Select
                mode="tags"
                style={{ width: '100%' }}
                value={position.tags ? position.tags : undefined}
                placeholder="Tags"
                onSelect={(value) => {
                  const upperV = value.toUpperCase();
                  const idx = position.tags.findIndex(it => it.toUpperCase() === upperV);
                  if (idx === -1) {
                    onChange({ ...position, tags: [...(position.tags || []), value] }, info);
                  }
                }}
                onDeselect={(value) => {
                  const upperV = value.toUpperCase();
                  onChange({ ...position, tags: position.tags.filter(it => it.toUpperCase() !== upperV) }, info);
                }}
                maxTagTextLength={10}
                maxTagCount={3}
              />
            </Row>
          </Card>
        </Col>
        <Col xs={12} lg={12} xl={6}> {/* Offset */}
          <Card
            className="position-attribute-card"
            title={'Offset'}
            extra={
              <Tooltip className="tool-tip"
                title={'The position offset relative to animation center.'}
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            <Row gutter={[12, 12]}>
              {['x', 'y', 'z', 'r'].map((axis, index) => (
                <Col span={12} key={index}>
                  <InputNumber
                    addonBefore={axis.toUpperCase()}
                    controls
                    decimalSeparator=","
                    precision={1}
                    step={0.1}
                    value={position.offset[axis] ? position.offset[axis] : undefined}
                    onChange={(e) => {
                      onChange({ ...position, offset: { ...position.offset, [axis]: e ? e : 0.0 } }, info);
                    }}
                    placeholder="0.0"
                    min={axis === 'r' ? 0.0 : undefined}
                    max={axis === 'r' ? 359.9 : undefined}
                  />
                </Col>))}
            </Row>
          </Card>
        </Col>
        <Col xs={12} lg={12} xl={6}> {/* Scale */}
          <Card
            className="position-attribute-card"
            title={'Scale'}
            extra={
              <Tooltip className="tool-tip"
                title={
                  'The desired scale of this actor. Usually the same scale used in the creation of the behavior file.'
                }
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            <InputNumber
              addonBefore={'Factor'}
              controls
              decimalSeparator="."
              precision={2}
              min={0.01}
              max={2}
              step={0.01}
              value={info.scale}
              onChange={(e) => {
                onChange(position, { ...info, scale: typeof e === 'number' ? e : 1.0 });
              }}
              placeholder="1.0"
            />
          </Card>
        </Col>
        <Col xs={12} lg={12} xl={6}> {/* Stripping */}
          <Card
            className="position-attribute-card"
            title={'Stripping'}
            extra={
              <Tooltip className="tool-tip"
                title={'The items this position should strip in this stage.'}
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            <Select
              className="position-strip-tree"
              mode="multiple"
              value={getStrips(position.strip_data)}
              options={[
                {
                  label: 'Unique',
                  options: [
                    { label: stripOptions[0], value: stripOptions[0] },
                    { label: stripOptions[1], value: stripOptions[1] },
                    { label: stripOptions[2], value: stripOptions[2] },
                  ],
                },
                {
                  label: 'Multiple',
                  options: [
                    { label: stripOptions[3], value: stripOptions[3] },
                    { label: stripOptions[4], value: stripOptions[4] },
                    { label: stripOptions[5], value: stripOptions[5] },
                  ],
                },
              ]}
              maxTagTextLength={7}
              maxTagCount={3}
              onSelect={(value) => {
                if (stripOptions.indexOf(value) < uniqueOptionIndex) {
                  onChange({ ...position, strip_data: makeStrips([value]) }, info);
                } else {
                  const strips = getStrips(position.strip_data);
                  if (stripOptions.some((v, i) => i < uniqueOptionIndex && strips.includes(v)))
                    onChange({ ...position, strip_data: makeStrips([value]) }, info);
                  else
                    onChange({ ...position, strip_data: makeStrips([...strips, value]) }, info);
                }
              }}
              onDeselect={(value) => {
                let newValue = makeStrips(getStrips(position.strip_data).filter((it) => it !== value));
                onChange({ ...position, strip_data: newValue.length ? newValue : [stripOptions[0]] }, info);
              }}
            />
          </Card>
        </Col>
        <Col span={24}> {/* SLAL-only flags */}
          <Card
            className="position-attribute-card position-slal-compat-card"
            size="small"
            title={'SLAL compatibility'}
            extra={
              <Tooltip className="tool-tip"
                title={
                  'Optional classic SLAL JSON flags for this position. Not used by SLSB/.slr playback — only written when exporting SLAL.'
                }
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            <Space wrap size="middle">
              {[
                { attr: 'open_mouth', label: 'Open Mouth' },
                { attr: 'silent', label: 'Silent' },
                { attr: 'strap_on', label: 'Strap-on' },
              ].map(({ attr, label }) => (
                <Checkbox
                  key={attr}
                  checked={!!position[attr]}
                  onChange={(e) => onChange({ ...position, [attr]: e.target.checked }, info)}
                >
                  {label}
                </Checkbox>
              ))}
            </Space>
          </Card>
        </Col>
        <Col span={24}> {/* OStim author fill-ins */}
          <Card
            className="position-attribute-card position-ostim-compat-card"
            size="small"
            title={'OStim compatibility'}
            extra={
              <Tooltip className="tool-tip"
                title={
                  'Optional OStim actor fields. Stored in the project JSON and written on OStim export. Not used by .slr playback — fill these when authoring or converting packs for OStim.'
                }
              >
                <Button type="text">Info</Button>
              </Tooltip>
            }
          >
            <Space direction="vertical" style={{ width: '100%' }} size="small">
              <Space wrap size="middle">
                <InputNumber
                  addonBefore="lookUp"
                  value={position.look_up ?? 0}
                  min={-100}
                  max={100}
                  onChange={(v) =>
                    onChange({ ...position, look_up: typeof v === 'number' ? v : 0 }, info)
                  }
                />
                <InputNumber
                  addonBefore="lookLeft"
                  value={position.look_left ?? 0}
                  min={-100}
                  max={100}
                  onChange={(v) =>
                    onChange({ ...position, look_left: typeof v === 'number' ? v : 0 }, info)
                  }
                />
                <InputNumber
                  addonBefore="animIndex"
                  placeholder="default"
                  value={
                    position.animation_index === null || position.animation_index === undefined
                      ? null
                      : position.animation_index
                  }
                  min={0}
                  max={8}
                  onChange={(v) =>
                    onChange(
                      {
                        ...position,
                        animation_index: typeof v === 'number' ? v : null,
                      },
                      info
                    )
                  }
                />
              </Space>
              <Input
                addonBefore="expression"
                placeholder="e.g. tongue (expressionOverride)"
                value={position.expression_override ?? ''}
                onChange={(e) =>
                  onChange({ ...position, expression_override: e.target.value }, info)
                }
              />
              <TokenAutoComplete
                addonBefore="equip"
                placeholder="OStim equip object types (space-separated)"
                value={position.equip_objects ?? ''}
                options={equipOptions}
                onChange={(v) =>
                  onChange({ ...position, equip_objects: v }, info)
                }
                onCommit={rememberEquip}
              />
            </Space>
          </Card>
        </Col>
      </Row>
    </div >
  );
};

export default PositionField;
