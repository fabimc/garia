//! Listing an FTP directory so the add dialog can offer files, not a path.
//!
//! aria2 already fetches `ftp://` — that is not the hole. The hole is having
//! to know the file's name before you start. This talks LIST (and MLSD when
//! the server offers it), using the same site login aria2 will read from the
//! netrc, so a password is never attached to a download and never sent to
//! the frontend.
//!
//! What this is not: a site grabber, SFTP, FTPS, or a recursive copy. A
//! folder is opened. The files inside are what get queued.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

#[cfg(test)]
use std::net::TcpListener;

use serde::Serialize;

const CONNECT_SECS: u64 = 12;
const IO_SECS: u64 = 20;
const MAX_LISTING: usize = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FtpListing {
    pub url: String,
    pub host: String,
    pub path: String,
    /// Who we signed in as. `"anonymous"` when nobody was saved — that is
    /// still a login, just the one FTP invented for public trees.
    pub login: String,
    pub entries: Vec<FtpEntry>,
    /// The listing was cut off. A grabber would page; we stop.
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FtpEntry {
    pub name: String,
    pub dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FtpTarget {
    pub host: String,
    pub port: u16,
    pub path: String,
    pub username: String,
    pub password: String,
}

/// A URL garia will try to list. `ftps://` is refused here — the listing
/// client is plain FTP, and wrapping it in TLS is a different feature.
/// aria2 can still fetch an `ftps://` file URL on its own.
pub fn parse_ftp_url(input: &str) -> Result<FtpTarget, String> {
    let raw = input.trim();
    let rest = raw
        .strip_prefix("ftp://")
        .or_else(|| raw.strip_prefix("FTP://"))
        .ok_or_else(|| {
            if raw.to_ascii_lowercase().starts_with("ftps://") {
                "FTPS listing is not something garia does — paste the file URL.".to_string()
            } else {
                "That is not an FTP URL.".to_string()
            }
        })?;

    let (authority, path_and_more) = rest.split_once('/').unwrap_or((rest, ""));
    if authority.is_empty() {
        return Err("Which host?".to_string());
    }
    let path_and_more = path_and_more.split(['?', '#']).next().unwrap_or("");
    let path = format!("/{}", percent_decode(path_and_more).trim_end_matches('/'));
    let path = if path == "/" { String::new() } else { path };

    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((userinfo, hostport)) => (userinfo, hostport),
        None => ("", authority),
    };

    let (username, password) = if userinfo.is_empty() {
        (String::new(), String::new())
    } else {
        match userinfo.split_once(':') {
            Some((u, p)) => (percent_decode(u), percent_decode(p)),
            None => (percent_decode(userinfo), String::new()),
        }
    };

    let (host, port) = split_host_port(hostport)?;
    if host.is_empty() {
        return Err("Which host?".to_string());
    }

    Ok(FtpTarget {
        host,
        port,
        path,
        username,
        password,
    })
}

fn split_host_port(s: &str) -> Result<(String, u16), String> {
    if let Some(end) = s.strip_prefix('[').and_then(|r| r.find(']')) {
        let host = s[1..=end].to_ascii_lowercase();
        let port = match s.get(end + 2..) {
            Some(rest) if rest.starts_with(':') => parse_port(&rest[1..])?,
            Some("") | None => 21,
            Some(_) => return Err("That host:port is not one.".to_string()),
        };
        return Ok((format!("[{host}]"), port));
    }
    if let Some((host, port)) = s.rsplit_once(':') {
        if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
            return Ok((host.to_ascii_lowercase(), parse_port(port)?));
        }
    }
    Ok((s.to_ascii_lowercase(), 21))
}

fn parse_port(s: &str) -> Result<u16, String> {
    s.parse::<u16>()
        .map_err(|_| "That port is not a port.".to_string())
        .and_then(|p| {
            if p == 0 {
                Err("That port is not a port.".to_string())
            } else {
                Ok(p)
            }
        })
}

/// The directory URL the dialog shows and navigates. Userinfo is stripped:
/// a password in the location bar is how it used to leak into the session.
pub fn directory_url(target: &FtpTarget) -> String {
    let host = host_for_url(&target.host, target.port);
    if target.path.is_empty() {
        format!("ftp://{host}/")
    } else {
        format!("ftp://{host}{}/", encode_path(&target.path))
    }
}

