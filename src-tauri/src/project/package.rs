use log::info;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufReader, BufWriter, ErrorKind, Write},
    mem::size_of,
    path::PathBuf,
    vec,
};
use tauri_plugin_dialog::DialogExt;

use crate::{
    project::{
        define::{Node, Sex},
        position::Position,
        serialize::{make_fnis_lines, map_race_to_folder},
    },
    racekeys::map_legacy_to_racekey,
};

use super::{scene::Scene, serialize::EncodeBinary, stage::Stage, NanoID};

const VERSION: u8 = 4; // current version

#[derive(Debug, Serialize, Deserialize)]
pub struct Package {
    #[serde(default)]
    pub version: u8,
    #[serde(skip)]
    pub pack_path: PathBuf,

    pub pack_name: String,
    pub pack_author: String,
    pub prefix_hash: NanoID,
    pub scenes: HashMap<NanoID, Scene>,
}

impl Package {
    pub fn new() -> Self {
        Self {
            version: VERSION, // current version
            pack_path: Default::default(),
            pack_name: Default::default(),
            pack_author: "Unknown".into(),
            prefix_hash: NanoID::new_prefix(),
            scenes: HashMap::new(),
        }
    }

    pub fn from_file(file: std::fs::File) -> Result<Package, String> {
        serde_json::from_reader(BufReader::new(file))
            .map_err(|e| e.to_string())
            .and_then(|mut package: Package| {
                if package.version < VERSION {
                    package.update_to_latest_version()?;
                }
                info!("Loaded project {}", package.pack_name);
                Ok(package)
            })
    }

    fn update_to_latest_version(&mut self) -> Result<(), String> {
        for (_, scene) in &mut self.scenes {
            if let Err(e) = scene.update_to_latest_version(self.version) {
                return Err(format!("Failed to update scene {}: {}", scene.id.0, e));
            }
        }
        self.version = VERSION;
        Ok(())
    }

    pub fn reset(&mut self) -> &Self {
        *self = Self::new();
        self
    }

    pub fn save_scene(&mut self, scene: Scene) -> &Scene {
        let id = scene.id.clone();
        info!("Saving or inserting Scene: {} / {}", id.0, scene.name);
        self.scenes.insert(id.clone(), scene);
        self.scenes.get(&id).unwrap()
    }

    pub fn discard_scene(&mut self, id: &NanoID) -> Option<Scene> {
        self.scenes.remove(id).map(|s| {
            info!("Deleting Scene: {} / {}", id.0, s.name);
            s
        })
    }

    pub fn get_scene(&self, id: &NanoID) -> Option<&Scene> {
        self.scenes.get(id)
    }

    pub fn get_scene_mut(&mut self, id: &NanoID) -> Option<&mut Scene> {
        self.scenes.get_mut(id)
    }

    pub fn get_stage(&self, id: &NanoID) -> Option<&Stage> {
        for (_, scene) in &self.scenes {
            let stage = scene.get_stage(id);
            if stage.is_some() {
                return stage;
            }
        }
        None
    }

    pub fn load_project(&mut self, app: &tauri::AppHandle) -> Result<(), String> {
        let path = app
            .dialog()
            .file()
            .add_filter("SexLab Project", &["slsb.json"])
            .blocking_pick_file()
            .ok_or("No path to load project from".to_string())?
            .into_path()
            .map_err(|e| e.to_string())?;
        *self = Package::from_file(fs::File::open(&path).map_err(|e| e.to_string())?)?;
        self.set_project_name_from_path(&path);
        self.pack_path = path.into();
        Ok(())
    }

    pub fn save_project(&mut self, save_as: bool, app: &tauri::AppHandle) -> Result<(), String> {
        let path = if save_as || !self.pack_path.exists() || self.pack_path.is_dir() {
            app.dialog()
                .file()
                .set_title("Save Project")
                .set_file_name(&self.pack_name)
                .add_filter("SexLab Project", &["slsb.json"])
                .blocking_save_file()
                .ok_or("No path to save project to".to_string())?
                .into_path()
                .map_err(|e| e.to_string())?
        } else {
            self.pack_path.clone()
        };

        self.set_project_name_from_path(&path);
        self.write(path)
    }

