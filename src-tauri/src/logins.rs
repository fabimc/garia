//! Downloads behind a login, and the question the feature is actually about:
//! where the credentials live.
//!
//! Three ways to prove who you are, and they are not the same promise:
//!
//! * **A password** goes into a netrc file (0600) that aria2 reads for itself,
//!   per request, per host. It is never a download option — measured against
//!   aria2 1.37, `http-passwd` given at `addUri` is written verbatim into the
//!   session file, and handed back by `getOption` to anything holding the RPC
//!   token. netrc keeps it out of both.
//! * **A header** is a literal aria2 has to carry on the request, so it *is*
//!   a download option, and it does land in the session file. That is the
//!   cost of a bearer token, and the dialog says so rather than pretending.
//! * **A cookie jar** is a path. Nothing is copied: the file stays the
//!   browser's export, and aria2 re-reads it at launch.
//!
//! Two constraints netrc puts on this, both measured rather than assumed:
//! aria2 ignores a netrc that anyone but its owner can read, and netrc has no
//! quoting at all — `password "two words"` is read as the literal `"two`. So a
//! password with whitespace in it cannot go through netrc, and garia turns
//! that one into an `Authorization:` header instead, which works for any
//! password and is honest about being written down.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// A site garia knows how to sign in to. This is garia's own record, kept in
/// `logins.json` at 0600 — the netrc beside it is *derived* from these, for
/// aria2 to read.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Login {
    /// The bare host, lowercased. Matching is exact: netrc matches the host
    /// aria2 is talking to, and garia matches headers the same way, so the two
    /// can never disagree about which site a credential is for.
    pub host: String,
    pub username: String,
    pub password: String,
    /// `Name: value` lines, as typed.
    pub headers: Vec<String>,
}

/// What the frontend is allowed to know. Never the password — the dialog can
/// say a site has one and offer to replace it, which is all it needs.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginView {
    pub host: String,
    pub username: String,
    pub has_password: bool,
    /// This password could not go in the netrc, so it rides on the request as
    /// an `Authorization:` header — and is written into aria2's session file
    /// along with it.
    pub via_header: bool,
    /// The headers as typed, for the editor.
    pub headers: Vec<String>,
    /// The headers garia adds itself. Sent with the download, not shown in the
    /// editor, because nobody typed them.
    pub extra_headers: Vec<String>,
}

/// The host part of whatever was typed — a URL, a host with a port, a bare
/// name. Anything that isn't a host is not a host: the caller decides what an
/// empty string means.
pub fn host_of(input: &str) -> String {
    let mut s = input.trim();
    if let Some((_, rest)) = s.split_once("://") {
        s = rest;
    }
    // Path, query and fragment all sit after the authority.
    s = s.split(['/', '?', '#']).next().unwrap_or("");
    // user:pass@host — the userinfo is not the host, and is not somewhere to
    // keep a password either.
    if let Some((_, rest)) = s.rsplit_once('@') {
        s = rest;
    }
    // A bracketed IPv6 literal keeps its colons; everything else loses its port.
    let host = if let Some(end) = s.strip_prefix('[').and_then(|r| r.find(']')) {
        &s[..end + 2]
    } else {
        s.split(':').next().unwrap_or("")
    };
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// netrc is whitespace-separated with no quoting and no escapes, so a value
/// containing whitespace cannot be written down in it at all.
pub fn netrc_can_hold(value: &str) -> bool {
    !value.is_empty() && !value.chars().any(char::is_whitespace)
}

/// A header has to name something. Everything else about it is the server's
/// business, not ours.
pub fn tidy_headers(headers: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for line in headers {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match line.split_once(':') {
            Some((name, _)) if !name.trim().is_empty() => out.push(line.to_string()),
            _ => return Err(format!("\"{line}\" is not a header — write it as Name: value")),
        }
    }
    Ok(out)
}

/// A missing or unreadable file is a machine with no logins on it, which is
/// every machine until someone adds one.
pub fn read(file: &Path) -> Vec<Login> {
    fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Login>>(&text).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|l| !l.host.is_empty())
        .collect()
}

/// garia's own store. 0600 because it holds passwords: the netrc next to it is
/// only what aria2 is allowed to see.
pub fn write(file: &Path, logins: &[Login]) -> io::Result<()> {
    let json = serde_json::to_string_pretty(logins)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(file, json)?;
    owner_only(file)
}

/// The netrc aria2 reads, rebuilt from the store every time it changes.
/// Returns whether there is anything in it — an empty netrc is deleted rather
/// than left behind, so that a machine with no logins leaves aria2's own
/// default (the user's `~/.netrc`) exactly as it found it.
pub fn write_netrc(file: &Path, logins: &[Login]) -> io::Result<bool> {
    let mut text = String::from(
        "# Written by garia — edits here are overwritten.\n\
         # aria2 reads this at launch. Nothing in it is attached to a download,\n\
         # so no password reaches aria2's session file.\n",
    );
    let mut any = false;
    for login in logins {
        if login.host.is_empty() || login.username.is_empty() || !netrc_can_hold(&login.password) {
            continue;
        }
        text.push_str(&format!(
            "\nmachine {}\n  login {}\n  password {}\n",
            login.host, login.username, login.password
        ));
        any = true;
    }

    if !any {
        // A netrc with no machines in it is not the same as no netrc: the
        // second is what leaves aria2 looking where it would have looked.
        if file.exists() {
            fs::remove_file(file)?;
        }
        return Ok(false);
    }

    fs::write(file, text)?;
    // aria2 ignores a netrc that anyone but its owner can read — silently, with
    // no auth header on the wire at all. Measured, not assumed.
    owner_only(file)?;
    Ok(true)
}

