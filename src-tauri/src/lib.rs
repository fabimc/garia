use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

mod catch;
mod logins;
mod schedule;
#[cfg(target_os = "macos")]
mod service;

/// The aria2c child process plus the RPC secret it was started with. The two
/// paths are here because they are launch-time inputs and nothing else: aria2
/// reads a netrc and a cookie jar once, when it starts, so changing either is
/// a restart — and a restart has to be able to rebuild the same command line.
///
/// The secret is behind a lock because turning remote control on or off
/// replaces it: an unlisted, per-launch token is right for a socket only this
/// machine can reach, and wrong for one a phone has to be paired with.
struct Aria2 {
    child: Mutex<Option<Child>>,
    secret: Mutex<String>,
    port: u16,
    pid_file: PathBuf,
    session: PathBuf,
    netrc: PathBuf,
    /// Where the token lives while remote control is on. Deleted when it is
    /// turned off, which is what makes turning it off an un-pairing rather
    /// than a closed door.
    remote_secret: PathBuf,
}

impl Aria2 {
    /// Every caller wants an owned copy for the length of one request, and
    /// none of them should be holding the lock across a network call.
    fn secret(&self) -> String {
        self.secret
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }
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

/// aria2's conventional port, and what every aria2 client on a phone offers
/// first. Named because remote control cares which one was actually taken.
const DEFAULT_RPC_PORT: u16 = 6800;

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
    /// A Netscape cookies.txt exported from the browser, read by aria2 at
    /// launch and matched to hosts by aria2 itself. A path, not a copy: the
    /// jar stays the browser's file, and garia holds nothing from it. Empty
    /// means no jar, which is the default.
    cookie_file: String,
    /// Let anything on the local network reach the RPC port. Off by default,
    /// and the only setting in here that opens a socket to the outside: aria2
    /// has no way to bind one chosen interface, so this is `--rpc-listen-all`
    /// and nothing narrower. Turning it on also swaps the per-launch token for
    /// one that persists, because a phone cannot be re-paired every morning.
    #[serde(default)]
    remote_control: bool,
    /// Run downloads only between two times of day. Off by default, and the
    /// only setting in here that stops something the user has already asked
    /// for — which is why the dialog says in words what it will and will not
    /// do, rather than implying an alarm clock. See `schedule.rs`.
    #[serde(default)]
    schedule_enabled: bool,
    /// The window's ends, as minutes since local midnight. A time of day and
    /// not a timestamp: 02:00 is 02:00 again after the clocks change, which a
    /// stored instant would not be. `end` before `start` wraps midnight, which
    /// is the shape "overnight" actually has.
    #[serde(default)]
    schedule_start: u32,
    #[serde(default)]
    schedule_end: u32,
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
            cookie_file: String::new(),
            remote_control: false,
            schedule_enabled: false,
            // What the card on the roadmap was drawn around, and what people
            // mean by off-peak: overnight, wrapping midnight.
            schedule_start: 2 * 60,
            schedule_end: 8 * 60,
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

        // A jar that isn't there is no jar: aria2 takes --load-cookies on a
        // missing file without complaint and simply sends no cookies, which
        // looks exactly like the login not working.
        self.cookie_file = self.cookie_file.trim().to_string();
        if !self.cookie_file.is_empty() && !Path::new(&self.cookie_file).is_file() {
            self.cookie_file = String::new();
        }

        // A time of day that is not one — a hand-edited file, or a frontend
        // that sent minutes past the end of a day.
        self.schedule_start %= schedule::DAY;
        self.schedule_end %= schedule::DAY;
        // A window with no width is not a window. Read as "always" it is the
        // setting being off; read as "never" it is a download manager that
        // never downloads — so rather than pick, it is off.
        if self.schedule_start == self.schedule_end {
            self.schedule_enabled = false;
        }

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

/// garia's own credential store, and the netrc derived from it. Two files
/// because they answer to two different readers: the first is garia's, holds
/// the passwords, and is never handed to anything; the second is aria2's, and
/// holds only what aria2 can act on.
struct LoginsState {
    file: PathBuf,
    netrc: PathBuf,
    current: Mutex<Vec<logins::Login>>,
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

/// ── Remote control ───────────────────────────────────────────────────────
/// Everything in garia already talks to aria2 over JSON-RPC on a port, so
/// letting a phone do the same is one launch flag. What it is not is one
/// decision: the token has to stop being per-launch, the socket stops being
/// this machine's, and the secret has to reach the other device without being
/// typed. Those three are the feature.
///
/// The token lives in its own file rather than in settings.json, for the same
/// reason the logins do: it is a credential, and settings.json is a file the
/// user is invited to read. Deleting it is what turning remote control off
/// means — the next time it goes on, a new token, and every device paired
/// against the old one is un-paired rather than merely unable to connect.
fn remote_secret(path: &Path) -> String {
    if let Some(saved) = fs::read_to_string(path).ok().map(|t| t.trim().to_string()) {
        // A hand-mangled file is not a token. Anything that isn't the shape
        // random_secret() writes is replaced rather than handed to aria2,
        // which would take it and leave the pairing quietly broken.
        if saved.len() == 32 && saved.bytes().all(|b| b.is_ascii_hexdigit()) {
            return saved;
        }
    }

    let secret = random_secret();
    if let Err(e) = fs::write(path, &secret) {
        eprintln!("[garia] Could not write {}: {e}", path.display());
    }
    restrict(path);
    secret
}

/// 0600, the way the logins file is. A token that anyone with an account on
/// the machine can read is a token, not a secret.
#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
        eprintln!("[garia] Could not restrict {}: {e}", path.display());
    }
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

/// The address a phone on the same network would use. Asking the routing
/// table beats enumerating interfaces: a UDP socket that is *connected* has
/// picked a route and therefore a source address, and connecting a UDP socket
/// sends nothing. The address it is pointed at is from TEST-NET-1, which is
/// reserved precisely so that it can be named without meaning a real host —
/// nothing is contacted, and no packet leaves.
fn local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("192.0.2.1", 80)).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(ip.to_string())
}