fn host_for_url(host: &str, port: u16) -> String {
    if port == 21 {
        host.to_string()
    } else {
        format!("{host}:{port}")
    }
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|part| {
            if part.is_empty() {
                String::new()
            } else {
                encode_segment(part)
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_segment(name: &str) -> String {
    let mut out = String::new();
    for &b in name.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
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

/// Walk one directory. `saved` is the site login for this host, if any.
/// URL userinfo wins for this listing only, so a one-off `user:pass@`
/// still works without being written down.
pub fn list_directory(target: &FtpTarget, saved: Option<(&str, &str)>) -> Result<FtpListing, String> {
    let (username, password) = credentials(target, saved);
    let listing = talk(target, &username, &password)?;
    Ok(finish_listing(target, &username, listing))
}

fn credentials<'a>(target: &'a FtpTarget, saved: Option<(&'a str, &'a str)>) -> (String, String) {
    if !target.username.is_empty() {
        return (target.username.clone(), target.password.clone());
    }
    if let Some((user, pass)) = saved {
        if !user.is_empty() {
            return (user.to_string(), pass.to_string());
        }
    }
    ("anonymous".to_string(), "garia@".to_string())
}

fn finish_listing(target: &FtpTarget, username: &str, raw: Vec<FtpEntry>) -> FtpListing {
    let base = directory_url(target);
    let mut entries = Vec::new();
    let mut truncated = false;
    for mut entry in raw {
        if entry.name == "." || entry.name == ".." || entry.name.is_empty() {
            continue;
        }
        if entry.name.contains('/') || entry.name.contains('\0') {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        entry.url = if entry.dir {
            format!("{base}{}/", encode_segment(&entry.name))
        } else if target.username.is_empty() {
            format!("{base}{}", encode_segment(&entry.name))
        } else {
            // The only credential is in the URL. aria2 will not see the
            // netrc for this host, so the file URL has to carry who we are.
            // The picker shows the name, not this string.
            let host = host_for_url(&target.host, target.port);
            let user = encode_segment(&target.username);
            let pass = encode_segment(&target.password);
            let path = if target.path.is_empty() {
                format!("/{}", encode_segment(&entry.name))
            } else {
                format!("{}/{}", encode_path(&target.path), encode_segment(&entry.name))
            };
            format!("ftp://{user}:{pass}@{host}{path}")
        };
        entries.push(entry);
    }
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase())));
    FtpListing {
        url: base,
        host: target.host.clone(),
        path: if target.path.is_empty() {
            "/".to_string()
        } else {
            target.path.clone()
        },
        login: username.to_string(),
        entries,
        truncated,
    }
}

struct Control {
    writer: TcpStream,
    reader: BufReader<TcpStream>,
}

impl Control {
    fn connect(host: &str, port: u16) -> Result<Self, String> {
        let stream = connect(host, port)?;
        let reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        Ok(Self {
            writer: stream,
            reader,
        })
    }

    fn command(&mut self, line: &str) -> Result<(u16, String), String> {
        self.writer
            .write_all(format!("{line}\r\n").as_bytes())
            .and_then(|_| self.writer.flush())
            .map_err(|e| format!("The FTP connection dropped: {e}"))?;
        self.read_reply()
    }

    fn read_reply(&mut self) -> Result<(u16, String), String> {
        let mut text = String::new();
        loop {
            let mut line = String::new();
            let n = self
                .reader
                .read_line(&mut line)
                .map_err(|e| format!("The FTP server stopped answering: {e}"))?;
            if n == 0 {
                return Err("The FTP server closed the connection.".to_string());
            }
            text.push_str(&line);
            let trimmed = line.trim_end();
            if trimmed.len() >= 4
                && trimmed.as_bytes()[3] == b' '
                && trimmed.as_bytes()[..3].iter().all(|b| b.is_ascii_digit())
            {
                let code = trimmed[..3]
                    .parse()
                    .map_err(|_| "that server sent a reply we could not read".to_string())?;
                return Ok((code, text));
            }
            if text.len() > 32 * 1024 {
                return Err("that server's reply ran on".to_string());
            }
        }
    }

    fn peer_addr(&self) -> Result<SocketAddr, String> {
        self.writer
            .peer_addr()
            .map_err(|e| format!("lost the control connection: {e}"))
    }
}

fn talk(target: &FtpTarget, username: &str, password: &str) -> Result<Vec<FtpEntry>, String> {
    let mut control = Control::connect(&target.host, target.port)?;
    let greet = control.read_reply()?;
    if greet.0 != 220 {
        return Err(ftp_error(greet.0, &greet.1, "that server did not greet us"));
    }

    let user = control.command(&format!("USER {username}"))?;
    if user.0 == 331 {
        let pass = control.command(&format!("PASS {password}"))?;
        if !matches!(pass.0, 230 | 202) {
            return Err(auth_error(pass.0, &pass.1));
        }
    } else if !matches!(user.0, 230 | 202) {
        return Err(auth_error(user.0, &user.1));
    }

    let _ = control.command("TYPE I");
    let _ = control.command("OPTS UTF8 ON");

    if !target.path.is_empty() {
        let cwd = control.command(&format!("CWD {}", target.path))?;
        if cwd.0 == 550 {
            return Err("not-a-directory".to_string());
        }
        if !matches!(cwd.0, 250 | 200) {
            let rest = target.path.trim_start_matches('/');
            let again = control.command(&format!("CWD {rest}"))?;
            if again.0 == 550 {
                return Err("not-a-directory".to_string());
            }
            if !matches!(again.0, 250 | 200) {
                return Err(ftp_error(again.0, &again.1, "could not open that folder"));
            }
        }
    }

    let text = retrieve_listing(&mut control)?;
    let _ = control.command("QUIT");
    Ok(parse_listing(&text))
}

fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let host_for_dns = host.trim_start_matches('[').trim_end_matches(']');
    let addrs = (host_for_dns, port)
        .to_socket_addrs()
        .map_err(|e| format!("Could not look up {host}: {e}"))?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(format!("Could not look up {host}"));
    }
    let timeout = Duration::from_secs(CONNECT_SECS);
    let mut last = "could not connect".to_string();
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                apply_timeouts(&stream)?;
                return Ok(stream);
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("Could not reach {host}: {last}"))
}

