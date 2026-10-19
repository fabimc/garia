//! aria2 lifecycle, JSON-RPC, and settings/logins orchestration.

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;



/// The aria2c child process plus the RPC secret it was started with. The
/// paths are here because they are launch-time inputs and nothing else: aria2
/// reads a netrc, a cookie jar, and a proxy once, when it starts, so changing
/// any of them is a restart — and a restart has to be able to rebuild the
/// same command line.
///
/// The secret is behind a lock because turning remote control on or off
/// replaces it: an unlisted, per-launch token is right for a socket only this
/// machine can reach, and wrong for one a phone has to be paired with.
pub struct Aria2 {
    pub child: Mutex<Option<Child>>,
    pub secret: Mutex<String>,
    pub port: u16,
    pub pid_file: PathBuf,
    pub session: PathBuf,
    pub netrc: PathBuf,
    /// Where the token lives while remote control is on. Deleted when it is
    /// turned off, which is what makes turning it off an un-pairing rather
    /// than a closed door.
    pub remote_secret: PathBuf,
    /// How many of the frontend's calls may be in flight at once. Launch asks
    /// `getOption` once per download, and a long list would otherwise be a
    /// thread and a socket for every row, all at the same moment.
    pub calls: tokio::sync::Semaphore,
    /// Held for reading by every frontend call and for writing by a restart,
    /// so a poll that lands while aria2 is down waits for it to come back
    /// instead of reporting it unreachable.
    pub restarting: RwLock<()>,
}

/// Frontend calls to aria2 allowed in flight at once.
pub const RPC_CONCURRENCY: usize = 6;

impl Aria2 {
    /// Every caller wants an owned copy for the length of one request, and
    /// none of them should be holding the lock across a network call.
    pub fn secret(&self) -> String {
        self.secret
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }
}

/// A cap nobody can find is a cap nobody uses. FDM frames the one number as
/// three modes instead, switchable without opening a dialog — so garia keeps


/// One agent for every call to aria2: it keeps the connection open between
/// polls rather than opening a fresh one each second, and it has timeouts. A
/// hung aria2 used to hang the call with it, with no end.
pub fn rpc_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(2))
            .timeout(Duration::from_secs(30))
            .build()
    })
}

/// The params aria2 is sent, with the secret where it looks for it: first in
/// the call, or first in each call of a batch.
pub fn rpc_args(method: &str, params: serde_json::Value, secret: &str) -> Vec<serde_json::Value> {
    let mut args = match params {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Null => Vec::new(),
        other => vec![other],
    };
    let token = serde_json::json!(format!("token:{secret}"));
    if method == "system.multicall" {
        // aria2 wants the token inside each call of a batch, and refuses one
        // put on the batch itself.
        if let Some(serde_json::Value::Array(calls)) = args.first_mut() {
            for call in calls.iter_mut().filter_map(|c| c.as_object_mut()) {
                match call.get_mut("params") {
                    Some(serde_json::Value::Array(p)) => p.insert(0, token.clone()),
                    _ => {
                        call.insert("params".into(), serde_json::json!([token.clone()]));
                    }
                }
            }
        }
    } else {
        args.insert(0, token);
    }
    args
}

pub fn aria2_request(
    port: u16,
    secret: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let args = rpc_args(method, params, secret);

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": args,
    });

    rpc_agent()
        .post(&format!("http://127.0.0.1:{port}/jsonrpc"))
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("aria2 request failed: {e}"))?
        .into_json::<serde_json::Value>()
        .map_err(|e| format!("aria2 invalid response: {e}"))
}

/// Everything the frontend asks of aria2 comes through here, which is what
/// makes this the right place for the scheduler to stand: a download queued
/// while the window is shut is added *already paused* rather than started and
/// stopped a moment later. `pause=true` at `addUri` is honoured — measured, not
/// assumed, and unlike `pause` sent to `changeGlobalOption`, which answers OK
/// and does nothing. It is an action rather than a stored option, so `getOption`
/// never reports it and nothing about it reaches the session file.
///
/// The gid is recorded as held on the way back out, because a download nobody