/// What the Settings panel needs to put a pairing in front of someone. The
/// secret is in here, which is the one place garia hands it to its own
/// frontend — and only while remote control is on, because a token nobody can
/// use is a token nobody needs to see.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteInfo {
    enabled: bool,
    /// None when the machine is on no network at all, which makes the whole
    /// panel a promise it cannot keep.
    host: Option<String>,
    port: u16,
    secret: String,
    /// aria2's conventional port, and the one every client defaults to. When
    /// something else already held it at launch the pairing still works, but
    /// it is a different number next time — which is worth saying out loud.
    default_port: bool,
    /// The QR as a square of modules, drawn by the frontend rather than here:
    /// an SVG built in Rust would carry its own colours into a stylesheet that
    /// already has them.
    qr_width: usize,
    qr_modules: Vec<bool>,
}

/// The secret alone, not a URL with the secret in it. Clients ask for host,
/// port and token as three fields; the first two are short enough to read off
/// the screen and type, and the third is the only one that isn't.
fn qr_of(text: &str) -> (usize, Vec<bool>) {
    use qrcode::{EcLevel, QrCode};
    match QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M) {
        Ok(code) => {
            let width = code.width();
            let modules = code
                .to_colors()
                .into_iter()
                .map(|c| c == qrcode::Color::Dark)
                .collect();
            (width, modules)
        }
        Err(e) => {
            eprintln!("[garia] Could not encode the pairing QR: {e}");
            (0, Vec::new())
        }
    }
}

#[tauri::command]
fn remote_info(aria2: tauri::State<Aria2>, settings: tauri::State<SettingsState>) -> RemoteInfo {
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

/// Everything the frontend asks of aria2 comes through here, which is what
/// makes this the right place for the scheduler to stand: a download queued
/// while the window is shut is added *already paused* rather than started and
/// stopped a moment later. `pause=true` at `addUri` is honoured — measured, not
/// assumed, and unlike `pause` sent to `changeGlobalOption`, which answers OK
/// and does nothing. It is an action rather than a stored option, so `getOption`
/// never reports it and nothing about it reaches the session file.
///
/// The gid is recorded as held on the way back out, because a download nobody
/// remembers pausing is a download nobody will start again.
#[tauri::command]
fn aria2_rpc(
    aria2: tauri::State<Aria2>,
    settings: tauri::State<SettingsState>,
    schedule: tauri::State<schedule::Schedule>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let holding = method == "aria2.addUri" && !window_open(&settings);
    let params = if holding {
        schedule::with_pause(params)
    } else {
        params
    };

    let out = aria2_request(aria2.port, &aria2.secret(), &method, params)?;

    if holding {
        if let Some(gid) = schedule::gid_of(&out) {
            schedule.hold(&gid);
        }
    }
    Ok(out)
}

/// The one answer to "may downloads run right now". Everything that asks —
/// the tick, the `addUri` path, the panel — asks this, so nothing can be
/// working from a different reading of the same two numbers.
fn window_open(settings: &tauri::State<SettingsState>) -> bool {
    settings
        .current
        .lock()
        .map(|s| {
            !s.schedule_enabled
                || schedule::open_at(s.schedule_start, s.schedule_end, schedule::minutes_now())
        })
        .unwrap_or(true)
}

/// What the list and the detail panel need in order to say *why* a row is
/// stopped. The window's state is computed here rather than in the frontend so
/// there is only ever one clock deciding it.
#[tauri::command]
fn schedule_state(
    settings: tauri::State<SettingsState>,
    schedule: tauri::State<schedule::Schedule>,
) -> schedule::ScheduleState {
    let (enabled, start, end) = settings
        .current
        .lock()
        .map(|s| (s.schedule_enabled, s.schedule_start, s.schedule_end))
        .unwrap_or((false, 0, 0));
    let saved = schedule.snapshot();

    schedule::ScheduleState {
        enabled,
        open: !enabled || schedule::open_at(start, end, schedule::minutes_now()),
        start,
        end,
        next_change: if enabled {
            schedule::next_change(start, end)
        } else {
            0
        },
        held: saved.held.iter().cloned().collect(),
        starts: saved.starts,
        now: schedule::epoch_now(),
    }
}

/// Give one download an hour of its own, or take it away. Setting a time in
/// the future stops the download now rather than waiting for the next tick —
/// the click and the effect belong in the same moment — and clearing one lets
/// it go again, unless the window is what is holding it.
#[tauri::command]
fn set_download_start(
    aria2: tauri::State<Aria2>,
    settings: tauri::State<SettingsState>,
    schedule: tauri::State<schedule::Schedule>,
    gid: String,
    at: Option<i64>,
) -> Result<schedule::ScheduleState, String> {
    let now = schedule::epoch_now();
    let pending = at.filter(|at| *at > now);
    schedule.set_start(&gid, pending);

    let secret = aria2.secret();
    match pending {
        Some(_) => {
            // forcePause takes a `waiting` download as readily as an `active`
            // one, and both land on `paused` — which is why a queued row and a
            // running one need no separate handling here.
            if aria2_request(
                aria2.port,
                &secret,
                "aria2.forcePause",
                serde_json::json!([gid]),
            )
            .is_ok()
            {
                schedule.hold(&gid);
            }
        }
        None => {
            if window_open(&settings) {
                let _ = aria2_request(
                    aria2.port,
                    &secret,
                    "aria2.unpause",
                    serde_json::json!([gid]),
                );
                schedule.release(&gid);
            }
        }
    }

    Ok(schedule_state(settings, schedule))
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
    // Checked before normalising, which drops a jar that isn't there: a path
    // that was typed rather than chosen can be wrong, and silently having no
    // cookies looks exactly like the login not working.
    let jar = settings.cookie_file.trim();
    if !jar.is_empty() && !Path::new(jar).is_file() {
        return Err(format!("No cookie file at {jar}"));
    }

    let settings = settings.normalised();

    // Read before anything is written: these are the two settings aria2 will
    // not take while it is running, so a change to either is a restart.
    // `rpc-listen-all` sent to changeGlobalOption answers OK, leaves the
    // socket bound exactly as it was, and getGlobalOption still reports the
    // old value — measured against aria2 1.37, and the same trap the cookie
    // jar sprang.
    let (jar_changed, remote_changed) = state
        .current
        .lock()
        .map(|current| {
            (
                current.cookie_file != settings.cookie_file,
                current.remote_control != settings.remote_control,
            )
        })
        .unwrap_or((false, false));

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
            remote_secret(&aria2.remote_secret)
        } else {
            let _ = fs::remove_file(&aria2.remote_secret);
            random_secret()
        }
    });

    if jar_changed || remote_changed {
        restart_aria2(&aria2, &settings, next_secret).map_err(|e| {
            format!("The settings are saved, but {e}. Unfinished downloads are in the session file.")
        })?;
    }

    Ok(settings)
}

