use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct Aria2Process(Mutex<Option<Child>>);

fn spawn_aria2() -> Option<Child> {
    let download_dir = dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads"));

    Command::new("aria2c")
        .args([
            "--enable-rpc",
            "--rpc-allow-origin-all",
            "--quiet=true",
            &format!("--dir={}", download_dir.display()),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| eprintln!("[garia] Failed to start aria2c: {e}"))
        .ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let child = spawn_aria2();
            if child.is_none() {
                eprintln!("[garia] aria2c not found — install it with: brew install aria2");
            }
            app.manage(Aria2Process(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Aria2Process>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
