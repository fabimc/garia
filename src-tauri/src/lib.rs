use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, RwLock};

use serde::Serialize;
use tauri::{Emitter, Manager};

use garia_core::aria2::{self, Aria2};
use garia_core::catch;
use garia_core::ftp;
use garia_core::logins;
use garia_core::process;
use garia_core::schedule;
use garia_core::settings::{self, DoneAction, LoginsState, Settings, SettingsState};
use garia_core::trash;
use garia_core::video::{self, Probe, PreviewState, SidecarTool, Video, VideoTools};

#[cfg(target_os = "macos")]
mod dock;
#[cfg(target_os = "macos")]
mod service;


async fn off_main<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("the task did not finish: {e}"))?
}

#[tauri::command]
fn remote_info(aria2: tauri::State<Aria2>, settings: tauri::State<SettingsState>) -> settings::RemoteInfo {
    aria2::remote_info(&aria2, &settings)
}

#[tauri::command]
async fn aria2_rpc(
    app: tauri::AppHandle,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let aria2 = app.state::<Aria2>();
    let _permit = aria2
        .calls
        .acquire()
        .await
        .map_err(|_| "aria2 is shutting down".to_string())?;
    let app = app.clone();
    off_main(move || {
        aria2::aria2_call(
            app.state::<Aria2>().inner(),
            app.state::<SettingsState>().inner(),
            app.state::<schedule::Schedule>().inner(),
            &method,
            params,
        )
    })
    .await
}

#[tauri::command]
async fn set_download_start(
    app: tauri::AppHandle,
    gid: String,
    at: Option<i64>,
) -> Result<schedule::ScheduleState, String> {
    off_main(move || {
        aria2::set_download_start(
            app.state::<Aria2>().inner(),
            app.state::<SettingsState>().inner(),
            app.state::<schedule::Schedule>().inner(),
            gid,
            at,
        )
    })
    .await
}

#[tauri::command]
async fn set_queue_stopped(
    app: tauri::AppHandle,
    stopped: bool,
) -> Result<schedule::ScheduleState, String> {
    off_main(move || {
        let settings = app.state::<SettingsState>();
        let schedule = app.state::<schedule::Schedule>();
        let next = aria2::set_queue_stopped(settings.inner(), stopped)?;
        let _ = app.emit("settings-changed", &next);
        schedule_tick(&app);
        Ok(aria2::schedule_state(settings.inner(), schedule.inner()))
    })
    .await
}

#[tauri::command]
async fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    off_main(move || {
        let result = aria2::save_settings(
            app.state::<Aria2>().inner(),
            app.state::<SettingsState>().inner(),
            settings,
        )?;
        let _ = app.emit("settings-changed", &result);
        schedule_tick(&app);
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn save_login(
    app: tauri::AppHandle,
    host: String,
    username: String,
    password: Option<String>,
    headers: Vec<String>,
) -> Result<Vec<logins::LoginView>, String> {
    off_main(move || {
        let views = aria2::save_login(
            app.state::<Aria2>().inner(),
            app.state::<SettingsState>().inner(),
            app.state::<LoginsState>().inner(),
            host,
            username,
            password,
            headers,
        )?;
        let _ = app.emit("logins-changed", &views);
        Ok(views)
    })
    .await
}

#[tauri::command]
async fn delete_login(
    app: tauri::AppHandle,
    host: String,
) -> Result<Vec<logins::LoginView>, String> {
    off_main(move || {
        let views = aria2::delete_login(
            app.state::<Aria2>().inner(),
            app.state::<SettingsState>().inner(),
            app.state::<LoginsState>().inner(),
            host,
        )?;
        let _ = app.emit("logins-changed", &views);
        Ok(views)
    })
    .await
}

#[tauri::command]
async fn ftp_list(app: tauri::AppHandle, url: String) -> Result<ftp::FtpListing, String> {
    off_main(move || aria2::ftp_list(app.state::<LoginsState>().inner(), url)).await
}

#[tauri::command]
async fn trash_files(paths: Vec<String>) -> Result<(), String> {
    off_main(move || trash::trash_files(paths)).await
}

#[tauri::command]
async fn video_tools(app: tauri::AppHandle) -> Result<VideoTools, String> {
    off_main(move || Ok(video::video_tools_blocking(app.state::<Video>().inner()))).await
}

#[tauri::command]
async fn sidecar_tools(app: tauri::AppHandle) -> Result<Vec<SidecarTool>, String> {
    off_main(move || {
        Ok(video::sidecar_tools_blocking(
            app.state::<Video>().inner(),
            app.state::<Aria2>().inner(),
        ))
    })
    .await
}

#[tauri::command]
async fn video_probe(app: tauri::AppHandle, url: String) -> Result<Probe, String> {
    off_main(move || {
        video::video_probe_blocking(
            app.state::<Video>().inner(),
            app.state::<SettingsState>().inner(),
            url,
        )
    })
    .await
}

#[tauri::command]
fn cancel_video_probes() {
    process::cancel_video_probes();
}

#[tauri::command]
async fn mux_video(
    app: tauri::AppHandle,
    video_path: String,
    audio_path: String,
    out_path: String,
) -> Result<String, String> {
    off_main(move || {
        let emit_path = out_path.clone();
        video::mux_video_blocking(video_path, audio_path, out_path, |fraction| {
            let _ = app.emit(
                "mux-progress",
                serde_json::json!({ "outPath": emit_path, "fraction": fraction }),
            );
        })
    })
    .await
}

#[tauri::command]
async fn preview_state(path: String, ready_bytes: u64) -> Result<PreviewState, String> {
    off_main(move || Ok(video::preview_state_blocking(path, ready_bytes))).await
}

#[tauri::command]
fn schedule_state(
    settings: tauri::State<SettingsState>,
    schedule: tauri::State<schedule::Schedule>,
) -> schedule::ScheduleState {
    aria2::schedule_state(&settings, &schedule)
}

#[tauri::command]
fn cancel_queue_drain(app: tauri::AppHandle) {
    if let Some(watch) = app.try_state::<DrainWatch>() {
        cancel_drain(&watch);
    }
}

#[tauri::command]
fn aria2_endpoint(state: tauri::State<Aria2>) -> String {
    aria2::aria2_endpoint(&state)
}

#[tauri::command]
fn platform() -> &'static str {
    aria2::platform()
}

#[tauri::command]
fn get_settings(state: tauri::State<SettingsState>) -> Settings {
    aria2::get_settings(&state)
}

#[tauri::command]
fn get_logins(state: tauri::State<LoginsState>) -> Vec<logins::LoginView> {
    aria2::get_logins(&state)
}
#[tauri::command]
fn set_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    // None clears it — a zero badge would otherwise show as a literal "0".
    window
        .set_badge_count(if count == 0 { None } else { Some(count as i64) })
        .map_err(|e| format!("could not set the dock badge: {e}"))
}

