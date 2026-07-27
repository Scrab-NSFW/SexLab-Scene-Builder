#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
mod cli;
mod furniture;
mod project;
mod racekeys;
mod window_geometry;

use log::{error, info};
use once_cell::sync::Lazy;
use project::{package::{AssetLibrary, ExportFormats, Package}, position::Position, progress::JobProgress, scene::Scene, stage::Stage, NanoID};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, SubmenuBuilder},
    AppHandle, Emitter, Listener, Manager, Runtime, Theme, WebviewWindowBuilder, Wry,
};
use tauri_plugin_cli::CliExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::project::position_info::PositionInfo;

const DEFAULT_MAINWINDOW_TITLE: &str = "SexLab Scene Builder";

#[derive(Debug, Serialize, Clone)]
struct ProjectUpdatePayload<'a> {
    scenes: &'a indexmap::IndexMap<NanoID, Scene>,
    pack_name: &'a str,
    pack_author: &'a str,
    pack_version: &'a str,
    asset_library: &'a AssetLibrary,
}

fn emit_project_update<R: Runtime>(emitter: &impl Emitter<R>, prjct: &Package) {
    let payload = ProjectUpdatePayload {
        scenes: &prjct.scenes,
        pack_name: &prjct.pack_name,
        pack_author: &prjct.pack_author,
        pack_version: &prjct.pack_version,
        asset_library: &prjct.asset_library,
    };
    if let Err(e) = emitter.emit("on_project_update", &payload) {
        error!("Failed to emit on_project_update: {}", e);
    }
}

fn export_tip_pref_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join("SexLabSceneBuilder").join("hide_export_clip_tip"))
}

fn is_export_clip_tip_hidden() -> bool {
    export_tip_pref_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

fn set_export_clip_tip_hidden(hidden: bool) {
    let Some(path) = export_tip_pref_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, if hidden { "1" } else { "0" });
}

fn export_merge_warn_pref_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join("SexLabSceneBuilder").join("hide_export_merge_warn"))
}

fn is_export_merge_warn_hidden() -> bool {
    export_merge_warn_pref_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

fn set_export_merge_warn_hidden(hidden: bool) {
    let Some(path) = export_merge_warn_pref_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, if hidden { "1" } else { "0" });
}

fn run_export(app: AppHandle, formats: ExportFormats) {
    if !formats.any() {
        app.dialog()
            .message("Select at least one format to export.")
            .title("Export")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::Ok)
            .show(|_| {});
        return;
    }
    tauri::async_runtime::spawn(async move {
        let (pack_root, write_roots, fnis_mod) = {
            let prjct = PROJECT.lock().unwrap();
            match prjct.pick_export_paths_for(&app, formats) {
                Ok((root, roots)) => (root, roots, prjct.fnis_mod_name()),
                Err(err) => {
                    if err != "Export cancelled" {
                        error!("Failed to export project: {}", err);
                        app.dialog()
                            .message(&err)
                            .title("Export failed")
                            .kind(MessageDialogKind::Error)
                            .buttons(MessageDialogButtons::Ok)
                            .show(|_| {});
                    }
                    return;
                }
            }
        };

        let would_merge = write_roots
            .iter()
            .any(|p| project::package::dir_nonempty(p));
        if would_merge && !is_export_merge_warn_hidden() {
            let message = if formats.ostim && !formats.slsb && !formats.slal {
                format!(
                    "Export writes into a subfolder named {fnis_mod}. That folder already has files.\n\n\
                     OStim export will merge: only changed scene JSON is rewritten, missing HKX \
                     are copied, and new animlist lines are appended. Other files are kept.\n\n\
                     Continue?"
                )
            } else {
                format!(
                    "Export writes into a subfolder named {fnis_mod} and merges with anything already there.\n\n\
                     The pack folder is not deleted. Matching generated files (AnimLists, Behavior, \
                     registry, scene JSON) are overwritten. Other files already in the folder \
                     (such as .hkx animation clips) are kept.\n\n\
                     Continue?"
                )
            };
            let proceed = app
                .dialog()
                .message(message)
                .title("Export merge")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Continue".into(),
                    "Cancel".into(),
                ))
                .blocking_show();
            if !proceed {
                return;
            }
            let hide = app
                .dialog()
                .message("Don't warn about export overwrites again?")
                .title("Export merge")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::YesNo)
                .blocking_show();
            if hide {
                set_export_merge_warn_hidden(true);
            }
        }

        let result = {
            let title = formats.label();
            let progress = JobProgress::new(Some(&app), "export", &title);
            progress.start("Exporting pack…");
            let result = {
                let prjct = PROJECT.lock().unwrap();
                prjct.export_formats_into(&pack_root, formats, Some(&progress))
            };
            match &result {
                Ok(()) => progress.done(),
                Err(err) if err == "Export cancelled" => {}
                Err(err) => progress.fail(err),
            }
            result
        };
        if let Err(err) = result {
            if err == "Export cancelled" {
                return;
            }
            error!("Failed to export project: {}", err);
            app.dialog()
                .message(&err)
                .title("Export failed")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::Ok)
                .show(|_| {});
        }
    });
}

/// Show the Pandora clip-folder tip when SexLab formats are included, then open the picker.
fn start_export_with_tip(app: &AppHandle, formats: ExportFormats) {
    if !formats.slsb && !formats.slal {
        run_export(app.clone(), formats);
        return;
    }
    if is_export_clip_tip_hidden() {
        run_export(app.clone(), formats);
        return;
    }

    let fnis_mod = PROJECT.lock().unwrap().fnis_mod_name();
    let message = format!(
        "Export writes into a subfolder named {fnis_mod} under the folder you pick.\n\n\
         It writes AnimLists, Behavior files, and registry data into that pack folder.\n\
         Existing matching generated files are overwritten; other files already there \
         (such as .hkx clips) are kept — the folder is not wiped.\n\n\
         If this project was imported from OStim, matching .hkx clips are copied automatically \
         using the event names on each stage.\n\n\
         Otherwise, place animation HKX files in:\n\
         meshes/actors/<race>/animations/{fnis_mod}/\n\n\
         For humans that is usually:\n\
         meshes/actors/character/animations/{fnis_mod}/\n\n\
         Pandora only plays clips that live in the folder the Behavior references."
    );

    let app_continue = app.clone();
    app.dialog()
        .message(message)
        .title("Animation clips for Pandora")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Continue".into(),
            "Cancel".into(),
        ))
        .show(move |proceed| {
            if !proceed {
                return;
            }
            let app_hide = app_continue.clone();
            app_continue
                .dialog()
                .message("Don't show this tip again on export?")
                .title("Export tip")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::YesNo)
                .show(move |hide| {
                    if hide {
                        set_export_clip_tip_hidden(true);
                    }
                    run_export(app_hide, formats);
                });
        });
}