fn apply_timeouts(stream: &TcpStream) -> Result<(), String> {
    let t = Duration::from_secs(IO_SECS);
    stream
        .set_read_timeout(Some(t))
        .and_then(|_| stream.set_write_timeout(Some(t)))
        .map_err(|e| e.to_string())
}

fn retrieve_listing(control: &mut Control) -> Result<String, String> {
    let data_addr = open_data_port(control)?;
    let data = TcpStream::connect_timeout(&data_addr, Duration::from_secs(CONNECT_SECS))
        .map_err(|e| format!("Could not open the data connection: {e}"))?;
    apply_timeouts(&data)?;

    let listed = control.command("MLSD");
    let used_mlsd = matches!(listed, Ok((code, _)) if (150..200).contains(&code));
    if !used_mlsd {
        let list = control.command("LIST")?;
        if !(150..200).contains(&list.0) {
            return Err(ftp_error(list.0, &list.1, "that server would not list the folder"));
        }
    }

    let mut buf = Vec::new();
    data.take(MAX_LISTING as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("The listing stopped arriving: {e}"))?;

    let done = control.read_reply()?;
    if !matches!(done.0, 226 | 250) {
        return Err(ftp_error(done.0, &done.1, "the listing did not finish"));
    }
    if buf.len() > MAX_LISTING {
        buf.truncate(MAX_LISTING);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn open_data_port(control: &mut Control) -> Result<SocketAddr, String> {
    let peer = control.peer_addr()?;
    if let Ok((229, text)) = control.command("EPSV") {
        if let Some(port) = parse_epsv(&text) {
            return Ok(SocketAddr::new(peer.ip(), port));
        }
    }
    let pasv = control.command("PASV")?;
    if pasv.0 != 227 {
        return Err(ftp_error(pasv.0, &pasv.1, "that server would not open a data port"));
    }
    let port = parse_pasv_port(&pasv.1)
        .ok_or_else(|| "that server's PASV reply was not a port".to_string())?;
    // The host in PASV is often a lie behind NAT. The port is the part we
    // need; the address is the one we already reached.
    Ok(SocketAddr::new(peer.ip(), port))
}

fn parse_epsv(text: &str) -> Option<u16> {
    let start = text.find("|||")?;
    let rest = &text[start + 3..];
    let end = rest.find('|')?;
    rest[..end].parse().ok()
}

fn parse_pasv_port(text: &str) -> Option<u16> {
    let start = text.find('(')?;
    let end = text[start + 1..].find(')')?;
    let nums: Vec<&str> = text[start + 1..start + 1 + end].split(',').collect();
    if nums.len() < 6 {
        return None;
    }
    let hi: u16 = nums[4].trim().parse().ok()?;
    let lo: u16 = nums[5].trim().parse().ok()?;
    Some(hi * 256 + lo)
}

fn auth_error(code: u16, text: &str) -> String {
    if matches!(code, 530 | 331 | 332) {
        "Needs a login — add one in Settings".to_string()
    } else {
        ftp_error(code, text, "the server refused the login")
    }
}

fn ftp_error(code: u16, text: &str, fallback: &str) -> String {
    let last = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(fallback);
    let message = last
        .trim()
        .trim_start_matches(|c: char| c.is_ascii_digit() || c == '-' || c == ' ')
        .trim();
    if message.is_empty() {
        format!("FTP {code}: {fallback}")
    } else {
        message.to_string()
    }
}

/// MLSD first (machine tags), then Unix `ls`, then DOS. A line that names
/// `.` or `..` is dropped by the caller; the parser keeps them so a test
/// can see they were recognised.
pub fn parse_listing(text: &str) -> Vec<FtpEntry> {
    let lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim_end_matches(['\r', '\n']))
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return Vec::new();
    }
    if lines.iter().any(|l| l.contains("type=") && l.contains(';')) {
        return lines.into_iter().filter_map(parse_mlsd).collect();
    }
    if lines.iter().any(|l| {
        l.len() > 10
            && matches!(l.as_bytes()[0], b'-' | b'd' | b'l')
            && l.as_bytes()[1].is_ascii_alphanumeric()
            || (l.len() > 10 && matches!(l.as_bytes()[0], b'-' | b'd' | b'l') && l[1..].starts_with("rw"))
    }) {
        let parsed: Vec<FtpEntry> = lines.iter().copied().filter_map(parse_unix).collect();
        if !parsed.is_empty() {
            return parsed;
        }
    }
    lines.into_iter().filter_map(parse_dos).collect()
}

