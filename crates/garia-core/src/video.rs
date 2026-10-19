//! yt-dlp / ffmpeg probe, mux, preview, and sidecar discovery.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

// ── Video (yt-dlp) ───────────────────────────────────────────────────────
// aria2 downloads files; a video page is not a file. yt-dlp is what turns one
// into the other — it resolves a page into the actual media URLs, which aria2
// can then fetch in parallel like anything else.

/// How garia gets to yt-dlp, resolved once per launch.
pub struct Video {
    /// The 3 MB zipapp shipped in the bundle, if it made it there.
    pub zipapp: Option<PathBuf>,
    /// The command that actually runs — `None` until first asked. A failed
    /// resolution is never cached, so installing yt-dlp and asking again works
    /// without a relaunch.
    /// Kept with the version it answered, which is how resolution proved it
    /// runs — so launch asks yt-dlp once, not twice.
    pub resolved: Mutex<Option<(Vec<String>, String)>>,
    /// What the last successful look around found. Working it out costs three
    /// process launches, and Settings asks every time it opens.
    pub tools: Mutex<Option<VideoTools>>,
}

/// What the frontend needs to know before it offers a video download at all.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VideoTools {
    /// yt-dlp's version string, or empty when there is no yt-dlp.
    pub version: String,
    /// "system" or "bundled" — worth saying, because a stale bundled copy is
    /// the likeliest reason a site stops working.
    pub source: String,
    /// Whether an ffmpeg was found. Without one, the qualities that arrive as
    /// separate video and audio streams cannot be offered.
    pub ffmpeg: bool,
    /// "bundled" or "system" — which of the two answered, or empty when
    /// neither did. The bundled one is a remux-only build, so a system ffmpeg
    /// showing up here means the sidecar went missing.
    pub ffmpeg_source: String,
}

/// One runtime tool row for the Settings → About sidecar list.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SidecarTool {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub version: String,
    /// "bundled" or "system", or empty when no tool was found.
    pub source: String,
    pub path: String,
}

/// One downloadable stream, trimmed to what the picker shows and what aria2
/// needs. yt-dlp's own JSON runs to 150 KB for a single YouTube video; almost
/// none of it survives this.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VideoFormat {
    pub id: String,
    pub ext: String,
    /// "complete" — one file with both streams; "video" / "audio" — one half,
    /// which only means something paired with the other and an ffmpeg.
    pub kind: String,
    pub height: u64,
    pub fps: f64,
    /// Bitrate in kbit/s: total for video, audio-only for audio.
    pub bitrate: f64,
    /// Bytes, exact when the server said so and yt-dlp's estimate otherwise.
    pub filesize: u64,
    pub note: String,
    pub url: String,
    /// Ready for aria2's `header` option: "Name: Value" per entry. Some sites
    /// hand out URLs that only answer to the User-Agent they were minted for.
    pub headers: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub title: String,
    pub uploader: String,
    /// Seconds. Zero for a live stream or when the site doesn't say.
    pub duration: f64,
    pub thumbnail: String,
    pub webpage_url: String,
    pub extractor: String,
    pub formats: Vec<VideoFormat>,
}

/// How many of a playlist's entries the picker will take. A channel can hold
/// thousands, and neither the JSON nor a list of thousands of checkboxes is
/// something to hand a dialog — the cap is said out loud rather than hidden.
pub const MAX_PLAYLIST_ENTRIES: usize = 300;

/// One video inside a playlist, as `--flat-playlist` reports it: enough to
/// list, and enough to probe when it is ticked. There are deliberately no
/// formats here — collecting them is what turns a playlist into minutes.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    pub id: String,
    pub title: String,
    /// The page URL to probe if this entry is picked.
    pub url: String,
    /// Seconds, and often absent in a flat listing.
    pub duration: f64,
    pub uploader: String,
    pub thumbnail: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistInfo {
    pub title: String,
    pub uploader: String,
    pub webpage_url: String,
    pub extractor: String,
    /// What the site says is in it, which can be more than `entries` holds:
    /// only the first `MAX_PLAYLIST_ENTRIES` are taken.
    pub total: u64,
    pub entries: Vec<PlaylistEntry>,
}