#[cfg(unix)]
fn owner_only(file: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(file, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn owner_only(_file: &Path) -> io::Result<()> {
    Ok(())
}

/// What the frontend gets: every site, no password, and the headers garia will
/// add on its behalf.
pub fn views(logins: &[Login]) -> Vec<LoginView> {
    logins
        .iter()
        .map(|login| {
            let has_password = !login.password.is_empty();
            let via_header = has_password && !netrc_can_hold(&login.password);
            let extra_headers = if via_header {
                vec![format!(
                    "Authorization: Basic {}",
                    base64(format!("{}:{}", login.username, login.password).as_bytes())
                )]
            } else {
                Vec::new()
            };
            LoginView {
                host: login.host.clone(),
                username: login.username.clone(),
                has_password,
                via_header,
                headers: login.headers.clone(),
                extra_headers,
            }
        })
        .collect()
}

/// Basic auth is base64, and base64 is twenty lines. Carrying a crate to hold
/// them would be the larger thing to maintain.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_gives_up_its_host() {
        assert_eq!(host_of("https://files.example.com/big.iso?x=1"), "files.example.com");
        assert_eq!(host_of("  HTTP://Example.COM:8080/  "), "example.com");
        assert_eq!(host_of("example.com"), "example.com");
    }

    #[test]
    fn userinfo_is_not_the_host() {
        assert_eq!(host_of("https://alice:hunter2@example.com/f"), "example.com");
    }

    #[test]
    fn an_ipv6_literal_keeps_its_colons() {
        assert_eq!(host_of("http://[::1]:6800/jsonrpc"), "[::1]");
    }

    #[test]
    fn netrc_cannot_quote_a_space() {
        assert!(netrc_can_hold("hunter2"));
        assert!(!netrc_can_hold("two words"));
        assert!(!netrc_can_hold(""));
    }

    #[test]
    fn a_header_has_to_name_something() {
        assert_eq!(
            tidy_headers(&["X-Token: abc".into(), "  ".into()]).unwrap(),
            vec!["X-Token: abc".to_string()]
        );
        assert!(tidy_headers(&["not a header".into()]).is_err());
        assert!(tidy_headers(&[": nothing".into()]).is_err());
    }

    #[test]
    fn a_password_netrc_refuses_becomes_a_header() {
        let logins = vec![
            Login {
                host: "a.example".into(),
                username: "alice".into(),
                password: "hunter2".into(),
                headers: vec![],
            },
            Login {
                host: "b.example".into(),
                username: "bob".into(),
                password: "two words".into(),
                headers: vec![],
            },
        ];
        let views = views(&logins);
        assert!(!views[0].via_header);
        assert!(views[0].extra_headers.is_empty());
        assert!(views[1].via_header);
        assert_eq!(views[1].extra_headers, vec!["Authorization: Basic Ym9iOnR3byB3b3Jkcw==".to_string()]);
    }

    #[test]
    fn the_view_never_carries_the_password() {
        let logins = vec![Login {
            host: "a.example".into(),
            username: "alice".into(),
            password: "hunter2".into(),
            headers: vec!["X-Token: abc".into()],
        }];
        let json = serde_json::to_string(&views(&logins)).unwrap();
        assert!(!json.contains("hunter2"));
        assert!(json.contains("\"hasPassword\":true"));
    }

    /// The file aria2 actually reads. Written to a fixed place so the live
    /// check — pointing a real aria2 at it against a server that demands
    /// Basic auth — has something to point at.
    #[test]
    fn the_netrc_is_written_in_the_form_aria2_reads() {
        let dir = std::env::temp_dir().join("garia-logins-test");
        fs::create_dir_all(&dir).unwrap();
        let netrc = dir.join("netrc");

        let logins = vec![
            Login {
                host: "127.0.0.1".into(),
                username: "alice".into(),
                password: "s3cr3t-pass".into(),
                headers: vec![],
            },
            // netrc cannot hold this one, so it must not appear in the file at
            // all — a half-written machine line would be worse than none.
            Login {
                host: "spaces.example".into(),
                username: "bob".into(),
                password: "two words".into(),
                headers: vec![],
            },
            // Headers only: nothing for aria2 to authenticate with.
            Login {
                host: "headers.example".into(),
                username: String::new(),
                password: String::new(),
                headers: vec!["X-Token: abc".into()],
            },
        ];

        assert!(write_netrc(&netrc, &logins).unwrap());
        let text = fs::read_to_string(&netrc).unwrap();
        assert!(text.contains("machine 127.0.0.1\n  login alice\n  password s3cr3t-pass\n"));
        assert!(!text.contains("spaces.example"));
        assert!(!text.contains("two words"));
        assert!(!text.contains("headers.example"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // aria2 ignores a netrc anyone else can read, and says nothing.
            let mode = fs::metadata(&netrc).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // Every login gone means no netrc, not an empty one: the file's
        // absence is what leaves aria2 reading the user's own ~/.netrc.
        assert!(!write_netrc(&netrc, &[]).unwrap());
        assert!(!netrc.exists());

        // Left behind on purpose for the live check.
        write_netrc(&netrc, &logins).unwrap();
    }

    #[test]
    fn base64_matches_the_examples_everyone_knows() {
        assert_eq!(base64(b"Aladdin:open sesame"), "QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b""), "");
    }
}
