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

fn ffmpeg_path() -> Option<String> {
    let mut candidates = vec!["ffmpeg".to_string()];

    #[cfg(target_os = "macos")]
    candidates.extend([
        "/opt/homebrew/bin/ffmpeg".to_string(),
        "/usr/local/bin/ffmpeg".to_string(),
    ]);

    #[cfg(target_os = "linux")]
    candidates.extend(["/usr/bin/ffmpeg".to_string(), "/usr/local/bin/ffmpeg".to_string()]);

    for bin in candidates {
        if bin.contains('/') && !is_executable(&bin) {
            continue;
        }
        let ok = run_capped(&bin, &["-version".to_string()], 10)
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Some(bin);
        }
    }
    None
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
    let tools = VideoTools {
        version: cmd.as_deref().and_then(ytdlp_version).unwrap_or_default(),
        source: if bundled { "bundled" } else { "system" }.to_string(),
        ffmpeg: ffmpeg_path().is_some(),
    };

    // A machine with neither tool is one `brew install` away from having them,
    // and Settings is where that message is read — so don't cache a "no".
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
            set_badge,
            video_tools,
            video_probe,
            mux_video
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
}