pub static PROJECT: Lazy<Mutex<Package>> = Lazy::new(|| {
    let prjct = Package::new();
    Mutex::new(prjct)
});

static EDITED: AtomicBool = AtomicBool::new(false);
#[inline]
fn set_edited(val: bool) -> () {
    EDITED.store(val, Ordering::Relaxed)
}
#[inline]
fn get_edited() -> bool {
    EDITED.load(Ordering::Relaxed)
}

static IS_DARKMODE: AtomicBool = AtomicBool::new(false);
#[inline]
fn set_darkmode(val: bool) -> () {
    IS_DARKMODE.store(val, Ordering::Relaxed)
}
#[inline]
fn get_darkmode() -> bool {
    IS_DARKMODE.load(Ordering::Relaxed)
}

static FOLLOW_OS_THEME: AtomicBool = AtomicBool::new(true);
#[inline]
fn set_follow_os_theme(val: bool) {
    FOLLOW_OS_THEME.store(val, Ordering::Relaxed)
}
#[inline]
fn get_follow_os_theme() -> bool {
    FOLLOW_OS_THEME.load(Ordering::Relaxed)
}

/// Cached OS dark/light. After forced Light, Tao's theme() can still report Light
/// until the stripped GTK name is restored — needed when returning to System.
static LAST_OS_DARK: AtomicBool = AtomicBool::new(false);
#[inline]
fn set_last_os_dark(val: bool) {
    LAST_OS_DARK.store(val, Ordering::Relaxed)
}
#[inline]
fn get_last_os_dark() -> bool {
    LAST_OS_DARK.load(Ordering::Relaxed)
}

#[cfg(target_os = "linux")]
static SAVED_GTK_THEME: Mutex<Option<String>> = Mutex::new(None);

#[cfg(target_os = "linux")]
const GTK_DARK_SUFFIXES: &[&str] = &["-dark", "-Dark", ":dark", "-darker", "-Darker"];

fn theme_for(is_dark: bool) -> Theme {
    if is_dark {
        Theme::Dark
    } else {
        Theme::Light
    }
}

fn set_menu_checked<R: Runtime>(submenu: &tauri::menu::Submenu<R>, id: &str, checked: bool) {
    if let Some(item) = submenu.get(id) {
        if let Some(check) = item.as_check_menuitem() {
            let _ = check.set_checked(checked);
        }
    }
}

fn theme_submenu_from_menu<R: Runtime>(menu: &Menu<R>) -> Option<tauri::menu::Submenu<R>> {
    let items = menu.items().ok()?;
    for item in items {
        let Some(view) = item.as_submenu() else {
            continue;
        };
        if view.get(THEME_SYSTEM).is_some() {
            return Some(view.clone());
        }
        if let Ok(subs) = view.items() {
            for sub in subs {
                if let Some(theme_menu) = sub.as_submenu() {
                    if theme_menu.get(THEME_SYSTEM).is_some() {
                        return Some(theme_menu.clone());
                    }
                }
            }
        }
    }
    None
}

fn update_theme_menu<R: Runtime>(app: &AppHandle<R>) {
    // Menu is attached to the main window, not the app handle.
    let menu = app
        .get_webview_window(MAIN_WINDOW)
        .and_then(|w| w.menu())
        .or_else(|| app.menu());
    let Some(menu) = menu else {
        return;
    };
    let Some(theme_menu) = theme_submenu_from_menu(&menu) else {
        return;
    };

    let follow = get_follow_os_theme();
    let is_dark = get_darkmode();
    set_menu_checked(&theme_menu, THEME_SYSTEM, follow);
    set_menu_checked(&theme_menu, THEME_LIGHT, !follow && !is_dark);
    set_menu_checked(&theme_menu, THEME_DARK, !follow && is_dark);
}

#[cfg(target_os = "linux")]
fn restore_saved_gtk_theme(settings: &gtk::Settings) {
    use gtk::prelude::GtkSettingsExt;
    if let Ok(mut saved) = SAVED_GTK_THEME.lock() {
        if let Some(name) = saved.take() {
            settings.set_gtk_theme_name(Some(name.as_str()));
        }
    }
}