fn parse_mlsd(line: &str) -> Option<FtpEntry> {
    let (facts, name) = line.split_once(' ')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let mut kind = "";
    let mut size = None;
    for fact in facts.split(';') {
        let Some((k, v)) = fact.split_once('=') else {
            continue;
        };
        match k.to_ascii_lowercase().as_str() {
            "type" => kind = v,
            "size" => size = v.parse().ok(),
            _ => {}
        }
    }
    let dir = matches!(kind, "dir" | "cdir" | "pdir");
    if kind == "cdir" || kind == "pdir" {
        // Current / parent — the dialog has Up for that.
        if name == "." || name == ".." {
            return None;
        }
    }
    Some(FtpEntry {
        name: name.to_string(),
        dir,
        size: if dir { None } else { size },
        url: String::new(),
    })
}

fn parse_unix(line: &str) -> Option<FtpEntry> {
    let bytes = line.as_bytes();
    if bytes.is_empty() || !matches!(bytes[0], b'-' | b'd' | b'l') {
        return None;
    }
    let dir = bytes[0] == b'd';
    let mut parts = line.split_whitespace();
    let _mode = parts.next()?;
    let _links = parts.next()?;
    let _user = parts.next()?;
    let _group = parts.next()?;
    let size = parts.next()?.parse().ok();
    let _month = parts.next()?;
    let _day = parts.next()?;
    let _time_or_year = parts.next()?;
    let name = parts.collect::<Vec<_>>().join(" ");
    let name = name.split(" -> ").next().unwrap_or(&name).trim();
    if name.is_empty() {
        return None;
    }
    Some(FtpEntry {
        name: name.to_string(),
        dir,
        size: if dir { None } else { size },
        url: String::new(),
    })
}