/// ── Downloads behind a login ─────────────────────────────────────────────
/// The store is garia's; the netrc is aria2's copy of the part it can use. The
/// frontend is told about neither file — it gets a list with no passwords in
/// it, and the headers to put on a download for a given host.
#[tauri::command]
fn get_logins(state: tauri::State<LoginsState>) -> Vec<logins::LoginView> {
    state
        .current
        .lock()
        .map(|current| logins::views(&current))
        .unwrap_or_default()
}

/// Add a site or change one. A `None` password is "leave the one that's
/// there" — the dialog can say a site has a password without ever being sent
/// it, so it has to be able to save the rest without asking for it again.
#[tauri::command]
fn save_login(
    aria2: tauri::State<Aria2>,
    settings: tauri::State<SettingsState>,
    state: tauri::State<LoginsState>,
    host: String,
    username: String,
    password: Option<String>,
    headers: Vec<String>,
) -> Result<Vec<logins::LoginView>, String> {
    let host = logins::host_of(&host);
    if host.is_empty() {
        return Err("Which site is this for? Paste a URL or type a host name.".to_string());
    }
    let headers = logins::tidy_headers(&headers)?;
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

    // Clearing the user name is how a password is taken back off a site: a
    // netrc line is a pair, so half of one is not a credential to keep.
    let password = if username.is_empty() {
        String::new()
    } else {
        password.unwrap_or(kept)
    };

    let entry = logins::Login { host: host.clone(), username, password, headers };
    match current.iter_mut().find(|l| l.host == host) {
        Some(existing) => *existing = entry,
        None => current.push(entry),
    }
    current.sort_by(|a, b| a.host.cmp(&b.host));

    commit(&aria2, &settings, &state, current)
}

#[tauri::command]
fn delete_login(
    aria2: tauri::State<Aria2>,
    settings: tauri::State<SettingsState>,
    state: tauri::State<LoginsState>,
    host: String,
) -> Result<Vec<logins::LoginView>, String> {
    let host = logins::host_of(&host);
    let mut current = state
        .current
        .lock()
        .map_err(|_| "the login list is in an unknown state".to_string())?
        .clone();
    current.retain(|l| l.host != host);
    commit(&aria2, &settings, &state, current)
}

/// Write both files, and restart aria2 only if the one *it* reads changed —
/// editing a header is a change to what garia sends, which needs no restart at
/// all, and paying for one anyway would make every edit cost a reconnect.
fn commit(
    aria2: &Aria2,
    settings: &SettingsState,
    state: &LoginsState,
    next: Vec<logins::Login>,
) -> Result<Vec<logins::LoginView>, String> {
    logins::write(&state.file, &next)
        .map_err(|e| format!("could not write {}: {e}", state.file.display()))?;

    let before = fs::read(&state.netrc).ok();
    logins::write_netrc(&state.netrc, &next)
        .map_err(|e| format!("could not write {}: {e}", state.netrc.display()))?;
    let after = fs::read(&state.netrc).ok();

    let views = logins::views(&next);
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

/// The number next to the menu-bar extra. Zero clears it, the same way a
/// dock badge of zero would otherwise sit there as a literal "0".
#[tauri::command]
fn set_status_item(app: tauri::AppHandle, active: u32) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("status") else {
        return Ok(());
    };
    let title = if active == 0 {
        None
    } else {
        Some(active.to_string())
    };
    #[cfg(target_os = "macos")]
    tray.set_title(title.as_deref())
        .map_err(|e| format!("could not set the menu-bar title: {e}"))?;
    #[cfg(not(target_os = "macos"))]
    let _ = title;
    let tip = if active == 0 {
        "Garia".to_string()
    } else if active == 1 {
        "Garia — 1 downloading".to_string()
    } else {
        format!("Garia — {active} downloading")
    };
    tray.set_tooltip(Some(&tip))
        .map_err(|e| format!("could not set the menu-bar tooltip: {e}"))
}