#[cfg(target_os = "linux")]
fn apply_linux_gtk_theme(follow_os: bool, is_dark: bool) {
    use gtk::prelude::GtkSettingsExt;

    let Some(settings) = gtk::Settings::default() else {
        return;
    };

    if follow_os || is_dark {
        settings.set_gtk_application_prefer_dark_theme(is_dark);
        restore_saved_gtk_theme(&settings);
        return;
    }

    // Tao's set_theme(Light) only clears prefer-dark; strip *-dark for light CSD.
    settings.set_gtk_application_prefer_dark_theme(false);
    if let Some(theme) = settings.gtk_theme_name() {
        let name = theme.as_str();
        if let Some(base) = GTK_DARK_SUFFIXES
            .iter()
            .find_map(|suffix| name.strip_suffix(suffix))
        {
            if let Ok(mut saved) = SAVED_GTK_THEME.lock() {
                if saved.is_none() {
                    *saved = Some(name.to_string());
                }
            }
            settings.set_gtk_theme_name(Some(base));
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_linux_gtk_theme(_follow_os: bool, _is_dark: bool) {}

fn apply_window_chrome_theme<R: Runtime>(app: &AppHandle<R>, follow_os: bool, is_dark: bool) {
    let theme = if follow_os {
        None
    } else {
        Some(theme_for(is_dark))
    };
    app.set_theme(theme);
    for window in app.webview_windows().values() {
        let _ = window.set_theme(theme);
    }
    apply_linux_gtk_theme(follow_os, is_dark);
}

fn apply_color_theme<R: Runtime>(app: &AppHandle<R>, is_dark: bool, follow_os: bool) {
    set_follow_os_theme(follow_os);
    set_darkmode(is_dark);
    apply_window_chrome_theme(app, follow_os, is_dark);
    update_theme_menu(app);
    if let Err(err) = app.emit("toggle_darkmode", is_dark) {
        error!("Unable to emit theme change: {}", err);
    }
}

/// Restore GTK before clearing preferred_theme so theme() can see *-dark again.
fn apply_system_theme<R: Runtime>(app: &AppHandle<R>) {
    let cached_os_dark = get_last_os_dark();
    apply_linux_gtk_theme(true, cached_os_dark);
    app.set_theme(None);
    for window in app.webview_windows().values() {
        let _ = window.set_theme(None);
    }
    let os_dark = app
        .get_webview_window(MAIN_WINDOW)
        .and_then(|w| w.theme().ok())
        .map(|t| matches!(t, Theme::Dark))
        .unwrap_or(cached_os_dark);
    set_last_os_dark(os_dark);
    apply_color_theme(app, os_dark, true);
}

fn apply_os_theme_event<R: Runtime>(app: &AppHandle<R>, theme: Theme) {
    let is_dark = matches!(theme, Theme::Dark);
    if !get_follow_os_theme() {
        // Re-assert forced chrome; do not treat this as an OS theme sample.
        apply_window_chrome_theme(app, false, get_darkmode());
        return;
    }
    set_last_os_dark(is_dark);
    if get_darkmode() == is_dark {
        update_theme_menu(app);
        return;
    }
    set_darkmode(is_dark);
    update_theme_menu(app);
    if let Err(err) = app.emit("toggle_darkmode", is_dark) {
        error!("Unable to emit OS theme change: {}", err);
    }
}

fn sync_theme_from_window<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    match window.theme() {
        Ok(theme) => {
            if get_follow_os_theme() {
                apply_os_theme_event(window.app_handle(), theme);
            } else {
                apply_window_chrome_theme(window.app_handle(), false, get_darkmode());
            }
        }
        Err(err) => error!("Unable to read window theme: {}", err),
    }
}

fn setup_logger() -> Result<(), fern::InitError> {
    let mut dispatch = fern::Dispatch::new()
        .format(|out, message, record| out.finish(format_args!("[{}] {}", record.level(), message)))
        .level(log::LevelFilter::Info)
        .chain(std::io::stdout());

    // Try to create log file in user's data directory, fall back to stdout-only if not possible
    if let Some(data_dir) = dirs::data_local_dir() {
        let log_dir = data_dir.join("SexLabSceneBuilder");
        if std::fs::create_dir_all(&log_dir).is_ok() {
            let log_path = log_dir.join("SceneBuilder.log");
            if let Ok(log_file) = fern::log_file(&log_path) {
                dispatch = dispatch.chain(log_file);
            }
        }
    }

    dispatch.apply()?;
    Ok(())
}

/// MAIN

const MAIN_WINDOW: &str = "main_window";

const NEW_PROJECT: &str = "new_prjct";
const OPEN_PROJECT: &str = "open_prjct";
const IMPORT_SLAL: &str = "import_slal";
const IMPORT_OSTIM: &str = "import_ostim";
const IMPORT_ASSET_LIBRARY: &str = "import_asset_library";
const MANAGE_ASSET_LIBRARY: &str = "manage_asset_library";
const ENRICH_SLANIM: &str = "enrich_slanim";
const ENRICH_FNIS: &str = "enrich_fnis";
const THEME_SYSTEM: &str = "theme_system";
const THEME_LIGHT: &str = "theme_light";
const THEME_DARK: &str = "theme_dark";

fn save_and_exit<R: Runtime>(app: &AppHandle<R>) {
    window_geometry::save_all_window_geometry(app);
    app.exit(0);
}

fn main() {
    setup_logger().expect("Unable to initialize logger");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_cli::init())
        .invoke_handler(tauri::generate_handler![
            request_project_update,
            set_pack_name,
            set_pack_author,
            set_pack_version,
            get_race_keys,
            create_blank_scene,
            save_scene,
            delete_scene,
            open_stage_editor,
            open_stage_editor_from,
            stage_save_and_close,
            export_ostim_scene_json,
            start_pack_export,
            make_position,
            mark_as_edited,
            get_in_darkmode,
            write_export_file,
            set_asset_library,
            replace_asset_library
        ])
        .setup(|app| {
            let matches = app.cli().matches()?;
            if let Some(command) = matches.subcommand {
                let res = match command.name.as_str() {
                    "convert" => cli::convert(command.matches.args),
                    "convert-ostim" => cli::convert_ostim(command.matches.args),
                    "build" => cli::build(command.matches.args),
                    "export-slal" => cli::export_slal(command.matches.args),
                    "export-ostim" => cli::export_ostim(command.matches.args),
                    "export-ostim-json" => cli::export_ostim_json(command.matches.args),
                    "generate-behaviors" => cli::generate_behaviors(command.matches.args),
                    _ => Err(format!("Unrecognized subcommand: {}", command.name)),
                };
                if let Err(e) = &res {
                    error!("Error while processing CLI command: {}", e);
                }
                // Exit here so CLI never falls through into the GTK event loop
                // (needed for headless generate-behaviors / CI smoke tests).
                std::process::exit(res.is_err() as i32);
            }
            let main_window = WebviewWindowBuilder::new(
                app.app_handle(),
                MAIN_WINDOW.to_string(),
                tauri::WebviewUrl::App("./index.html".into()),
            )
            .title(DEFAULT_MAINWINDOW_TITLE)
            .menu(get_menu(&app.app_handle()).expect("Failed to create menu"))
            .min_inner_size(800.0, 500.0)
            .inner_size(1280.0, 720.0)
            .build()
            .expect("Failed to create main window");
            window_geometry::restore_window_geometry(&main_window);
            set_follow_os_theme(true);
            app.app_handle().set_theme(None);
            sync_theme_from_window(&main_window);
            app.on_menu_event(menu_event_listener);
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::ThemeChanged(theme) => {
                    apply_os_theme_event(window.app_handle(), *theme);
                }
                tauri::WindowEvent::CloseRequested { api, .. }
                    if window.label() == MAIN_WINDOW =>
                {
                    // Always prevent first — blocking dialogs on the GTK main thread
                    // freeze the app on Linux (especially after a second webview existed).
                    api.prevent_close();
                    let app = window.app_handle().clone();
                    if get_edited() {
                        app.dialog()
                            .message(
                                "There are unsaved changes. Are you sure you want to close?",
                            )
                            .title("Close")
                            .buttons(MessageDialogButtons::YesNo)
                            .kind(MessageDialogKind::Warning)
                            .show(move |should_close| {
                                if should_close {
                                    save_and_exit(&app);
                                }
                            });
                    } else {
                        save_and_exit(&app);
                    }
                }
                tauri::WindowEvent::CloseRequested { .. }
                    if window.label() == STAGE_EDITOR_LABEL
                        || window.label().starts_with("stage_editor_") =>
                {
                    window_geometry::save_window_geometry_by_label(
                        window.app_handle(),
                        window.label(),
                    );
                }
                tauri::WindowEvent::Destroyed
                    if window.label() == STAGE_EDITOR_LABEL
                        || window.label().starts_with("stage_editor_") =>
                {
                    unblock_main_if_no_stage_editors(window.app_handle());
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn reload_project(reload_type: &str, window: &tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    let (job, title) = match reload_type {
        NEW_PROJECT => ("new_project", "New Project"),
        OPEN_PROJECT => ("open_project", "Open Project"),
        IMPORT_SLAL => ("import_slal", "Import SLAL"),
        IMPORT_OSTIM => ("import_ostim", "Import OStim"),
        _ => ("load", "Load"),
    };
    let progress = JobProgress::new(Some(&app), job, title);

    let mut prjct = PROJECT.lock().unwrap();
    let result = match reload_type {
        NEW_PROJECT => {
            progress.start("Creating new project…");
            prjct.reset();
            Ok(())
        }
        OPEN_PROJECT => prjct.load_project(&app, &progress),
        IMPORT_SLAL => prjct.load_slal(&app, &progress),
        IMPORT_OSTIM => prjct.load_ostim(&app, &progress),
        _ => Err(format!("Invalid reload type: {}", reload_type)),
    };

    if let Err(e) = result {
        // Folder/file pick cancelled — progress never started.
        if e.starts_with("No path to") {
            info!("{}", e);
            return;
        }
        error!("{}", e);
        progress.fail(&e);
        window
            .app_handle()
            .dialog()
            .message(&e)
            .title("Load failed")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::Ok)
            .show(|_| {});
        return;
    }
    if prjct.pack_name == String::default() {
        let _ = window.set_title(DEFAULT_MAINWINDOW_TITLE);
    } else {
        let _ = window
            .set_title(format!("{} - {}", DEFAULT_MAINWINDOW_TITLE, prjct.pack_name).as_str());
    }
    // Import leaves an unsaved in-memory project until Save As
    set_edited(reload_type == IMPORT_SLAL || reload_type == IMPORT_OSTIM);
    if reload_type == IMPORT_SLAL || reload_type == IMPORT_OSTIM {
        prjct.rebuild_asset_library();
    }
    let asset_summary = if reload_type == IMPORT_SLAL || reload_type == IMPORT_OSTIM {
        Some(format!(
            "Project library: {} HKX/events, {} icons, {} anim objects, {} equip objects.",
            prjct.asset_library.events.len(),
            prjct.asset_library.icons.len(),
            prjct.asset_library.anim_objects.len(),
            prjct.asset_library.equip_objects.len(),
        ))
    } else {
        None
    };
    // Keep the modal open; the frontend closes it after applying scenes.
    progress.update("Loading scenes into editor…", None, None);
    emit_project_update(window, &prjct);
    if let Some(summary) = asset_summary {
        let app = window.app_handle().clone();
        app.dialog()
            .message(&summary)
            .title(if reload_type == IMPORT_OSTIM {
                "OStim import complete"
            } else {
                "SLAL import complete"
            })
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::Ok)
            .show(|_| {});
    }
}

fn get_menu(app: &AppHandle) -> Result<Menu<Wry>, Box<dyn std::error::Error>> {
    let import_menu = SubmenuBuilder::new(app, "Import")
        .items(&[
            &MenuItem::with_id(
                app,
                IMPORT_SLAL,
                "SLAL Pack...",
                true,
                Option::<&str>::None,
            )?,
            &MenuItem::with_id(
                app,
                IMPORT_OSTIM,
                "OStim...",
                true,
                Option::<&str>::None,
            )?,
            &MenuItem::with_id(
                app,
                "import_offset",
                "Offset.yaml...",
                true,
                Option::<&str>::None,
            )?,
        ])
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .items(&[
            &MenuItem::with_id(
                app,
                NEW_PROJECT,
                "New Project",
                true,
                "cmdOrControl+N".into(),
            )?,
            &MenuItem::with_id(
                app,
                OPEN_PROJECT,
                "Open Project",
                true,
                "cmdOrControl+O".into(),
            )?,
        ])
        .separator()
        .item(&import_menu)
        .item(&MenuItem::with_id(
            app,
            "export_pack",
            "Export...",
            true,
            "cmdOrControl+B".into(),
        )?)
        .separator()
        .items(&[
            &MenuItem::with_id(app, "save", "Save", true, "cmdOrControl+S".into())?,
            &MenuItem::with_id(
                app,
                "save_as",
                "Save As...",
                true,
                "cmdOrControl+Shift+S".into(),
            )?,
        ])
        .separator()
        .quit()
        .build()?;

    let tools_menu = SubmenuBuilder::new(app, "Tools")
        .items(&[
            &MenuItem::with_id(
                app,
                ENRICH_SLANIM,
                "Enrich from SLAnim source...",
                true,
                Option::<&str>::None,
            )?,
            &MenuItem::with_id(
                app,
                ENRICH_FNIS,
                "Enrich from FNIS AnimList...",
                true,
                Option::<&str>::None,
            )?,
        ])
        .build()?;

    let theme_menu = SubmenuBuilder::new(app, "Theme")
        .item(&CheckMenuItem::with_id(
            app,
            THEME_SYSTEM,
            "System",
            true,
            get_follow_os_theme(),
            Option::<&str>::None,
        )?)
        .item(&CheckMenuItem::with_id(
            app,
            THEME_LIGHT,
            "Light",
            true,
            !get_follow_os_theme() && !get_darkmode(),
            Option::<&str>::None,
        )?)
        .item(&CheckMenuItem::with_id(
            app,
            THEME_DARK,
            "Dark",
            true,
            !get_follow_os_theme() && get_darkmode(),
            Option::<&str>::None,
        )?)
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&theme_menu)
        .build()?;
    let help_menu = SubmenuBuilder::new(app, "Help")
        .text("open_docs", "Open Wiki")
        .separator()
        .text("about", "About")
        .separator()
        .text("discord", "Discord")
        .text("patreon", "Patreon")
        .text("kofi", "Ko-Fi")
        .build()?;
    let assets_menu = SubmenuBuilder::new(app, "Assets")
        .item(&MenuItem::with_id(
            app,
            IMPORT_ASSET_LIBRARY,
            "Import meshes / graphics / HKX…",
            true,
            Option::<&str>::None,
        )?)
        .item(&MenuItem::with_id(
            app,
            MANAGE_ASSET_LIBRARY,
            "Manage library…",
            true,
            Option::<&str>::None,
        )?)
        .build()?;
    let top_menu = MenuBuilder::new(app)
        .items(&[
            &file_menu,
            &assets_menu,
            &tools_menu,
            &view_menu,
            &help_menu,
        ])
        .build()?;
    Ok(top_menu)
}

fn menu_event_listener(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().0.as_str() {
        NEW_PROJECT | OPEN_PROJECT | IMPORT_SLAL | IMPORT_OSTIM => {
            let event_id = event.id().0.clone();
            let window = app.get_webview_window(MAIN_WINDOW).unwrap();
            let title = match event_id.as_str() {
                NEW_PROJECT => "New Project",
                OPEN_PROJECT => "Open Project",
                IMPORT_OSTIM => "Import OStim",
                _ => "Import SLAL",
            };
            // blocking_* dialogs must not run on the GTK menu/main thread (Linux freeze).
            let start_reload = move || {
                let event_id = event_id.clone();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    reload_project(&event_id, &window);
                });
            };
            if get_edited() {
                app.dialog()
                    .message("There are unsaved changes. Loading a new project will cause these changes to be lost.\nContinue?")
                    .title(title)
                    .buttons(MessageDialogButtons::YesNo)
                    .kind(MessageDialogKind::Warning)
                    .show(move |result| match result {
                        true => start_reload(),
                        false => info!("User cancelled the project reload.")
                    });
                return;
            }
            start_reload();
        }
        IMPORT_ASSET_LIBRARY => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let path = {
                    let picked = app
                        .dialog()
                        .file()
                        .set_title("Import HKX / OStim icons from folder")
                        .blocking_pick_folder();
                    match picked {
                        Some(p) => match p.into_path() {
                            Ok(path) => path,
                            Err(e) => {
                                error!("{}", e);
                                return;
                            }
                        },
                        None => return,
                    }
                };
                let result = {
                    let mut prjct = PROJECT.lock().unwrap();
                    prjct.import_asset_library_folder(&path)
                };
                match result {
                    Ok((lib, stats)) => {
                        set_edited(true);
                        let _ = app.emit("on_asset_library_update", &lib);
                        let source_note = {
                            let prjct = PROJECT.lock().unwrap();
                            prjct
                                .ostim_source
                                .as_ref()
                                .map(|p| format!("\nBinary source: {}", p.display()))
                                .unwrap_or_default()
                        };
                        app.dialog()
                            .message(format!(
                                "Scanned {} .hkx and {} icon file(s).\n\
                                 Library now: {} events, {} icons, {} anim objects, {} equip objects.{}",
                                stats.hkx_files,
                                stats.icon_files,
                                lib.events.len(),
                                lib.icons.len(),
                                lib.anim_objects.len(),
                                lib.equip_objects.len(),
                                source_note
                            ))
                            .title("Assets imported")
                            .kind(MessageDialogKind::Info)
                            .buttons(MessageDialogButtons::Ok)
                            .show(|_| {});
                    }
                    Err(err) => {
                        error!("{}", err);
                        app.dialog()
                            .message(&err)
                            .title("Import failed")
                            .kind(MessageDialogKind::Error)
                            .buttons(MessageDialogButtons::Ok)
                            .show(|_| {});
                    }
                }
            });
        }
        MANAGE_ASSET_LIBRARY => {
            let _ = app.emit("on_manage_asset_library", ());
        }
        "save" | "save_as" => {
            let save_as = event.id().0 == "save_as";
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut prjct = PROJECT.lock().unwrap();
                if let Err(err) = prjct.save_project(save_as, &app) {
                    error!("Failed to save project: {}", err);
                    return;
                }
                set_edited(false);
                let window = app.get_webview_window(MAIN_WINDOW).unwrap();
                if prjct.pack_name.is_empty() {
                    let _ = window.set_title(DEFAULT_MAINWINDOW_TITLE);
                } else {
                    let _ = window.set_title(
                        format!("{} - {}", DEFAULT_MAINWINDOW_TITLE, prjct.pack_name).as_str(),
                    );
                }
                let _ = app.emit(
                    "on_project_saved",
                    serde_json::json!({
                        "path": prjct.pack_path.display().to_string(),
                        "packName": prjct.pack_name,
                    }),
                );
            });
        }
        "export_pack" => {
            let _ = app.emit("on_export_dialog", ());
        }
        "export_both" | "export_slsb" | "export_slal" | "export_ostim" => {
            // Legacy menu ids (shortcuts / older builds) → format presets.
            let formats = match event.id().0.as_str() {
                "export_slsb" => ExportFormats {
                    slsb: true,
                    ..Default::default()
                },
                "export_slal" => ExportFormats {
                    slal: true,
                    ..Default::default()
                },
                "export_ostim" => ExportFormats {
                    ostim: true,
                    ..Default::default()
                },
                _ => ExportFormats {
                    slsb: true,
                    slal: true,
                    ..Default::default()
                },
            };
            start_export_with_tip(app, formats);
        }
        THEME_SYSTEM => {
            apply_system_theme(app);
        }
        THEME_LIGHT => {
            apply_color_theme(app, false, false);
        }
        THEME_DARK => {
            apply_color_theme(app, true, false);
        }
        "open_docs" => {
            let _ = app.opener().open_url(
                "https://slp-community.github.io/SexLab-Wiki/slsb/creating-packs-using-slsb/",
                Option::<String>::None,
            );
        }
        "about" => {
            let msg = format!(
                "SexLab Scene Builder {}\n\
                 Apache-2.0 — Scrab and contributors\n\
                 https://github.com/SLP-Community/SexLab-Scene-Builder\n\n\
                 Third-party:\n\
                 • serde-hkx (MIT OR Apache-2.0) — Behavior.hkx packing\n\
                   https://github.com/SARDONYX-sard/serde-hkx\n\
                   Copyright SARDONYX and contributors",
                env!("CARGO_PKG_VERSION")
            );
            app.dialog()
                .message(msg)
                .title("About SexLab Scene Builder")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::Ok)
                .show(|_| {});
        }
        "discord" => {
            let _ = app
                .opener()
                .open_url("https://discord.gg/JPSHb4ebqj", Option::<String>::None);
        }
        "patreon" => {
            let _ = app.opener().open_url(
                "https://www.patreon.com/ScrabJoseline",
                Option::<String>::None,
            );
        }
        "kofi" => {
            let _ = app
                .opener()
                .open_url("https://ko-fi.com/scrab", Option::<String>::None);
        }
        "import_offset" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut prjct = PROJECT.lock().unwrap();
                if let Err(err) = prjct.import_offset(&app) {
                    error!("{}", err);
                }
            });
        }
        ENRICH_SLANIM => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut prjct = PROJECT.lock().unwrap();
                match prjct.enrich_from_slanim_source(&app) {
                    Ok(summary) => {
                        set_edited(true);
                        let window = app.get_webview_window(MAIN_WINDOW).unwrap();
                        emit_project_update(&window, &prjct);
                        let kind = if summary.positions_updated > 0 {
                            MessageDialogKind::Info
                        } else {
                            MessageDialogKind::Warning
                        };
                        app.dialog()
                            .message(summary.message())
                            .title("Enrich from SLAnim source")
                            .kind(kind)
                            .buttons(MessageDialogButtons::Ok)
                            .show(|_| {});
                    }
                    Err(err) => {
                        error!("{}", err);
                        app.dialog()
                            .message(&err)
                            .title("Enrich failed")
                            .kind(MessageDialogKind::Error)
                            .buttons(MessageDialogButtons::Ok)
                            .show(|_| {});
                    }
                }
            });
        }
        ENRICH_FNIS => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut prjct = PROJECT.lock().unwrap();
                match prjct.enrich_from_fnis_lists(&app) {
                    Ok(summary) => {
                        set_edited(true);
                        let window = app.get_webview_window(MAIN_WINDOW).unwrap();
                        emit_project_update(&window, &prjct);
                        let kind = if summary.positions_updated > 0 {
                            MessageDialogKind::Info
                        } else {
                            MessageDialogKind::Warning
                        };
                        app.dialog()
                            .message(summary.message_fnis())
                            .title("Enrich from FNIS AnimList")
                            .kind(kind)
                            .buttons(MessageDialogButtons::Ok)
                            .show(|_| {});
                    }
                    Err(err) => {
                        error!("{}", err);
                        app.dialog()
                            .message(&err)
                            .title("Enrich failed")
                            .kind(MessageDialogKind::Error)
                            .buttons(MessageDialogButtons::Ok)
                            .show(|_| {});
                    }
                }
            });
        }
        _ => {
            error!("Unrecognized command: {}", event.id().0)
        }
    }
}