fn parse_dos(line: &str) -> Option<FtpEntry> {
    // 01-01-26  12:00PM       <DIR>          pub
    // 01-01-26  12:00PM                12345 file.zip
    let rest = line.trim();
    let mut parts = rest.split_whitespace();
    let date = parts.next()?;
    if !date.contains('-') && !date.contains('/') {
        return None;
    }
    let time = parts.next()?;
    if !time.contains(':') {
        return None;
    }
    let third = parts.next()?;
    if third.eq_ignore_ascii_case("<DIR>") {
        let name = parts.collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            return None;
        }
        return Some(FtpEntry {
            name,
            dir: true,
            size: None,
            url: String::new(),
        });
    }
    let size = third.parse().ok();
    let name = parts.collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return None;
    }
    Some(FtpEntry {
        name,
        dir: false,
        size,
        url: String::new(),
    })
}

/// A local server that speaks just enough FTP for the client tests.
/// PASV advertises 127.0.0.1 and the port we actually bound.
#[cfg(test)]
pub fn serve_fixture(listing: &str) -> (u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("ftp fixture bind");
    let port = listener.local_addr().unwrap().port();
    let body = listing.to_string();
    let handle = std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else { return };
        let _ = write_reply(&mut stream, 220, "ok");
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut data_listener: Option<TcpListener> = None;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).ok().unwrap_or(0) == 0 {
                break;
            }
            let cmd = line.trim_end().to_ascii_uppercase();
            if cmd.starts_with("USER ") {
                let _ = write_reply(&mut stream, 331, "password");
            } else if cmd.starts_with("PASS ") {
                let _ = write_reply(&mut stream, 230, "in");
            } else if cmd == "TYPE I" || cmd.starts_with("OPTS ") {
                let _ = write_reply(&mut stream, 200, "ok");
            } else if cmd.starts_with("CWD ") {
                if cmd.contains("MISSING") {
                    let _ = write_reply(&mut stream, 550, "no such file");
                } else {
                    let _ = write_reply(&mut stream, 250, "cwd");
                }
            } else if cmd == "EPSV" {
                let _ = write_reply(&mut stream, 500, "no");
            } else if cmd == "PASV" {
                let bound = TcpListener::bind("127.0.0.1:0").unwrap();
                let p = bound.local_addr().unwrap().port();
                let hi = p / 256;
                let lo = p % 256;
                data_listener = Some(bound);
                let _ = write_reply(
                    &mut stream,
                    227,
                    &format!("(127,0,0,1,{hi},{lo})"),
                );
            } else if cmd == "LIST" || cmd == "MLSD" {
                let _ = write_reply(&mut stream, 150, "here");
                if let Some(listener) = data_listener.take() {
                    if let Ok((mut data, _)) = listener.accept() {
                        let _ = data.write_all(body.as_bytes());
                    }
                }
                let _ = write_reply(&mut stream, 226, "done");
            } else if cmd == "QUIT" {
                let _ = write_reply(&mut stream, 221, "bye");
                break;
            } else {
                let _ = write_reply(&mut stream, 502, "no");
            }
        }
    });
    (port, handle)
}