/// The number next to the menu-bar extra. Zero clears it, the same way a
/// dock badge of zero would otherwise sit there as a literal "0".
#[tauri::command]
fn set_status_item(app: tauri::AppHandle, active: u32) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("status") else {
        return Ok(());
    };
    // tray-icon ignores None, so an empty string is what actually takes
    // the number away. A literal "0" would sit there the way a dock
    // badge of zero does.
    let title = if active == 0 {
        String::new()
    } else {
        active.to_string()
    };
    #[cfg(target_os = "macos")]
    tray.set_title(Some(&title))
        .map_err(|e| format!("could not set the menu-bar title: {e}"))?;
    #[cfg(not(target_os = "macos"))]
    let _ = title;
    let tip = if active == 0 {
        "Garia".to_string()
    } else if active == 1 {
        "Garia — 1 downloading".to_string()
    } else {
        format!("Garia — {active} downloading")
    };
    tray.set_tooltip(Some(&tip))
        .map_err(|e| format!("could not set the menu-bar tooltip: {e}"))
}

/// A finished file leaves the window the way it leaves Finder: the row is a
/// handle, and the drop is a real file, not a URL the other app has to guess.
#[tauri::command]
fn start_file_drag(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    let files: Vec<PathBuf> = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect();
    if files.is_empty() {
        return Err("nothing on disk to drag".into());
    }

    #[cfg(target_os = "linux")]
    {
        let _ = (window, files);
        return Err("drag-out is only wired on macOS".into());
    }

    #[cfg(not(target_os = "linux"))]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                // The page takes drops itself, and a row dragged out crosses
                // it on the way to the Finder. It is told when the drag is
                // over so it can tell its own file from one coming in.
                let ended = win.clone();
                let _ = drag::start_drag(
                    &win,
                    drag::DragItem::Files(files),
                    drag::Image::Raw(include_bytes!("../icons/32x32.png").to_vec()),
                    move |_, _| {
                        let _ = ended.emit("file-drag-ended", ());
                    },
                    drag::Options::default(),
                );
            })
            .map_err(|e| format!("could not start the drag: {e}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    notes: String,
    current_version: String,
}

/// What GitHub last published, if it is newer than this build. None is
/// "you already have it" — a missing latest.json is an error, not that.
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            version: update.version,
            notes: update.body.unwrap_or_default(),
            current_version: app.package_info().version.to_string(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Download the update that check_for_update found and relaunch into it.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update available".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}

/// Checkmarks on View → Columns and Show Sidebar. The frontend owns the
/// preference (localStorage, like the sidebar collapse); this is only so the
/// menu can be told when that changes.
struct ViewMenu {
    items: Mutex<Vec<tauri::menu::CheckMenuItem<tauri::Wry>>>,
}

#[tauri::command]
fn sync_view_menu(state: tauri::State<ViewMenu>, sidebar: bool, columns: Vec<String>) {
    let Ok(items) = state.items.lock() else { return };
    for item in items.iter() {
        let id = item.id().as_ref();
        let checked = if id == "show-sidebar" {
            sidebar
        } else if let Some(col) = id.strip_prefix("col-") {
            columns.iter().any(|c| c == col)
        } else {
            continue;
        };
        let _ = item.set_checked(checked);
    }
}

/// URLs that arrived before the frontend was listening. The live `catch-url`
/// event covers everything after that; this is the ones that beat it.
struct CatchQueue {
    pending: Mutex<Vec<catch::CatchEvent>>,
}

/// The queue is drained once, at startup, so everything caught afterwards
/// would pile up forever if it weren't capped. Keeping the newest few is the
/// right end to keep: a reload should show what just arrived, not an hour of
/// stale clipboard offers.
const MAX_PENDING_CATCHES: usize = 8;

#[tauri::command]
fn take_pending_catch(state: tauri::State<CatchQueue>) -> Vec<catch::CatchEvent> {
    state
        .pending
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

/// `.torrent` files the system opened before the list was listening — Finder
/// double-click, Open With, File → Open. Same shape as the URL catch queue.
struct TorrentQueue {
    pending: Mutex<Vec<String>>,
}

#[tauri::command]
fn take_pending_torrents(state: tauri::State<TorrentQueue>) -> Vec<String> {
    state
        .pending
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

/// The torrent bytes as aria2 wants them. The frontend already knows how to
/// add one (folder, seed rules, in-order); this is just the file, checked so
/// a path that is not a torrent never becomes an RPC payload.
#[tauri::command]
fn read_torrent(path: String) -> Result<String, String> {
    let path = PathBuf::from(&path);
    if !catch::is_torrent(&path) {
        return Err("that isn't a .torrent file".into());
    }
    let bytes = fs::read(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    Ok(aria2::encode_base64(&bytes))
}

/// Launch at login lives in a LaunchAgent, not in settings.json: the OS is
/// the source of truth, and System Settings can turn it off without us.
#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|e| e.to_string())
}


pub(crate) fn bring_to_front(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Settings is its own window so a pairing QR can stay up while the list is
/// visible, and so the form can stop being a modal that grew a field at a time.
/// Hide-on-close matches the main window: the webview stays warm for the next
/// ⌘,. Creating it here rather than in tauri.conf.json keeps launch as one
/// window.
fn show_settings(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Settings")
    .inner_size(780.0, 600.0)
    .min_inner_size(680.0, 480.0)
    .resizable(true)
    .accept_first_mouse(true);

    #[cfg(target_os = "macos")]
    let builder = builder
        .transparent(true)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay);

    let win = builder
        .build()
        .map_err(|e| format!("Could not open Settings: {e}"))?;
    #[cfg(target_os = "macos")]
    let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    Ok(())
}

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    show_settings(&app)
}

/// Folder Chrome / Firefox / Edge / Brave / Arc load as an unpacked
/// extension, and what Safari's converter is pointed at. A release build
/// ships it inside the bundle; `tauri dev` falls back to the copy next
/// to the crate.
#[tauri::command]
fn browser_extension_dir(app: tauri::AppHandle) -> Result<String, String> {
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("garia"));
        candidates.push(resources.join("extensions/garia"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extensions/garia"));

    for path in candidates {
        if path.join("manifest.json").is_file() {
            let shown = path.canonicalize().unwrap_or(path);
            // Reveal the folder itself — Load unpacked wants this
            // directory, not its parent with the folder selected.
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("open").arg(&shown).status();
            }
            #[cfg(target_os = "linux")]
            {
                let _ = std::process::Command::new("xdg-open").arg(&shown).status();
            }
            return Ok(shown.display().to_string());
        }
    }
    Err("The browser extension is not in this build.".into())
}

fn dispatch_torrent(app: &tauri::AppHandle, path: PathBuf) {
    let event = path.display().to_string();
    if let Some(queue) = app.try_state::<TorrentQueue>() {
        if let Ok(mut pending) = queue.pending.lock() {
            pending.push(event.clone());
            let overflow = pending.len().saturating_sub(MAX_PENDING_CATCHES);
            pending.drain(..overflow);
        }
    }
    let _ = app.emit("open-torrent", &event);
    bring_to_front(app);
}

/// Files and magnets the system handed us — Finder, a browser, Open With.
/// `garia://` stays with the deep-link plugin so it is not queued twice.
fn ingest_opened(app: &tauri::AppHandle, raw: &str) {
    if let Some(path) = catch::torrent_path(raw) {
        dispatch_torrent(app, path);
    } else if let Some(url) = catch::magnet_url(raw) {
        dispatch_catch(app, url, "scheme");
    }
}

pub(crate) fn dispatch_catch(app: &tauri::AppHandle, url: String, source: &str) {
    dispatch_catch_event(
        app,
        catch::CatchEvent {
            url,
            source: source.to_string(),
            name: None,
            referrer: None,
            confirm: false,
            urls: Vec::new(),
        },
    );
}

fn dispatch_catch_event(app: &tauri::AppHandle, event: catch::CatchEvent) {
    if let Some(queue) = app.try_state::<CatchQueue>() {
        if let Ok(mut pending) = queue.pending.lock() {
            pending.push(event.clone());
            let overflow = pending.len().saturating_sub(MAX_PENDING_CATCHES);
            pending.drain(..overflow);
        }
    }
    let _ = app.emit("catch-url", &event);
    if event.source == "scheme" || event.source == "extension" {
        bring_to_front(app);
    }
}

/// The last thing garia itself put on the clipboard. The watcher is looking
/// for a file URL the user copied somewhere else — a URL copied out of garia's
/// own detail panel is not news, and offering it straight back would be a loop.
#[derive(Default)]
struct OwnCopy(Mutex<Option<String>>);

/// The detail panel's Copy buttons. This goes through Rust rather than
/// `navigator.clipboard` because the webview's clipboard needs a permission
/// the app has no reason to depend on, and arboard is already here for the
/// watcher on the other side of the same clipboard.
#[tauri::command]
fn copy_text(state: tauri::State<OwnCopy>, text: String) -> Result<(), String> {
    // Written down before the write, so the watcher can never see it first.
    if let Ok(mut own) = state.0.lock() {
        *own = Some(text.clone());
    }
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| format!("could not write to the clipboard: {e}"))
}

/// The first clipboard read is whatever was already copied, not news: without
fn spawn_clipboard_watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[garia] No clipboard access: {e}");
                return;
            }
        };
        let mut last: Option<String> = None;
        let mut primed = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(800));
            let watching = app
                .try_state::<SettingsState>()
                .and_then(|s| s.current.lock().ok().map(|g| g.catch_clipboard))
                .unwrap_or(true);
            if !watching {
                primed = false;
                last = None;
                continue;
            }
            let Ok(text) = clipboard.get_text() else {
                continue;
            };
            if !primed {
                last = Some(text);
                primed = true;
                continue;
            }
            if last.as_deref() == Some(text.as_str()) {
                continue;
            }
            last = Some(text.clone());
            // Copying a download's own source URL out of garia must not come
            // back as an offer to download it again.
            let ours = app
                .try_state::<OwnCopy>()
                .and_then(|own| own.0.lock().ok().map(|g| g.as_deref() == Some(text.as_str())))
                .unwrap_or(false);
            if ours {
                continue;
            }
            if let Some(url) = catch::file_url_in(&text) {
                dispatch_catch(&app, url, "clipboard");
            }
        }
    });
}