    pub fn write(&mut self, path: PathBuf) -> Result<(), String> {
        let file = fs::File::create(&path).map_err(|e| e.to_string())?;
        serde_json::to_writer(file, self).map_err(|e| e.to_string())?;
        println!("Saved project {}", self.pack_name);
        Ok(())
    }

    pub fn load_slal(&mut self, app: &tauri::AppHandle) -> Result<(), String> {
        let path = app
            .dialog()
            .file()
            .set_title("Load SLAL File")
            .add_filter("SLAL.json", &["json"])
            .blocking_pick_file()
            .ok_or("No path to load slal file from".to_string())?
            .into_path()
            .map_err(|e| e.to_string())?;

        Package::from_slal(path).map(|prjct| *self = prjct)
    }

    pub fn from_slal(path: PathBuf) -> Result<Package, String> {
        let file = fs::File::open(&path).map_err(|e| e.to_string())?;

        let slal: serde_json::Value =
            serde_json::from_reader(BufReader::new(file)).map_err(|e| e.to_string())?;

        let mut prjct = Package::new();
        prjct.version = 0; // SLAL files are always version 0
        prjct.pack_name = slal["name"]
            .as_str()
            .ok_or("Missing name attribute")?
            .into();

        let anims = slal["animations"]
            .as_array()
            .ok_or("Missing animations attribute")?;
        for animation in anims {
            let mut scene = Scene::default();
            scene.name = animation["name"]
                .as_str()
                .ok_or("Missing name attribute")?
                .into();
            let crt_race = animation["creature_race"].as_str().unwrap_or_default();
            let actors = animation["actors"]
                .as_array()
                .ok_or("Missing actors attribute")?;

            // initialize stages and copy information for every position into the respective stage
            for (n, position) in actors.iter().enumerate() {
                let sex = position["type"].as_str().unwrap_or("male").to_lowercase();
                let events = position["stages"]
                    .as_array()
                    .ok_or("Missing stages attribute")?;

                if scene.stages.is_empty() {
                    for _ in 0..events.len() {
                        scene.stages.push(Stage::new(&scene));
                    }
                    if scene.stages.is_empty() {
                        return Err("Scene has no stages".into());
                    }
                    for stage in &mut scene.stages {
                        stage.positions = vec![Position::new(None); actors.len()];
                    }
                }
                for (i, evt) in events.iter().enumerate() {
                    let edit_position = &mut scene.stages[i].positions[n];
                    edit_position.event =
                        vec![evt["id"].as_str().ok_or("Missing id attribute")?.into()];
                    match sex.as_str() {
                        "male" | "type" => {
                            edit_position.sex = Sex {
                                male: true,
                                female: false,
                                futa: false,
                            };
                            edit_position.race = "Human".into();
                        }
                        "female" => {
                            edit_position.sex = Sex {
                                male: false,
                                female: true,
                                futa: false,
                            };
                            edit_position.race = "Human".into();
                        }
                        "creaturemale" => {
                            edit_position.sex = Sex {
                                male: true,
                                female: false,
                                futa: false,
                            };
                            edit_position.race = map_legacy_to_racekey(
                                position["race"].as_str().unwrap_or(crt_race),
                            )?;
                        }
                        "creaturefemale" => {
                            edit_position.sex = Sex {
                                male: false,
                                female: true,
                                futa: false,
                            };
                            edit_position.race = map_legacy_to_racekey(
                                position["race"].as_str().unwrap_or(crt_race),
                            )?;
                        }
                        _ => {
                            return Err(format!("Unrecognized gender: {}", sex));
                        }
                    }
                }
            }
            // finalize stage data, adding climax to last positions
            let tags = animation["tags"]
                .as_str()
                .and_then(|tags| {
                    let list = tags
                        .to_lowercase()
                        .split(',')
                        .map(|str| str.trim().to_string())
                        .collect::<Vec<_>>();
                    Some(list)
                })
                .unwrap_or_default();
            let stage_extra = animation["stage"].as_array();
            for (i, stage) in scene.stages.iter_mut().enumerate() {
                stage.tags = tags.clone();
                if let Some(extra_vec) = stage_extra {
                    for extra in extra_vec {
                        let n = extra["number"].as_i64().unwrap_or(-1);
                        if n == -1 || n as usize != i {
                            continue;
                        }
                        stage.extra.fixed_len = extra["timer"].as_f64().unwrap_or_default() as f32;
                    }
                }
            }
            let last = scene.stages.last_mut().unwrap();
            for position in &mut last.positions {
                position.extra.climax = true;
            }
            // build graph
            scene.root = scene.stages[0].id.clone();
            let mut prev_id: Option<NanoID> = None;
            for stage in scene.stages.iter_mut().rev() {
                let mut value = Node::default();
                if let Some(id) = prev_id {
                    value.dest = vec![id];
                }
                scene.graph.insert(stage.id.clone(), value);
                prev_id = Some(stage.id.clone());
            }
            // add to prjct
            prjct.scenes.insert(scene.id.clone(), scene);
        }
        println!(
            "Loaded {} Animations from {}",
            prjct.scenes.len(),
            path.to_str().unwrap_or_default()
        );
        prjct.update_to_latest_version()?;
        Ok(prjct)
    }

