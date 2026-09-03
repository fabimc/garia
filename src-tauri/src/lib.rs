use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

mod catch;

/// The aria2c child process plus the RPC secret it was started with.
struct Aria2 {
    child: Mutex<Option<Child>>,
    secret: String,
    port: u16,
    pid_file: PathBuf,
}

/// A cap nobody can find is a cap nobody uses. FDM frames the one number as
/// three modes instead, switchable without opening a dialog — so garia keeps
/// the number in Settings and the choice between them in the status bar.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
enum TrafficMode {
    Full,
    Medium,
    Light,
}

/// What Medium and Light mean before the user says otherwise: enough for a
/// video to keep up, and slow enough to disappear behind a call.
const DEFAULT_MEDIUM_LIMIT: u64 = 2 * 1024 * 1024;
const DEFAULT_LIGHT_LIMIT: u64 = 512 * 1024;
/// Below a kilobyte a second a download is stopped, not limited.
const MIN_LIMIT: u64 = 1024;

/// What the user gets to decide. Kept here rather than read back out of aria2
/// because these have to survive a restart, and aria2 forgets everything that
/// isn't an unfinished download.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    download_dir: String,
    max_concurrent_downloads: u32,
    /// Which of the three modes is in force. `None` is a settings file written
    /// before the modes existed; the bare cap it holds becomes Medium. The
    /// field says so itself, because the struct's own default names a mode.
    #[serde(default = "no_mode")]
    traffic_mode: Option<TrafficMode>,
    /// Bytes per second the two capped modes stand for. The numbers are the
    /// user's; only the switching between them is fixed.
    medium_limit: u64,
    light_limit: u64,
    /// Bytes per second across every download — derived from the mode, not set
    /// on its own. 0 is aria2's own "no limit", which is what Full is.
    max_overall_download_limit: u64,
    /// Seed a finished torrent until this share ratio. aria2's own default is
    /// 1.0 — give back what you took; 0.0 means seed until told to stop.
    seed_ratio: f64,
    /// …or for this many minutes, whichever comes first. 0 is no time limit,
    /// and the option is left off entirely rather than sent as a zero, which
    /// aria2 reads as "do not seed at all".
    seed_time_minutes: u32,
    /// Route each download into a subfolder named after its kind. Off by
    /// default: where a file lands is the user's expectation to change, not
    /// ours. The routing itself lives in the frontend, which names the folder
    /// per download at add time — nothing here moves a file.
    smart_folders: bool,
    /// Say so when a download finishes. On by default: the whole point of a
    /// download manager is not having to watch it.
    notify_on_complete: bool,
    /// Watch the clipboard for a copied file URL and offer to take it. On by
    /// default: catching a download that started in the browser is why the
    /// app stays open. Off if the offer gets in the way.
    catch_clipboard: bool,
    /// Ask aria2 for the lowest-numbered piece it can take next, so the file
    /// fills from the front and can be played before it is finished. Off by
    /// default, because it is a real trade: the default selector picks pieces
    /// to keep connections alive, and in-order arrival gives some of that up.
    /// Nothing here reads it — it goes on each download as it is added, since
    /// aria2 will not change a piece selector on a download it is working.
    in_order: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: default_download_dir().display().to_string(),
            // aria2's own default, and a sane one: five files at a time.
            max_concurrent_downloads: 5,
            traffic_mode: Some(TrafficMode::Full),
            medium_limit: DEFAULT_MEDIUM_LIMIT,
            light_limit: DEFAULT_LIGHT_LIMIT,
            max_overall_download_limit: 0,
            seed_ratio: 1.0,
            seed_time_minutes: 0,
            smart_folders: false,
            notify_on_complete: true,
            catch_clipboard: true,
            in_order: false,
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

        // A settings file from before the modes carries a cap and no mode. The
        // cap is what the user chose, so it becomes what Medium means and the
        // app comes up capped exactly as it was left.
        let mode = match self.traffic_mode {
            Some(mode) => mode,
            None if self.max_overall_download_limit > 0 => {
                self.medium_limit = self.max_overall_download_limit;
                TrafficMode::Medium
            }
            None => TrafficMode::Full,
        };

        // A ratio arrives from a hand-editable file, so NaN is possible and
        // uploading a hundred times what you took is nobody's intent.
        if !self.seed_ratio.is_finite() || self.seed_ratio < 0.0 {
            self.seed_ratio = 1.0;
        }
        self.seed_ratio = (self.seed_ratio * 100.0).round() / 100.0;
        self.seed_ratio = self.seed_ratio.min(100.0);
        // A month of seeding is already "until I stop it".
        self.seed_time_minutes = self.seed_time_minutes.min(60 * 24 * 30);

        self.medium_limit = clamp_limit(self.medium_limit, DEFAULT_MEDIUM_LIMIT);
        self.light_limit = clamp_limit(self.light_limit, DEFAULT_LIGHT_LIMIT);

        // The overall cap is the mode's number, always — the frontend sends it
        // back with the rest and never gets to disagree with the mode.
        self.traffic_mode = Some(mode);
        self.max_overall_download_limit = match mode {
            TrafficMode::Full => 0,
            TrafficMode::Medium => self.medium_limit,
            TrafficMode::Light => self.light_limit,
        };
        self
    }
}