/// ── The scheduler's tick ─────────────────────────────────────────────────
/// Reconciles what aria2 is doing against what the clock allows. It runs from
/// the moment the app starts, before the webview has painted, because that is
/// the case the frontend cannot cover: aria2 reads its session file and starts
/// every unfinished download in it within milliseconds of launch, so a window
/// that is shut has to be shut by something that is already awake.
///
/// The first pass happens immediately rather than after a tick's wait, which is
/// also what makes a launch *into* an open window start downloading at once —
/// the window is reconciled against the wall clock, not waited for.
fn spawn_schedule_watch(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        schedule_tick(&app);
        std::thread::sleep(schedule::TICK);
    });
}

fn schedule_tick(app: &tauri::AppHandle) {
    let (Some(aria2), Some(settings), Some(sched)) = (
        app.try_state::<Aria2>(),
        app.try_state::<SettingsState>(),
        app.try_state::<schedule::Schedule>(),
    ) else {
        return;
    };

    let saved = sched.snapshot();
    let (enabled, queue_stopped, done_action) = settings
        .current
        .lock()
        .map(|s| (s.schedule_enabled, s.queue_stopped, s.done_action))
        .unwrap_or((false, false, DoneAction::None));
    // Nothing to enforce and nothing outstanding: the common case, and it must
    // cost nothing. A schedule turned off while rows are still held is not that
    // case — those have to be let go rather than left stopped forever. A
    // done-action has to keep looking even when the clock is idle.
    if !enabled
        && !queue_stopped
        && saved.held.is_empty()
        && saved.starts.is_empty()
        && done_action == DoneAction::None
    {
        return;
    }

    let daily_open = aria2::window_open(&settings);
    let open = daily_open && !queue_stopped;
    let now = schedule::epoch_now();
    let secret = aria2.secret();
    let ask = |method: &str, params: serde_json::Value| {
        aria2::aria2_request(aria2.port, &secret, method, params).ok()
    };

    // `seeder` because a finished torrent is `active` to aria2 for as long as
    // it is uploading, and the window is about downloading. Stopping a seed is
    // a removal everywhere else in garia — a clock must not quietly make it a
    // pause instead.
    let keys = serde_json::json!(["gid", "status", "seeder"]);
    let mut rows: Vec<schedule::Row> = Vec::new();
    let mut known: std::collections::BTreeSet<String> = Default::default();

    for (method, params) in [
        ("aria2.tellActive", serde_json::json!([keys])),
        ("aria2.tellWaiting", serde_json::json!([0, 500, keys])),
        ("aria2.tellStopped", serde_json::json!([0, 500, keys])),
    ] {
        let Some(answer) = ask(method, params) else {
            // aria2 unreachable — say nothing and change nothing. Acting on a
            // half-read picture is how a scheduler loses downloads.
            return;
        };
        let Some(list) = answer.get("result").and_then(|r| r.as_array()) else {
            return;
        };
        for item in list {
            let gid = item.get("gid").and_then(|g| g.as_str()).unwrap_or_default();
            let status = item
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or_default();
            if gid.is_empty() {
                continue;
            }
            let seeding = item.get("seeder").and_then(|s| s.as_str()) == Some("true");
            known.insert(gid.to_string());
            // Only the two lists a download can be pulled out of or put back
            // into are worth deciding about; `tellStopped` is read to know
            // which gids still exist at all.
            if method != "aria2.tellStopped" && !seeding {
                rows.push(schedule::Row {
                    gid: gid.to_string(),
                    status: status.to_string(),
                });
            }
        }
    }

    let mut overridden = sched.overridden();
    let mut hold: Vec<String> = Vec::new();
    let mut unhold: Vec<String> = Vec::new();
    // Start times that have come round. Dropped whether the row ran on them or
    // was already going, so a retry of the same gid is not held a second time
    // for an hour that has already passed.
    let mut spent: Vec<String> = Vec::new();

    for row in &rows {
        // `open` already folds in Stop Queue. Start times have to be read
        // even when the daily window is off — otherwise a row held until
        // 3am is released on the next tick.
        let allowed = schedule::allowed(&row.gid, open, &saved.starts, now);
        if allowed && saved.starts.get(&row.gid).is_some_and(|at| now >= *at) {
            spent.push(row.gid.clone());
        }

        match schedule::decide(
            row,
            allowed,
            saved.held.contains(&row.gid),
            overridden.contains(&row.gid),
        ) {
            schedule::Act::Hold => {
                if ask("aria2.forcePause", serde_json::json!([row.gid])).is_some() {
                    hold.push(row.gid.clone());
                }
            }
            schedule::Act::Release => {
                if ask("aria2.unpause", serde_json::json!([row.gid])).is_some() {
                    unhold.push(row.gid.clone());
                }
            }
            // Somebody pressed Resume inside a shut window. That is an answer,
            // so the row stops being ours: we neither pause it again nor count
            // ourselves responsible for restarting it later.
            schedule::Act::Overridden => {
                overridden.insert(row.gid.clone());
                unhold.push(row.gid.clone());
            }
            schedule::Act::Leave => {}
        }
    }

    // An override answers one shut window rather than every future one, so the
    // window opening clears them all.
    if open {
        overridden.clear();
    } else {
        overridden.retain(|gid| known.contains(gid));
    }
    sched.set_overridden(overridden);
    sched.reconcile(&hold, &unhold, &spent, &known);

    let working = !rows.is_empty();
    // Held rows are still work, so a stopped queue does not look empty.
    // Passing None also cancels a drain that was armed before Stop Queue.
    drain_tick(
        app,
        working,
        if queue_stopped {
            DoneAction::None
        } else {
            done_action
        },
    );
}

