//! Settings, categories, secrets, and remote-control pairing helpers.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::schedule;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TrafficMode {
    Full,
    Medium,
    Light,
}

/// What to do when the last download that still has work finishes. Sleep
/// and shut down are the Mac version of IDM's "disconnect when done".
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DoneAction {
    #[default]
    None,
    Sleep,
    Shutdown,
}

/// What Medium and Light mean before the user says otherwise: enough for a
/// video to keep up, and slow enough to disappear behind a call.
pub const DEFAULT_MEDIUM_LIMIT: u64 = 2 * 1024 * 1024;
pub const DEFAULT_LIGHT_LIMIT: u64 = 512 * 1024;
/// Below a kilobyte a second a download is stopped, not limited.
pub const MIN_LIMIT: u64 = 1024;

/// aria2's conventional port, and what every aria2 client on a phone offers
/// first. Named because remote control cares which one was actually taken.
pub const DEFAULT_RPC_PORT: u16 = 6800;

/// A folder new downloads can land in. The four built-in kinds — Video,
/// Music, Documents, Archives — are the default list; the user can rename
/// them, add a site-specific one, or delete them all.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub folder: String,
    /// Optional host. When set, only URLs from that site take this folder,
    /// and they take it before a type-only category would.
    #[serde(default)]
    pub host: String,
}

impl Default for Category {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            extensions: Vec::new(),
            folder: String::new(),
            host: String::new(),
        }
    }
}