/// A settings file that has never heard of the modes, as distinct from one
/// that names Full — the first is migrated, the second is obeyed.
fn no_mode() -> Option<TrafficMode> {
    None
}

/// A mode's number, kept usable: zero means the file never carried one, and
/// anything under a kilobyte a second is a stall rather than a limit.
fn clamp_limit(bytes: u64, fallback: u64) -> u64 {
    if bytes == 0 {
        fallback
    } else {
        bytes.max(MIN_LIMIT)
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
/// so nothing needs a restart. Those three aria2 options are all live-changeable
/// — measured against aria2 1.37, not assumed. The rest are the frontend's
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
    // cannot be reached is already saying so in the status bar. The seeding
    // rules are deliberately absent: aria2 takes neither on a running download,
    // so they go on each torrent as it is added and into the next launch.
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

fn bring_to_front(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn dispatch_catch(app: &tauri::AppHandle, url: String, source: &str) {
    let event = catch::CatchEvent {
        url,
        source: source.to_string(),
    };
    if let Some(queue) = app.try_state::<CatchQueue>() {
        if let Ok(mut pending) = queue.pending.lock() {
            pending.push(event.clone());
            let overflow = pending.len().saturating_sub(MAX_PENDING_CATCHES);
            pending.drain(..overflow);
        }
    }
    let _ = app.emit("catch-url", &event);
    if source == "scheme" {
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
/// this, launching garia would offer a file URL the user copied hours ago.
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


// ── Video (yt-dlp) ───────────────────────────────────────────────────────
// aria2 downloads files; a video page is not a file. yt-dlp is what turns one
// into the other — it resolves a page into the actual media URLs, which aria2
// can then fetch in parallel like anything else.

/// How garia gets to yt-dlp, resolved once per launch.
struct Video {
    /// The 3 MB zipapp shipped in the bundle, if it made it there.
    zipapp: Option<PathBuf>,
    /// The command that actually runs — `None` until first asked. A failed
    /// resolution is never cached, so installing yt-dlp and asking again works
    /// without a relaunch.
    resolved: Mutex<Option<Vec<String>>>,
    /// What the last successful look around found. Working it out costs three
    /// process launches, and Settings asks every time it opens.
    tools: Mutex<Option<VideoTools>>,
}

/// What the frontend needs to know before it offers a video download at all.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct VideoTools {
    /// yt-dlp's version string, or empty when there is no yt-dlp.
    version: String,
    /// "system" or "bundled" — worth saying, because a stale bundled copy is
    /// the likeliest reason a site stops working.
    source: String,
    /// Whether an ffmpeg was found. Without one, the qualities that arrive as
    /// separate video and audio streams cannot be offered.
    ffmpeg: bool,
    /// "bundled" or "system" — which of the two answered, or empty when
    /// neither did. The bundled one is a remux-only build, so a system ffmpeg
    /// showing up here means the sidecar went missing.
    ffmpeg_source: String,
}

/// One downloadable stream, trimmed to what the picker shows and what aria2
/// needs. yt-dlp's own JSON runs to 150 KB for a single YouTube video; almost
/// none of it survives this.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct VideoFormat {
    id: String,
    ext: String,
    /// "complete" — one file with both streams; "video" / "audio" — one half,
    /// which only means something paired with the other and an ffmpeg.
    kind: String,
    height: u64,
    fps: f64,
    /// Bitrate in kbit/s: total for video, audio-only for audio.
    bitrate: f64,
    /// Bytes, exact when the server said so and yt-dlp's estimate otherwise.
    filesize: u64,
    note: String,
    url: String,
    /// Ready for aria2's `header` option: "Name: Value" per entry. Some sites
    /// hand out URLs that only answer to the User-Agent they were minted for.
    headers: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct VideoInfo {
    title: String,
    uploader: String,
    /// Seconds. Zero for a live stream or when the site doesn't say.
    duration: f64,
    thumbnail: String,
    webpage_url: String,
    extractor: String,
    formats: Vec<VideoFormat>,
}

fn is_executable(path: &str) -> bool {
    Path::new(path).is_file()
}

/// Runs a command, killing it if it outstays `secs`. `Command` has no timeout
/// of its own, and a yt-dlp waiting on a site that never answers would
/// otherwise hang the probe until the app quits.
fn run_capped(
    program: &str,
    args: &[String],
    secs: u64,
) -> Result<std::process::Output, String> {
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {program}: {e}"))?;

    let pid = child.id();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();

    // The watchdog waits to be told the process finished. Being told is what
    // stops it — so a run that ends on time can never have its pid killed
    // after the fact, when the number may belong to something else.
    std::thread::spawn(move || {
        if done_rx
            .recv_timeout(std::time::Duration::from_secs(secs))
            .is_err()
        {
            #[cfg(unix)]
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    });

    let output = child
        .wait_with_output()
        .map_err(|e| format!("{program} failed: {e}"));
    let _ = done_tx.send(());
    output
}

/// A yt-dlp the user installed themselves, newest-first in the sense that
/// matters: theirs is the one that gets updated when a site breaks.
fn system_ytdlp() -> Option<Vec<String>> {
    let mut candidates = vec!["yt-dlp".to_string()];

    #[cfg(target_os = "macos")]
    candidates.extend([
        "/opt/homebrew/bin/yt-dlp".to_string(),
        "/usr/local/bin/yt-dlp".to_string(),
    ]);

    #[cfg(target_os = "linux")]
    candidates.extend([
        "/usr/bin/yt-dlp".to_string(),
        "/usr/local/bin/yt-dlp".to_string(),
    ]);

    for bin in candidates {
        if bin.contains('/') && !is_executable(&bin) {
            continue;
        }
        if ytdlp_version(std::slice::from_ref(&bin)).is_some() {
            return Some(vec![bin]);
        }
    }
    None
}

/// The bundled copy is a zipapp, so it needs an interpreter — and not just any
/// one: macOS ships `/usr/bin/python3` as 3.9, which yt-dlp dropped. The
/// version test is why this looks past the first python3 it finds.
fn python_for(zipapp: &Path) -> Option<Vec<String>> {
    let mut candidates = vec!["python3".to_string()];

    #[cfg(target_os = "macos")]
    candidates.extend([
        "/opt/homebrew/bin/python3".to_string(),
        "/usr/local/bin/python3".to_string(),
    ]);

    // python.org installs land here, newest last in the sort, so walk it back.
    #[cfg(target_os = "macos")]
    if let Ok(entries) = fs::read_dir("/Library/Frameworks/Python.framework/Versions") {
        let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        versions.sort();
        for v in versions.into_iter().rev() {
            candidates.push(v.join("bin/python3").display().to_string());
        }
    }

    #[cfg(target_os = "linux")]
    candidates.extend([
        "/usr/bin/python3".to_string(),
        "/usr/local/bin/python3".to_string(),
    ]);

    for python in candidates {
        if python.contains('/') && !is_executable(&python) {
            continue;
        }
        let ok = run_capped(
            &python,
            &["-c".to_string(), "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)".to_string()],
            10,
        )
        .map(|o| o.status.success())
        .unwrap_or(false);
        if !ok {
            continue;
        }
        let cmd = vec![python, zipapp.display().to_string()];
        if ytdlp_version(&cmd).is_some() {
            return Some(cmd);
        }
    }
    None
}

/// Doubles as the "does this actually work" test: a yt-dlp that cannot print
/// its own version is not one we should hand a URL to.
fn ytdlp_version(cmd: &[String]) -> Option<String> {
    let mut args: Vec<String> = cmd[1..].to_vec();
    args.push("--version".to_string());
    let out = run_capped(&cmd[0], &args, 20).ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// Resolution is cached, but only when it succeeded: a user who installs
/// yt-dlp and presses the button again should not have to relaunch.
fn resolve_ytdlp(video: &Video) -> Option<Vec<String>> {
    if let Ok(guard) = video.resolved.lock() {
        if let Some(cmd) = guard.as_ref() {
            return Some(cmd.clone());
        }
    }

    let found = system_ytdlp().or_else(|| video.zipapp.as_deref().and_then(python_for));

    if let (Some(cmd), Ok(mut guard)) = (found.as_ref(), video.resolved.lock()) {
        *guard = Some(cmd.clone());
    }
    found
}

/// Where to look for ffmpeg, best first — the same order, and for the same
/// reasons, as `aria2c_candidates`. The sidecar sits next to the app binary
/// and is what a fresh install runs, so merging works with nothing installed.
/// The system copies stay as a fallback: they keep `tauri dev` working, and
/// they rescue a bundle whose sidecar went missing.
/// Each candidate carries where it came from, rather than that being read off
/// its position: `current_exe` can fail, and a list that then starts with the
/// machine's own ffmpeg would have Settings calling it the bundled one.
fn ffmpeg_candidates() -> Vec<(String, &'static str)> {
    let mut candidates = Vec::new();

    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        candidates.push((dir.join("ffmpeg").display().to_string(), "bundled"));
    }

    candidates.push(("ffmpeg".to_string(), "system"));

    #[cfg(target_os = "macos")]
    candidates.extend([
        ("/opt/homebrew/bin/ffmpeg".to_string(), "system"),
        ("/usr/local/bin/ffmpeg".to_string(), "system"),
    ]);

    #[cfg(target_os = "linux")]
    candidates.extend([
        ("/usr/bin/ffmpeg".to_string(), "system"),
        ("/usr/local/bin/ffmpeg".to_string(), "system"),
    ]);

    candidates
}

/// The first candidate that runs, paired with where it came from. Asking for
/// its version doubles as the "does this actually work" test, the same way it
/// does for yt-dlp: a sidecar that won't launch is not one to hand two files.
fn ffmpeg_found() -> Option<(String, &'static str)> {
    for (bin, origin) in ffmpeg_candidates() {
        if bin.contains('/') && !is_executable(&bin) {
            continue;
        }
        let ok = run_capped(&bin, &["-version".to_string()], 10)
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Some((bin, origin));
        }
    }
    None
}

fn ffmpeg_path() -> Option<String> {
    ffmpeg_found().map(|(bin, _)| bin)
}

#[tauri::command]
fn video_tools(video: tauri::State<Video>) -> VideoTools {
    if let Ok(guard) = video.tools.lock() {
        if let Some(tools) = guard.as_ref() {
            return tools.clone();
        }
    }

    let cmd = resolve_ytdlp(&video);
    // Resolution already proved the command works by asking it its version;
    // this is the same answer, kept rather than asked for twice.
    let bundled = cmd.as_ref().map(|c| c.len() > 1).unwrap_or(false);
    let ffmpeg = ffmpeg_found();
    let tools = VideoTools {
        version: cmd.as_deref().and_then(ytdlp_version).unwrap_or_default(),
        source: if bundled { "bundled" } else { "system" }.to_string(),
        ffmpeg: ffmpeg.is_some(),
        ffmpeg_source: ffmpeg.map(|(_, src)| src).unwrap_or_default().to_string(),
    };

    // A machine without yt-dlp is one `brew install` away from having it, and
    // Settings is where that message is read — so don't cache a "no". The same
    // goes for an ffmpeg the sidecar failed to be: the next look might find one.
    if !tools.version.is_empty() && tools.ffmpeg {
        if let Ok(mut guard) = video.tools.lock() {
            *guard = Some(tools.clone());
        }
    }
    tools
}

fn as_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn as_num(v: &serde_json::Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// aria2 wants headers as "Name: Value" lines. yt-dlp hands them over as an
/// object, and for some sites they are not optional — a URL minted for one
/// User-Agent is a 403 for any other.
fn header_lines(f: &serde_json::Value) -> Vec<String> {
    let Some(map) = f.get("http_headers").and_then(|h| h.as_object()) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(k, v)| v.as_str().map(|v| format!("{k}: {v}")))
        .collect()
}

/// Which of the three kinds a format is — and the reason a missing codec field
/// counts as "complete" rather than as a half: plenty of extractors simply
/// don't report codecs for a plain file, and dropping those would throw away
/// the one format the site offers.
fn format_kind(f: &serde_json::Value) -> &'static str {
    let vcodec = f.get("vcodec").and_then(|x| x.as_str());
    let acodec = f.get("acodec").and_then(|x| x.as_str());
    match (vcodec, acodec) {
        (Some("none"), Some("none")) => "none",
        (Some("none"), _) => "audio",
        (_, Some("none")) => "video",
        _ => "complete",
    }
}

#[tauri::command]
fn video_probe(video: tauri::State<Video>, url: String) -> Result<VideoInfo, String> {
    let Some(cmd) = resolve_ytdlp(&video) else {
        return Err("no-ytdlp".to_string());
    };

    let mut args: Vec<String> = cmd[1..].to_vec();
    args.extend([
        "-J".to_string(),
        "--no-playlist".to_string(),
        "--no-warnings".to_string(),
        "--no-progress".to_string(),
        url,
    ]);

    let out = run_capped(&cmd[0], &args, 120)?;
    if !out.status.success() {
        // yt-dlp's own diagnosis is better than anything we could write: it
        // knows the difference between a private video, a login wall, and a
        // page with no media on it at all.
        let stderr = String::from_utf8_lossy(&out.stderr);
        let reason = stderr
            .lines()
            .rev()
            .find(|l| l.contains("ERROR:"))
            .map(|l| l.trim().trim_start_matches("ERROR:").trim())
            .map(|l| l.split(". See ").next().unwrap_or(l).trim().to_string())
            .unwrap_or_else(|| "yt-dlp could not read that page".to_string());
        return Err(reason);
    }

    let root: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("could not read what yt-dlp returned: {e}"))?;

    trim_info(&root)
}

/// Everything yt-dlp's 150 KB of JSON becomes: a handful of streams aria2 can
/// actually fetch, in the order the picker lists them.
fn trim_info(root: &serde_json::Value) -> Result<VideoInfo, String> {
    // --no-playlist is a preference, not a guarantee: a channel or a playlist
    // page still comes back as a playlist, and the first entry is what the
    // user pointed at.
    let info = if root.get("_type").and_then(|t| t.as_str()) == Some("playlist") {
        root.get("entries")
            .and_then(|e| e.as_array())
            .and_then(|e| e.first())
            .cloned()
            .ok_or_else(|| "that page has no video on it".to_string())?
    } else {
        root.clone()
    };

    let empty = Vec::new();
    let raw = info
        .get("formats")
        .and_then(|f| f.as_array())
        .unwrap_or(&empty);

    let mut formats: Vec<VideoFormat> = Vec::new();
    for f in raw {
        // aria2 fetches files over HTTP. A segmented stream — HLS, DASH — is a
        // playlist of thousands of pieces, and handing one to aria2 downloads
        // the playlist rather than the video.
        let protocol = as_str(f, "protocol");
        if protocol != "https" && protocol != "http" {
            continue;
        }
        let url = as_str(f, "url");
        if url.is_empty() {
            continue;
        }
        let kind = format_kind(f);
        if kind == "none" {
            continue;
        }

        let filesize = f
            .get("filesize")
            .and_then(|x| x.as_f64())
            .or_else(|| f.get("filesize_approx").and_then(|x| x.as_f64()))
            .unwrap_or(0.0);

        let bitrate = if kind == "audio" {
            as_num(f, "abr")
        } else {
            let tbr = as_num(f, "tbr");
            if tbr > 0.0 { tbr } else { as_num(f, "vbr") }
        };

        formats.push(VideoFormat {
            id: as_str(f, "format_id"),
            ext: as_str(f, "ext"),
            kind: kind.to_string(),
            height: as_num(f, "height") as u64,
            fps: as_num(f, "fps"),
            bitrate,
            filesize: filesize.max(0.0) as u64,
            note: as_str(f, "format_note"),
            url,
            headers: header_lines(f),
        });
    }

    // Best first, and by the thing the row is labelled with: pixels for
    // anything with a picture, bitrate for sound.
    formats.sort_by(|a, b| {
        b.height
            .cmp(&a.height)
            .then(b.bitrate.partial_cmp(&a.bitrate).unwrap_or(std::cmp::Ordering::Equal))
            .then(b.filesize.cmp(&a.filesize))
    });

    // Nothing aria2 can fetch is a different answer from "no video here", and
    // the frontend says so differently.
    if formats.is_empty() && raw.is_empty() {
        return Err("that page has no video on it".to_string());
    }

    Ok(VideoInfo {
        title: as_str(&info, "title"),
        uploader: as_str(&info, "uploader"),
        duration: as_num(&info, "duration"),
        thumbnail: as_str(&info, "thumbnail"),
        webpage_url: as_str(&info, "webpage_url"),
        extractor: as_str(&info, "extractor_key"),
        formats,
    })
}

/// The last step of a merged download: two files aria2 fetched in parallel,
/// stitched into one. `-c copy` means no re-encoding — this is a container
/// rewrite, seconds for a feature-length video, and the picture and sound come
/// out bit-identical to what was downloaded.
#[tauri::command]
fn mux_video(video_path: String, audio_path: String, out_path: String) -> Result<String, String> {
    let ffmpeg = ffmpeg_path().ok_or_else(|| "no-ffmpeg".to_string())?;

    for p in [&video_path, &audio_path] {
        if !Path::new(p).is_file() {
            return Err(format!("{p} is not there any more"));
        }
    }

    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        video_path.clone(),
        "-i".to_string(),
        audio_path.clone(),
        "-c".to_string(),
        "copy".to_string(),
    ];
    // Puts the index at the front so the file plays before it has been read to
    // the end. MP4 only — the other containers keep theirs there anyway.
    if out_path.ends_with(".mp4") || out_path.ends_with(".m4v") {
        args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }
    args.push(out_path.clone());

    let out = run_capped(&ffmpeg, &args, 900)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let reason = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("ffmpeg could not merge the two files")
            .trim()
            .to_string();
        let _ = fs::remove_file(&out_path);
        return Err(reason);
    }

    // The halves have served their purpose. Trash rather than unlink, for the
    // same reason deleting a download does.
    for p in [&video_path, &audio_path] {
        let _ = trash::delete(Path::new(p));
    }

    Ok(out_path)
}