/// COMMANDS

#[tauri::command]
async fn request_project_update<R: Runtime>(window: tauri::Window<R>) -> () {
    let prjct = PROJECT.lock().unwrap();
    emit_project_update(&window, &prjct);
}

#[tauri::command]
fn set_pack_name(name: String) {
    PROJECT.lock().unwrap().pack_name = name;
}

#[tauri::command]
fn set_pack_author(author: String) {
    PROJECT.lock().unwrap().pack_author = author;
}

#[tauri::command]
fn set_pack_version(version: String) {
    PROJECT.lock().unwrap().pack_version = version;
}

#[tauri::command]
fn set_asset_library(library: AssetLibrary) -> AssetLibrary {
    let mut prjct = PROJECT.lock().unwrap();
    prjct.merge_asset_library(&library);
    set_edited(true);
    prjct.asset_library.clone()
}

/// Replace the project library wholesale (manage / clear UI).
#[tauri::command]
fn replace_asset_library<R: Runtime>(
    app: tauri::AppHandle<R>,
    library: AssetLibrary,
) -> AssetLibrary {
    let mut prjct = PROJECT.lock().unwrap();
    prjct.asset_library = library;
    prjct.asset_library.sort();
    set_edited(true);
    let lib = prjct.asset_library.clone();
    drop(prjct);
    let _ = app.emit("on_asset_library_update", &lib);
    lib
}