pub fn batch_adds(params: &serde_json::Value) -> bool {
    params
        .get(0)
        .and_then(|calls| calls.as_array())
        .is_some_and(|calls| {
            calls.iter().any(|c| {
                c.get("methodName")
                    .and_then(|m| m.as_str())
                    .is_some_and(|m| m.starts_with("aria2.add"))
            })
        })
}



/// Apply schedule hold on add, then call aria2. Tauri/UI layers pass the
/// managed state references.
pub fn aria2_call(
    aria2: &Aria2,
    settings: &crate::settings::SettingsState,
    schedule: &crate::schedule::Schedule,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if method == "system.multicall" && batch_adds(&params) {
        return Err("add downloads one at a time, not in a batch".to_string());
    }
    let holding = matches!(method, "aria2.addUri" | "aria2.addTorrent")
        && !run_allowed(settings);
    let params = if holding {
        crate::schedule::with_pause(params)
    } else {
        params
    };

    let _up = aria2.restarting.read().unwrap_or_else(|e| e.into_inner());
    let out = aria2_request(aria2.port, &aria2.secret(), method, params)?;

    if holding {
        if let Some(gid) = crate::schedule::gid_of(&out) {
            schedule.hold(&gid);
        }
    }
    Ok(out)
}



/// The daily window alone.
pub fn window_open(settings: &crate::settings::SettingsState) -> bool {
    settings
        .current
        .lock()
        .map(|s| {
            !s.schedule_enabled
                || crate::schedule::open_at(s.schedule_start, s.schedule_end, crate::schedule::minutes_now())
        })
        .unwrap_or(true)
}

/// The one answer to "may downloads run right now".
pub fn run_allowed(settings: &crate::settings::SettingsState) -> bool {
    settings
        .current
        .lock()
        .map(|s| {
            !s.queue_stopped
                && (!s.schedule_enabled
                    || crate::schedule::open_at(s.schedule_start, s.schedule_end, crate::schedule::minutes_now()))
        })
        .unwrap_or(true)
}

pub fn schedule_state(
    settings: &crate::settings::SettingsState,
    schedule: &crate::schedule::Schedule,
) -> crate::schedule::ScheduleState {
    let (enabled, start, end, queue_stopped) = settings
        .current
        .lock()
        .map(|s| (s.schedule_enabled, s.schedule_start, s.schedule_end, s.queue_stopped))
        .unwrap_or((false, 0, 0, false));
    let saved = schedule.snapshot();
    crate::schedule::ScheduleState {
        enabled,
        open: !enabled || crate::schedule::open_at(start, end, crate::schedule::minutes_now()),
        queue_stopped,
        start,
        end,
        next_change: if enabled { crate::schedule::next_change(start, end) } else { 0 },
        held: saved.held.iter().cloned().collect(),
        starts: saved.starts,
        now: crate::schedule::epoch_now(),
    }
}



pub fn set_download_start(
    aria2: &Aria2,
    settings: &crate::settings::SettingsState,
    schedule: &crate::schedule::Schedule,
    gid: String,
    at: Option<i64>,
) -> Result<crate::schedule::ScheduleState, String> {
    let now = crate::schedule::epoch_now();
    let pending = at.filter(|at| *at > now);
    schedule.set_start(&gid, pending);
    let secret = aria2.secret();
    match pending {
        Some(_) => {
            if aria2_request(aria2.port, &secret, "aria2.forcePause", serde_json::json!([gid])).is_ok() {
                schedule.hold(&gid);
            }
        }
        None => {
            if run_allowed(settings) {
                let _ = aria2_request(aria2.port, &secret, "aria2.unpause", serde_json::json!([gid]));
                schedule.release(&gid);
            }
        }
    }
    Ok(schedule_state(settings, schedule))
}

/// Persist queue stopped flag. Caller emits settings-changed and ticks schedule.
pub fn set_queue_stopped(
    settings: &crate::settings::SettingsState,
    stopped: bool,
) -> Result<crate::settings::Settings, String> {
    let next = {
        let Ok(mut guard) = settings.current.lock() else {
            return Err("could not read settings".into());
        };
        guard.queue_stopped = stopped;
        guard.clone()
    };
    let json = serde_json::to_string_pretty(&next)
        .map_err(|e| format!("could not encode the settings: {e}"))?;
    std::fs::write(&settings.file, json)
        .map_err(|e| format!("could not write {}: {e}", settings.file.display()))?;
    Ok(next)
}


