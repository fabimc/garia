//! iced entry point for Garia (Phase 3 — platform parity).
//!
//! Package name is `garia-app` so it can sit beside the Tauri package `garia`.

use std::path::PathBuf;

use garia_core::aria2;
use garia_platform::Platform;
use garia_ui::App;
use iced::Size;

fn main() -> iced::Result {
    let data_dir = data_dir();
    eprintln!("[garia-app] data dir {}", data_dir.display());
    let engine = aria2::bootstrap(data_dir.clone());
    let download_dir = engine
        .settings
        .current
        .lock()
        .map(|s| PathBuf::from(&s.download_dir))
        .unwrap_or_else(|_| PathBuf::from("."));
    let platform = Platform::start(download_dir);

    iced::application(App::title, App::update, App::view)
        .subscription(App::subscription)
        .theme(App::theme)
        .window_size(Size::new(1040.0, 720.0))
        .run_with(move || App::new(engine, platform))
}

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("garia")
}