/// What the user gets to decide. Kept here rather than read back out of aria2
/// because these have to survive a restart, and aria2 forgets everything that
/// isn't an unfinished download.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub download_dir: String,
    pub max_concurrent_downloads: u32,
    /// Which of the three modes is in force. `None` is a settings file written
    /// before the modes existed; the bare cap it holds becomes Medium. The
    /// field says so itself, because the struct's own default names a mode.
    #[serde(default = "no_mode")]
    pub traffic_mode: Option<TrafficMode>,
    /// Bytes per second the two capped modes stand for. The numbers are the
    /// user's; only the switching between them is fixed.
    pub medium_limit: u64,
    pub light_limit: u64,
    /// Bytes per second across every download — derived from the mode, not set
    /// on its own. 0 is aria2's own "no limit", which is what Full is.
    pub max_overall_download_limit: u64,
    /// Seed a finished torrent until this share ratio. aria2's own default is
    /// 1.0 — give back what you took; 0.0 means seed until told to stop.
    pub seed_ratio: f64,
    /// …or for this many minutes, whichever comes first. 0 is no time limit,
    /// and the option is left off entirely rather than sent as a zero, which
    /// aria2 reads as "do not seed at all".
    pub seed_time_minutes: u32,
    /// Route each download into a subfolder named after its kind. Off by
    /// default: where a file lands is the user's expectation to change, not
    /// ours. The routing itself lives in the frontend, which names the folder
    /// per download at add time — nothing here moves a file.
    pub smart_folders: bool,
    /// The folders that switch uses. Empty plus the switch on is the four
    /// built-in kinds; a list the user has edited is stored as they left it.
    #[serde(default)]
    pub categories: Vec<Category>,
    /// Say so when a download finishes. On by default: the whole point of a
    /// download manager is not having to watch it.
    pub notify_on_complete: bool,
    /// Watch the clipboard for a copied file URL and offer to take it. On by
    /// default: catching a download that started in the browser is why the
    /// app stays open. Off if the offer gets in the way.
    pub catch_clipboard: bool,
    /// Ask for a name, a folder, and start-vs-queue when the browser
    /// extension sends a file. On by default — a click in the browser is
    /// not the same as choosing Services, and the sheet is where those
    /// three get decided. The bookmarklet and a video page skip it.
    #[serde(default = "default_true")]
    pub confirm_capture: bool,
    /// Ask aria2 for the lowest-numbered piece it can take next, so the file
    /// fills from the front and can be played before it is finished. Off by
    /// default, because it is a real trade: the default selector picks pieces
    /// to keep connections alive, and in-order arrival gives some of that up.
    /// Nothing here reads it — it goes on each download as it is added, since
    /// aria2 will not change a piece selector on a download it is working.
    pub in_order: bool,
    /// A Netscape cookies.txt exported from the browser, read by aria2 at
    /// launch and matched to hosts by aria2 itself. A path, not a copy: the
    /// jar stays the browser's file, and garia holds nothing from it. Empty
    /// means no jar, which is the default.
    pub cookie_file: String,
    /// Let anything on the local network reach the RPC port. Off by default,
    /// and the only setting in here that opens a socket to the outside: aria2
    /// has no way to bind one chosen interface, so this is `--rpc-listen-all`
    /// and nothing narrower. Turning it on also swaps the per-launch token for
    /// one that persists, because a phone cannot be re-paired every morning.
    #[serde(default)]
    pub remote_control: bool,
    /// Run downloads only between two times of day. Off by default, and the
    /// only setting in here that stops something the user has already asked
    /// for — which is why the dialog says in words what it will and will not
    /// do, rather than implying an alarm clock. See `schedule.rs`.
    #[serde(default)]
    pub schedule_enabled: bool,
    /// The window's ends, as minutes since local midnight. A time of day and
    /// not a timestamp: 02:00 is 02:00 again after the clocks change, which a
    /// stored instant would not be. `end` before `start` wraps midnight, which
    /// is the shape "overnight" actually has.
    #[serde(default)]
    pub schedule_start: u32,
    #[serde(default)]
    pub schedule_end: u32,
    /// The queue is stopped: nothing new starts, and anything running is
    /// held the same way a shut window holds it. Off by default. Pause All
    /// is per row; this is the verb that means "not now".
    #[serde(default)]
    pub queue_stopped: bool,
    /// After the last unfinished download lands. `none` is the default, and
    /// the action waits until this run has actually had work — a launch
    /// onto an empty list must not put the Mac to sleep.
    #[serde(default)]
    pub done_action: DoneAction,
    /// Send HTTP, HTTPS, and FTP through this host. Off by default. aria2
    /// has no SOCKS and no NTLM — this is `--all-proxy`, an HTTP proxy, and
    /// that is the whole setting. BitTorrent peers are not HTTP, so they
    /// still connect directly.
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxy_host: String,
    #[serde(default = "default_proxy_port")]
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_user: String,
    /// Hosts that skip the proxy. Comma-separated, handed to aria2 as
    /// `--no-proxy` and to yt-dlp as `NO_PROXY`.
    #[serde(default)]
    pub proxy_no_proxy: String,
    /// From the Settings form, or loaded from `proxy-passwd`. Never written
    /// to settings.json — that file is one the user is invited to read.
    #[serde(default, skip_serializing)]
    pub proxy_password: String,
    /// For the frontend only: a password is stored. Never read back out of
    /// a settings file, because one must not have been written there.
    #[serde(default, skip_deserializing, skip_serializing_if = "is_false")]
    pub has_proxy_password: bool,
    /// Whether the first-run sheet has been dismissed. A new install starts
    /// false. A settings file written before this field existed is treated
    /// as already seen, so an upgrade does not reopen the sheet.
    #[serde(default = "default_true")]
    pub setup_seen: bool,
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
            categories: Vec::new(),
            notify_on_complete: true,
            catch_clipboard: true,
            confirm_capture: true,
            in_order: false,
            cookie_file: String::new(),
            remote_control: false,
            schedule_enabled: false,
            // What the card on the roadmap was drawn around, and what people
            // mean by off-peak: overnight, wrapping midnight.
            schedule_start: 2 * 60,
            schedule_end: 8 * 60,
            queue_stopped: false,
            done_action: DoneAction::None,
            proxy_enabled: false,
            proxy_host: String::new(),
            proxy_port: default_proxy_port(),
            proxy_user: String::new(),
            proxy_no_proxy: String::new(),
            proxy_password: String::new(),
            has_proxy_password: false,
            setup_seen: false,
        }
    }
}