/// Watches for the last unfinished download to land, then sleeps or shuts
/// the Mac down. Armed only after this run has seen work, so a launch onto
/// an empty list does nothing.
struct DrainWatch {
    seen_work: Mutex<bool>,
    cancel: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DrainEvent {
    action: DoneAction,
    seconds: u32,
}

const DRAIN_GRACE_SECS: u32 = 30;

fn cancel_drain(watch: &DrainWatch) {
    if let Ok(mut slot) = watch.cancel.lock() {
        if let Some(flag) = slot.take() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

fn drain_tick(app: &tauri::AppHandle, working: bool, action: DoneAction) {
    let Some(watch) = app.try_state::<DrainWatch>() else {
        return;
    };
    if action == DoneAction::None {
        cancel_drain(&watch);
        if let Ok(mut seen) = watch.seen_work.lock() {
            *seen = working;
        }
        return;
    }
    if working {
        cancel_drain(&watch);
        if let Ok(mut seen) = watch.seen_work.lock() {
            *seen = true;
        }
        return;
    }
    let armed = watch.seen_work.lock().map(|mut s| {
        let was = *s;
        *s = false;
        was
    }).unwrap_or(false);
    if !armed {
        return;
    }
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Ok(mut slot) = watch.cancel.lock() {
        if let Some(old) = slot.replace(flag.clone()) {
            old.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let host = if cfg!(target_os = "macos") {
        "This Mac"
    } else {
        "This computer"
    };
    let body = match action {
        DoneAction::Sleep => format!("{host} will sleep in 30 seconds."),
        DoneAction::Shutdown => format!("{host} will shut down in 30 seconds."),
        DoneAction::None => return,
    };
    let _ = app.emit("queue-drained", DrainEvent { action, seconds: DRAIN_GRACE_SECS });
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Queue finished")
        .body(body)
        .show();
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(DRAIN_GRACE_SECS as u64));
        if flag.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        perform_done_action(action);
        if let Some(watch) = handle.try_state::<DrainWatch>() {
            if let Ok(mut slot) = watch.cancel.lock() {
                slot.take();
            }
        }
    });
}

fn perform_done_action(action: DoneAction) {
    match action {
        DoneAction::None => {}
        #[cfg(target_os = "macos")]
        DoneAction::Sleep => {
            let _ = Command::new("osascript")
                .args(["-e", "tell application \"System Events\" to sleep"])
                .status();
        }
        #[cfg(target_os = "macos")]
        DoneAction::Shutdown => {
            let _ = Command::new("osascript")
                .args(["-e", "tell application \"System Events\" to shut down"])
                .status();
        }
        #[cfg(target_os = "linux")]
        DoneAction::Sleep => {
            if Command::new("systemctl")
                .args(["suspend"])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                return;
            }
            let _ = Command::new("loginctl").args(["suspend"]).status();
        }
        #[cfg(target_os = "linux")]
        DoneAction::Shutdown => {
            if Command::new("systemctl")
                .args(["poweroff"])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                return;
            }
            let _ = Command::new("loginctl").args(["poweroff"]).status();
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        DoneAction::Sleep | DoneAction::Shutdown => {}
    }
}

#[tauri::command]
fn preview_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !Path::new(&path).is_file() {
        return Err(format!("{path} is not there any more"));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|e| format!("could not open {path}: {e}"))
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        // Size and place, not visibility: hide-on-close would otherwise come
        // back as a launch with no window.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            aria2_rpc,
            aria2_endpoint,
            platform,
            trash_files,
            get_settings,
            save_settings,
            get_logins,
            save_login,
            delete_login,
            set_badge,
            take_pending_catch,
            take_pending_torrents,
            read_torrent,
            copy_text,
            video_tools,
            sidecar_tools,
            video_probe,
            cancel_video_probes,
            ftp_list,
            mux_video,
            preview_state,
            preview_file,
            remote_info,
            schedule_state,
            set_download_start,
            set_queue_stopped,
            cancel_queue_drain,
            autostart_enabled,
            set_autostart,
            open_settings_window,
            sync_view_menu,
            browser_extension_dir,
            start_file_drag,
            check_for_update,
            install_update,
            set_status_item
        ])
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("garia"));
            if let Err(e) = fs::create_dir_all(&dir) {
                eprintln!("[garia] Could not create {}: {e}", dir.display());
            }

            let pid_file = dir.join("aria2.pid");
            aria2::reap_orphan(&pid_file);

            let settings_file = dir.join("settings.json");
            let mut settings = settings::read_settings(&settings_file);
            settings.proxy_password = settings::read_proxy_passwd(&settings::proxy_passwd_path(&settings_file));

            let logins_file = dir.join("logins.json");
            let netrc_file = dir.join("netrc");
            let saved_logins = logins::read(&logins_file);
            // The netrc is derived, so it is rebuilt at every launch rather
            // than trusted: a store edited by hand, or one written by a build
            // that stored passwords differently, still ends up with an aria2
            // that reads exactly what garia holds.
            if let Err(e) = logins::write_netrc(&netrc_file, &saved_logins) {
                eprintln!("[garia] Could not write {}: {e}", netrc_file.display());
            }

            // A launch with remote control already on picks up the token the
            // devices were paired against; every other launch gets one that
            // has never been written down.
            let remote_secret_file = dir.join("remote-secret");
            let secret = if settings.remote_control {
                settings::remote_secret(&remote_secret_file)
            } else {
                let _ = fs::remove_file(&remote_secret_file);
                settings::random_secret()
            };
            let session = aria2::session_path(&dir);
            let port = aria2::pick_port();
            let child = aria2::spawn_aria2(port, &secret, &session, &netrc_file, &settings);

            match &child {
                Some(c) => {
                    if let Err(e) = fs::write(&pid_file, c.id().to_string()) {
                        eprintln!("[garia] Could not record the aria2c pid: {e}");
                    }
                }
                None => eprintln!(
                    "[garia] No aria2c found — the bundled one is missing and none is installed. \
                 Build it with: npm run sidecar"
                ),
            }

            app.manage(Aria2 {
                child: Mutex::new(child),
                secret: Mutex::new(secret),
                port,
                pid_file,
                session,
                netrc: netrc_file.clone(),
                remote_secret: remote_secret_file,
                calls: tokio::sync::Semaphore::new(aria2::RPC_CONCURRENCY),
                restarting: RwLock::new(()),
            });
            app.manage(SettingsState {
                file: settings_file,
                current: Mutex::new(settings),
            });
            app.manage(LoginsState {
                file: logins_file,
                netrc: netrc_file,
                current: Mutex::new(saved_logins),
            });

            // The bundled zipapp. Missing it is not fatal — it is the second
            // choice anyway, and a machine with its own yt-dlp never looks.
            let zipapp = app
                .path()
                .resolve("resources/yt-dlp", tauri::path::BaseDirectory::Resource)
                .ok()
                .filter(|p| p.is_file());
            if zipapp.is_none() {
                eprintln!(
                    "[garia] No bundled yt-dlp — video downloads need one on the machine. \
                 Fetch it with: npm run sidecar"
                );
            }
            app.manage(Video {
                zipapp,
                resolved: Mutex::new(None),
                tools: Mutex::new(None),
            });
            app.manage(CatchQueue {
                pending: Mutex::new(Vec::new()),
            });
            app.manage(TorrentQueue {
                pending: Mutex::new(Vec::new()),
            });
            app.manage(schedule::Schedule::new(schedule::state_file(&dir)));
            app.manage(DrainWatch {
                seen_work: Mutex::new(false),
                cancel: Mutex::new(None),
            });
            app.manage(OwnCopy::default());

            // `garia://add?url=…` from a bookmarklet, and `magnet:` from the
            // browser or Finder. macOS delivers these to the running instance;
            // a cold launch is `get_current` below. `.torrent` files arrive
            // as `RunEvent::Opened`, not through this plugin.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for link in event.urls() {
                        ingest_deep_link(&handle, link.as_str());
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let handle = app.handle().clone();
                    for link in urls {
                        ingest_deep_link(&handle, link.as_str());
                    }
                }
            }

            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
            }
            match install_menu(app) {
                Ok(items) => {
                    app.manage(ViewMenu {
                        items: Mutex::new(items),
                    });
                }
                Err(e) => eprintln!("[garia] Could not install the menu: {e}"),
            }
            if let Err(e) = install_status_item(app) {
                eprintln!("[garia] Could not install the menu-bar extra: {e}");
            }
            #[cfg(target_os = "macos")]
            if let Err(e) = service::install(app.handle().clone()) {
                eprintln!("[garia] Could not install Services: {e}");
            }
            #[cfg(target_os = "macos")]
            if let Err(e) = dock::install(app.handle().clone()) {
                eprintln!("[garia] Could not install the dock menu: {e}");
            }
            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "settings" => {
                        if let Err(e) = show_settings(app) {
                            eprintln!("[garia] Could not open Settings: {e}");
                        }
                    }
                    "new-download" | "open-torrent" | "find"
                    | "pause-all" | "resume-all" | "stop-queue" | "start-queue"
                    | "open-folder"
                    | "check-updates" | "licenses" | "help"
                    | "show-sidebar" => {
                        bring_to_front(app);
                        let _ = app.emit("menu", event.id().as_ref());
                    }
                    "col-size" | "col-speed" | "col-eta" | "col-connections"
                    | "col-source" | "col-category" => {
                        let _ = app.emit("menu", event.id().as_ref());
                    }
                    _ => {}
                }
            });

            spawn_clipboard_watch(app.handle().clone());
            // Started last and running from this moment: aria2 was spawned a
            // few lines up and is already working through the session file.
            // Closing the window no longer stops it — only Quit does — so a
            // schedule that opens at 2am has a process to talk to.
            spawn_schedule_watch(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close hides the window. Downloads keep going; the tray (and on
            // macOS the dock icon) is how you come back. Quit is the exit.
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::Exit => {
                    if let Some(state) = app.try_state::<Aria2>() {
                        // kill() is a SIGKILL, so aria2 never gets to write the
                        // session itself — ask it to before pulling the plug.
                        if let Err(e) = aria2::aria2_request(
                            state.port,
                            &state.secret(),
                            "aria2.saveSession",
                            serde_json::json!([]),
                        ) {
                            eprintln!("[garia] Could not save the aria2 session: {e}");
                        }
                        if let Ok(mut guard) = state.child.lock() {
                            if let Some(mut child) = guard.take() {
                                let _ = child.kill();
                                let _ = child.wait();
                            }
                        }
                        let _ = fs::remove_file(&state.pid_file);
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => bring_to_front(app),
                #[cfg(any(target_os = "macos", target_os = "ios"))]
                tauri::RunEvent::Opened { urls } => {
                    for url in urls {
                        ingest_opened(app, url.as_str());
                    }
                }
                _ => {}
            }
        });
}

