import { useState, useEffect } from "react";
import { Select } from "antd";
import { invoke } from "@tauri-apps/api/core"

function RaceSelect({ race, onSelect, raceKeys: raceKeysProp, ...raceSelectProps }) {
  const [raceKeysLocal, setRaceKeysLocal] = useState([]);
  const raceKeys = Array.isArray(raceKeysProp) ? raceKeysProp : raceKeysLocal;

  useEffect(() => {
    if (Array.isArray(raceKeysProp)) return;
    invoke('get_race_keys')
      .then((result) => {
        setRaceKeysLocal(Array.isArray(result) ? result : []);
      })
      .catch(() => {
        setRaceKeysLocal([]);
      });
  }, [raceKeysProp]);

  return (
    <Select
      className="position-race-select"
      value={race}
      showSearch
      placeholder="Race"
      optionFilterProp="children"
      filterOption={(input, option) =>
        (option?.label ?? '').includes(input)
      }
      filterSort={(optionA, optionB) =>
        (optionA?.label ?? '')
          .toLowerCase()
          .localeCompare((optionB?.label ?? '').toLowerCase())
      }
      options={raceKeys.map((key) => {
        return { value: key, label: key };
      })}
      onSelect={(value) => {
        onSelect(value);
      }}
      {...raceSelectProps}
    />
  );
}

export default RaceSelect;