#[tauri::command]
async fn get_race_keys() -> Vec<String> {
    racekeys::get_race_keys_string()
}

#[tauri::command]
async fn mark_as_edited<R: Runtime>(window: tauri::Window<R>) -> () {
    set_edited(true);
    if let Ok(title) = window.title() {
        if !title.ends_with('*') {
            window.set_title(format!("{}*", title).as_str()).unwrap();
        }
    }
}

#[tauri::command]
fn get_in_darkmode() -> bool {
    get_darkmode()
}

/// Write export contents to an already-chosen path (dialog runs on the frontend).
/// Keeps the GTK main loop free — never call blocking_save_file from here on Linux.
#[tauri::command]
async fn write_export_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, contents.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/* Scene */

#[tauri::command]
fn create_blank_scene() -> Scene {
    Scene::default()
}

#[tauri::command]
async fn save_scene<R: Runtime>(app: tauri::AppHandle<R>, window: tauri::Window<R>, scene: Scene) -> () {
    mark_as_edited(window).await;
    let mut prjct = PROJECT.lock().unwrap();
    prjct.save_scene(scene);
    prjct.rebuild_asset_library();
    let lib = prjct.asset_library.clone();
    drop(prjct);
    let _ = app.emit("on_asset_library_update", &lib);
}

