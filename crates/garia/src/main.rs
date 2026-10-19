//! iced entry point for Garia.
//!
//! Package and binary name: `garia`.

use std::path::PathBuf;

use garia_core::aria2;
use garia_platform::Platform;
use garia_ui::App;
use iced::Size;

fn main() -> iced::Result {
    let data_dir = data_dir();
    eprintln!("[garia] data dir {}", data_dir.display());
    let engine = aria2::bootstrap(data_dir.clone());
    let download_dir = engine
        .settings
        .current
        .lock()
        .map(|s| PathBuf::from(&s.download_dir))
        .unwrap_or_else(|_| PathBuf::from("."));
    let platform = Platform::start(download_dir);
    let zipapp = bundled_yt_dlp();
    if zipapp.is_none() {
        eprintln!(
            "[garia] No bundled yt-dlp next to the binary — video pages need yt-dlp on PATH \
             or resources/yt-dlp beside the executable. Fetch with: ./scripts/sidecar.sh"
        );
    }

    iced::application(App::title, App::update, App::view)
        .subscription(App::subscription)
        .theme(App::theme)
        .window_size(Size::new(1040.0, 720.0))
        .run_with(move || App::new(engine, platform, zipapp))
}

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("garia")
}

/// Prefer `yt-dlp` next to the executable (release layout), then `resources/yt-dlp`
/// relative to the cwd / repo (dev after `./scripts/sidecar.sh`).
fn bundled_yt_dlp() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("yt-dlp"));
            candidates.push(dir.join("resources").join("yt-dlp"));
        }
    }
    candidates.push(PathBuf::from("resources/yt-dlp"));
    candidates.into_iter().find(|p| p.is_file())
}
