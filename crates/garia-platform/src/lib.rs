//! OS integration for the iced Garia shell (Mac + Linux).
//!
//! Traits describe product behaviour; `macos` / `linux` modules supply the
//! concrete bits. The iced UI talks to [`Platform`] and drains [`PlatformEvent`]s.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use garia_core::catch::{self, CatchEvent};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "linux")]
use linux as os;
#[cfg(target_os = "macos")]
use macos as os;

/// Events the iced shell should turn into Messages.
#[derive(Debug, Clone)]
pub enum PlatformEvent {
    Tray(TrayAction),
    Catch(CatchEvent),
    OpenTorrent(PathBuf),
    DeepLink(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Show,
    NewDownload,
    PauseAll,
    ResumeAll,
    OpenFolder,
    Quit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    pub current_version: String,
    pub url: Option<String>,
}

const LATEST_JSON: &str =
    "https://github.com/fabimc/garia/releases/latest/download/latest.json";

/// Shared handle the UI and background watchers use.
#[derive(Clone)]
pub struct Platform {
    events_tx: Sender<PlatformEvent>,
    events_rx: Arc<Mutex<Receiver<PlatformEvent>>>,
    download_dir: Arc<Mutex<PathBuf>>,
}

thread_local! {
    static TRAY: std::cell::RefCell<Option<tray_icon::TrayIcon>> = const { std::cell::RefCell::new(None) };
    static TRAY_IDS: std::cell::RefCell<Option<TrayIds>> = const { std::cell::RefCell::new(None) };
}

#[derive(Clone)]
struct TrayIds {
    show: tray_icon::menu::MenuId,
    new_dl: tray_icon::menu::MenuId,
    pause: tray_icon::menu::MenuId,
    resume: tray_icon::menu::MenuId,
    folder: tray_icon::menu::MenuId,
    quit: tray_icon::menu::MenuId,
}

impl Platform {
    pub fn start(download_dir: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel();
        let platform = Self {
            events_tx: tx.clone(),
            events_rx: Arc::new(Mutex::new(rx)),
            download_dir: Arc::new(Mutex::new(download_dir)),
        };

        // argv: garia://, magnet:, .torrent paths (cold launch / desktop open).
        for arg in std::env::args().skip(1) {
            ingest_arg(&platform.events_tx, &arg);
        }

        spawn_clipboard_watch(tx.clone());
        #[cfg(target_os = "linux")]
        {
            // tray-icon on Linux talks to AppIndicator via GTK.
            if let Err(e) = gtk::init() {
                eprintln!("[garia] gtk::init failed (tray may be unavailable): {e}");
            }
        }
        if let Err(e) = install_tray_main_thread() {
            eprintln!("[garia] tray icon unavailable: {e}");
        }

        os::on_start(&platform);
        platform
    }

    pub fn try_recv(&self) -> Option<PlatformEvent> {
        let rx = self.events_rx.lock().ok()?;
        match rx.try_recv() {
            Ok(ev) => Some(ev),
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => None,
        }
    }

    pub fn set_download_dir(&self, dir: PathBuf) {
        if let Ok(mut g) = self.download_dir.lock() {
            *g = dir;
        }
    }

    pub fn download_dir(&self) -> PathBuf {
        self.download_dir
            .lock()
            .map(|d| d.clone())
            .unwrap_or_else(|_| PathBuf::from("."))
    }

    /// Mac: tray title count. Linux: tooltip only.
    pub fn set_active_count(&self, active: u32) {
        TRAY.with(|cell| {
            let binding = cell.borrow();
            let Some(tray) = binding.as_ref() else { return };
            let tip = if active == 0 {
                "Garia".to_string()
            } else if active == 1 {
                "Garia — 1 downloading".to_string()
            } else {
                format!("Garia — {active} downloading")
            };
            let _ = tray.set_tooltip(Some(&tip));
            #[cfg(target_os = "macos")]
            {
                let title = if active == 0 {
                    String::new()
                } else {
                    active.to_string()
                };
                let _ = tray.set_title(Some(&title));
            }
        });
    }

    /// Drain tray menu clicks into the event queue (call from iced main thread).
    pub fn pump_tray_menus(&self) {
        use tray_icon::menu::MenuEvent;
        let Ok(ids) = TRAY_IDS.try_with(|c| c.borrow().clone()) else { return };
        let Some(ids) = ids else { return };
        let receiver = MenuEvent::receiver();
        while let Ok(event) = receiver.try_recv() {
            let action = if event.id == ids.show {
                TrayAction::Show
            } else if event.id == ids.new_dl {
                TrayAction::NewDownload
            } else if event.id == ids.pause {
                TrayAction::PauseAll
            } else if event.id == ids.resume {
                TrayAction::ResumeAll
            } else if event.id == ids.folder {
                TrayAction::OpenFolder
            } else if event.id == ids.quit {
                TrayAction::Quit
            } else {
                continue;
            };
            let _ = self.events_tx.send(PlatformEvent::Tray(action));
        }
    }