fn ingest_deep_link(app: &tauri::AppHandle, link: &str) {
    if let Some(mut event) = catch::catch_from_garia_link(link) {
        // A long "download all links" list will not fit in the scheme, so
        // the extension writes it to the clipboard and sends batch=1.
        if event.url.is_empty() {
            let text = clipboard_text().unwrap_or_default();
            let urls = catch::urls_in(&text);
            if urls.is_empty() {
                return;
            }
            if let Some(own) = app.try_state::<OwnCopy>() {
                if let Ok(mut guard) = own.0.lock() {
                    *guard = Some(text);
                }
            }
            event.url = urls[0].clone();
            event.urls = if urls.len() > 1 { urls } else { Vec::new() };
            event.source = "extension".into();
            event.confirm = true;
        }
        dispatch_catch_event(app, event);
    } else if let Some(url) = catch::magnet_url(link) {
        dispatch_catch(app, url, "scheme");
    }
}

fn clipboard_text() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}

/// The menu a Mac app is expected to have: the app name, File, Edit, Window,
/// and the shortcuts that belong on them. Replacing Tauri's default is what
/// makes Settings land on ⌘, and New Download on ⌘N rather than nowhere.
fn install_menu(app: &tauri::App) -> tauri::Result<Vec<tauri::menu::CheckMenuItem<tauri::Wry>>> {
    use tauri::menu::{AboutMetadata, CheckMenuItem, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let new_download = MenuItemBuilder::with_id("new-download", "New Download")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open_torrent = MenuItemBuilder::with_id("open-torrent", "Open Torrent…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("open-folder", "Open Download Folder")
        .build(app)?;
    let find = MenuItemBuilder::with_id("find", "Find")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let pause_all = MenuItemBuilder::with_id("pause-all", "Pause All").build(app)?;
    let resume_all = MenuItemBuilder::with_id("resume-all", "Resume All").build(app)?;
    let stop_queue = MenuItemBuilder::with_id("stop-queue", "Stop Queue").build(app)?;
    let start_queue = MenuItemBuilder::with_id("start-queue", "Start Queue").build(app)?;

    let check_updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…")
        .build(app)?;
    let garia_help = MenuItemBuilder::with_id("help", "Garia Help")
        .accelerator("CmdOrCtrl+?")
        .build(app)?;
    let licenses = MenuItemBuilder::with_id("licenses", "Licenses…").build(app)?;

    let about = AboutMetadata {
        name: Some("Garia".into()),
        version: Some(app.package_info().version.to_string()),
        copyright: Some("A download manager.".into()),
        website: Some("https://github.com/fabimc/garia".into()),
        website_label: Some("Source and issue tracker".into()),
        credits: Some(
            "Downloads run on a bundled aria2 (GPL-2.0-or-later).\n\
             Video pages are read by yt-dlp (Unlicense).\n\
             Video merges use ffmpeg, licensed under LGPL-2.1 — \
             muxers only, no GPL parts.\n\
             The window is Tauri (MIT or Apache-2.0).\n\
             Help → Licenses lists where the source is."
                .into(),
        ),
        icon: app.default_window_icon().cloned(),
        ..Default::default()
    };

    let app_menu = SubmenuBuilder::new(app, "Garia")
        .about(Some(about))
        .item(&check_updates)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_download)
        .item(&open_torrent)
        .separator()
        .item(&open_folder)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .build()?;

    let show_sidebar = CheckMenuItem::with_id(
        app,
        "show-sidebar",
        "Show Sidebar",
        true,
        true,
        None::<&str>,
    )?;
    let col_size = CheckMenuItem::with_id(app, "col-size", "Size", true, true, None::<&str>)?;
    let col_speed = CheckMenuItem::with_id(app, "col-speed", "Speed", true, true, None::<&str>)?;
    let col_eta = CheckMenuItem::with_id(app, "col-eta", "Time left", true, true, None::<&str>)?;
    let col_connections =
        CheckMenuItem::with_id(app, "col-connections", "Sockets", true, false, None::<&str>)?;
    let col_source = CheckMenuItem::with_id(app, "col-source", "Source", true, false, None::<&str>)?;
    let col_category =
        CheckMenuItem::with_id(app, "col-category", "Category", true, false, None::<&str>)?;
    let columns_menu = SubmenuBuilder::new(app, "Columns")
        .item(&col_size)
        .item(&col_speed)
        .item(&col_eta)
        .separator()
        .item(&col_connections)
        .item(&col_source)
        .item(&col_category)
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&show_sidebar)
        .separator()
        .item(&columns_menu)
        .build()?;

    let download_menu = SubmenuBuilder::new(app, "Download")
        .item(&pause_all)
        .item(&resume_all)
        .separator()
        .item(&stop_queue)
        .item(&start_queue)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .close_window()
        .build()?;

    let help_menu = SubmenuBuilder::with_id(app, tauri::menu::HELP_SUBMENU_ID, "Help")
        .item(&garia_help)
        .separator()
        .item(&licenses)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&download_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    help_menu.set_as_help_menu_for_nsapp()?;
    Ok(vec![
        show_sidebar,
        col_size,
        col_speed,
        col_eta,
        col_connections,
        col_source,
        col_category,
    ])
}