// ── Preview ──────────────────────────────────────────────────────────────
// A download that arrives from the front is a playable file long before it is
// a finished one. What stops it being playable is never the missing tail — it
// is the container's index, which some formats keep at the end of the file.

/// Containers that carry an index the player has to find before it can start.
/// Everything else garia downloads — Matroska, WebM, Ogg, MPEG-TS, a raw MP3 —
/// is built to be read from the first byte, so having some of it is enough.
const INDEXED_EXTS: [&str; 5] = ["mp4", "m4v", "m4a", "mov", "3gp"];

/// Below this there is not enough of anything for a player to make sense of,
/// whatever the container. A quarter of a megabyte is a few seconds of audio
/// and rather less video, and it is smaller than one aria2 piece.
const PREVIEW_FLOOR: u64 = 256 * 1024;

/// What the panel says about opening a half-downloaded file, and whether it
/// offers to.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PreviewState {
    ready: bool,
    /// Why not, in the panel's own words — empty once it is ready, because
    /// then the panel has the number to show instead.
    reason: String,
}

impl PreviewState {
    fn no(reason: &str) -> Self {
        Self { ready: false, reason: reason.to_string() }
    }
}

/// Walks the top-level boxes of an ISO base media file looking for `moov` —
/// the index, without which a player has no idea what is in the file or where.
/// `limit` is how far into the file the bytes have actually arrived: reading a
/// box header past it would be reading a hole aria2 has not filled in yet.
fn moov_within<R: Read + Seek>(src: &mut R, limit: u64) -> bool {
    let mut offset = 0u64;
    // A real file has a handful of top-level boxes. The cap is so a corrupt
    // one — or one whose header lands on a hole that reads as zeroes — cannot
    // walk forever.
    for _ in 0..64 {
        if offset.saturating_add(8) > limit || src.seek(SeekFrom::Start(offset)).is_err() {
            return false;
        }
        let mut head = [0u8; 8];
        if src.read_exact(&mut head).is_err() {
            return false;
        }
        let kind = &head[4..8];
        let mut size = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as u64;
        let mut header = 8u64;

        if size == 1 {
            // The 32-bit field is an escape: the real size is the eight bytes
            // after the type. This is how an mdat larger than 4 GB is written.
            if offset.saturating_add(16) > limit {
                return false;
            }
            let mut ext = [0u8; 8];
            if src.read_exact(&mut ext).is_err() {
                return false;
            }
            size = u64::from_be_bytes(ext);
            header = 16;
        } else if size == 0 {
            // "To the end of the file" — so nothing follows it to go looking for.
            return kind == b"moov";
        }

        if size < header {
            return false;
        }
        if kind == b"moov" {
            // Finding where it starts is not enough; a player reads all of it.
            return offset.saturating_add(size) <= limit;
        }
        offset = offset.saturating_add(size);
    }
    false
}