/// What a pasted page turned out to be. Both answers come from one yt-dlp
/// launch, which is why the probe asks rather than guessing from the URL:
/// `--no-playlist` still returns the single video for a watch link that
/// happens to carry a list, and `--flat-playlist` keeps a 200-video channel
/// from costing 200 extractions before the dialog says anything at all.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Probe {
    Video(VideoInfo),
    Playlist(PlaylistInfo),
}



/// A yt-dlp the user installed themselves, newest-first in the sense that
/// matters: theirs is the one that gets updated when a site breaks.
pub fn system_ytdlp() -> Option<(Vec<String>, String)> {
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
        if bin.contains('/') && !crate::process::is_executable(&bin) {
            continue;
        }
        if let Some(version) = ytdlp_version(std::slice::from_ref(&bin)) {
            return Some((vec![bin], version));
        }
    }
    None
}

/// The bundled copy is a zipapp, so it needs an interpreter — and not just any
/// one: macOS ships `/usr/bin/python3` as 3.9, which yt-dlp dropped. The
/// version test is why this looks past the first python3 it finds.
pub fn python_for(zipapp: &Path) -> Option<(Vec<String>, String)> {
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
        if python.contains('/') && !crate::process::is_executable(&python) {
            continue;
        }
        let ok = crate::process::run_capped(
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
        if let Some(version) = ytdlp_version(&cmd) {
            return Some((cmd, version));
        }
    }
    None
}

/// Doubles as the "does this actually work" test: a yt-dlp that cannot print
/// its own version is not one we should hand a URL to.
pub fn version_after(line: &str, needle: &str) -> Option<String> {
    let mut parts = line.split_whitespace();
    while let Some(part) = parts.next() {
        if part.eq_ignore_ascii_case(needle) {
            return parts.next().map(|s| s.to_string());
        }
    }
    None
}

