//! iced entry point for Garia (Phase 2 MVP).
//!
//! Package name is `garia-app` so it can sit beside the Tauri package `garia`
//! in the same workspace. Binary: `garia-app`.

use std::path::PathBuf;

use garia_core::aria2;
use garia_ui::App;
use iced::Size;

fn main() -> iced::Result {
    let data_dir = data_dir();
    eprintln!("[garia-app] data dir {}", data_dir.display());
    let engine = aria2::bootstrap(data_dir);

    iced::application(App::title, App::update, App::view)
        .subscription(App::subscription)
        .theme(App::theme)
        .window_size(Size::new(960.0, 640.0))
        .run_with(move || App::new(engine))
}

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("garia")
}
