use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// The aria2c child process plus the RPC secret it was started with.
struct Aria2 {
    child: Mutex<Option<Child>>,
    secret: String,
    port: u16,
    pid_file: PathBuf,
}

/// What the user gets to decide. Kept here rather than read back out of aria2
/// because these have to survive a restart, and aria2 forgets everything that
/// isn't an unfinished download.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    download_dir: String,
    max_concurrent_downloads: u32,
    /// Bytes per second across every download. 0 is aria2's own "no limit".
    max_overall_download_limit: u64,
    /// Route each download into a subfolder named after its kind. Off by
    /// default: where a file lands is the user's expectation to change, not
    /// ours. The routing itself lives in the frontend, which names the folder
    /// per download at add time — nothing here moves a file.
    smart_folders: bool,
    /// Say so when a download finishes. On by default: the whole point of a
    /// download manager is not having to watch it.
    notify_on_complete: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: default_download_dir().display().to_string(),
            // aria2's own default, and a sane one: five files at a time.
            max_concurrent_downloads: 5,
            max_overall_download_limit: 0,
            smart_folders: false,
            notify_on_complete: true,
        }
    }
}

impl Settings {
    /// Settings arrive from a JSON file the user can edit and from the
    /// frontend, so nothing is trusted: a zero concurrency stalls every
    /// download, and an empty folder makes aria2 refuse to start.
    fn normalised(mut self) -> Self {
        self.max_concurrent_downloads = self.max_concurrent_downloads.clamp(1, 16);
        if self.download_dir.trim().is_empty() {
            self.download_dir = default_download_dir().display().to_string();
        }
        self
    }
}

/// The settings file, plus the values currently in force.
struct SettingsState {
    file: PathBuf,
    current: Mutex<Settings>,
}

fn default_download_dir() -> PathBuf {
    dirs::download_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads"))
}

/// A missing or unreadable file is not an error — it is a first launch.
fn read_settings(file: &Path) -> Settings {
    fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
        .normalised()
}

/// aria2 binds to 127.0.0.1, but any process on the machine — including a web
/// page in the user's browser — can reach that port. The secret token is what
/// keeps the RPC interface ours: it's generated fresh on every launch and
/// prepended to the params of every call, per aria2's RPC spec.
fn random_secret() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("failed to generate an RPC secret");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn aria2_request(
    port: u16,
    secret: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut args = match params {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Null => Vec::new(),
        other => vec![other],
    };
    args.insert(0, serde_json::json!(format!("token:{secret}")));

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": args,
    });

    ureq::post(&format!("http://127.0.0.1:{port}/jsonrpc"))
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("aria2 request failed: {e}"))?
        .into_json::<serde_json::Value>()
        .map_err(|e| format!("aria2 invalid response: {e}"))
}

#[tauri::command]
fn aria2_rpc(
    state: tauri::State<Aria2>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    aria2_request(state.port, &state.secret, &method, params)
}

/// The status bar names the endpoint it's talking to, and the port is no
/// longer a constant, so the frontend has to ask.
#[tauri::command]
fn aria2_endpoint(state: tauri::State<Aria2>) -> String {
    format!("127.0.0.1:{}", state.port)
}

#[tauri::command]
fn get_settings(state: tauri::State<SettingsState>) -> Settings {
    state.current.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Saving is three steps: normalise, persist, and push into the running aria2
/// so nothing needs a restart. The three aria2 options are all live-changeable
/// — measured against aria2 1.37, not assumed. The other two are the frontend's
/// to act on: it sends `dir` with each download it adds, which is how smart
/// folders route by file type without touching this global.
#[tauri::command]
fn save_settings(
    aria2: tauri::State<Aria2>,
    state: tauri::State<SettingsState>,
    settings: Settings,
) -> Result<Settings, String> {
    let settings = settings.normalised();

    // The folder is the one setting that can be wrong in a way the user has to
    // fix: everything else is clamped into range above.
    let dir = Path::new(&settings.download_dir);
    fs::create_dir_all(dir).map_err(|e| format!("Cannot use {}: {e}", settings.download_dir))?;
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", settings.download_dir));
    }

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("could not encode the settings: {e}"))?;
    fs::write(&state.file, json)
        .map_err(|e| format!("could not write {}: {e}", state.file.display()))?;

    // Best-effort: the file on disk is the source of truth, and an aria2 that
    // cannot be reached is already saying so in the status bar.
    if let Err(e) = aria2_request(
        aria2.port,
        &aria2.secret,
        "aria2.changeGlobalOption",
        serde_json::json!([{
            "dir": settings.download_dir,
            "max-concurrent-downloads": settings.max_concurrent_downloads.to_string(),
            "max-overall-download-limit": settings.max_overall_download_limit.to_string(),
        }]),
    ) {
        eprintln!("[garia] Settings saved, but aria2 did not take them now: {e}");
    }

    if let Ok(mut guard) = state.current.lock() {
        *guard = settings.clone();
    }
    Ok(settings)
}

/// Deleting a row can take the downloaded file with it. Trash, not unlink: a
/// mis-click then costs a trip to the Finder rather than the download itself.
/// aria2's `.aria2` control file rides along — it is meaningless without the
/// partial file it describes.
#[tauri::command]
fn trash_files(paths: Vec<String>) -> Result<(), String> {
    for p in paths {
        let path = Path::new(&p);
        // aria2 reports a path for downloads that never wrote a byte, and names
        // the directory among the entries of a multi-file torrent. Only ever
        // trash something that is on disk and is a file.
        if !path.is_file() {
            continue;
        }

        trash::delete(path).map_err(|e| format!("could not move {p} to the Trash: {e}"))?;

        let control = PathBuf::from(format!("{p}.aria2"));
        if control.is_file() {
            let _ = trash::delete(&control);
        }
    }
    Ok(())
}