#[tauri::command]
fn delete_scene<R: Runtime>(window: tauri::Window<R>, id: NanoID) -> Result<Scene, String> {
    let ret = PROJECT.lock().unwrap().discard_scene(&id).ok_or_else(|| {
        let msg = format!("Invalid Scene ID: {}", id.0);
        error!("{}", msg);
        msg
    });

    if ret.is_ok() {
        set_edited(true);
        if let Ok(title) = window.title() {
            if !title.ends_with('*') {
                window.set_title(format!("{}*", title).as_str()).unwrap();
            }
        }
    }

    ret
}

/* Stage */

const STAGE_EDITOR_LABEL: &str = "stage_editor";

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SceneCatalogStage {
    pub id: NanoID,
    pub name: String,
    #[serde(default)]
    pub ostim_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SceneCatalogEntry {
    pub id: NanoID,
    pub name: String,
    pub stages: Vec<SceneCatalogStage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct EditorPayload {
    pub scene: NanoID,
    pub stage: Stage,
    pub positions: Vec<PositionInfo>,
    pub dark: bool,
    #[serde(default)]
    pub asset_library: AssetLibrary,
    /// Current scene graph for DestRef editing in the stage window.
    #[serde(default)]
    pub graph: std::collections::HashMap<NanoID, crate::project::define::Node>,
    #[serde(default)]
    pub scene_catalog: Vec<SceneCatalogEntry>,
}

fn any_stage_editor_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| label == STAGE_EDITOR_LABEL || label.starts_with("stage_editor_"))
}

