/// Catching a download that started somewhere else — the clipboard, or a
/// `garia://add?url=` link from a bookmarklet or extension.
///
/// The full FDM version intercepts the browser's own downloader. The 80/20 is
/// these two: a copied file URL is offered, and anything sent on purpose
/// through the scheme is queued.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchEvent {
    pub url: String,
    /// `"clipboard"` is an offer; `"scheme"` is an instruction;
    /// `"extension"` is the browser taking a click or a download.
    pub source: String,
    /// A name the browser already knew — Content-Disposition, or the
    /// filename on the link. The confirm sheet pre-fills it; aria2 gets it
    /// as `out` so a URL that ends in `download?id=…` still lands as a file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The page the click came from. aria2 puts it on `Referer`, which is
    /// what sites that refuse a hotlink are checking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referrer: Option<String>,
    /// The extension asks; the bookmarklet does not. A page still goes to
    /// the quality picker — that *is* its confirm.
    #[serde(default)]
    pub confirm: bool,
}

/// Extensions that mean the clipboard holds a file, not a page. A copied
/// YouTube URL would otherwise offer itself all day; a copied `.iso` is the
/// thing a download manager is for. Keep in step with `DIRECT_EXTS` in
/// `src/main.js`.
const FILE_EXTS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "ts",
    "mp3", "flac", "wav", "aac", "ogg", "oga", "m4a", "wma", "opus", "aiff", "alac",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
    "rtf", "txt", "csv", "epub", "mobi", "djvu",
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "dmg", "pkg",
    "exe", "msi", "deb", "rpm", "apk", "jar", "bin", "img", "torrent", "xip",
    "json", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp", "dat",
];

/// The first file URL in a clipboard dump. Magnets count; a bare page does not.
pub fn file_url_in(text: &str) -> Option<String> {
    for raw in text.split_whitespace() {
        let token = tidy_token(raw);
        if let Some(url) = as_file_url(token) {
            return Some(url);
        }
    }
    None
}

fn tidy_token(s: &str) -> &str {
    s.trim_matches(|c| matches!(c, '<' | '>' | '"' | '\'' | ',' | '“' | '”' | '‘' | '’'))
}

fn as_file_url(s: &str) -> Option<String> {
    if s.starts_with("magnet:") {
        return Some(s.to_string());
    }
    if !(s.starts_with("http://") || s.starts_with("https://")) {
        return None;
    }
    let ext = extension_of(s)?;
    FILE_EXTS.contains(&ext.as_str()).then(|| s.to_string())
}

/// The extension has to come out of a URL, not a filename: query strings and
/// fragments both sit after the part that names the file.
fn extension_of(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let name = path.rsplit('/').next().unwrap_or("");
    let dot = name.rfind('.')?;
    if dot == 0 || dot == name.len() - 1 {
        return None;
    }
    Some(name[dot + 1..].to_ascii_lowercase())
}

/// Pull the download URL out of `garia://add?url=…`. The URL itself has to be
/// percent-encoded when it contains `?` (magnets, query strings); a plain
/// `https://…` with no extra `?` still works unencoded.
pub fn url_from_garia_link(link: &str) -> Option<String> {
    catch_from_garia_link(link).map(|event| event.url)
}

/// The same link, with the extras an extension can send. `from=extension`
/// or `confirm=1` is how a click in the browser is told apart from the
/// bookmarklet, which stays a fast `scheme` add.
pub fn catch_from_garia_link(link: &str) -> Option<CatchEvent> {
    let link = link.trim();
    let rest = link
        .strip_prefix("garia://")
        .or_else(|| link.strip_prefix("garia:"))?;
    let rest = rest.trim_start_matches('/');
    let query = rest.split_once('?')?.1;

    let mut url = None;
    let mut name = None;
    let mut referrer = None;
    let mut confirm = false;
    let mut from_extension = false;

    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        let decoded = percent_decode(v);
        match k {
            "url" => {
                let decoded = decoded.trim();
                if is_download_url(decoded) {
                    url = Some(decoded.to_string());
                }
            }
            "name" => name = safe_filename(&decoded),
            "referrer" | "referer" => {
                if is_download_url(decoded.trim()) {
                    referrer = Some(decoded.trim().to_string());
                }
            }
            "confirm" => confirm = matches!(decoded.as_str(), "1" | "true" | "yes"),
            "from" => from_extension = decoded.eq_ignore_ascii_case("extension"),
            _ => {}
        }
    }

    let url = url?;
    let extension = from_extension || confirm;
    Some(CatchEvent {
        url,
        source: if extension {
            "extension".to_string()
        } else {
            "scheme".to_string()
        },
        name,
        referrer,
        confirm: extension,
    })
}