/// Whether the bytes that have arrived are worth opening — asked of the file
/// on disk, not of aria2, because aria2 knows how much has arrived and nothing
/// at all about what a player needs.
///
/// `ready_bytes` is the contiguous run from the front of the file, which the
/// panel works out from aria2's piece bitfield. A download can be 90% complete
/// and have none of it.
#[tauri::command]
fn preview_state(path: String, ready_bytes: u64) -> PreviewState {
    let file = Path::new(&path);
    let Ok(meta) = fs::metadata(file) else {
        return PreviewState::no("Nothing has been written to disk yet.");
    };
    // aria2 preallocates, so the file is full-size from the first second and
    // its length says nothing. It is still the ceiling on what can be read.
    let ready = ready_bytes.min(meta.len());
    if ready < PREVIEW_FLOOR {
        return PreviewState::no("Not enough of the front of the file has arrived to play.");
    }

    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !INDEXED_EXTS.contains(&ext.as_str()) {
        return PreviewState { ready: true, reason: String::new() };
    }

    let Ok(mut handle) = fs::File::open(file) else {
        return PreviewState::no("The file could not be opened.");
    };
    if moov_within(&mut handle, ready) {
        PreviewState { ready: true, reason: String::new() }
    } else {
        PreviewState::no(
            "Its index hasn't arrived. Some MP4s keep it at the end of the file, \
             and those only play once the download finishes.",
        )
    }
}