impl Settings {
    /// Settings arrive from a JSON file the user can edit and from the
    /// frontend, so nothing is trusted: a zero concurrency stalls every
    /// download, and an empty folder makes aria2 refuse to start.
    pub fn normalised(mut self) -> Self {
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

        // A settings file from before categories existed has the switch and
        // an empty list. The four kinds are what that switch always meant.
        if self.smart_folders && self.categories.is_empty() {
            self.categories = default_categories();
        }
        let mut used = HashSet::new();
        self.categories = self
            .categories
            .into_iter()
            .filter_map(|cat| normalise_category(cat, &mut used))
            .collect();

        let (host, embedded_port) = parse_proxy_authority(&self.proxy_host);
        self.proxy_host = host;
        if let Some(port) = embedded_port {
            self.proxy_port = port;
        }
        if self.proxy_port == 0 {
            self.proxy_port = default_proxy_port();
        }
        self.proxy_user = self.proxy_user.trim().to_string();
        self.proxy_no_proxy = normalise_no_proxy(&self.proxy_no_proxy);
        // A switch with nowhere to send traffic is not a proxy.
        if self.proxy_host.is_empty() {
            self.proxy_enabled = false;
        }
        self
    }

    /// What the frontend is allowed to see. The password stays in memory for
    /// the next aria2 launch; the flag is all the form needs to say one is
    /// stored without ever being sent it.
    pub fn for_frontend(&self) -> Self {
        let mut s = self.clone();
        s.has_proxy_password = !s.proxy_password.is_empty();
        s.proxy_password.clear();
        s
    }

    pub fn for_disk(&self) -> Self {
        let mut s = self.clone();
        s.proxy_password.clear();
        s.has_proxy_password = false;
        s
    }
}

/// A settings file that has never heard of the modes, as distinct from one
/// that names Full — the first is migrated, the second is obeyed.
pub fn no_mode() -> Option<TrafficMode> {
    None
}

/// serde's `default` is `false` for a bool. Capture confirmation is the
/// other way around: a file that predates the field should still ask,
/// because a click in the browser is not the same as the bookmarklet.
pub fn default_true() -> bool {
    true
}

pub fn default_proxy_port() -> u16 {
    8080
}

pub fn is_false(v: &bool) -> bool {
    !*v
}

/// Host and optional port from whatever was typed — a URL, `host:port`, or a
/// bare name. Userinfo is dropped: the password field is where a password
/// goes, not the host box.
pub fn parse_proxy_authority(input: &str) -> (String, Option<u16>) {
    let mut s = input.trim();
    if let Some((_, rest)) = s.split_once("://") {
        s = rest;
    }
    s = s.split(['/', '?', '#']).next().unwrap_or(s);
    if let Some((_, rest)) = s.rsplit_once('@') {
        s = rest;
    }
    if let Some(rest) = s.strip_prefix('[') {
        if let Some((host, rest)) = rest.split_once(']') {
            let port = rest
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .filter(|p| *p > 0);
            let host = host.trim();
            if host.is_empty() {
                return (String::new(), port);
            }
            return (format!("[{host}]"), port);
        }
    }
    if let Some((host, port)) = s.rsplit_once(':') {
        if !host.is_empty() {
            if let Ok(p) = port.parse::<u16>() {
                if p > 0 {
                    return (
                        host.trim_end_matches('.').to_ascii_lowercase(),
                        Some(p),
                    );
                }
            }
        }
    }
    (
        s.trim().trim_end_matches('.').to_ascii_lowercase(),
        None,
    )
}