    pub fn export(&self, app: &tauri::AppHandle) -> Result<(), std::io::Error> {
        let path = app
            .dialog()
            .file()
            .set_title("Export Project")
            .set_file_name(&self.pack_name)
            .blocking_pick_folder()
            .ok_or(std::io::Error::from(ErrorKind::NotFound))?
            .into_path()
            .map_err(|e| std::io::Error::new(ErrorKind::Other, e))?;

        self.build(path)
    }

    pub fn build(&self, root_dir: PathBuf) -> Result<(), std::io::Error> {
        println!("Compiling project {}", self.pack_name);
        self.write_binary_file(&root_dir)?;
        self.write_fnis_files(&root_dir)?;
        info!(
            "Successfully compiled {}",
            root_dir.to_str().unwrap_or_default()
        );
        Ok(())
    }

    pub fn import_offset(&mut self, app: &tauri::AppHandle) -> Result<(), String> {
        let path = app
            .dialog()
            .file()
            .set_title("Import Offsets")
            .add_filter("Offset File", &["yaml", "yml"])
            .blocking_pick_file()
            .ok_or("No path to load offsets from".to_string())?
            .into_path()
            .map_err(|e| e.to_string())?;
        let file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let offsetfile: serde_yaml::Mapping =
            serde_yaml::from_reader(BufReader::new(file)).map_err(|e| e.to_string())?;

        for (scene_id_v, stages_v) in offsetfile {
            if !stages_v.is_mapping() {
                continue;
            }
            let scene_id = scene_id_v
                .as_str()
                .ok_or("Not a valid offset file, expected string for scene id".to_string())?
                .to_string();
            if let Some(scene) = self.get_scene_mut(&NanoID(scene_id.clone())) {
                scene.import_offset(
                    stages_v
                        .as_mapping()
                        .ok_or(format!("Expected mapping in scene {}", scene_id))?,
                )?;
            }
        }

        Ok(())
    }

    fn set_project_name_from_path(&mut self, path: &PathBuf) -> () {
        self.pack_name = String::from(
            path.file_name() // ...\\{project.slsb.json}
                .and_then(|name| name.to_str())
                .and_then(|str| {
                    let ret = &str[0..str.find(".slsb.json").unwrap_or(str.len())];
                    Some(ret)
                })
                .unwrap_or_default(),
        );
    }

    fn write_binary_file(&self, root_dir: &PathBuf) -> Result<(), std::io::Error> {
        let target_dir = root_dir.join("SKSE\\SexLab\\Registry\\");
        let project_name = format!(
            "{}.slr",
            if self.pack_name.is_empty() {
                &self.prefix_hash.0
            } else {
                &self.pack_name
            }
        );
        let mut buf: Vec<u8> = Vec::new();
        buf.reserve(self.get_byte_size());
        info!(
            "Writing binary file for project {} with size {} at {}",
            project_name,
            buf.capacity(),
            target_dir.to_str().unwrap_or("Unknown path")
        );
        self.write_byte(&mut buf);
        fs::create_dir_all(&target_dir)?;
        fs::File::create(target_dir.join(project_name))?.write(&buf)?;
        Ok(())
    }

