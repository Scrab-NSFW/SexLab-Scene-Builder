use std::path::PathBuf;
use crate::project::package::Package;

pub fn convert(
  args: std::collections::HashMap<String, tauri_plugin_cli::ArgData>,
) -> Result<(), String> {
  let in_path = match &args.get("in").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("input slal file not provided".to_string()),
  };
  if !in_path.exists() || !in_path.is_file() || in_path.extension().unwrap() != "json" {
      return Err("input slal file is invalid".to_string());
  }

  let mut out_path = match &args.get("out").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("output dir not provided".to_string()),
  };
  if !out_path.exists() || !out_path.is_dir() {
      return Err("output dir is invalid".to_string());
  }

  out_path.push(in_path.file_stem().unwrap());
  out_path.set_extension("slsb.json");
  println!("Converting {} to {}", in_path.display(), out_path.display());

  let mut project = Package::from_slal(in_path)?;
  project.write(out_path.clone())
}

pub fn convert_ostim(
  args: std::collections::HashMap<String, tauri_plugin_cli::ArgData>,
) -> Result<(), String> {
  let in_path = match &args.get("in").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("input OStim pack folder not provided".to_string()),
  };
  if !in_path.exists() || !in_path.is_dir() {
      return Err("input OStim path must be an existing folder".to_string());
  }

  let out_dir = match &args.get("out").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("output dir not provided".to_string()),
  };
  if !out_dir.exists() || !out_dir.is_dir() {
      return Err("output dir is invalid".to_string());
  }

  let mut project = Package::from_ostim(in_path.clone(), None)?;
  let mut out_path = out_dir.join(
    if project.pack_name.trim().is_empty() {
      "ostim_pack".to_string()
    } else {
      project.pack_name.clone()
    },
  );
  out_path.set_extension("slsb.json");
  println!(
    "Converting OStim pack {} to {}",
    in_path.display(),
    out_path.display()
  );
  project.write(out_path)?;

  let copy_hkx = args
    .get("hkx")
    .map(|a| matches!(a.value, serde_json::Value::Bool(true)))
    .unwrap_or(false);
  if copy_hkx {
    let n = project.copy_ostim_hkx_for_slsb(&in_path, &out_dir)?;
    println!("Copied/renamed {n} OStim HKX clip(s) for SLSB/FNIS naming");
  }
  Ok(())
}

pub fn build(
  args: std::collections::HashMap<String, tauri_plugin_cli::ArgData>,
) -> Result<(), String> {
  let in_path = match &args.get("in").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("input project file not provided".to_string()),
  };
  if !in_path.exists() || !in_path.is_file() || in_path.extension().unwrap() != "json" {
      return Err("input project file is invalid".to_string());
  }

  let out_dir = match &args.get("out").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("output dir not provided".to_string()),
  };
  if !out_dir.exists() || !out_dir.is_dir() {
      return Err("output dir is invalid".to_string());
  }

  let file = std::fs::File::open(&in_path).map_err(|e| e.to_string())?;
  let project = Package::from_file(file)?;
  let with_slal = args
    .get("slal")
    .map(|a| matches!(a.value, serde_json::Value::Bool(true)))
    .unwrap_or(false);
  let with_ostim = args
    .get("ostim")
    .map(|a| matches!(a.value, serde_json::Value::Bool(true)))
    .unwrap_or(false);

  project.build(out_dir.clone(), None).map_err(|e| e.to_string())?;
  if with_slal {
    project.write_slal_pack(&out_dir.join("SLAL"))?;
  }
  if with_ostim {
    let hkx = args
      .get("hkx")
      .and_then(|a| match &a.value {
        serde_json::Value::String(v) if !v.is_empty() => Some(PathBuf::from(v)),
        _ => None,
      });
    project.write_ostim_pack(&out_dir.join("OStim"), hkx.as_deref(), None)?;
  }
  Ok(())
}

pub fn export_slal(
  args: std::collections::HashMap<String, tauri_plugin_cli::ArgData>,
) -> Result<(), String> {
  let in_path = match &args.get("in").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("input project file not provided".to_string()),
  };
  if !in_path.exists() || !in_path.is_file() || in_path.extension().unwrap() != "json" {
      return Err("input project file is invalid".to_string());
  }

  let out_dir = match &args.get("out").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("output dir not provided".to_string()),
  };
  if !out_dir.exists() || !out_dir.is_dir() {
      return Err("output dir is invalid".to_string());
  }

  let file = std::fs::File::open(&in_path).map_err(|e| e.to_string())?;
  let project = Package::from_file(file)?;
  project.write_slal_pack(&out_dir)
}

pub fn export_ostim(
  args: std::collections::HashMap<String, tauri_plugin_cli::ArgData>,
) -> Result<(), String> {
  let in_path = match &args.get("in").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("input project file not provided".to_string()),
  };
  if !in_path.exists() || !in_path.is_file() || in_path.extension().unwrap() != "json" {
      return Err("input project file is invalid".to_string());
  }

  let out_dir = match &args.get("out").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("output dir not provided".to_string()),
  };
  if !out_dir.exists() || !out_dir.is_dir() {
      return Err("output dir is invalid".to_string());
  }

  let hkx = args
    .get("hkx")
    .and_then(|a| match &a.value {
      serde_json::Value::String(v) if !v.is_empty() => Some(PathBuf::from(v)),
      _ => None,
    });

  let file = std::fs::File::open(&in_path).map_err(|e| e.to_string())?;
  let project = Package::from_file(file)?;
  project.write_ostim_pack(&out_dir, hkx.as_deref(), None)
}

pub fn export_ostim_json(
  args: std::collections::HashMap<String, tauri_plugin_cli::ArgData>,
) -> Result<(), String> {
  let in_path = match &args.get("in").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("input project file not provided".to_string()),
  };
  if !in_path.exists() || !in_path.is_file() || in_path.extension().unwrap() != "json" {
      return Err("input project file is invalid".to_string());
  }

  let out_dir = match &args.get("out").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("output dir not provided".to_string()),
  };
  if !out_dir.exists() || !out_dir.is_dir() {
      return Err("output dir is invalid".to_string());
  }

  let scene_id = match args.get("scene").and_then(|a| match &a.value {
      serde_json::Value::String(v) if !v.is_empty() => Some(v.clone()),
      _ => None,
  }) {
      Some(id) => id,
      None => return Err("scene id not provided (use --scene)".to_string()),
  };

  let file = std::fs::File::open(&in_path).map_err(|e| e.to_string())?;
  let project = Package::from_file(file)?;
  let nid = crate::project::NanoID(scene_id);
  if !project.scenes.contains_key(&nid) {
      return Err(format!("scene {} not found in project", nid.0));
  }
  project.write_ostim_json_subset(&out_dir, &[nid], None)
}

pub fn generate_behaviors(
  args: std::collections::HashMap<String, tauri_plugin_cli::ArgData>,
) -> Result<(), String> {
  let in_path = match &args.get("in").unwrap().value {
      serde_json::Value::String(value) => PathBuf::from(value),
      _ => return Err("input dir not provided".to_string()),
  };
  if !in_path.exists() || !in_path.is_dir() {
      return Err("input dir is invalid".to_string());
  }
  let paths = crate::project::behavior_gen::generate_behaviors_under(&in_path)
    .map_err(|e| e.to_string())?;
  println!("Generated {} behavior file(s)", paths.len());
  for p in paths {
    println!("  {}", p.display());
  }
  Ok(())
}