pub fn ytdlp_version(cmd: &[String]) -> Option<String> {
    let mut args: Vec<String> = cmd[1..].to_vec();
    args.push("--version".to_string());
    let out = crate::process::run_capped(&cmd[0], &args, 20).ok()?;
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
pub fn resolve_ytdlp(video: &Video) -> Option<Vec<String>> {
    resolve_ytdlp_versioned(video).map(|(cmd, _)| cmd)
}

pub fn resolve_ytdlp_versioned(video: &Video) -> Option<(Vec<String>, String)> {
    if let Ok(guard) = video.resolved.lock() {
        if let Some(found) = guard.as_ref() {
            return Some(found.clone());
        }
    }

    let found = system_ytdlp().or_else(|| video.zipapp.as_deref().and_then(python_for));

    if let (Some(found), Ok(mut guard)) = (found.as_ref(), video.resolved.lock()) {
        *guard = Some(found.clone());
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
pub fn ffmpeg_candidates() -> Vec<(String, &'static str)> {
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

pub fn ffmpeg_version(bin: &str) -> Option<String> {
    let out = crate::process::run_capped(bin, &["-version".to_string()], 10).ok()?;
    if !out.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if first.is_empty() {
        return None;
    }
    version_after(&first, "version").or(Some(first))
}

pub fn ffmpeg_probe() -> Option<(String, &'static str, String)> {
    for (bin, origin) in ffmpeg_candidates() {
        if bin.contains('/') && !crate::process::is_executable(&bin) {
            continue;
        }
        if let Some(version) = ffmpeg_version(&bin) {
            return Some((bin, origin, version));
        }
    }
    None
}

/// The first candidate that runs, paired with where it came from. Asking for
/// its version doubles as the "does this actually work" test, the same way it
/// does for yt-dlp: a sidecar that won't launch is not one to hand two files.
pub fn ffmpeg_found() -> Option<(String, &'static str)> {
    ffmpeg_probe().map(|(bin, origin, _)| (bin, origin))
}

pub fn ffmpeg_path() -> Option<String> {
    ffmpeg_found().map(|(bin, _)| bin)
}

pub fn video_tools_blocking(video: &Video) -> VideoTools {
    if let Ok(guard) = video.tools.lock() {
        if let Some(tools) = guard.as_ref() {
            return tools.clone();
        }
    }

    // Resolution already proved the command works by asking it its version;
    // this is the same answer, kept rather than asked for twice.
    let found = resolve_ytdlp_versioned(&video);
    let bundled = found.as_ref().map(|(c, _)| c.len() > 1).unwrap_or(false);
    let version = found.map(|(_, v)| v).unwrap_or_default();
    let ffmpeg = ffmpeg_found();
    let tools = VideoTools {
        version: version.clone(),
        source: if version.is_empty() {
            String::new()
        } else if bundled {
            "bundled".to_string()
        } else {
            "system".to_string()
        },
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


pub fn sidecar_tools_blocking(
    video: &Video,
    aria2: &crate::aria2::Aria2,
) -> Vec<SidecarTool> {
    let aria2_probe = crate::aria2::aria2c_probe();
    let aria2_version = crate::aria2::running_aria2_version(aria2)
        .or_else(|| aria2_probe.as_ref().map(|(_, _, v)| v.clone()))
        .unwrap_or_default();
    let aria2_path = aria2_probe
        .as_ref()
        .map(|(bin, _, _)| bin.clone())
        .unwrap_or_default();
    let aria2_source = aria2_probe
        .as_ref()
        .map(|(_, src, _)| src.to_string())
        .unwrap_or_default();

    let ytdlp_cmd = resolve_ytdlp(&video);
    let ytdlp_version = ytdlp_cmd
        .as_deref()
        .and_then(ytdlp_version)
        .unwrap_or_default();
    let ytdlp_bundled = ytdlp_cmd.as_ref().map(|c| c.len() > 1).unwrap_or(false);
    let ytdlp_path = ytdlp_cmd
        .as_ref()
        .map(|cmd| {
            if ytdlp_bundled {
                cmd.get(1).cloned().unwrap_or_else(|| cmd.join(" "))
            } else {
                cmd.first().cloned().unwrap_or_default()
            }
        })
        .unwrap_or_default();

    let ffmpeg_info = ffmpeg_probe();
    let ffmpeg_version = ffmpeg_info
        .as_ref()
        .map(|(_, _, v)| v.clone())
        .unwrap_or_default();
    let ffmpeg_path = ffmpeg_info
        .as_ref()
        .map(|(bin, _, _)| bin.clone())
        .unwrap_or_default();
    let ffmpeg_source = ffmpeg_info
        .as_ref()
        .map(|(_, src, _)| src.to_string())
        .unwrap_or_default();

    vec![
        SidecarTool {
            id: "aria2".to_string(),
            name: "aria2".to_string(),
            installed: !aria2_version.is_empty(),
            version: aria2_version,
            source: aria2_source,
            path: aria2_path,
        },
        SidecarTool {
            id: "ffmpeg".to_string(),
            name: "ffmpeg".to_string(),
            installed: !ffmpeg_version.is_empty(),
            version: ffmpeg_version,
            source: ffmpeg_source,
            path: ffmpeg_path,
        },
        SidecarTool {
            id: "yt-dlp".to_string(),
            name: "yt-dlp".to_string(),
            installed: !ytdlp_version.is_empty(),
            version: ytdlp_version,
            source: if ytdlp_bundled {
                "bundled".to_string()
            } else if ytdlp_path.is_empty() {
                String::new()
            } else {
                "system".to_string()
            },
            path: ytdlp_path,
        },
    ]
}


pub fn as_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

pub fn as_num(v: &serde_json::Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// The first of several keys that is actually filled in. Extractors disagree
/// about which one carries the name — `uploader` on one site, `channel` on the
/// next — and an empty string is the same as a missing key here.
pub fn as_str_any(v: &serde_json::Value, keys: &[&str]) -> String {
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
pub fn header_lines(f: &serde_json::Value) -> Vec<String> {
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
pub fn format_kind(f: &serde_json::Value) -> &'static str {
    let vcodec = f.get("vcodec").and_then(|x| x.as_str());
    let acodec = f.get("acodec").and_then(|x| x.as_str());
    match (vcodec, acodec) {
        (Some("none"), Some("none")) => "none",
        (Some("none"), _) => "audio",
        (_, Some("none")) => "video",
        _ => "complete",
    }
}

pub fn video_probe_blocking(
    video: &Video,
    settings: &crate::settings::SettingsState,
    url: String,
) -> Result<Probe, String> {
    let Some(cmd) = resolve_ytdlp(&video) else {
        return Err("no-ytdlp".to_string());
    };

    let current = settings
        .current
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();

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
    ]);
    if let Some(proxy) = crate::settings::ytdlp_proxy_url(&current) {
        args.push("--proxy".to_string());
        args.push(proxy);
    }
    args.push(url);

    let no_proxy = current.proxy_no_proxy.clone();
    let env = if current.proxy_enabled && !no_proxy.is_empty() {
        vec![("NO_PROXY", no_proxy.as_str()), ("no_proxy", no_proxy.as_str())]
    } else {
        Vec::new()
    };
    let out = crate::process::run_watched(&cmd[0], &args, 120, &env, true)?;
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
pub fn thumbnail_of(v: &serde_json::Value) -> String {
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
pub fn trim_probe(root: &serde_json::Value) -> Result<Probe, String> {
    if root.get("_type").and_then(|t| t.as_str()) == Some("playlist") {
        trim_playlist(root).map(Probe::Playlist)
    } else {
        trim_info(root).map(Probe::Video)
    }
}

/// A playlist as the picker needs it: a line per entry, and the page URL to
/// come back to for each one.
pub fn trim_playlist(root: &serde_json::Value) -> Result<PlaylistInfo, String> {
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
pub fn trim_info(info: &serde_json::Value) -> Result<VideoInfo, String> {
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
pub fn mux_video_blocking(
    video_path: String,
    audio_path: String,
    out_path: String,
    mut on_progress: impl FnMut(f64),
) -> Result<String, String> {
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

    // The row says how far along it is. A long film can take a minute to
    // rewrite, and a full bar that says "Merging" for a minute looks stuck.
    let out = crate::process::run_ffmpeg_with_progress(&ffmpeg, &args, 900, |fraction| {
        on_progress(fraction);
    })?;
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
pub const INDEXED_EXTS: [&str; 5] = ["mp4", "m4v", "m4a", "mov", "3gp"];

/// Below this there is not enough of anything for a player to make sense of,
/// whatever the container. A quarter of a megabyte is a few seconds of audio
/// and rather less video, and it is smaller than one aria2 piece.
pub const PREVIEW_FLOOR: u64 = 256 * 1024;

/// What the panel says about opening a half-downloaded file, and whether it
/// offers to.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    pub ready: bool,
    /// Why not, in the panel's own words — empty once it is ready, because
    /// then the panel has the number to show instead.
    pub reason: String,
}

impl PreviewState {
    pub fn no(reason: &str) -> Self {
        Self { ready: false, reason: reason.to_string() }
    }
}

/// Walks the top-level boxes of an ISO base media file looking for `moov` —
/// the index, without which a player has no idea what is in the file or where.
/// `limit` is how far into the file the bytes have actually arrived: reading a
/// box header past it would be reading a hole aria2 has not filled in yet.
pub fn moov_within<R: Read + Seek>(src: &mut R, limit: u64) -> bool {
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
pub fn preview_state_blocking(path: String, ready_bytes: u64) -> PreviewState {
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