    fn write_fnis_files(&self, root_dir: &PathBuf) -> Result<(), std::io::Error> {
        let mut events: HashMap<&str, Vec<String>> = HashMap::new(); // map<RaceKey, Lines[]>
        let mut control: HashSet<&str> = HashSet::from(["__BLANK__", "__DEFAULT__"]);
        for (_, scene) in &self.scenes {
            if scene.has_warnings {
                continue;
            }
            assert_eq!(
                scene
                    .stages
                    .first()
                    .expect(&format!("Scene {} has 0 Stages", scene.id.0))
                    .positions
                    .len(),
                scene.positions.len()
            );
            for stage in &scene.stages {
                for i in 0..stage.positions.len() {
                    let stage_position = &stage.positions[i];
                    let scene_position = &scene.positions[i];
                    let event = &stage_position.event[0];
                    if control.contains(event.as_str()) {
                        continue;
                    }
                    control.insert(event);
                    let lines = make_fnis_lines(
                        &stage_position.event,
                        &self.prefix_hash.0,
                        stage.extra.fixed_len > 0.0,
                        &stage_position
                            .anim_obj
                            .split(',')
                            .fold(vec![], |mut acc, x| {
                                if !x.is_empty() {
                                    acc.push(x.to_string());
                                }
                                acc
                            }),
                    );
                    let mut insert = |race| {
                        events
                            .entry(race)
                            .and_modify(|list| list.append(&mut lines.clone()))
                            .or_insert(lines.clone());
                    };
                    let race = scene_position.race.as_str();
                    match race {
                        "Canine" => {
                            insert(&race);
                            insert("Dog");
                            insert("Wolf");
                        }
                        "Dog" | "Wolf" => {
                            insert(&race);
                            insert("Canine");
                        }
                        "Chaurus" | "Chaurus Reaper" => insert("Chaurus"),
                        "Spider" | "Large Spider" | "Giant Spider" => insert("Spider"),
                        "Boar" | "Boar (Mounted)" | "Boar (Any)" => insert("Boar (Any)"),
                        _ => insert(&race),
                    }
                }
            }
        }
        info!("---------------------------------------------------------");
        for (racekey, anim_events) in events {
            let target_folder = map_race_to_folder(racekey)
                .expect(format!("Cannot find folder for RaceKey {}", racekey).as_str());
            let path = root_dir.join(format!(
                "meshes\\actors\\{}\\animations\\{}",
                target_folder, self.pack_name
            ));
            let crt = &target_folder[target_folder
                .find('\\')
                .and_then(|w| Some(w + 1))
                .unwrap_or(0)..];
            fs::create_dir_all(&path)?;

            let create = |file_path: PathBuf| -> Result<(), std::io::Error> {
                let name = file_path.to_str().unwrap_or("NONE".into()).to_string();
                let file = fs::File::create(file_path)?;
                let mut file = BufWriter::new(file);
                info!(
                    "Adding {} lines to race {} |||||| file: {}",
                    anim_events.len(),
                    racekey,
                    name
                );
                for anim_event in anim_events {
                    writeln!(file, "{}", anim_event)?;
                }
                Ok(())
            };
            match crt {
                "character" => create(path.join(format!("FNIS_{}_List.txt", self.pack_name))),
                "canine" => match racekey {
                    "Canine" => {
                        create(path.join(format!("FNIS_{}_canine_List.txt", self.pack_name)))
                    }
                    "Dog" => create(path.join(format!("FNIS_{}_dog_List.txt", self.pack_name))),
                    _ => create(path.join(format!("FNIS_{}_wolf_List.txt", self.pack_name))),
                },
                _ => create(path.join(format!("FNIS_{}_{}_List.txt", self.pack_name, crt))),
            }?;
        }
        info!("---------------------------------------------------------");
        Ok(())
    }
}

impl EncodeBinary for Package {
    fn get_byte_size(&self) -> usize {
        self.version.get_byte_size()
            + self.pack_name.get_byte_size()
            + self.pack_author.get_byte_size()
            + self.prefix_hash.get_byte_size()
            + self
                .scenes
                .iter()
                .filter(|(_, scene)| !scene.has_warnings && !scene.stages.is_empty())
                .fold(size_of::<u64>(), |acc, (_, scene)| {
                    acc + scene.get_byte_size()
                })
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        self.version.write_byte(buf);
        self.pack_name.write_byte(buf);
        self.pack_author.write_byte(buf);
        self.prefix_hash.write_byte(buf);
        buf.extend_from_slice(&(self.scenes.len() as u64).to_be_bytes());
        self.scenes
            .iter()
            .filter(|(_, scene)| !scene.has_warnings && !scene.stages.is_empty())
            .for_each(|(_, scene)| scene.write_byte(buf));
    }
}