    pub fn notify(&self, title: &str, body: &str) {
        let _ = notify_rust::Notification::new()
            .summary(title)
            .body(body)
            .appname("Garia")
            .show();
    }

    pub fn pick_folder(&self) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title("Download folder")
            .pick_folder()
    }

    pub fn pick_torrent(&self) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title("Open torrent")
            .add_filter("Torrent", &["torrent"])
            .pick_file()
    }

    pub fn reveal(&self, path: &Path) -> Result<(), String> {
        let path = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        open::that(path).map_err(|e| format!("could not reveal {}: {e}", path.display()))
    }

    pub fn open_path(&self, path: &Path) -> Result<(), String> {
        open::that(path).map_err(|e| format!("could not open {}: {e}", path.display()))
    }

    pub fn autostart_enabled(&self) -> Result<bool, String> {
        autostart()?.is_enabled().map_err(|e| e.to_string())
    }

    pub fn set_autostart(&self, enabled: bool) -> Result<(), String> {
        let auto = autostart()?;
        if enabled {
            auto.enable().map_err(|e| e.to_string())
        } else {
            auto.disable().map_err(|e| e.to_string())
        }
    }

    /// Check GitHub `latest.json` (Tauri updater format). Signature verify is
    /// deferred — we compare versions and surface notes/URL only.
    pub fn check_for_update(&self, current_version: &str) -> Result<Option<UpdateInfo>, String> {
        check_latest_json(current_version)
    }

    /// Dock badge — macOS only; Linux no-op.
    pub fn set_badge(&self, count: u32) {
        os::set_badge(count);
    }

    pub fn push(&self, event: PlatformEvent) {
        let _ = self.events_tx.send(event);
    }
}

fn ingest_arg(tx: &Sender<PlatformEvent>, arg: &str) {
    let arg = arg.trim();
    if arg.is_empty() {
        return;
    }
    if let Some(event) = catch::catch_from_garia_link(arg) {
        let _ = tx.send(PlatformEvent::Catch(event));
        return;
    }
    if let Some(url) = catch::magnet_url(arg) {
        let _ = tx.send(PlatformEvent::Catch(CatchEvent {
            url,
            source: "scheme".into(),
            name: None,
            referrer: None,
            confirm: false,
            urls: Vec::new(),
        }));
        return;
    }
    let path = PathBuf::from(arg);
    if catch::is_torrent(&path) {
        let _ = tx.send(PlatformEvent::OpenTorrent(path));
        return;
    }
    if arg.starts_with("garia://") || arg.starts_with("magnet:") {
        let _ = tx.send(PlatformEvent::DeepLink(arg.to_string()));
    }
}

fn spawn_clipboard_watch(tx: Sender<PlatformEvent>) {
    thread::spawn(move || {
        let Ok(mut clipboard) = arboard::Clipboard::new() else {
            eprintln!("[garia] No clipboard access");
            return;
        };
        let mut last = clipboard.get_text().unwrap_or_default();
        // Skip whatever was already there.
        loop {
            thread::sleep(Duration::from_millis(800));
            let Ok(text) = clipboard.get_text() else {
                continue;
            };
            if text == last || text.trim().is_empty() {
                continue;
            }
            last = text.clone();
            if let Some(url) = catch::file_url_in(&text) {
                let _ = tx.send(PlatformEvent::Catch(CatchEvent {
                    url,
                    source: "clipboard".into(),
                    name: None,
                    referrer: None,
                    confirm: true,
                    urls: Vec::new(),
                }));
            }
        }
    });
}