/// aria2's `out` is a filename, not a path. A Content-Disposition that
/// carried a folder, or a `name` an extension copied off a download item,
/// is trimmed to the last component so nothing here chooses a directory.
fn safe_filename(s: &str) -> Option<String> {
    let name = s.replace('\\', "/");
    let name = name.rsplit('/').next().unwrap_or("").trim();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    if name.chars().any(|c| c == '/' || c == '\0') {
        return None;
    }
    Some(name.to_string())
}

fn is_download_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://") || s.starts_with("magnet:")
}

/// A URL the user pointed at on purpose — Services, a selected line.
/// Unlike the clipboard, a page counts: they chose the menu item.
pub fn url_from_selection(text: &str) -> Option<String> {
    for raw in text.split_whitespace() {
        let token = tidy_token(raw);
        if let Some(url) = url_from_garia_link(token) {
            return Some(url);
        }
        if is_download_url(token) {
            return Some(token.to_string());
        }
    }
    None
}

/// A magnet handed to the app as its own URL, not wrapped in `garia://`.
/// Safari and other clients open `magnet:?xt=…` directly once we claim the
/// scheme; the bookmarklet still goes through `url_from_garia_link`.
pub fn magnet_url(link: &str) -> Option<String> {
    let link = link.trim();
    link.starts_with("magnet:").then(|| link.to_string())
}

/// A `.torrent` the system asked us to open — Finder, Open With, or a
/// `file://` from `RunEvent::Opened`. The path is what the frontend reads;
/// we only decide whether it is one.
pub fn torrent_path(link: &str) -> Option<PathBuf> {
    let link = link.trim();
    let raw = if let Some(rest) = link.strip_prefix("file://") {
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        percent_decode(rest)
    } else if Path::new(link).is_absolute() {
        link.to_string()
    } else {
        return None;
    };
    let path = PathBuf::from(raw);
    is_torrent(&path).then_some(path)
}