pub fn save_settings(
    aria2: &Aria2,
    state: &crate::settings::SettingsState,
    settings: crate::settings::Settings,
) -> Result<crate::settings::Settings, String> {
    // Checked before normalising, which drops a jar that isn't there: a path
    // that was typed rather than chosen can be wrong, and silently having no
    // cookies looks exactly like the login not working.
    let jar = settings.cookie_file.trim();
    if !jar.is_empty() && !Path::new(jar).is_file() {
        return Err(format!("No cookie file at {jar}"));
    }

    let mut settings = settings.normalised();
    let incoming_pass = settings.proxy_password.clone();
    let passwd_file = crate::settings::proxy_passwd_path(&state.file);

    // Read before anything is written: these are the settings aria2 will
    // not take while it is running, so a change to any of them is a restart.
    // `rpc-listen-all` sent to changeGlobalOption answers OK, leaves the
    // socket bound exactly as it was, and getGlobalOption still reports the
    // old value — measured against aria2 1.37, and the same trap the cookie
    // jar sprang. `--all-proxy` is the same family: a credential, and one
    // aria2 reads when it starts.
    let (jar_changed, remote_changed, proxy_changed, kept_pass) = state
        .current
        .lock()
        .map(|current| {
            let kept = if incoming_pass.is_empty() {
                current.proxy_password.clone()
            } else {
                incoming_pass.clone()
            };
            let proxy_changed = current.proxy_enabled != settings.proxy_enabled
                || current.proxy_host != settings.proxy_host
                || current.proxy_port != settings.proxy_port
                || current.proxy_user != settings.proxy_user
                || current.proxy_no_proxy != settings.proxy_no_proxy
                || current.proxy_password != kept;
            (
                current.cookie_file != settings.cookie_file,
                current.remote_control != settings.remote_control,
                proxy_changed,
                kept,
            )
        })
        .unwrap_or((
            false,
            false,
            !incoming_pass.is_empty(),
            incoming_pass.clone(),
        ));

    settings.proxy_password = kept_pass;
    if !incoming_pass.is_empty() {
        crate::settings::write_proxy_passwd(&passwd_file, &incoming_pass)?;
    }

    // The folder is the one setting that can be wrong in a way the user has to
    // fix: everything else is clamped into range above.
    let dir = Path::new(&settings.download_dir);
    fs::create_dir_all(dir).map_err(|e| format!("Cannot use {}: {e}", settings.download_dir))?;
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", settings.download_dir));
    }

    let json = serde_json::to_string_pretty(&settings.for_disk())
        .map_err(|e| format!("could not encode the settings: {e}"))?;
    fs::write(&state.file, json)
        .map_err(|e| format!("could not write {}: {e}", state.file.display()))?;

    // Best-effort: the file on disk is the source of truth, and an aria2 that
    // cannot be reached is already saying so in the status bar. The seeding
    // rules are deliberately absent: aria2 takes neither on a running download,
    // so they go on each torrent as it is added and into the next launch.
    if let Err(e) = aria2_request(
        aria2.port,
        &aria2.secret(),
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

    // Turning remote control on or off replaces the token as well as the
    // socket: a per-launch secret is right for a port only this machine can
    // reach and useless for one a phone is paired with, and dropping the
    // saved one on the way out is what makes turning it off an un-pairing
    // rather than a door that could be opened again on the same key.
    let next_secret = remote_changed.then(|| {
        if settings.remote_control {
            crate::settings::remote_secret(&aria2.remote_secret)
        } else {
            let _ = fs::remove_file(&aria2.remote_secret);
            crate::settings::random_secret()
        }
    });


    if jar_changed || remote_changed || proxy_changed {
        restart_aria2(aria2, &settings, next_secret).map_err(|e| {
            format!("The settings are saved, but {e}. Unfinished downloads are in the session file.")
        })?;
    }

    Ok(settings.for_frontend())
}

