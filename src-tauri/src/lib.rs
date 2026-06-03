use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;

struct Aria2Process(Mutex<Option<Child>>);

#[tauri::command]
fn aria2_rpc(method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let url = "http://127.0.0.1:6800/jsonrpc";
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });

    ureq::post(url)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("aria2 request failed: {e}"))?
        .into_json::<serde_json::Value>()
        .map_err(|e| format!("aria2 invalid response: {e}"))
}

fn aria2c_candidates() -> Vec<&'static str> {
    let mut c = vec!["aria2c"];

    // macOS GUI apps (launched via Finder) often don't inherit Homebrew PATH.
    // Try common Homebrew install locations explicitly.
    #[cfg(target_os = "macos")]
    {
        c.extend(["/opt/homebrew/bin/aria2c", "/usr/local/bin/aria2c"]);
    }

    // Common Linux locations.
    #[cfg(target_os = "linux")]
    {
        c.extend(["/usr/bin/aria2c", "/bin/aria2c", "/snap/bin/aria2c"]);
    }

    c
}

fn spawn_aria2() -> Option<Child> {
    let download_dir = dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads"));

    for bin in aria2c_candidates() {
        if bin.contains('/') && !Path::new(bin).exists() {
            continue;
        }

        let child = Command::new(bin)
            .args([
                "--enable-rpc",
                "--rpc-allow-origin-all",
                "--rpc-listen-all=false",
                "--rpc-listen-port=6800",
                "--quiet=true",
                &format!("--dir={}", download_dir.display()),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        match child {
            Ok(child) => {
                eprintln!("[garia] Started aria2c via {bin}");
                return Some(child);
            }
            Err(e) => {
                // If the binary isn't found in PATH, trying the next candidate may help.
                eprintln!("[garia] Failed to start aria2c via {bin}: {e}");
            }
        }
    }

    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![aria2_rpc])
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