fn set_main_window_blocked<R: Runtime>(app: &AppHandle<R>, blocked: bool) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = main.set_enabled(!blocked);
    if !blocked {
        let _ = main.set_focus();
    }
}

fn unblock_main_if_no_stage_editors<R: Runtime>(app: &AppHandle<R>) {
    if !any_stage_editor_open(app) {
        set_main_window_blocked(app, false);
    }
}

fn open_stage_editor_impl<R: Runtime>(app: &tauri::AppHandle<R>, payload: EditorPayload) {
    let stage = &payload.stage;
    let title = format!(
        "Stage Editor [{}]",
        if stage.name.is_empty() {
            "Untitled"
        } else {
            stage.name.as_str()
        }
    );
    info!(
        "Opening Stage {} from Scene {}",
        stage.id.0, payload.scene.0
    );
    // Reuse one editor webview so antd/React are not re-parsed per stage.
    if let Some(existing) = app.get_webview_window(STAGE_EDITOR_LABEL) {
        set_main_window_blocked(app, true);
        let _ = existing.set_title(&title);
        let _ = existing.set_focus();
        if let Err(e) = existing.emit("on_data_received", payload.clone()) {
            error!("Failed to re-send stage editor payload: {}", e);
        }
        return;
    }
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        error!("Cannot open stage editor: main window missing");
        return;
    };
    let builder = WebviewWindowBuilder::new(
        app,
        STAGE_EDITOR_LABEL,
        tauri::WebviewUrl::App("./stage.html".into()),
    )
    .title(title)
    .min_inner_size(720.0, 540.0)
    .inner_size(1152.0, 864.0)
    .resizable(true);
    let builder = match builder.parent(&main) {
        Ok(b) => b,
        Err(e) => {
            error!("Failed to parent stage editor to main window: {}", e);
            return;
        }
    };
    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            error!(
                "Failed to create stage editor window for Stage {}: {}",
                stage.id.0, e
            );
            return;
        }
    };
    set_main_window_blocked(app, true);
    // Register before geometry restore: webview can emit before restore finishes.
    let theme_window = window.clone();
    window.clone().once("on_request_data", move |_| {
        if let Err(e) = window.emit("on_data_received", payload.clone()) {
            error!("Failed to send stage editor payload: {}", e);
        }
    });
    window_geometry::restore_window_geometry(&theme_window);
    sync_theme_from_window(&theme_window);
}

fn blank_stage_from_parts(
    existing_stage_count: usize,
    positions: &[PositionInfo],
    template: Option<&Stage>,
) -> Stage {
    let n = existing_stage_count + 1;
    let actor_n = positions.len().max(1);
    Stage {
        id: NanoID::new_nanoid(),
        name: format!("Stage {n}/{n}"),
        positions: template.map_or_else(
            || vec![crate::project::position::Position::new(None); actor_n],
            |s| {
                s.positions
                    .iter()
                    .map(|p| crate::project::position::Position::new(Some(p)))
                    .collect()
            },
        ),
        tags: {
            let mut tags = Vec::new();
            if let Some(s) = template {
                for t in &s.tags {
                    if t.starts_with("ostim_folder:") {
                        tags.push(t.clone());
                    }
                }
            }
            tags
        },
        extra: Default::default(),
    }
}

#[tauri::command]
async fn open_stage_editor<R: Runtime>(
    app: tauri::AppHandle<R>,
    scene_id: NanoID,
    positions: Vec<PositionInfo>,
    stage: Option<Stage>,
    #[allow(non_snake_case)]
    existing_stage_count: Option<usize>,
    template_stage: Option<Stage>,
    graph: Option<std::collections::HashMap<NanoID, crate::project::define::Node>>,
    scene_catalog: Option<Vec<SceneCatalogEntry>>,
) -> () {
    let stage = stage.unwrap_or_else(|| {
        blank_stage_from_parts(
            existing_stage_count.unwrap_or(0),
            &positions,
            template_stage.as_ref(),
        )
    });
    let (asset_library, fallback_graph, fallback_catalog) = {
        let mut prjct = PROJECT.lock().unwrap();
        prjct.rebuild_asset_library();
        let g = prjct
            .scenes
            .get(&scene_id)
            .map(|s| s.graph.clone())
            .unwrap_or_default();
        let catalog: Vec<SceneCatalogEntry> = prjct
            .scenes
            .values()
            .map(|s| SceneCatalogEntry {
                id: s.id.clone(),
                name: s.name.clone(),
                stages: s
                    .stages
                    .iter()
                    .map(|st| SceneCatalogStage {
                        id: st.id.clone(),
                        name: st.name.clone(),
                        ostim_id: st
                            .tags
                            .iter()
                            .find_map(|t| t.strip_prefix("ostim_id:").map(|s| s.to_string())),
                    })
                    .collect(),
            })
            .collect();
        (prjct.asset_library.clone(), g, catalog)
    };
    open_stage_editor_impl(
        &app,
        EditorPayload {
            scene: scene_id,
            stage,
            positions,
            dark: get_darkmode(),
            asset_library,
            graph: graph.unwrap_or(fallback_graph),
            scene_catalog: scene_catalog.unwrap_or(fallback_catalog),
        },
    );
}