pub fn get_logins(state: &crate::settings::LoginsState) -> Vec<crate::logins::LoginView> {
    state
        .current
        .lock()
        .map(|current| crate::logins::views(current.as_slice()))
        .unwrap_or_default()
}

pub fn save_login(
    aria2: &Aria2,
    settings: &crate::settings::SettingsState,
    state: &crate::settings::LoginsState,
    host: String,
    username: String,
    password: Option<String>,
    headers: Vec<String>,
) -> Result<Vec<crate::logins::LoginView>, String> {
    let host = crate::logins::host_of(&host);
    if host.is_empty() {
        return Err("Which site is this for? Paste a URL or type a host name.".to_string());
    }
    let headers = crate::logins::tidy_headers(&headers)?;
    let username = username.trim().to_string();

    let mut current = state
        .current
        .lock()
        .map_err(|_| "the login list is in an unknown state".to_string())?
        .clone();

    let kept = current
        .iter()
        .find(|l| l.host == host)
        .map(|l| l.password.clone())
        .unwrap_or_default();
    if username.is_empty() && password.as_deref().is_some_and(|p| !p.is_empty()) {
        return Err("A password needs a user name to go with it.".to_string());
    }
    if username.is_empty() && headers.is_empty() {
        return Err("Nothing to save — give the site a user name, a header, or both.".to_string());
    }

    let password = if username.is_empty() {
        String::new()
    } else {
        password.unwrap_or(kept)
    };

    let entry = crate::logins::Login { host: host.clone(), username, password, headers };
    match current.iter_mut().find(|l| l.host == host) {
        Some(existing) => *existing = entry,
        None => current.push(entry),
    }
    current.sort_by(|a, b| a.host.cmp(&b.host));

    commit_logins(aria2, settings, state, current)
}

pub fn delete_login(
    aria2: &Aria2,
    settings: &crate::settings::SettingsState,
    state: &crate::settings::LoginsState,
    host: String,
) -> Result<Vec<crate::logins::LoginView>, String> {
    let host = crate::logins::host_of(&host);
    let mut current = state
        .current
        .lock()
        .map_err(|_| "the login list is in an unknown state".to_string())?
        .clone();
    current.retain(|l| l.host != host);
    commit_logins(aria2, settings, state, current)
}

/// Write both files; restart aria2 only if the netrc changed. Caller emits logins-changed.
pub fn commit_logins(
    aria2: &Aria2,
    settings: &crate::settings::SettingsState,
    state: &crate::settings::LoginsState,
    next: Vec<crate::logins::Login>,
) -> Result<Vec<crate::logins::LoginView>, String> {
    crate::logins::write(&state.file, &next)
        .map_err(|e| format!("could not write {}: {e}", state.file.display()))?;

    let before = std::fs::read(&state.netrc).ok();
    crate::logins::write_netrc(&state.netrc, &next)
        .map_err(|e| format!("could not write {}: {e}", state.netrc.display()))?;
    let after = std::fs::read(&state.netrc).ok();

    let views = crate::logins::views(&next);
    if let Ok(mut guard) = state.current.lock() {
        *guard = next;
    }

    if before != after {
        let current = settings.current.lock().map(|s| s.clone()).unwrap_or_default();
        restart_aria2(aria2, &current, None).map_err(|e| {
            format!("The login is saved, but {e}. It will be in force from the next launch.")
        })?;
    }

    Ok(views)
}

pub fn ftp_list(
    state: &crate::settings::LoginsState,
    url: String,
) -> Result<crate::ftp::FtpListing, String> {
    let target = crate::ftp::parse_ftp_url(&url)?;
    let host = crate::logins::host_of(&target.host);
    let current = state.current.lock().map(|g| g.clone()).unwrap_or_default();
    let saved = current.iter().find(|l| l.host == host).and_then(|l| {
        if l.username.is_empty() {
            None
        } else {
            Some((l.username.as_str(), l.password.as_str()))
        }
    });
    let owned = saved.map(|(u, p)| (u.to_string(), p.to_string()));
    let pair = owned.as_ref().map(|(u, p)| (u.as_str(), p.as_str()));
    crate::ftp::list_directory(&target, pair)
}