/// Hands the partial file to whatever the machine opens that kind with. The
/// panel has already asked whether it is worth opening; this only refuses the
/// case that would open a Finder window on nothing.
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

/// Everything aria2 is started with. A Vec rather than an array because one
/// of them is conditional: `--seed-time=0` does not mean "no time limit", it
/// means "never seed", so the option has to be absent rather than zero.
fn aria2_args(port: u16, secret: &str, session_file: &Path, settings: &Settings) -> Vec<String> {
    let mut args = vec![
        "--enable-rpc".to_string(),
        "--rpc-listen-all=false".to_string(),
        format!("--rpc-listen-port={port}"),
        format!("--rpc-secret={secret}"),
        "--quiet=true".to_string(),
        format!("--dir={}", settings.download_dir),
        // The user's settings, applied from the first second. The first two are
        // also pushed into a running aria2 by save_settings.
        format!(
            "--max-concurrent-downloads={}",
            settings.max_concurrent_downloads
        ),
        format!(
            "--max-overall-download-limit={}",
            settings.max_overall_download_limit
        ),
        // Seeding is the half of a torrent that happens after the download, and
        // aria2 will not change either of these on a download that is already
        // running — so they are set here, and again on each torrent as it is
        // added, rather than pushed at a running process.
        format!("--seed-ratio={}", settings.seed_ratio),
        // Without these, aria2 opens a single connection per download —
        // the multi-segment speed-up people install a download manager
        // for never happens.
        "--continue=true".to_string(),
        "--max-connection-per-server=16".to_string(),
        "--split=16".to_string(),
        "--min-split-size=1M".to_string(),
        // Unfinished and queued downloads survive a quit: aria2 writes
        // them here and reads them back on the next launch.
        format!("--save-session={}", session_file.display()),
        "--save-session-interval=30".to_string(),
        format!("--input-file={}", session_file.display()),
    ];
    if settings.seed_time_minutes > 0 {
        args.push(format!("--seed-time={}", settings.seed_time_minutes));
    }
    args
}