/// A finished file leaves the window the way it leaves Finder: the row is a
/// handle, and the drop is a real file, not a URL the other app has to guess.
#[tauri::command]
fn start_file_drag(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    let files: Vec<PathBuf> = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect();
    if files.is_empty() {
        return Err("nothing on disk to drag".into());
    }

    #[cfg(target_os = "linux")]
    {
        let _ = (window, files);
        return Err("drag-out is only wired on macOS".into());
    }

    #[cfg(not(target_os = "linux"))]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = drag::start_drag(
                    &win,
                    drag::DragItem::Files(files),
                    drag::Image::Raw(include_bytes!("../icons/32x32.png").to_vec()),
                    |_, _| {},
                    drag::Options::default(),
                );
            })
            .map_err(|e| format!("could not start the drag: {e}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    notes: String,
    current_version: String,
}

/// What GitHub last published, if it is newer than this build. None is
/// "you already have it" — a missing latest.json is an error, not that.
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            version: update.version,
            notes: update.body.unwrap_or_default(),
            current_version: app.package_info().version.to_string(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Download the update that check_for_update found and relaunch into it.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update available".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
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

/// `.torrent` files the system opened before the list was listening — Finder
/// double-click, Open With, File → Open. Same shape as the URL catch queue.
struct TorrentQueue {
    pending: Mutex<Vec<String>>,
}

#[tauri::command]
fn take_pending_torrents(state: tauri::State<TorrentQueue>) -> Vec<String> {
    state
        .pending
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

/// The torrent bytes as aria2 wants them. The frontend already knows how to
/// add one (folder, seed rules, in-order); this is just the file, checked so
/// a path that is not a torrent never becomes an RPC payload.
#[tauri::command]
fn read_torrent(path: String) -> Result<String, String> {
    let path = PathBuf::from(&path);
    if !catch::is_torrent(&path) {
        return Err("that isn't a .torrent file".into());
    }
    let bytes = fs::read(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    Ok(encode_base64(&bytes))
}

/// Launch at login lives in a LaunchAgent, not in settings.json: the OS is
/// the source of truth, and System Settings can turn it off without us.
#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|e| e.to_string())
}

fn encode_base64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (a << 16) | (b << 8) | c;
        out.push(T[(n >> 18) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn bring_to_front(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn dispatch_torrent(app: &tauri::AppHandle, path: PathBuf) {
    let event = path.display().to_string();
    if let Some(queue) = app.try_state::<TorrentQueue>() {
        if let Ok(mut pending) = queue.pending.lock() {
            pending.push(event.clone());
            let overflow = pending.len().saturating_sub(MAX_PENDING_CATCHES);
            pending.drain(..overflow);
        }
    }
    let _ = app.emit("open-torrent", &event);
    bring_to_front(app);
}

/// Files and magnets the system handed us — Finder, a browser, Open With.
/// `garia://` stays with the deep-link plugin so it is not queued twice.
fn ingest_opened(app: &tauri::AppHandle, raw: &str) {
    if let Some(path) = catch::torrent_path(raw) {
        dispatch_torrent(app, path);
    } else if let Some(url) = catch::magnet_url(raw) {
        dispatch_catch(app, url, "scheme");
    }
}

pub(crate) fn dispatch_catch(app: &tauri::AppHandle, url: String, source: &str) {
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


/// ── The scheduler's tick ─────────────────────────────────────────────────
/// Reconciles what aria2 is doing against what the clock allows. It runs from
/// the moment the app starts, before the webview has painted, because that is
/// the case the frontend cannot cover: aria2 reads its session file and starts
/// every unfinished download in it within milliseconds of launch, so a window
/// that is shut has to be shut by something that is already awake.
///
/// The first pass happens immediately rather than after a tick's wait, which is
/// also what makes a launch *into* an open window start downloading at once —
/// the window is reconciled against the wall clock, not waited for.
fn spawn_schedule_watch(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        schedule_tick(&app);
        std::thread::sleep(schedule::TICK);
    });
}

fn schedule_tick(app: &tauri::AppHandle) {
    let (Some(aria2), Some(settings), Some(sched)) = (
        app.try_state::<Aria2>(),
        app.try_state::<SettingsState>(),
        app.try_state::<schedule::Schedule>(),
    ) else {
        return;
    };

    let saved = sched.snapshot();
    let enabled = settings
        .current
        .lock()
        .map(|s| s.schedule_enabled)
        .unwrap_or(false);
    // Nothing to enforce and nothing outstanding: the common case, and it must
    // cost nothing. A schedule turned off while rows are still held is not that
    // case — those have to be let go rather than left stopped forever.
    if !enabled && saved.held.is_empty() && saved.starts.is_empty() {
        return;
    }

    let open = window_open(&settings);
    let now = schedule::epoch_now();
    let secret = aria2.secret();
    let ask = |method: &str, params: serde_json::Value| {
        aria2_request(aria2.port, &secret, method, params).ok()
    };

    // `seeder` because a finished torrent is `active` to aria2 for as long as
    // it is uploading, and the window is about downloading. Stopping a seed is
    // a removal everywhere else in garia — a clock must not quietly make it a
    // pause instead.
    let keys = serde_json::json!(["gid", "status", "seeder"]);
    let mut rows: Vec<schedule::Row> = Vec::new();
    let mut known: std::collections::BTreeSet<String> = Default::default();

    for (method, params) in [
        ("aria2.tellActive", serde_json::json!([keys])),
        ("aria2.tellWaiting", serde_json::json!([0, 500, keys])),
        ("aria2.tellStopped", serde_json::json!([0, 500, keys])),
    ] {
        let Some(answer) = ask(method, params) else {
            // aria2 unreachable — say nothing and change nothing. Acting on a
            // half-read picture is how a scheduler loses downloads.
            return;
        };
        let Some(list) = answer.get("result").and_then(|r| r.as_array()) else {
            return;
        };
        for item in list {
            let gid = item.get("gid").and_then(|g| g.as_str()).unwrap_or_default();
            let status = item
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or_default();
            if gid.is_empty() {
                continue;
            }
            let seeding = item.get("seeder").and_then(|s| s.as_str()) == Some("true");
            known.insert(gid.to_string());
            // Only the two lists a download can be pulled out of or put back
            // into are worth deciding about; `tellStopped` is read to know
            // which gids still exist at all.
            if method != "aria2.tellStopped" && !seeding {
                rows.push(schedule::Row {
                    gid: gid.to_string(),
                    status: status.to_string(),
                });
            }
        }
    }

    let mut overridden = sched.overridden();
    let mut hold: Vec<String> = Vec::new();
    let mut unhold: Vec<String> = Vec::new();
    // Start times that have come round. Dropped whether the row ran on them or
    // was already going, so a retry of the same gid is not held a second time
    // for an hour that has already passed.
    let mut spent: Vec<String> = Vec::new();

    for row in &rows {
        let allowed = !enabled || schedule::allowed(&row.gid, open, &saved.starts, now);
        if allowed && saved.starts.get(&row.gid).is_some_and(|at| now >= *at) {
            spent.push(row.gid.clone());
        }

        match schedule::decide(
            row,
            allowed,
            saved.held.contains(&row.gid),
            overridden.contains(&row.gid),
        ) {
            schedule::Act::Hold => {
                if ask("aria2.forcePause", serde_json::json!([row.gid])).is_some() {
                    hold.push(row.gid.clone());
                }
            }
            schedule::Act::Release => {
                if ask("aria2.unpause", serde_json::json!([row.gid])).is_some() {
                    unhold.push(row.gid.clone());
                }
            }
            // Somebody pressed Resume inside a shut window. That is an answer,
            // so the row stops being ours: we neither pause it again nor count
            // ourselves responsible for restarting it later.
            schedule::Act::Overridden => {
                overridden.insert(row.gid.clone());
                unhold.push(row.gid.clone());
            }
            schedule::Act::Leave => {}
        }
    }

    // An override answers one shut window rather than every future one, so the
    // window opening clears them all.
    if open {
        overridden.clear();
    } else {
        overridden.retain(|gid| known.contains(gid));
    }
    sched.set_overridden(overridden);
    sched.reconcile(&hold, &unhold, &spent, &known);
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

/// How many of a playlist's entries the picker will take. A channel can hold
/// thousands, and neither the JSON nor a list of thousands of checkboxes is
/// something to hand a dialog — the cap is said out loud rather than hidden.
const MAX_PLAYLIST_ENTRIES: usize = 300;

/// One video inside a playlist, as `--flat-playlist` reports it: enough to
/// list, and enough to probe when it is ticked. There are deliberately no
/// formats here — collecting them is what turns a playlist into minutes.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PlaylistEntry {
    id: String,
    title: String,
    /// The page URL to probe if this entry is picked.
    url: String,
    /// Seconds, and often absent in a flat listing.
    duration: f64,
    uploader: String,
    thumbnail: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PlaylistInfo {
    title: String,
    uploader: String,
    webpage_url: String,
    extractor: String,
    /// What the site says is in it, which can be more than `entries` holds:
    /// only the first `MAX_PLAYLIST_ENTRIES` are taken.
    total: u64,
    entries: Vec<PlaylistEntry>,
}

/// What a pasted page turned out to be. Both answers come from one yt-dlp
/// launch, which is why the probe asks rather than guessing from the URL:
/// `--no-playlist` still returns the single video for a watch link that
/// happens to carry a list, and `--flat-playlist` keeps a 200-video channel
/// from costing 200 extractions before the dialog says anything at all.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Probe {
    Video(VideoInfo),
    Playlist(PlaylistInfo),
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

/// The first of several keys that is actually filled in. Extractors disagree
/// about which one carries the name — `uploader` on one site, `channel` on the
/// next — and an empty string is the same as a missing key here.
fn as_str_any(v: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        let found = as_str(v, key);
        if !found.is_empty() {
            return found;
        }
    }
    String::new()
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
fn video_probe(video: tauri::State<Video>, url: String) -> Result<Probe, String> {
    let Some(cmd) = resolve_ytdlp(&video) else {
        return Err("no-ytdlp".to_string());
    };

    let mut args: Vec<String> = cmd[1..].to_vec();
    args.extend([
        "-J".to_string(),
        // Still a preference for the single video: a watch link that carries
        // a list is the video someone was watching, not the list.
        "--no-playlist".to_string(),
        // And when the URL really is a playlist, stop at the listing. The
        // formats come later, one probe per entry that gets ticked — a
        // playlist's entries do not all offer the same qualities, so there is
        // no one answer to collect here anyway.
        "--flat-playlist".to_string(),
        "--playlist-end".to_string(),
        MAX_PLAYLIST_ENTRIES.to_string(),
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

    trim_probe(&root)
}

/// A thumbnail, wherever the extractor put it. A flat entry carries a
/// `thumbnails` list and no `thumbnail`, and the list runs worst-first — which
/// is the end to take for something rendered at 96 pixels wide.
fn thumbnail_of(v: &serde_json::Value) -> String {
    let direct = as_str(v, "thumbnail");
    if !direct.is_empty() {
        return direct;
    }
    v.get("thumbnails")
        .and_then(|t| t.as_array())
        .and_then(|t| t.first())
        .map(|t| as_str(t, "url"))
        .unwrap_or_default()
}

/// Which of the two a page is. Splitting here rather than inside `trim_info`
/// keeps the single-video parser honest: it is only ever handed a video.
fn trim_probe(root: &serde_json::Value) -> Result<Probe, String> {
    if root.get("_type").and_then(|t| t.as_str()) == Some("playlist") {
        trim_playlist(root).map(Probe::Playlist)
    } else {
        trim_info(root).map(Probe::Video)
    }
}

/// A playlist as the picker needs it: a line per entry, and the page URL to
/// come back to for each one.
fn trim_playlist(root: &serde_json::Value) -> Result<PlaylistInfo, String> {
    let empty = Vec::new();
    let raw = root
        .get("entries")
        .and_then(|e| e.as_array())
        .unwrap_or(&empty);

    let mut entries: Vec<PlaylistEntry> = Vec::new();
    let mut nested = 0usize;
    for e in raw {
        // A channel's front page is a playlist of playlists — its tabs. There
        // is nothing to download in one of those, and walking into them is a
        // different feature from listing videos.
        if e.get("_type").and_then(|t| t.as_str()) == Some("playlist") {
            nested += 1;
            continue;
        }
        let url = as_str_any(e, &["url", "webpage_url"]);
        if url.is_empty() {
            continue;
        }
        entries.push(PlaylistEntry {
            id: as_str(e, "id"),
            title: as_str(e, "title"),
            url,
            duration: as_num(e, "duration"),
            uploader: as_str_any(e, &["uploader", "channel", "creator"]),
            thumbnail: thumbnail_of(e),
        });
        if entries.len() == MAX_PLAYLIST_ENTRIES {
            break;
        }
    }

    if entries.is_empty() {
        return Err(if nested > 0 {
            "that page lists playlists rather than videos — open the one you want and paste that"
                .to_string()
        } else {
            "that playlist has nothing in it".to_string()
        });
    }

    // The site's own count when it gives one, so a capped listing can say what
    // it is missing. A count smaller than what arrived is not a count.
    let total = root
        .get("playlist_count")
        .and_then(|c| c.as_u64())
        .filter(|c| *c as usize >= entries.len())
        .unwrap_or(entries.len() as u64);

    Ok(PlaylistInfo {
        title: as_str(root, "title"),
        uploader: as_str_any(root, &["uploader", "channel", "creator"]),
        webpage_url: as_str(root, "webpage_url"),
        extractor: as_str(root, "extractor_key"),
        total,
        entries,
    })
}

/// Everything yt-dlp's 150 KB of JSON becomes: a handful of streams aria2 can
/// actually fetch, in the order the picker lists them.
fn trim_info(info: &serde_json::Value) -> Result<VideoInfo, String> {
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
        title: as_str(info, "title"),
        uploader: as_str_any(info, &["uploader", "channel", "creator"]),
        duration: as_num(info, "duration"),
        thumbnail: thumbnail_of(info),
        webpage_url: as_str(info, "webpage_url"),
        extractor: as_str(info, "extractor_key"),
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
fn aria2_args(
    port: u16,
    secret: &str,
    session_file: &Path,
    netrc_file: &Path,
    settings: &Settings,
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
    args
}

fn spawn_aria2(
    port: u16,
    secret: &str,
    session_file: &Path,
    netrc_file: &Path,
    settings: &Settings,
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
fn restart_aria2(
    aria2: &Aria2,
    settings: &Settings,
    next_secret: Option<String>,
) -> Result<(), String> {
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
        if TcpListener::bind(("127.0.0.1", DEFAULT_RPC_PORT)).is_ok() {
            return DEFAULT_RPC_PORT;
        }
        // A just-reaped aria2c can hold the port a moment longer.
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(DEFAULT_RPC_PORT)
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
        // Size and place, not visibility: hide-on-close would otherwise come
        // back as a launch with no window.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            aria2_rpc,
            aria2_endpoint,
            trash_files,
            get_settings,
            save_settings,
            get_logins,
            save_login,
            delete_login,
            set_badge,
            take_pending_catch,
            take_pending_torrents,
            read_torrent,
            copy_text,
            video_tools,
            video_probe,
            mux_video,
            preview_state,
            preview_file,
            remote_info,
            schedule_state,
            set_download_start,
            autostart_enabled,
            set_autostart,
            start_file_drag,
            check_for_update,
            install_update,
            set_status_item
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

            let logins_file = dir.join("logins.json");
            let netrc_file = dir.join("netrc");
            let saved_logins = logins::read(&logins_file);
            // The netrc is derived, so it is rebuilt at every launch rather
            // than trusted: a store edited by hand, or one written by a build
            // that stored passwords differently, still ends up with an aria2
            // that reads exactly what garia holds.
            if let Err(e) = logins::write_netrc(&netrc_file, &saved_logins) {
                eprintln!("[garia] Could not write {}: {e}", netrc_file.display());
            }

            // A launch with remote control already on picks up the token the
            // devices were paired against; every other launch gets one that
            // has never been written down.
            let remote_secret_file = dir.join("remote-secret");
            let secret = if settings.remote_control {
                remote_secret(&remote_secret_file)
            } else {
                let _ = fs::remove_file(&remote_secret_file);
                random_secret()
            };
            let session = session_path(&dir);
            let port = pick_port();
            let child = spawn_aria2(port, &secret, &session, &netrc_file, &settings);

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
                secret: Mutex::new(secret),
                port,
                pid_file,
                session,
                netrc: netrc_file.clone(),
                remote_secret: remote_secret_file,
            });
            app.manage(SettingsState {
                file: settings_file,
                current: Mutex::new(settings),
            });
            app.manage(LoginsState {
                file: logins_file,
                netrc: netrc_file,
                current: Mutex::new(saved_logins),
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
            app.manage(TorrentQueue {
                pending: Mutex::new(Vec::new()),
            });
            app.manage(schedule::Schedule::new(schedule::state_file(&dir)));
            app.manage(OwnCopy::default());

            // `garia://add?url=…` from a bookmarklet, and `magnet:` from the
            // browser or Finder. macOS delivers these to the running instance;
            // a cold launch is `get_current` below. `.torrent` files arrive
            // as `RunEvent::Opened`, not through this plugin.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for link in event.urls() {
                        ingest_deep_link(&handle, link.as_str());
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let handle = app.handle().clone();
                    for link in urls {
                        ingest_deep_link(&handle, link.as_str());
                    }
                }
            }

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
            }
            if let Err(e) = install_menu(app) {
                eprintln!("[garia] Could not install the menu: {e}");
            }
            if let Err(e) = install_status_item(app) {
                eprintln!("[garia] Could not install the menu-bar extra: {e}");
            }
            #[cfg(target_os = "macos")]
            if let Err(e) = service::install(app.handle().clone()) {
                eprintln!("[garia] Could not install Services: {e}");
            }
            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "settings" | "new-download" | "open-torrent" | "find"
                    | "pause-all" | "resume-all" | "open-folder"
                    | "check-updates" | "licenses" | "help" => {
                        bring_to_front(app);
                        let _ = app.emit("menu", event.id().as_ref());
                    }
                    _ => {}
                }
            });

            spawn_clipboard_watch(app.handle().clone());
            // Started last and running from this moment: aria2 was spawned a
            // few lines up and is already working through the session file.
            // Closing the window no longer stops it — only Quit does — so a
            // schedule that opens at 2am has a process to talk to.
            spawn_schedule_watch(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // The red button and ⌘W hide the window. Downloads keep going;
            // the dock icon is how you come back. ⌘Q is the one that exits.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::Exit => {
                    if let Some(state) = app.try_state::<Aria2>() {
                        // kill() is a SIGKILL, so aria2 never gets to write the
                        // session itself — ask it to before pulling the plug.
                        if let Err(e) = aria2_request(
                            state.port,
                            &state.secret(),
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
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => bring_to_front(app),
                #[cfg(any(target_os = "macos", target_os = "ios"))]
                tauri::RunEvent::Opened { urls } => {
                    for url in urls {
                        ingest_opened(app, url.as_str());
                    }
                }
                _ => {}
            }
        });
}

fn ingest_deep_link(app: &tauri::AppHandle, link: &str) {
    if let Some(url) = catch::url_from_garia_link(link) {
        dispatch_catch(app, url, "scheme");
    } else if let Some(url) = catch::magnet_url(link) {
        dispatch_catch(app, url, "scheme");
    }
}

/// The menu a Mac app is expected to have: the app name, File, Edit, Window,
/// and the shortcuts that belong on them. Replacing Tauri's default is what
/// makes Settings land on ⌘, and New Download on ⌘N rather than nowhere.
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let new_download = MenuItemBuilder::with_id("new-download", "New Download")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open_torrent = MenuItemBuilder::with_id("open-torrent", "Open Torrent…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("open-folder", "Open Download Folder")
        .build(app)?;
    let find = MenuItemBuilder::with_id("find", "Find")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let pause_all = MenuItemBuilder::with_id("pause-all", "Pause All").build(app)?;
    let resume_all = MenuItemBuilder::with_id("resume-all", "Resume All").build(app)?;

    let check_updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…")
        .build(app)?;
    let garia_help = MenuItemBuilder::with_id("help", "Garia Help")
        .accelerator("CmdOrCtrl+?")
        .build(app)?;
    let licenses = MenuItemBuilder::with_id("licenses", "Licenses…").build(app)?;

    let about = AboutMetadata {
        name: Some("Garia".into()),
        version: Some(app.package_info().version.to_string()),
        copyright: Some("A download manager.".into()),
        website: Some("https://github.com/fabimc/garia".into()),
        website_label: Some("Source and issue tracker".into()),
        credits: Some(
            "Downloads run on a bundled aria2 (GPL-2.0-or-later).\n\
             Video pages are read by yt-dlp (Unlicense).\n\
             Video merges use ffmpeg, licensed under LGPL-2.1 — \
             muxers only, no GPL parts.\n\
             The window is Tauri (MIT or Apache-2.0).\n\
             Help → Licenses lists where the source is."
                .into(),
        ),
        icon: app.default_window_icon().cloned(),
        ..Default::default()
    };

    let app_menu = SubmenuBuilder::new(app, "Garia")
        .about(Some(about))
        .item(&check_updates)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_download)
        .item(&open_torrent)
        .separator()
        .item(&open_folder)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .build()?;

    let download_menu = SubmenuBuilder::new(app, "Download")
        .item(&pause_all)
        .item(&resume_all)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .close_window()
        .build()?;

    let help_menu = SubmenuBuilder::with_id(app, tauri::menu::HELP_SUBMENU_ID, "Help")
        .item(&garia_help)
        .separator()
        .item(&licenses)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&download_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    help_menu.set_as_help_menu_for_nsapp()?;
    Ok(())
}

/// A face while the window is hidden: click the extra for New Download,
/// Pause All, and Show Garia. The dock icon is still how you come back
/// without thinking; this is for the moment you do not want the list.
fn install_status_item(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let new_download = MenuItemBuilder::with_id("new-download", "New Download").build(app)?;
    let pause_all = MenuItemBuilder::with_id("pause-all", "Pause All").build(app)?;
    let resume_all = MenuItemBuilder::with_id("resume-all", "Resume All").build(app)?;
    let open_folder = MenuItemBuilder::with_id("open-folder", "Open Download Folder").build(app)?;
    let show = MenuItemBuilder::with_id("show-window", "Show Garia").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&new_download)
        .separator()
        .item(&pause_all)
        .item(&resume_all)
        .separator()
        .item(&open_folder)
        .separator()
        .item(&show)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("status")
        .menu(&menu)
        .tooltip("Garia")
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-window" => bring_to_front(app),
            id @ ("new-download" | "pause-all" | "resume-all" | "open-folder") => {
                bring_to_front(app);
                let _ = app.emit("menu", id);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
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

    #[test]
    fn torrent_bytes_are_what_aria2_expects() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"Man"), "TWFu");
        assert_eq!(encode_base64(b"Ma"), "TWE=");
        assert_eq!(encode_base64(b"M"), "TQ==");
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

    /// A window has to have a width. Read as "always" a zero-length one is the
    /// setting being off; read as "never" it is a download manager that never
    /// downloads — so it is stored as off rather than as either reading.
    #[test]
    fn a_window_with_no_width_is_not_stored_as_a_window() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","scheduleEnabled":true,
                "scheduleStart":480,"scheduleEnd":480}"#,
        );
        assert!(!s.schedule_enabled);

        let s = settings_from(
            r#"{"downloadDir":"/tmp","scheduleEnabled":true,
                "scheduleStart":1320,"scheduleEnd":360}"#,
        );
        assert!(s.schedule_enabled);
        // An overnight window is stored exactly as typed; wrapping midnight is
        // the reader's job, not the writer's.
        assert_eq!((s.schedule_start, s.schedule_end), (1320, 360));
    }

    /// Minutes past the end of a day come from a hand-edited file, and a
    /// window nobody can reach is worse than one that has moved.
    #[test]
    fn a_time_of_day_past_midnight_wraps_into_one() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","scheduleEnabled":true,
                "scheduleStart":1500,"scheduleEnd":480}"#,
        );
        assert_eq!(s.schedule_start, 60);
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
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &settings);
        assert!(!args.iter().any(|a| a.starts_with("--seed-time")));
        assert!(args.iter().any(|a| a == "--seed-ratio=1"));

        let settings = settings_from(r#"{"downloadDir":"/tmp","seedTimeMinutes":90}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &settings);
        assert!(args.iter().any(|a| a == "--seed-time=90"));
    }

    /// The one flag that decides whether the RPC port is this machine's or the
    /// network's. It is always written out, off as well as on: aria2's own
    /// default is false, but a line that says so is a line nobody has to go
    /// and check.
    #[test]
    fn the_socket_is_loopback_unless_remote_control_says_otherwise() {
        let off = settings_from(r#"{"downloadDir":"/tmp"}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &off);
        assert!(args.iter().any(|a| a == "--rpc-listen-all=false"));

        let on = settings_from(r#"{"downloadDir":"/tmp","remoteControl":true}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &on);
        assert!(args.iter().any(|a| a == "--rpc-listen-all=true"));
    }

    /// A settings file from before remote control existed must not read as a
    /// machine that has opted into it.
    #[test]
    fn a_settings_file_without_the_field_keeps_the_port_closed() {
        let s = settings_from(r#"{"downloadDir":"/tmp","catchClipboard":true}"#);
        assert!(!s.remote_control);
    }

    /// The token survives a relaunch — a pairing that had to be redone every
    /// morning is not a pairing — and anything that isn't one is replaced
    /// rather than handed to aria2, which would take it and leave every
    /// paired device quietly locked out.
    #[test]
    fn the_remote_token_persists_but_only_while_it_is_a_token() {
        let dir = std::env::temp_dir().join("garia-remote-test");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("remote-secret");
        let _ = fs::remove_file(&file);

        let first = remote_secret(&file);
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(remote_secret(&file), first, "a second launch re-pairs nothing");

        fs::write(&file, "not a token").unwrap();
        assert_ne!(remote_secret(&file), "not a token");
        assert_eq!(remote_secret(&file).len(), 32);

        // 0600, the way the logins file is: a token every account on the
        // machine can read is not one.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = fs::remove_file(&file);
    }

    /// Asking the routing table for the source address it would use, rather
    /// than walking the interface list. The assertion has to hold on a laptop
    /// with no network too, which is the case the panel has its own sentence
    /// for: no address is an answer, a loopback one would be a wrong answer.
    #[test]
    fn the_address_offered_is_one_another_device_could_reach() {
        match local_ip() {
            None => {}
            Some(ip) => {
                let parsed: std::net::IpAddr = ip.parse().expect("not an address");
                assert!(!parsed.is_loopback());
                assert!(!parsed.is_unspecified());
            }
        }
    }

    /// The pairing QR carries the secret and nothing else, so it is always the
    /// same 32 characters and therefore always the same size: 29 modules a
    /// side, which is version 3 at error-correction level M. Version 2 stops
    /// at 26 bytes of the byte mode a lowercase hex token has to use.
    #[test]
    fn the_pairing_qr_is_a_square_of_modules() {
        let (width, modules) = qr_of(&random_secret());
        assert_eq!(width, 29);
        assert_eq!(modules.len(), width * width);
        // A finder pattern sits in each of three corners, so the top-left
        // module is dark in every QR ever made.
        assert!(modules[0]);
    }

    /// Both credentials aria2 will only take at launch. The netrc is named
    /// only when there is one — otherwise garia would be quietly overriding
    /// the user's own ~/.netrc with a file that isn't there.
    #[test]
    fn credentials_are_named_only_when_they_exist() {
        let dir = std::env::temp_dir().join("garia-netrc-test");
        let _ = fs::create_dir_all(&dir);
        let netrc = dir.join("netrc");
        let _ = fs::remove_file(&netrc);

        let settings = settings_from(r#"{"downloadDir":"/tmp"}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), &netrc, &settings);
        assert!(!args.iter().any(|a| a.starts_with("--netrc-path")));
        assert!(!args.iter().any(|a| a.starts_with("--load-cookies")));

        fs::write(&netrc, "machine example.com\n").unwrap();
        let jar = dir.join("cookies.txt");
        fs::write(&jar, "# Netscape HTTP Cookie File\n").unwrap();
        let settings = settings_from(&format!(
            r#"{{"downloadDir":"/tmp","cookieFile":"{}"}}"#,
            jar.display()
        ));
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), &netrc, &settings);
        assert!(args
            .iter()
            .any(|a| a == &format!("--netrc-path={}", netrc.display())));
        assert!(args
            .iter()
            .any(|a| a == &format!("--load-cookies={}", jar.display())));

        // A jar that has been moved or deleted is no jar at all.
        let settings = settings_from(r#"{"downloadDir":"/tmp","cookieFile":"/nope/gone.txt"}"#);
        assert_eq!(settings.cookie_file, "");
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

    fn playlist_of(entries: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "_type": "playlist",
            "title": "Physics lectures",
            "channel": "Physicsworks",
            "webpage_url": "https://example.com/list",
            "extractor_key": "Example",
            "entries": entries,
        })
    }

    fn as_playlist(root: &serde_json::Value) -> PlaylistInfo {
        match trim_probe(root).unwrap() {
            Probe::Playlist(list) => list,
            Probe::Video(v) => panic!("a playlist came back as the video {:?}", v.title),
        }
    }

    /// The whole point of the change: a playlist URL used to answer with its
    /// first video, which is a wrong answer rather than a missing feature.
    #[test]
    fn a_playlist_page_is_a_list_not_its_first_video() {
        let root = playlist_of(serde_json::json!([
            { "id": "a", "title": "One",   "url": "https://example.com/a", "duration": 61 },
            { "id": "b", "title": "Two",   "url": "https://example.com/b" },
            { "id": "c", "title": "Three", "url": "https://example.com/c" },
        ]));
        let list = as_playlist(&root);
        assert_eq!(list.total, 3);
        // The order is the playlist's, because that is the order they queue in.
        assert_eq!(
            list.entries.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(),
            ["One", "Two", "Three"]
        );
        assert_eq!(list.entries[0].url, "https://example.com/a");
        assert_eq!(list.entries[0].duration, 61.0);
        // `channel` where another site would have said `uploader`.
        assert_eq!(list.uploader, "Physicsworks");
    }

    /// `--no-playlist` still wins for a watch link that carries a list, so the
    /// single-video path has to survive the flat listing being asked for.
    #[test]
    fn a_single_video_is_still_a_video() {
        let root: serde_json::Value = serde_json::from_str(COMMONS).unwrap();
        match trim_probe(&root).unwrap() {
            Probe::Video(v) => {
                assert_eq!(v.title, "Physicsworks");
                assert_eq!(v.formats.len(), 4);
            }
            Probe::Playlist(_) => panic!("a video came back as a playlist"),
        }
    }

    #[test]
    fn an_empty_playlist_is_an_error_not_an_empty_picker() {
        let root = playlist_of(serde_json::json!([]));
        assert!(trim_probe(&root).is_err());
    }

    /// A channel's front page lists its tabs, which are playlists. Ticking one
    /// would download nothing, so it says which page to paste instead.
    #[test]
    fn a_page_of_playlists_says_so() {
        let root = playlist_of(serde_json::json!([
            { "_type": "playlist", "id": "videos", "title": "Videos", "url": "https://example.com/v" },
            { "_type": "playlist", "id": "shorts", "title": "Shorts", "url": "https://example.com/s" },
        ]));
        let err = trim_probe(&root).unwrap_err();
        assert!(err.contains("lists playlists"), "unhelpful: {err}");
    }

    /// An entry with nowhere to go can't be probed and can't be queued.
    #[test]
    fn an_entry_with_no_url_is_dropped() {
        let root = playlist_of(serde_json::json!([
            { "id": "a", "title": "One" },
            { "id": "b", "title": "Two", "webpage_url": "https://example.com/b" },
        ]));
        let list = as_playlist(&root);
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].url, "https://example.com/b");
    }

    /// A channel holds more than a dialog can show. The cap is a cap, and the
    /// count it came from is kept so the picker can say what it left behind.
    #[test]
    fn a_long_channel_is_capped_and_says_so() {
        let entries: Vec<serde_json::Value> = (0..MAX_PLAYLIST_ENTRIES + 120)
            .map(|i| serde_json::json!({ "id": i.to_string(), "url": format!("https://example.com/{i}") }))
            .collect();
        let mut root = playlist_of(serde_json::Value::Array(entries));
        root["playlist_count"] = serde_json::json!(1240);
        let list = as_playlist(&root);
        assert_eq!(list.entries.len(), MAX_PLAYLIST_ENTRIES);
        assert_eq!(list.total, 1240);
    }

    /// A count the site got wrong must not read as "there are more" — the
    /// picker would promise entries nothing can produce.
    #[test]
    fn a_count_smaller_than_the_listing_is_not_a_count() {
        let mut root = playlist_of(serde_json::json!([
            { "id": "a", "url": "https://example.com/a" },
            { "id": "b", "url": "https://example.com/b" },
        ]));
        root["playlist_count"] = serde_json::json!(1);
        assert_eq!(as_playlist(&root).total, 2);
    }

    /// Flat entries carry a `thumbnails` list and no `thumbnail`, worst first
    /// — which is the end worth taking for a 96-pixel row.
    #[test]
    fn a_flat_entry_takes_its_smallest_thumbnail() {
        let root = playlist_of(serde_json::json!([{
            "id": "a",
            "url": "https://example.com/a",
            "thumbnails": [
                { "url": "https://example.com/small.jpg", "height": 90 },
                { "url": "https://example.com/huge.jpg",  "height": 1080 },
            ],
        }]));
        assert_eq!(as_playlist(&root).entries[0].thumbnail, "https://example.com/small.jpg");
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