pub fn normalise_no_proxy(input: &str) -> String {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in input.split(|c: char| c == ',' || c.is_ascii_whitespace()) {
        let host = raw.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() || !seen.insert(host.clone()) {
            continue;
        }
        out.push(host);
    }
    out.join(",")
}

/// aria2's `--all-proxy`. User and password are separate flags so a
/// `:` in the password is not a second host.
pub fn proxy_arg(settings: &Settings) -> Option<String> {
    if !settings.proxy_enabled || settings.proxy_host.is_empty() {
        return None;
    }
    Some(format!(
        "http://{}:{}",
        settings.proxy_host, settings.proxy_port
    ))
}

/// yt-dlp takes one URL, so the login has to live in it. Percent-encoded,
/// because a password with `@` would steal the host.
pub fn ytdlp_proxy_url(settings: &Settings) -> Option<String> {
    let base = proxy_arg(settings)?;
    if settings.proxy_user.is_empty() && settings.proxy_password.is_empty() {
        return Some(base);
    }
    let user = encode_userinfo(&settings.proxy_user);
    let pass = encode_userinfo(&settings.proxy_password);
    let rest = base.strip_prefix("http://")?;
    Some(format!("http://{user}:{pass}@{rest}"))
}

pub fn encode_userinfo(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn proxy_passwd_path(settings_file: &Path) -> PathBuf {
    settings_file
        .parent()
        .unwrap_or(Path::new("."))
        .join("proxy-passwd")
}

pub fn read_proxy_passwd(path: &Path) -> String {
    fs::read_to_string(path)
        .map(|s| s.trim_end_matches(['\n', '\r']).to_string())
        .unwrap_or_default()
}

pub fn write_proxy_passwd(path: &Path, password: &str) -> Result<(), String> {
    if password.is_empty() {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    fs::write(path, password).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    restrict(path);
    Ok(())
}

/// A mode's number, kept usable: zero means the file never carried one, and
/// anything under a kilobyte a second is a stall rather than a limit.
pub fn clamp_limit(bytes: u64, fallback: u64) -> u64 {
    if bytes == 0 {
        fallback
    } else {
        bytes.max(MIN_LIMIT)
    }
}

/// The settings file, plus the values currently in force.
pub struct SettingsState {
    pub file: PathBuf,
    pub current: Mutex<Settings>,
}

/// garia's own credential store, and the netrc derived from it. Two files
/// because they answer to two different readers: the first is garia's, holds
/// the passwords, and is never handed to anything; the second is aria2's, and
/// holds only what aria2 can act on.
pub struct LoginsState {
    pub file: PathBuf,
    pub netrc: PathBuf,
    pub current: Mutex<Vec<crate::logins::Login>>,
}

pub fn default_download_dir() -> PathBuf {
    dirs::download_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads"))
}

/// The four kinds people actually sort by. Keep in step with `FOLDERS` in
/// `src/main.js` — the frontend uses the same table when Settings has not
/// been saved since the switch was turned on.
pub fn default_categories() -> Vec<Category> {
    vec![
        Category {
            id: "video".into(),
            name: "Video".into(),
            extensions: ext_list(&[
                "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp",
                "ts",
            ]),
            folder: "Video".into(),
            host: String::new(),
        },
        Category {
            id: "music".into(),
            name: "Music".into(),
            extensions: ext_list(&[
                "mp3", "flac", "wav", "aac", "ogg", "oga", "m4a", "wma", "opus", "aiff", "alac",
            ]),
            folder: "Music".into(),
            host: String::new(),
        },
        Category {
            id: "documents".into(),
            name: "Documents".into(),
            extensions: ext_list(&[
                "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
                "txt", "csv", "epub", "mobi", "djvu",
            ]),
            folder: "Documents".into(),
            host: String::new(),
        },
        Category {
            id: "archives".into(),
            name: "Archives".into(),
            extensions: ext_list(&[
                "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "dmg", "pkg",
            ]),
            folder: "Archives".into(),
            host: String::new(),
        },
    ]
}

pub fn ext_list(exts: &[&str]) -> Vec<String> {
    exts.iter().map(|e| (*e).to_string()).collect()
}

pub fn normalise_category(mut cat: Category, used: &mut HashSet<String>) -> Option<Category> {
    cat.name = cat.name.trim().to_string();
    if cat.name.is_empty() {
        return None;
    }

    let mut id = slug(&cat.id);
    if id.is_empty() {
        id = slug(&cat.name);
    }
    if id.is_empty() {
        id = "category".into();
    }
    let mut n = 2;
    let mut candidate = id.clone();
    while !used.insert(candidate.clone()) {
        candidate = format!("{id}-{n}");
        n += 1;
    }
    cat.id = candidate;

    let mut seen = HashSet::new();
    cat.extensions = cat
        .extensions
        .into_iter()
        .map(|e| {
            e.trim()
                .trim_start_matches('.')
                .to_ascii_lowercase()
        })
        .filter(|e| {
            !e.is_empty()
                && e.chars().all(|c| c.is_ascii_alphanumeric())
                && seen.insert(e.clone())
        })
        .collect();

    cat.folder = cat.folder.trim().replace('\\', "/");
    if cat.folder.is_empty() || cat.folder.split('/').any(|p| p == "..") {
        cat.folder = cat.name.clone();
    }
    cat.host = category_host(&cat.host);
    Some(cat)
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

/// The host, exactly as a URL would write it. A pasted `https://files.example.com/a`
/// still has to match `files.example.com`.
pub fn category_host(input: &str) -> String {
    let mut s = input.trim();
    if let Some(rest) = s.split_once("://") {
        s = rest.1;
    }
    s = s.split(['/', '?', '#']).next().unwrap_or(s);
    if let Some((_, host)) = s.rsplit_once('@') {
        s = host;
    }
    let host = if let Some(rest) = s.strip_prefix('[') {
        rest.split_once(']')
            .map(|(h, _)| format!("[{h}]"))
            .unwrap_or_else(|| s.to_string())
    } else {
        s.split(':').next().unwrap_or(s).to_string()
    };
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// A missing or unreadable file is not an error — it is a first launch.
pub fn read_settings(file: &Path) -> Settings {
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
pub fn random_secret() -> String {
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
pub fn remote_secret(path: &Path) -> String {
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
pub fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
        eprintln!("[garia] Could not restrict {}: {e}", path.display());
    }
}

#[cfg(not(unix))]
pub fn restrict(_path: &Path) {}

/// The address a phone on the same network would use. Asking the routing
/// table beats enumerating interfaces: a UDP socket that is *connected* has
/// picked a route and therefore a source address, and connecting a UDP socket
/// sends nothing. The address it is pointed at is from TEST-NET-1, which is
/// reserved precisely so that it can be named without meaning a real host —
/// nothing is contacted, and no packet leaves.
pub fn local_ip() -> Option<String> {
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
pub struct RemoteInfo {
    pub enabled: bool,
    /// None when the machine is on no network at all, which makes the whole
    /// panel a promise it cannot keep.
    pub host: Option<String>,
    pub port: u16,
    pub secret: String,
    /// aria2's conventional port, and the one every client defaults to. When
    /// something else already held it at launch the pairing still works, but
    /// it is a different number next time — which is worth saying out loud.
    pub default_port: bool,
    /// The QR as a square of modules, drawn by the frontend rather than here:
    /// an SVG built in Rust would carry its own colours into a stylesheet that
    /// already has them.
    pub qr_width: usize,
    pub qr_modules: Vec<bool>,
}

/// The secret alone, not a URL with the secret in it. Clients ask for host,
/// port and token as three fields; the first two are short enough to read off
/// the screen and type, and the third is the only one that isn't.
pub fn qr_of(text: &str) -> (usize, Vec<bool>) {
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