pub fn remote_info(
    aria2: &Aria2,
    settings: &crate::settings::SettingsState,
) -> crate::settings::RemoteInfo {
    use crate::settings::{local_ip, qr_of, RemoteInfo, DEFAULT_RPC_PORT};
    let enabled = settings
        .current
        .lock()
        .map(|s| s.remote_control)
        .unwrap_or(false);

    if !enabled {
        return RemoteInfo {
            enabled: false,
            host: None,
            port: aria2.port,
            secret: String::new(),
            default_port: aria2.port == DEFAULT_RPC_PORT,
            qr_width: 0,
            qr_modules: Vec::new(),
        };
    }

    let secret = aria2.secret();
    let (qr_width, qr_modules) = qr_of(&secret);
    RemoteInfo {
        enabled: true,
        host: local_ip(),
        port: aria2.port,
        secret,
        default_port: aria2.port == DEFAULT_RPC_PORT,
        qr_width,
        qr_modules,
    }
}

pub fn get_settings(state: &crate::settings::SettingsState) -> crate::settings::Settings {
    state
        .current
        .lock()
        .map(|s| s.for_frontend())
        .unwrap_or_default()
}

pub fn aria2_endpoint(aria2: &Aria2) -> String {
    format!("127.0.0.1:{}", aria2.port)
}

pub fn encode_base64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (a << 16) | (b << 8) | c;
        out.push(T[(n >> 18) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

pub fn read_torrent(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    Ok(encode_base64(&bytes))
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    }
}


/// Where to look for aria2c, best first. The sidecar sits next to the app
/// binary and is what a fresh install runs — no `brew install aria2` first.
/// The system copies stay as a fallback: they keep `tauri dev` working, and
/// they rescue a bundle whose sidecar went missing.
pub fn aria2c_candidates_with_origin() -> Vec<(String, &'static str)> {
    let mut c = Vec::new();

    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        c.push((dir.join("aria2c").display().to_string(), "bundled"));
    }

    c.push(("aria2c".to_string(), "system"));

    // macOS GUI apps (launched via Finder) often don't inherit Homebrew PATH.
    // Try common Homebrew install locations explicitly.
    #[cfg(target_os = "macos")]
    c.extend([
        ("/opt/homebrew/bin/aria2c".to_string(), "system"),
        ("/usr/local/bin/aria2c".to_string(), "system"),
    ]);

    // Common Linux locations.
    #[cfg(target_os = "linux")]
    c.extend([
        ("/usr/bin/aria2c".to_string(), "system"),
        ("/bin/aria2c".to_string(), "system"),
        ("/snap/bin/aria2c".to_string(), "system"),
    ]);

    c
}

pub fn aria2c_version(bin: &str) -> Option<String> {
    let out = crate::process::run_capped(bin, &["--version".to_string()], 10).ok()?;
    if !out.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(v) = crate::video::version_after(line, "version") {
            return Some(v);
        }
        return Some(line.to_string());
    }
    None
}

pub fn aria2c_probe() -> Option<(String, &'static str, String)> {
    for (bin, origin) in aria2c_candidates_with_origin() {
        if bin.contains('/') && !Path::new(&bin).exists() {
            continue;
        }
        if let Some(version) = aria2c_version(&bin) {
            return Some((bin, origin, version));
        }
    }
    None
}

pub fn running_aria2_version(aria2: &Aria2) -> Option<String> {
    aria2_request(
        aria2.port,
        &aria2.secret(),
        "aria2.getVersion",
        serde_json::json!([]),
    )
    .ok()?
    .get("result")
    .and_then(|r| r.get("version"))
    .and_then(|v| v.as_str())
    .map(|v| v.to_string())
}


pub fn aria2c_candidates() -> Vec<String> {
    aria2c_candidates_with_origin()
        .into_iter()
        .map(|(bin, _)| bin)
        .collect()
}