#[cfg(test)]
fn write_reply(stream: &mut TcpStream, code: u16, text: &str) -> std::io::Result<()> {
    stream.write_all(format!("{code} {text}\r\n").as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_host_is_the_root() {
        let t = parse_ftp_url("ftp://ftp.gnu.org").unwrap();
        assert_eq!(t.host, "ftp.gnu.org");
        assert_eq!(t.port, 21);
        assert!(t.path.is_empty());
        assert_eq!(directory_url(&t), "ftp://ftp.gnu.org/");
    }

    #[test]
    fn a_path_loses_its_trailing_slash_until_we_put_it_back() {
        let t = parse_ftp_url("ftp://ftp.gnu.org/gnu/").unwrap();
        assert_eq!(t.path, "/gnu");
        assert_eq!(directory_url(&t), "ftp://ftp.gnu.org/gnu/");
    }

    #[test]
    fn userinfo_is_kept_for_the_listing_and_stripped_from_the_place() {
        let t = parse_ftp_url("ftp://alice:s3cret@files.example.com:2121/pub").unwrap();
        assert_eq!(t.username, "alice");
        assert_eq!(t.password, "s3cret");
        assert_eq!(t.port, 2121);
        assert_eq!(directory_url(&t), "ftp://files.example.com:2121/pub/");
    }

    #[test]
    fn ftps_is_refused_rather_than_silently_downgraded() {
        let err = parse_ftp_url("ftps://files.example.com/a").unwrap_err();
        assert!(err.contains("FTPS"));
    }

    #[test]
    fn mlsd_names_files_and_folders() {
        let entries = parse_listing(
            "type=dir;modify=20200101120000; pub\r\n\
             type=file;size=12345; readme.txt\r\n\
             type=cdir; .\r\n\
             type=pdir; ..\r\n",
        );
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.name == "pub" && e.dir));
        assert_eq!(
            entries.iter().find(|e| e.name == "readme.txt").unwrap().size,
            Some(12345)
        );
    }

    #[test]
    fn unix_ls_survives_a_symlink_and_a_space_in_the_name() {
        let entries = parse_listing(
            "drwxr-xr-x  2 ftp ftp     4096 Jan  1  2020 gnu\n\
             -rw-r--r--  1 ftp ftp    12345 Jan  1 12:00 read me.txt\n\
             lrwxrwxrwx  1 ftp ftp        4 Jan  1 12:00 latest -> 1.0\n",
        );
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().any(|e| e.name == "gnu" && e.dir && e.size.is_none()));
        assert_eq!(
            entries.iter().find(|e| e.name == "read me.txt").unwrap().size,
            Some(12345)
        );
        assert_eq!(
            entries.iter().find(|e| e.name == "latest").unwrap().dir,
            false
        );
    }

    #[test]
    fn dos_listing_uses_dir_marker() {
        let entries = parse_listing(
            "01-01-26  12:00PM       <DIR>          pub\r\n\
             01-01-26  01:02AM                99 file.zip\r\n",
        );
        assert_eq!(entries.len(), 2);
        assert!(entries[0].dir || entries[1].dir);
        assert_eq!(
            entries.iter().find(|e| e.name == "file.zip").unwrap().size,
            Some(99)
        );
    }

    #[test]
    fn pasv_port_is_the_only_number_we_trust() {
        assert_eq!(parse_pasv_port("227 Entering Passive Mode (10,0,0,1,19,136)."), Some(5000));
        assert_eq!(parse_epsv("229 Entering Extended Passive Mode (|||5000|)"), Some(5000));
    }

    #[test]
    fn the_client_lists_a_local_server() {
        let listing = "-rw-r--r--  1 ftp ftp  12 Jan  1 12:00 hello.txt\n\
                       drwxr-xr-x  2 ftp ftp   0 Jan  1 12:00 pub\n";
        let (port, handle) = serve_fixture(listing);
        let target = FtpTarget {
            host: "127.0.0.1".into(),
            port,
            path: String::new(),
            username: String::new(),
            password: String::new(),
        };
        let got = list_directory(&target, None).unwrap();
        handle.join().unwrap();
        assert_eq!(got.login, "anonymous");
        let base = format!("ftp://127.0.0.1:{port}/");
        assert_eq!(got.url, base);
        assert!(got.entries.iter().any(|e| e.name == "pub" && e.dir && e.url == format!("{base}pub/")));
        assert!(got.entries.iter().any(|e| e.name == "hello.txt" && !e.dir && e.url == format!("{base}hello.txt")));
    }

    #[test]
    fn a_missing_folder_is_not_a_directory() {
        let (port, handle) = serve_fixture("");
        let target = FtpTarget {
            host: "127.0.0.1".into(),
            port,
            path: "/missing".into(),
            username: String::new(),
            password: String::new(),
        };
        let err = list_directory(&target, None).unwrap_err();
        handle.join().ok();
        assert_eq!(err, "not-a-directory");
    }

    #[test]
    fn url_userinfo_is_written_onto_the_file_urls() {
        let target = FtpTarget {
            host: "files.example.com".into(),
            port: 21,
            path: "/pub".into(),
            username: "alice".into(),
            password: "s3cret".into(),
        };
        let listing = finish_listing(
            &target,
            "alice",
            vec![FtpEntry {
                name: "a.iso".into(),
                dir: false,
                size: Some(1),
                url: String::new(),
            }],
        );
        assert_eq!(listing.entries[0].url, "ftp://alice:s3cret@files.example.com/pub/a.iso");
        assert_eq!(listing.url, "ftp://files.example.com/pub/");
    }
}