pub fn is_torrent(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("torrent"))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copied_iso_is_a_file() {
        assert_eq!(
            file_url_in("https://cdimage.debian.org/debian.iso"),
            Some("https://cdimage.debian.org/debian.iso".into())
        );
    }

    #[test]
    fn query_strings_dont_hide_the_extension() {
        assert_eq!(
            file_url_in("https://files.example.com/app.dmg?dl=1"),
            Some("https://files.example.com/app.dmg?dl=1".into())
        );
    }

    #[test]
    fn a_page_url_is_left_alone() {
        assert_eq!(file_url_in("https://www.youtube.com/watch?v=aqz-KE-bpKQ"), None);
        assert_eq!(file_url_in("https://example.com/"), None);
        assert_eq!(file_url_in("https://example.com/blog/post"), None);
    }

    #[test]
    fn magnets_count() {
        let magnet = "magnet:?xt=urn:btih:abc123&dn=something";
        assert_eq!(file_url_in(magnet), Some(magnet.into()));
    }

    #[test]
    fn surrounding_punctuation_is_stripped() {
        assert_eq!(
            file_url_in("see <https://mirror.example.com/a.zip> please"),
            Some("https://mirror.example.com/a.zip".into())
        );
    }

    #[test]
    fn scheme_link_with_encoded_url() {
        assert_eq!(
            url_from_garia_link("garia://add?url=https%3A%2F%2Fexample.com%2Ffile.zip"),
            Some("https://example.com/file.zip".into())
        );
    }

    #[test]
    fn scheme_link_with_a_plain_https_url() {
        assert_eq!(
            url_from_garia_link("garia://add?url=https://example.com/file.zip"),
            Some("https://example.com/file.zip".into())
        );
    }

    #[test]
    fn encoded_magnet_survives_the_query_string() {
        let magnet = "magnet:?xt=urn:btih:abc&dn=x";
        let link = format!("garia://add?url={}", "magnet%3A%3Fxt%3Durn%3Abtih%3Aabc%26dn%3Dx");
        assert_eq!(url_from_garia_link(&link), Some(magnet.into()));
    }

    #[test]
    fn a_garia_link_without_a_url_is_nothing() {
        assert_eq!(url_from_garia_link("garia://add"), None);
        assert_eq!(url_from_garia_link("https://example.com/file.zip"), None);
        assert_eq!(url_from_garia_link("garia://add?url=ftp://example.com/a"), None);
    }

    #[test]
    fn a_selected_page_is_an_instruction() {
        assert_eq!(
            url_from_selection("watch https://youtube.com/watch?v=abc later"),
            Some("https://youtube.com/watch?v=abc".into())
        );
        assert_eq!(
            url_from_selection("magnet:?xt=urn:btih:abc"),
            Some("magnet:?xt=urn:btih:abc".into())
        );
        assert_eq!(url_from_selection("nothing here"), None);
    }

    #[test]
    fn garia_without_slashes_still_parses() {
        assert_eq!(
            url_from_garia_link("garia:add?url=https://example.com/a.iso"),
            Some("https://example.com/a.iso".into())
        );
    }

    #[test]
    fn an_extension_link_carries_the_name_and_asks_to_confirm() {
        let event = catch_from_garia_link(
            "garia://add?url=https%3A%2F%2Fexample.com%2Fd%3Fid%3D1&name=disk.iso&referrer=https%3A%2F%2Fexample.com%2Fpage&from=extension",
        )
        .unwrap();
        assert_eq!(event.url, "https://example.com/d?id=1");
        assert_eq!(event.source, "extension");
        assert_eq!(event.name.as_deref(), Some("disk.iso"));
        assert_eq!(event.referrer.as_deref(), Some("https://example.com/page"));
        assert!(event.confirm);
    }

    #[test]
    fn a_path_in_the_name_is_trimmed_to_the_file() {
        let event = catch_from_garia_link(
            "garia://add?url=https://example.com/a.zip&name=%2FUsers%2Fme%2FDownloads%2Fa.zip&confirm=1",
        )
        .unwrap();
        assert_eq!(event.name.as_deref(), Some("a.zip"));
        assert_eq!(event.source, "extension");
    }

    #[test]
    fn the_bookmarklet_is_still_a_scheme_instruction() {
        let event = catch_from_garia_link("garia://add?url=https://example.com/watch?v=1").unwrap();
        assert_eq!(event.source, "scheme");
        assert!(!event.confirm);
        assert!(event.name.is_none());
    }

    #[test]
    fn a_dotdot_name_is_dropped() {
        let event = catch_from_garia_link("garia://add?url=https://example.com/a.zip&name=..").unwrap();
        assert!(event.name.is_none());
    }

    #[test]
    fn a_bare_magnet_is_taken() {
        let magnet = "magnet:?xt=urn:btih:abc&dn=x";
        assert_eq!(magnet_url(magnet), Some(magnet.into()));
        assert_eq!(magnet_url(" https://example.com/a.iso "), None);
    }

    #[test]
    fn a_file_url_to_a_torrent_is_a_path() {
        let path = torrent_path("file:///tmp/ubuntu.torrent").unwrap();
        assert_eq!(path, std::path::PathBuf::from("/tmp/ubuntu.torrent"));
    }

    #[test]
    fn a_percent_encoded_torrent_name_survives() {
        let path = torrent_path("file:///tmp/My%20Disk.torrent").unwrap();
        assert_eq!(path, std::path::PathBuf::from("/tmp/My Disk.torrent"));
    }

    #[test]
    fn a_plain_file_is_not_a_torrent() {
        assert_eq!(torrent_path("file:///tmp/movie.iso"), None);
        assert_eq!(torrent_path("relative.torrent"), None);
    }
}