/// Everything aria2 is started with. A Vec rather than an array because one
/// of them is conditional: `--seed-time=0` does not mean "no time limit", it
/// means "never seed", so the option has to be absent rather than zero.
pub fn aria2_args(
    port: u16,
    secret: &str,
    session_file: &Path,
    netrc_file: &Path,
    settings: &crate::settings::Settings,
) -> Vec<String> {
    let mut args = vec![
        "--enable-rpc".to_string(),
        // The one line that decides whether this socket is the machine's or
        // the network's. aria2 offers no middle setting — there is no "listen
        // on this interface only" for the RPC port — so it is all or loopback.
        format!("--rpc-listen-all={}", settings.remote_control),
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

    // The two credentials aria2 will only take at launch. Both are named here
    // and nowhere else: measured against aria2 1.37, `load-cookies` sent to
    // `changeGlobalOption` or carried on `addUri` is accepted, answers OK, and
    // loads nothing — and netrc is read once, so a login saved after this
    // process started is not one it knows about. That is why saving a login
    // restarts aria2 rather than pushing anything at it.
    if netrc_file.is_file() {
        // Only when there is one. Without this, garia would be overriding the
        // user's own ~/.netrc with an empty file on every machine.
        args.push(format!("--netrc-path={}", netrc_file.display()));
    }
    if !settings.cookie_file.is_empty() {
        args.push(format!("--load-cookies={}", settings.cookie_file));
    }
    if let Some(proxy) = crate::settings::proxy_arg(settings) {
        args.push(format!("--all-proxy={proxy}"));
        if !settings.proxy_user.is_empty() {
            args.push(format!("--all-proxy-user={}", settings.proxy_user));
        }
        if !settings.proxy_password.is_empty() {
            args.push(format!("--all-proxy-passwd={}", settings.proxy_password));
        }
        if !settings.proxy_no_proxy.is_empty() {
            args.push(format!("--no-proxy={}", settings.proxy_no_proxy));
        }
    }
    args
}

pub fn spawn_aria2(
    port: u16,
    secret: &str,
    session_file: &Path,
    netrc_file: &Path,
    settings: &crate::settings::Settings,
) -> Option<Child> {
    for bin in aria2c_candidates() {
        if bin.contains('/') && !Path::new(&bin).exists() {
            continue;
        }

        let child = Command::new(&bin)
            .args(aria2_args(port, secret, session_file, netrc_file, settings))
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

/// Credentials are launch-time state in aria2 — a netrc and a cookie jar are
/// both read once, when it starts — so changing one means starting it again.
/// That is the same move as quitting and relaunching garia, which already
/// resumes every unfinished download mid-file from the session file, so this
/// borrows it whole: ask aria2 to write the session, stop it, start it on the
/// same port with the same secret, and wait until it answers before saying so.
/// `next_secret` is the one case where the process that comes back is not the
/// one that went away: turning remote control on or off changes the token as
/// well as the socket. It is swapped in *after* the old aria2 has written its
/// session and been killed — asking the running one to save with a token it
/// has never seen is an Unauthorized and a lost queue.
pub fn restart_aria2(
    aria2: &Aria2,
    settings: &crate::settings::Settings,
    next_secret: Option<String>,
) -> Result<(), String> {
    let _down = aria2.restarting.write().unwrap_or_else(|e| e.into_inner());

    // kill() is a SIGKILL and aria2 would never get to write the session.
    if let Err(e) = aria2_request(
        aria2.port,
        &aria2.secret(),
        "aria2.saveSession",
        serde_json::json!([]),
    ) {
        eprintln!("[garia] Could not save the aria2 session before restarting: {e}");
    }

    let mut guard = aria2
        .child
        .lock()
        .map_err(|_| "the aria2 process is in an unknown state".to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    if let Some(next) = next_secret {
        *aria2
            .secret
            .lock()
            .map_err(|_| "the aria2 secret is in an unknown state".to_string())? = next;
    }
    let secret = aria2.secret();

    // The port it just let go of is the port it is about to take back, and a
    // just-killed process can hold it a moment longer than it takes to ask.
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let Some(child) =
            spawn_aria2(aria2.port, &secret, &aria2.session, &aria2.netrc, settings)
        else {
            return Err("no aria2c to start".to_string());
        };
        let pid = child.id();
        *guard = Some(child);

        // Spawning is not binding: an aria2 that cannot have the port exits a
        // moment later, so the proof is that it answers.
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if aria2_request(
                aria2.port,
                &secret,
                "aria2.getVersion",
                serde_json::json!([]),
            )
            .is_ok()
            {
                if let Err(e) = fs::write(&aria2.pid_file, pid.to_string()) {
                    eprintln!("[garia] Could not record the aria2c pid: {e}");
                }
                return Ok(());
            }
        }

        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    Err("aria2 did not come back — quit and reopen garia".to_string())
}

/// A force-quit or a crash leaves aria2c running: it outlives the app, keeps
/// the RPC port, and answers the next launch with the previous run's secret.
/// The pid we wrote at spawn is how we recognise our own leftovers — and only
/// our own, so an aria2 the user runs themselves is never touched.
pub fn reap_orphan(pid_file: &Path) {
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
pub fn pick_port() -> u16 {
    for _ in 0..20 {
        if TcpListener::bind(("127.0.0.1", crate::settings::DEFAULT_RPC_PORT)).is_ok() {
            return crate::settings::DEFAULT_RPC_PORT;
        }
        // A just-reaped aria2c can hold the port a moment longer.
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(crate::settings::DEFAULT_RPC_PORT)
}

/// `--input-file` is an error when the path doesn't exist, so the first launch
/// has to leave an empty one behind for aria2 to read.
pub fn session_path(dir: &Path) -> PathBuf {
    let path = dir.join("session.txt");
    if !path.exists() {
        if let Err(e) = fs::write(&path, "") {
            eprintln!("[garia] Could not create {}: {e}", path.display());
        }
    }
    path
}

/// Config + engine state for a non-Tauri shell (iced MVP, tests, …).
pub struct Engine {
    pub data_dir: PathBuf,
    pub aria2: Aria2,
    pub settings: crate::settings::SettingsState,
}

/// Create the app data dir, load settings, and spawn aria2. Missing aria2c is
/// not fatal — the UI can still open and show "unreachable".
pub fn bootstrap(data_dir: PathBuf) -> Engine {
    if let Err(e) = fs::create_dir_all(&data_dir) {
        eprintln!("[garia] Could not create {}: {e}", data_dir.display());
    }

    let pid_file = data_dir.join("aria2.pid");
    reap_orphan(&pid_file);

    let settings_file = data_dir.join("settings.json");
    let mut settings = crate::settings::read_settings(&settings_file);
    settings.proxy_password = crate::settings::read_proxy_passwd(
        &crate::settings::proxy_passwd_path(&settings_file),
    );

    let netrc_file = data_dir.join("netrc");
    let logins_file = data_dir.join("logins.json");
    let saved = crate::logins::read(&logins_file);
    if let Err(e) = crate::logins::write_netrc(&netrc_file, &saved) {
        eprintln!("[garia] Could not write {}: {e}", netrc_file.display());
    }

    let remote_secret_file = data_dir.join("remote-secret");
    let secret = if settings.remote_control {
        crate::settings::remote_secret(&remote_secret_file)
    } else {
        let _ = fs::remove_file(&remote_secret_file);
        crate::settings::random_secret()
    };

    let session = session_path(&data_dir);
    let port = pick_port();
    let child = spawn_aria2(port, &secret, &session, &netrc_file, &settings);
    match &child {
        Some(c) => {
            if let Err(e) = fs::write(&pid_file, c.id().to_string()) {
                eprintln!("[garia] Could not record the aria2c pid: {e}");
            }
        }
        None => eprintln!(
            "[garia] No aria2c found — the queue will show as unreachable until one is installed."
        ),
    }

    Engine {
        data_dir,
        aria2: Aria2 {
            child: Mutex::new(child),
            secret: Mutex::new(secret),
            port,
            pid_file,
            session,
            netrc: netrc_file,
            remote_secret: remote_secret_file,
            calls: tokio::sync::Semaphore::new(RPC_CONCURRENCY),
            restarting: RwLock::new(()),
        },
        settings: crate::settings::SettingsState {
            file: settings_file,
            current: Mutex::new(settings),
        },
    }
}

/// One row in the download queue as the iced MVP needs it.
#[derive(Clone, Debug, Default)]
pub struct QueueRow {
    pub gid: String,
    pub status: String,
    pub name: String,
    pub completed: u64,
    pub total: u64,
    pub download_speed: u64,
}

/// Snapshot used by the UI poll.
#[derive(Clone, Debug, Default)]
pub struct QueueSnapshot {
    pub rows: Vec<QueueRow>,
    pub active: u32,
    pub waiting: u32,
    pub stopped: u32,
    pub error: Option<String>,
}

/// Poll active + waiting downloads. Errors become `error` rather than failing
/// the call — the iced shell stays up when aria2 is missing.
pub fn poll_queue(port: u16, secret: &str) -> QueueSnapshot {
    let keys = serde_json::json!(["gid", "status", "totalLength", "completedLength", "downloadSpeed", "files", "bittorrent"]);

    let active = match aria2_request(port, secret, "aria2.tellActive", serde_json::json!([keys])) {
        Ok(v) => v,
        Err(e) => {
            return QueueSnapshot {
                error: Some(e),
                ..Default::default()
            };
        }
    };
    let waiting = match aria2_request(
        port,
        secret,
        "aria2.tellWaiting",
        serde_json::json!([0, 500, keys]),
    ) {
        Ok(v) => v,
        Err(e) => {
            return QueueSnapshot {
                error: Some(e),
                ..Default::default()
            };
        }
    };

    let mut rows = Vec::new();
    let mut push = |value: &serde_json::Value| {
        let Some(list) = value.get("result").and_then(|r| r.as_array()) else {
            return;
        };
        for item in list {
            rows.push(queue_row_from(item));
        }
    };
    push(&active);
    push(&waiting);

    let (active_n, waiting_n, stopped_n) = match aria2_request(
        port,
        secret,
        "aria2.getGlobalStat",
        serde_json::json!([]),
    ) {
        Ok(stat) => {
            let r = stat.get("result");
            (
                r.and_then(|s| s.get("numActive"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                r.and_then(|s| s.get("numWaiting"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                r.and_then(|s| s.get("numStopped"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
            )
        }
        Err(_) => (0, 0, 0),
    };

    QueueSnapshot {
        rows,
        active: active_n,
        waiting: waiting_n,
        stopped: stopped_n,
        error: None,
    }
}

fn queue_row_from(item: &serde_json::Value) -> QueueRow {
    let gid = item
        .get("gid")
        .and_then(|g| g.as_str())
        .unwrap_or("")
        .to_string();
    let status = item
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let completed = parse_u64(item.get("completedLength"));
    let total = parse_u64(item.get("totalLength"));
    let download_speed = parse_u64(item.get("downloadSpeed"));
    let name = download_name(item);
    QueueRow {
        gid,
        status,
        name,
        completed,
        total,
        download_speed,
    }
}

fn parse_u64(v: Option<&serde_json::Value>) -> u64 {
    v.and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .or_else(|| v.and_then(|v| v.as_u64()))
        .unwrap_or(0)
}

fn download_name(item: &serde_json::Value) -> String {
    if let Some(name) = item
        .get("bittorrent")
        .and_then(|b| b.get("info"))
        .and_then(|i| i.get("name"))
        .and_then(|n| n.as_str())
    {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    item.get("files")
        .and_then(|f| f.as_array())
        .and_then(|files| files.first())
        .and_then(|f| f.get("path"))
        .and_then(|p| p.as_str())
        .map(|p| {
            Path::new(p)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(p)
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(unnamed)".into())
}

#[cfg(test)]
mod queue_tests {
    use super::*;

    #[test]
    fn poll_queue_is_graceful_when_aria2_is_down() {
        // Nothing listening — must not panic, just report an error.
        let snap = poll_queue(9, "deadbeef");
        assert!(snap.error.is_some());
        assert!(snap.rows.is_empty());
    }

    #[test]
    fn queue_row_reads_a_plain_file_name() {
        let item = serde_json::json!({
            "gid": "abc",
            "status": "active",
            "completedLength": "50",
            "totalLength": "100",
            "downloadSpeed": "1024",
            "files": [{ "path": "/tmp/folder/film.mp4" }],
        });
        let row = queue_row_from(&item);
        assert_eq!(row.name, "film.mp4");
        assert_eq!(row.completed, 50);
        assert_eq!(row.total, 100);
        assert_eq!(row.download_speed, 1024);
    }
}