/// The dock icon carries the count of downloads that finished while the user
/// was looking somewhere else. A notification is gone the moment it's
/// dismissed; the badge is what's still there when they come back to the Mac.
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

/// Where to look for aria2c, best first. The sidecar sits next to the app
/// binary and is what a fresh install runs — no `brew install aria2` first.
/// The system copies stay as a fallback: they keep `tauri dev` working, and
/// they rescue a bundle whose sidecar went missing.
fn aria2c_candidates() -> Vec<String> {
    let mut c = Vec::new();

    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        c.push(dir.join("aria2c").display().to_string());
    }

    c.push("aria2c".to_string());

    // macOS GUI apps (launched via Finder) often don't inherit Homebrew PATH.
    // Try common Homebrew install locations explicitly.
    #[cfg(target_os = "macos")]
    c.extend([
        "/opt/homebrew/bin/aria2c".to_string(),
        "/usr/local/bin/aria2c".to_string(),
    ]);

    // Common Linux locations.
    #[cfg(target_os = "linux")]
    c.extend([
        "/usr/bin/aria2c".to_string(),
        "/bin/aria2c".to_string(),
        "/snap/bin/aria2c".to_string(),
    ]);

    c
}

fn spawn_aria2(port: u16, secret: &str, session_file: &Path, settings: &Settings) -> Option<Child> {
    for bin in aria2c_candidates() {
        if bin.contains('/') && !Path::new(&bin).exists() {
            continue;
        }

        let child = Command::new(&bin)
            .args([
                "--enable-rpc",
                "--rpc-listen-all=false",
                &format!("--rpc-listen-port={port}"),
                &format!("--rpc-secret={secret}"),
                "--quiet=true",
                &format!("--dir={}", settings.download_dir),
                // The user's settings, applied from the first second. Both are
                // also pushed into a running aria2 by save_settings.
                &format!(
                    "--max-concurrent-downloads={}",
                    settings.max_concurrent_downloads
                ),
                &format!(
                    "--max-overall-download-limit={}",
                    settings.max_overall_download_limit
                ),
                // Without these, aria2 opens a single connection per download —
                // the multi-segment speed-up people install a download manager
                // for never happens.
                "--continue=true",
                "--max-connection-per-server=16",
                "--split=16",
                "--min-split-size=1M",
                // Unfinished and queued downloads survive a quit: aria2 writes
                // them here and reads them back on the next launch.
                &format!("--save-session={}", session_file.display()),
                "--save-session-interval=30",
                &format!("--input-file={}", session_file.display()),
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

/// A force-quit or a crash leaves aria2c running: it outlives the app, keeps
/// the RPC port, and answers the next launch with the previous run's secret.
/// The pid we wrote at spawn is how we recognise our own leftovers — and only
/// our own, so an aria2 the user runs themselves is never touched.
fn reap_orphan(pid_file: &Path) {
    let Ok(text) = fs::read_to_string(pid_file) else {
        return;
    };
    let Ok(pid) = text.trim().parse::<u32>() else {
        let _ = fs::remove_file(pid_file);
        return;
    };

    #[cfg(unix)]
    {
        let still_aria2 = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("aria2c"))
            .unwrap_or(false);

        if still_aria2 {
            // SIGTERM, not SIGKILL: aria2 writes its session on the way out.
            let _ = Command::new("kill").arg(pid.to_string()).status();
            eprintln!("[garia] Stopped an orphaned aria2c (pid {pid}) from a previous run");

            // It still holds the RPC port until it's actually gone, and the
            // new instance is about to ask for that port back.
            for _ in 0..40 {
                let gone = Command::new("ps")
                    .args(["-p", &pid.to_string()])
                    .output()
                    .map(|o| !o.status.success())
                    .unwrap_or(true);
                if gone {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }

    let _ = fs::remove_file(pid_file);
}

/// aria2's conventional port, unless something else holds it — a second garia,
/// or an aria2 the user runs themselves. Losing that race used to mean aria2
/// exited on startup and the app sat there reporting "unreachable".
fn pick_port() -> u16 {
    for _ in 0..20 {
        if TcpListener::bind(("127.0.0.1", 6800)).is_ok() {
            return 6800;
        }
        // A just-reaped aria2c can hold the port a moment longer.
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(6800)
}

/// `--input-file` is an error when the path doesn't exist, so the first launch
/// has to leave an empty one behind for aria2 to read.
fn session_path(dir: &Path) -> PathBuf {
    let path = dir.join("session.txt");
    if !path.exists() {
        if let Err(e) = fs::write(&path, "") {
            eprintln!("[garia] Could not create {}: {e}", path.display());
        }
    }
    path
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            aria2_rpc,
            aria2_endpoint,
            trash_files,
            get_settings,
            save_settings,
            set_badge
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
            reap_orphan(&pid_file);

            let settings_file = dir.join("settings.json");
            let settings = read_settings(&settings_file);

            let secret = random_secret();
            let session = session_path(&dir);
            let port = pick_port();
            let child = spawn_aria2(port, &secret, &session, &settings);

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
                secret,
                port,
                pid_file,
            });
            app.manage(SettingsState {
                file: settings_file,
                current: Mutex::new(settings),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Aria2>() {
                    // kill() is a SIGKILL, so aria2 never gets to write the
                    // session itself — ask it to before pulling the plug.
                    if let Err(e) = aria2_request(
                        state.port,
                        &state.secret,
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
        });
}