fn spawn_aria2(port: u16, secret: &str, session_file: &Path, settings: &Settings) -> Option<Child> {
    for bin in aria2c_candidates() {
        if bin.contains('/') && !Path::new(&bin).exists() {
            continue;
        }

        let child = Command::new(&bin)
            .args(aria2_args(port, secret, session_file, settings))
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
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            aria2_rpc,
            aria2_endpoint,
            trash_files,
            get_settings,
            save_settings,
            set_badge,
            take_pending_catch,
            copy_text,
            video_tools,
            video_probe,
            mux_video,
            preview_state,
            preview_file
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
            app.manage(OwnCopy::default());

            // `garia://add?url=…` from a bookmarklet, an extension, or anything
            // else that wants to hand garia a download. macOS delivers these
            // to the running instance; a cold launch is `get_current` below.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for link in event.urls() {
                        if let Some(url) = catch::url_from_garia_link(link.as_str()) {
                            dispatch_catch(&handle, url, "scheme");
                        }
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let handle = app.handle().clone();
                    for link in urls {
                        if let Some(url) = catch::url_from_garia_link(link.as_str()) {
                            dispatch_catch(&handle, url, "scheme");
                        }
                    }
                }
            }

            spawn_clipboard_watch(app.handle().clone());
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Real yt-dlp output, trimmed to the fields the parser reads. YouTube
    /// because it is the hard case — 53 formats, not one of which is a
    /// complete file — and Wikimedia because it is the easy one.
    const YOUTUBE: &str = include_str!("../tests/fixtures/youtube.json");
    const COMMONS: &str = include_str!("../tests/fixtures/commons.json");

    fn parse(fixture: &str) -> VideoInfo {
        trim_info(&serde_json::from_str(fixture).unwrap()).unwrap()
    }

    fn settings_from(json: &str) -> Settings {
        serde_json::from_str::<Settings>(json).unwrap().normalised()
    }

    /// The upgrade case: a settings file written before the modes existed
    /// carries a cap and no mode. Losing it would silently un-throttle a
    /// connection someone deliberately throttled.
    #[test]
    fn an_old_cap_becomes_medium() {
        let s = settings_from(r#"{"downloadDir":"/tmp","maxOverallDownloadLimit":786432}"#);
        assert_eq!(s.traffic_mode, Some(TrafficMode::Medium));
        assert_eq!(s.medium_limit, 786_432);
        assert_eq!(s.max_overall_download_limit, 786_432);
    }

    #[test]
    fn an_old_file_with_no_cap_is_full_speed() {
        let s = settings_from(r#"{"downloadDir":"/tmp"}"#);
        assert_eq!(s.traffic_mode, Some(TrafficMode::Full));
        assert_eq!(s.max_overall_download_limit, 0);
        // The modes still mean something the moment one is picked.
        assert_eq!(s.medium_limit, DEFAULT_MEDIUM_LIMIT);
        assert_eq!(s.light_limit, DEFAULT_LIGHT_LIMIT);
    }

    /// The overall cap is derived, never taken: the frontend sends the whole
    /// settings object back and must not be able to contradict the mode.
    #[test]
    fn the_mode_decides_the_cap() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","trafficMode":"light","lightLimit":262144,
                "maxOverallDownloadLimit":99999999}"#,
        );
        assert_eq!(s.max_overall_download_limit, 262_144);

        let s =
            settings_from(r#"{"downloadDir":"/tmp","trafficMode":"full","mediumLimit":262144}"#);
        assert_eq!(s.max_overall_download_limit, 0);
    }

    /// A blank field is "unset", and anything under a kilobyte a second is a
    /// stall rather than a limit.
    #[test]
    fn a_mode_never_means_stopped() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","trafficMode":"medium","mediumLimit":0,"lightLimit":12}"#,
        );
        assert_eq!(s.medium_limit, DEFAULT_MEDIUM_LIMIT);
        assert_eq!(s.light_limit, MIN_LIMIT);
        assert_eq!(s.max_overall_download_limit, DEFAULT_MEDIUM_LIMIT);
    }

    /// `--seed-time=0` means "never seed", so "no time limit" has to be the
    /// absence of the option rather than a zero.
    #[test]
    fn no_seed_time_means_no_seed_time_option() {
        let settings = settings_from(r#"{"downloadDir":"/tmp","seedTimeMinutes":0}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), &settings);
        assert!(!args.iter().any(|a| a.starts_with("--seed-time")));
        assert!(args.iter().any(|a| a == "--seed-ratio=1"));

        let settings = settings_from(r#"{"downloadDir":"/tmp","seedTimeMinutes":90}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), &settings);
        assert!(args.iter().any(|a| a == "--seed-time=90"));
    }

    #[test]
    fn a_hand_edited_ratio_stays_a_ratio() {
        assert_eq!(
            settings_from(r#"{"downloadDir":"/tmp","seedRatio":-4}"#).seed_ratio,
            1.0
        );
        assert_eq!(
            settings_from(r#"{"downloadDir":"/tmp","seedRatio":1e9}"#).seed_ratio,
            100.0
        );
        // 0.0 is meaningful: seed until told to stop.
        assert_eq!(
            settings_from(r#"{"downloadDir":"/tmp","seedRatio":0}"#).seed_ratio,
            0.0
        );
    }

    #[test]
    fn keeps_only_what_aria2_can_fetch() {
        let info = parse(YOUTUBE);
        // Not one HLS or DASH playlist survives: handing aria2 an m3u8 URL
        // downloads the playlist, not the video.
        assert!(!info.formats.is_empty());
        for f in &info.formats {
            assert!(!f.url.is_empty(), "a format with no URL got through");
        }
        // 32 of YouTube's 53 formats are plain HTTPS; the rest are segmented.
        assert_eq!(info.formats.len(), 32);
    }

    #[test]
    fn youtube_has_no_complete_formats() {
        let info = parse(YOUTUBE);
        // The whole reason merging exists. If this ever fails, YouTube started
        // serving single-file formats again and the picker gets simpler.
        assert!(info.formats.iter().all(|f| f.kind != "complete"));
        assert!(info.formats.iter().any(|f| f.kind == "video"));
        assert!(info.formats.iter().any(|f| f.kind == "audio"));
        assert_eq!(info.title, "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film");
        assert_eq!(info.uploader, "Blender");
    }

    #[test]
    fn tallest_picture_first() {
        let info = parse(YOUTUBE);
        let heights: Vec<u64> = info.formats.iter().map(|f| f.height).collect();
        assert!(heights.windows(2).all(|w| w[0] >= w[1]), "{heights:?}");
        assert_eq!(heights[0], 2160);
    }

    #[test]
    fn a_missing_codec_field_is_not_a_missing_stream() {
        let info = parse(COMMONS);
        // Two of Wikimedia's four formats name no codecs at all. Reading that
        // as "no audio" would drop the only formats the page offers.
        assert_eq!(info.formats.len(), 4);
        assert!(info.formats.iter().all(|f| f.kind == "complete"));
    }

    #[test]
    fn headers_come_out_ready_for_aria2() {
        let info = parse(YOUTUBE);
        let headers = &info.formats[0].headers;
        assert!(!headers.is_empty());
        // aria2's `header` option takes "Name: Value" lines, not an object.
        assert!(headers.iter().all(|h| h.contains(": ")));
        assert!(headers.iter().any(|h| h.starts_with("User-Agent: ")));
    }

    #[test]
    fn sizes_fall_back_to_the_estimate() {
        let info = parse(YOUTUBE);
        assert!(
            info.formats.iter().all(|f| f.filesize > 0),
            "a format came through with no size at all"
        );
    }

    #[test]
    fn a_playlist_page_yields_its_first_video() {
        // --no-playlist is a preference, not a guarantee: a channel URL still
        // comes back wrapped.
        let inner: serde_json::Value = serde_json::from_str(COMMONS).unwrap();
        let wrapped = serde_json::json!({ "_type": "playlist", "entries": [inner] });
        let info = trim_info(&wrapped).unwrap();
        assert_eq!(info.title, "Physicsworks");
        assert_eq!(info.formats.len(), 4);
    }

    #[test]
    fn an_empty_playlist_is_an_error_not_an_empty_picker() {
        let wrapped = serde_json::json!({ "_type": "playlist", "entries": [] });
        assert!(trim_info(&wrapped).is_err());
    }

    /// One top-level ISO box: a big-endian size covering the header, the
    /// four-character type, and however much filler the size claims.
    fn boxed(kind: &[u8; 4], payload: usize) -> Vec<u8> {
        let size = (8 + payload) as u32;
        let mut out = size.to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend(std::iter::repeat_n(0u8, payload));
        out
    }

    fn walk(file: &[u8], ready: u64) -> bool {
        moov_within(&mut std::io::Cursor::new(file.to_vec()), ready)
    }

    /// A faststart MP4 — the one `mux_video` writes — puts the index in front
    /// of the media, which is the whole reason preview works on one at all.
    #[test]
    fn a_faststart_mp4_is_playable_from_its_first_bytes() {
        let mut file = boxed(b"ftyp", 24);
        file.extend(boxed(b"moov", 900));
        file.extend(boxed(b"mdat", 40_000));
        assert!(walk(&file, 2_000));
    }

    /// The case the panel exists to explain: everything has arrived except the
    /// index, because the index is behind all of it.
    #[test]
    fn an_index_at_the_end_is_not_playable_until_it_arrives() {
        let mut file = boxed(b"ftyp", 24);
        file.extend(boxed(b"mdat", 40_000));
        file.extend(boxed(b"moov", 900));
        assert!(!walk(&file, 20_000), "half the media is not an index");
        assert!(walk(&file, file.len() as u64), "and the whole file is");
    }

    /// Starting inside the downloaded prefix is not enough — a player reads
    /// the whole index, and the rest of it is still a hole.
    #[test]
    fn an_index_that_runs_past_the_frontier_is_not_playable() {
        let mut file = boxed(b"ftyp", 24);
        file.extend(boxed(b"moov", 4_000));
        assert!(!walk(&file, 1_000));
        assert!(walk(&file, 4_100));
    }

    /// A box header read past the frontier is a header read off a hole, which
    /// aria2 preallocated as zeroes — and a zero size means "to end of file".
    /// Walking that would report an index the file may not have.
    #[test]
    fn a_header_on_an_unwritten_hole_is_not_walked() {
        let mut file = boxed(b"ftyp", 24);
        file.extend(vec![0u8; 4_000]);
        assert!(!walk(&file, file.len() as u64));
    }

    /// The 64-bit escape, which is how any mdat over 4 GB is written — and a
    /// preview is exactly the case where the file is that big.
    #[test]
    fn a_64_bit_mdat_is_stepped_over_to_reach_the_index() {
        let mut file = boxed(b"ftyp", 24);
        let payload = 5_000u64;
        file.extend(1u32.to_be_bytes());
        file.extend(b"mdat");
        file.extend((16 + payload).to_be_bytes());
        file.extend(vec![0u8; payload as usize]);
        file.extend(boxed(b"moov", 100));
        assert!(walk(&file, file.len() as u64));
    }

    /// The sidecar is looked at first — a bundled garia must merge without
    /// anything installed — and only it is labelled "bundled", because that
    /// label is what Settings prints and what a support answer starts from.
    #[test]
    fn the_bundled_ffmpeg_is_looked_at_first_and_is_the_only_bundled_one() {
        let candidates = ffmpeg_candidates();
        let exe_dir = std::env::current_exe().unwrap();
        let exe_dir = exe_dir.parent().unwrap();

        assert_eq!(candidates[0].1, "bundled");
        assert_eq!(candidates[0].0, exe_dir.join("ffmpeg").display().to_string());
        assert!(candidates[1..].iter().all(|(_, origin)| *origin == "system"));
    }
}