fn install_tray_main_thread() -> Result<(), String> {
    use tray_icon::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tray_icon::TrayIconBuilder;

    let menu = Menu::new();
    let show = MenuItem::new("Show Garia", true, None);
    let new_dl = MenuItem::new("New Download", true, None);
    let pause = MenuItem::new("Pause All", true, None);
    let resume = MenuItem::new("Resume All", true, None);
    let folder = MenuItem::new("Open Download Folder", true, None);
    let quit = MenuItem::new("Quit", true, None);
    menu.append(&show).map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::separator())
        .map_err(|e| e.to_string())?;
    menu.append(&new_dl).map_err(|e| e.to_string())?;
    menu.append(&pause).map_err(|e| e.to_string())?;
    menu.append(&resume).map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::separator())
        .map_err(|e| e.to_string())?;
    menu.append(&folder).map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::separator())
        .map_err(|e| e.to_string())?;
    menu.append(&quit).map_err(|e| e.to_string())?;

    let ids = TrayIds {
        show: show.id().clone(),
        new_dl: new_dl.id().clone(),
        pause: pause.id().clone(),
        resume: resume.id().clone(),
        folder: folder.id().clone(),
        quit: quit.id().clone(),
    };

    let icon = tray_icon_rgba();
    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("Garia")
        .with_icon(icon)
        .build()
        .map_err(|e| e.to_string())?;

    TRAY.with(|c| *c.borrow_mut() = Some(tray));
    TRAY_IDS.with(|c| *c.borrow_mut() = Some(ids));
    Ok(())
}

fn tray_icon_rgba() -> tray_icon::Icon {
    // Simple 32×32 cream tile with a dark “G” block — enough for the tray.
    let size = 32u32;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let i = ((y * size + x) * 4) as usize;
            let edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
            let glyph = (x > 8 && x < 24 && y > 6 && y < 26)
                && !(x > 12 && x < 20 && y > 10 && y < 22 && !(y > 14 && y < 18 && x < 16));
            if edge || glyph {
                rgba[i] = 0x2a;
                rgba[i + 1] = 0x2a;
                rgba[i + 2] = 0x2a;
                rgba[i + 3] = 0xff;
            } else {
                rgba[i] = 0xf2;
                rgba[i + 1] = 0xeb;
                rgba[i + 2] = 0xdd;
                rgba[i + 3] = 0xff;
            }
        }
    }
    tray_icon::Icon::from_rgba(rgba, size, size).expect("tray icon")
}

fn autostart() -> Result<auto_launch::AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = "Garia";
    #[cfg(target_os = "macos")]
    {
        // LaunchAgent-style via auto-launch.
        auto_launch::AutoLaunchBuilder::new()
            .set_app_name(name)
            .set_app_path(&exe.display().to_string())
            .set_use_launch_agent(true)
            .build()
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        auto_launch::AutoLaunchBuilder::new()
            .set_app_name(name)
            .set_app_path(&exe.display().to_string())
            .build()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = exe;
        Err("autostart is only wired on macOS and Linux".into())
    }
}

fn check_latest_json(current_version: &str) -> Result<Option<UpdateInfo>, String> {
    let body: serde_json::Value = ureq::get(LATEST_JSON)
        .call()
        .map_err(|e| format!("could not fetch latest.json: {e}"))?
        .into_json()
        .map_err(|e| format!("could not parse latest.json: {e}"))?;

    // Tauri updater format: { version, notes, platforms: { ... } }
    let version = body
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "latest.json has no version".to_string())?
        .trim_start_matches('v')
        .to_string();
    let notes = body
        .get("notes")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let url = body
        .get("platforms")
        .and_then(|p| {
            #[cfg(target_os = "linux")]
            {
                p.get("linux-x86_64")
                    .or_else(|| p.get("linux-aarch64"))
                    .and_then(|x| x.get("url"))
                    .and_then(|u| u.as_str())
            }
            #[cfg(target_os = "macos")]
            {
                p.get("darwin-aarch64")
                    .or_else(|| p.get("darwin-x86_64"))
                    .and_then(|x| x.get("url"))
                    .and_then(|u| u.as_str())
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                None
            }
        })
        .map(|s| s.to_string());

    let current = current_version.trim_start_matches('v');
    if version_cmp(&version, current) > 0 {
        Ok(Some(UpdateInfo {
            version,
            notes,
            current_version: current.to_string(),
            url,
        }))
    } else {
        Ok(None)
    }
}

/// Very small dotted-numeric compare: 1.2.10 > 1.2.9. Non-numeric → equal.
fn version_cmp(a: &str, b: &str) -> i32 {
    let parse = |s: &str| {
        s.split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let aa = parse(a);
    let bb = parse(b);
    let n = aa.len().max(bb.len());
    for i in 0..n {
        let x = aa.get(i).copied().unwrap_or(0);
        let y = bb.get(i).copied().unwrap_or(0);
        if x > y {
            return 1;
        }
        if x < y {
            return -1;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_sort_ahead() {
        assert!(version_cmp("0.3.0", "0.2.0") > 0);
        assert!(version_cmp("0.2.0", "0.2.0") == 0);
        assert!(version_cmp("0.2.1", "0.2.10") < 0);
    }
}