/// A face while the window is hidden: click the extra for New Download,
/// Pause All, and Show Garia. The dock icon is still how you come back
/// without thinking; this is for the moment you do not want the list.
fn install_status_item(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let new_download = MenuItemBuilder::with_id("new-download", "New Download").build(app)?;
    let pause_all = MenuItemBuilder::with_id("pause-all", "Pause All").build(app)?;
    let resume_all = MenuItemBuilder::with_id("resume-all", "Resume All").build(app)?;
    let stop_queue = MenuItemBuilder::with_id("stop-queue", "Stop Queue").build(app)?;
    let start_queue = MenuItemBuilder::with_id("start-queue", "Start Queue").build(app)?;
    let open_folder = MenuItemBuilder::with_id("open-folder", "Open Download Folder").build(app)?;
    let show = MenuItemBuilder::with_id("show-window", "Show Garia").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&new_download)
        .separator()
        .item(&pause_all)
        .item(&resume_all)
        .separator()
        .item(&stop_queue)
        .item(&start_queue)
        .separator()
        .item(&open_folder)
        .separator()
        .item(&show)
        .build()?;

    // The dock icon is the shovel on a cream tile. As a template that
    // tile is every opaque pixel, so the extra rendered as a white
    // square. This file is just the shovel, black on clear.
    let icon = tauri::include_image!("icons/tray-template.png");
    TrayIconBuilder::with_id("status")
        .menu(&menu)
        .tooltip("Garia")
        .icon(icon)
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-window" => bring_to_front(app),
            id @ ("new-download" | "pause-all" | "resume-all" | "stop-queue" | "start-queue" | "open-folder") => {
                bring_to_front(app);
                let _ = app.emit("menu", id);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