#[tauri::command]
async fn open_stage_editor_from<R: Runtime>(
    app: tauri::AppHandle<R>,
    scene_id: NanoID,
    positions: Vec<PositionInfo>,
    copy_stage: Stage,
    #[allow(non_snake_case)]
    existing_stage_count: Option<usize>,
    graph: Option<std::collections::HashMap<NanoID, crate::project::define::Node>>,
    scene_catalog: Option<Vec<SceneCatalogEntry>>,
) -> () {
    // Clone must get a fresh id so save inserts a new stage instead of overwriting the source
    let mut stage = copy_stage;
    stage.id = NanoID::new_nanoid();
    let n = existing_stage_count.unwrap_or(0) + 1;
    if stage.name.is_empty() {
        stage.name = format!("Stage {n}/{n}");
    } else {
        stage.name = format!("{} (Copy)", stage.name);
    }
    // Do not copy navigation; mint a unique OStim id so export filenames do not collide.
    stage.tags.retain(|t| !t.starts_with("ostim_nav:"));
    let old_ostim = stage
        .tags
        .iter()
        .find_map(|t| t.strip_prefix("ostim_id:"))
        .map(|s| s.to_string());
    stage.tags.retain(|t| !t.starts_with("ostim_id:"));
    let (asset_library, fallback_graph, fallback_catalog, used_ostim_ids) = {
        let mut prjct = PROJECT.lock().unwrap();
        prjct.rebuild_asset_library();
        let g = prjct
            .scenes
            .get(&scene_id)
            .map(|s| s.graph.clone())
            .unwrap_or_default();
        let mut used = std::collections::HashSet::new();
        for sc in prjct.scenes.values() {
            for st in &sc.stages {
                if let Some(oid) = st.tags.iter().find_map(|t| t.strip_prefix("ostim_id:")) {
                    used.insert(oid.to_string());
                }
            }
        }
        let catalog: Vec<SceneCatalogEntry> = prjct
            .scenes
            .values()
            .map(|s| SceneCatalogEntry {
                id: s.id.clone(),
                name: s.name.clone(),
                stages: s
                    .stages
                    .iter()
                    .map(|st| SceneCatalogStage {
                        id: st.id.clone(),
                        name: st.name.clone(),
                        ostim_id: st
                            .tags
                            .iter()
                            .find_map(|t| t.strip_prefix("ostim_id:").map(|s| s.to_string())),
                    })
                    .collect(),
            })
            .collect();
        (prjct.asset_library.clone(), g, catalog, used)
    };
    let base = old_ostim
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("Stage");
    let candidate = format!("{base}_Copy");
    let mut unique = crate::project::ostim::events::sanitize_ostim_id(&candidate, &stage.id.0);
    if used_ostim_ids.contains(&unique) {
        let mut i = 2u32;
        loop {
            let next = crate::project::ostim::events::sanitize_ostim_id(
                &format!("{base}_Copy{i}"),
                &stage.id.0,
            );
            if !used_ostim_ids.contains(&next) {
                unique = next;
                break;
            }
            i += 1;
        }
    }
    stage.tags.push(format!("ostim_id:{unique}"));
    open_stage_editor_impl(
        &app,
        EditorPayload {
            scene: scene_id,
            stage,
            positions,
            dark: get_darkmode(),
            asset_library,
            graph: graph.unwrap_or(fallback_graph),
            scene_catalog: scene_catalog.unwrap_or(fallback_catalog),
        },
    );
}

#[tauri::command]
fn start_pack_export(app: tauri::AppHandle, formats: ExportFormats) {
    start_export_with_tip(&app, formats);
}

#[tauri::command]
async fn export_ostim_scene_json(
    app: tauri::AppHandle,
    scene_id: NanoID,
) -> Result<String, String> {
    let mod_name = {
        let prjct = PROJECT.lock().unwrap();
        if !prjct.scenes.contains_key(&scene_id) {
            return Err(format!("Scene {} not found in project", scene_id.0));
        }
        prjct.fnis_mod_name()
    };
    let path = app
        .dialog()
        .file()
        .set_title("Export OStim JSON (selected scene)")
        .set_file_name(&mod_name)
        .blocking_pick_folder()
        .ok_or_else(|| "Export cancelled".to_string())?
        .into_path()
        .map_err(|e| e.to_string())?;
    let pack_root = path.join(&mod_name);

    let progress = JobProgress::new(Some(&app), "export", "Export OStim JSON");
    progress.start("Writing scene JSON…");
    let result = {
        let prjct = PROJECT.lock().unwrap();
        prjct.write_ostim_json_subset(&pack_root, &[scene_id.clone()], Some(&progress))
    };
    match &result {
        Ok(()) => {
            progress.done();
            let msg = format!(
                "Wrote OStim JSON for scene {} under {}",
                scene_id.0,
                pack_root.display()
            );
            Ok(msg)
        }
        Err(err) if err == "Export cancelled" => Err(err.clone()),
        Err(err) => {
            progress.fail(err);
            Err(err.clone())
        }
    }
}

#[tauri::command]
async fn stage_save_and_close<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::Window<R>,
    scene: NanoID,
    positions: Vec<PositionInfo>,
    stage: Stage,
    graph: Option<std::collections::HashMap<NanoID, crate::project::define::Node>>,
) -> () {
    // IDEA: make give this event some unique id to allow
    // front end distinguish the timings at which some stage editor has been opened
    info!("Saving Stage {}", stage.id.0);
    let asset_library = {
        let mut prjct = PROJECT.lock().unwrap();
        // Harvest from this stage immediately (project scenes may still be dirty
        // in the frontend until the next save_scene / write).
        prjct.ingest_stage_assets(&stage);
        let lib = prjct.asset_library.clone();
        drop(prjct);
        let _ = app.emit("on_asset_library_update", &lib);
        lib
    };
    app.emit_to(
        MAIN_WINDOW,
        "on_stage_saved",
        EditorPayload {
            scene,
            stage,
            positions,
            dark: get_darkmode(),
            asset_library,
            graph: graph.unwrap_or_default(),
            scene_catalog: vec![],
        },
    )
    .unwrap();
    let _ = window.close();
}

/* Position related */

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PositionPayload {
    pub position: Position,
    pub info: PositionInfo,
}

#[tauri::command]
fn make_position() -> PositionPayload {
    PositionPayload {
        position: Position::new(None),
        info: PositionInfo::default(),
    }
}
