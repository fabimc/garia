//! Launch at login through an XDG autostart entry.
//!
//! The entry lives in `$XDG_CONFIG_HOME/autostart` (or `~/.config/autostart`)
//! and is written only when the user toggles the setting. Startup may add a
//! missing `--garia-background` flag, but never rewrites the executable path:
//! a test or dev build must not take over the user's real login entry.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const BACKGROUND_FLAG: &str = "--garia-background";

fn entry_path(config_home: Option<&OsStr>, home: Option<&Path>) -> io::Result<PathBuf> {
    let config = config_home
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .or_else(|| home.map(|path| path.join(".config")))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory unavailable"))?;
    Ok(config.join("autostart").join("Garia.desktop"))
}

fn desktop_entry(executable: &Path) -> io::Result<String> {
    let executable = executable.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "executable path is not UTF-8")
    })?;
    if executable.chars().any(|c| c.is_control()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "executable path contains a control character",
        ));
    }

    let mut exec = String::new();
    for c in executable.chars() {
        match c {
            '%' => exec.push_str("%%"),
            // Exec quoting is parsed after desktop-entry string escaping.
            '\\' => exec.push_str("\\\\\\\\"),
            '"' | '$' | '`' => {
                exec.push_str("\\\\");
                exec.push(c);
            }
            _ => exec.push(c),
        }
    }
    // StartupNotify=false: a background launch never maps a window, so a
    // launch-feedback cursor would spin until the desktop times it out.
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=Garia\nExec=\"{exec}\" {BACKGROUND_FLAG}\n\
         Terminal=false\nStartupNotify=false\n"
    ))
}

/// `(key, value)` for each line of the `[Desktop Entry]` group, by line index.
fn main_group(contents: &str) -> impl Iterator<Item = (usize, &str, &str)> {
    let mut in_main = false;
    contents.lines().enumerate().filter_map(move |(i, line)| {
        let line = line.trim();
        if line.starts_with('[') {
            in_main = line == "[Desktop Entry]";
            return None;
        }
        if !in_main || line.starts_with('#') {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        Some((i, key.trim(), value.trim()))
    })
}

fn enabled_at(entry: &Path) -> io::Result<bool> {
    let contents = match fs::read(entry) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    // Startup-apps managers switch an entry off in place rather than delete it.
    let switched_off = main_group(&contents).any(|(_, key, value)| {
        (key == "Hidden" && value == "true")
            || (key == "X-GNOME-Autostart-enabled" && value == "false")
    });
    Ok(!switched_off)
}

fn enable_at(entry: &Path, executable: &Path) -> io::Result<()> {
    let contents = desktop_entry(executable)?;
    let dir = entry.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "autostart directory unavailable",
        )
    })?;
    fs::create_dir_all(dir)?;
    fs::write(entry, contents)
}

fn disable_at(entry: &Path) -> io::Result<()> {
    match fs::remove_file(entry) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Append the background flag to an existing entry's Exec line and touch
/// nothing else — in particular not the executable it launches.
fn add_flag_at(entry: &Path) -> io::Result<()> {
    let contents = match fs::read_to_string(entry) {
        Ok(contents) => contents,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let Some((index, _, value)) = main_group(&contents).find(|(_, key, _)| *key == "Exec") else {
        return Ok(());
    };
    if value.split_whitespace().any(|arg| arg == BACKGROUND_FLAG) {
        return Ok(());
    }
    let mut updated = String::with_capacity(contents.len() + BACKGROUND_FLAG.len() + 1);
    for (i, line) in contents.split_inclusive('\n').enumerate() {
        if i == index {
            let body = line.trim_end_matches(['\r', '\n']);
            updated.push_str(body.trim_end());
            updated.push(' ');
            updated.push_str(BACKGROUND_FLAG);
            updated.push_str(&line[body.len()..]);
        } else {
            updated.push_str(line);
        }
    }
    fs::write(entry, updated)
}

fn config_home() -> Option<OsString> {
    std::env::var_os("XDG_CONFIG_HOME")
}

pub fn is_enabled(home: Option<&Path>) -> io::Result<bool> {
    enabled_at(&entry_path(config_home().as_deref(), home)?)
}

pub fn set_enabled(enabled: bool, executable: &Path, home: Option<&Path>) -> io::Result<()> {
    let entry = entry_path(config_home().as_deref(), home)?;
    if enabled {
        enable_at(&entry, executable)
    } else {
        disable_at(&entry)
    }
}

pub fn add_background_flag(home: Option<&Path>) -> io::Result<()> {
    add_flag_at(&entry_path(config_home().as_deref(), home)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory removed on drop, so a failing assert cleans up too.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "garia-autostart-{name}-{}-{nanos}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn xdg_config_home_or_default_home() {
        let home = Path::new("/home/test");
        assert_eq!(
            entry_path(Some(OsStr::new("/tmp/config")), Some(home)).unwrap(),
            Path::new("/tmp/config/autostart/Garia.desktop")
        );
        for value in [None, Some(OsStr::new("")), Some(OsStr::new("relative"))] {
            assert_eq!(
                entry_path(value, Some(home)).unwrap(),
                Path::new("/home/test/.config/autostart/Garia.desktop")
            );
        }
        assert!(entry_path(None, None).is_err());
        assert!(entry_path(Some(OsStr::new("/tmp/config")), None).is_ok());
    }

    #[test]
    fn enable_and_disable_only_touch_the_selected_entry() {
        let root = Scratch::new("select");
        let home = root.0.join("home");
        let default = entry_path(None, Some(&home)).unwrap();
        let custom = entry_path(Some(root.0.join("config").as_os_str()), Some(&home)).unwrap();
        enable_at(&default, Path::new("/real/garia")).unwrap();
        let original = fs::read(&default).unwrap();
        assert!(!enabled_at(&custom).unwrap());
        enable_at(&custom, Path::new("/test/garia")).unwrap();
        assert!(enabled_at(&custom).unwrap());
        assert_eq!(fs::read(&default).unwrap(), original);
        let written = fs::read_to_string(&custom).unwrap();
        assert!(written.contains("Exec=\"/test/garia\" --garia-background\n"));
        assert!(written.contains("StartupNotify=false\n"));
        assert!(written.contains("Terminal=false\n"));
        disable_at(&custom).unwrap();
        disable_at(&custom).unwrap();
        assert!(!enabled_at(&custom).unwrap());
        assert_eq!(fs::read(&default).unwrap(), original);
    }

    #[test]
    fn executable_is_safely_quoted_for_desktop_exec() {
        let entry = desktop_entry(Path::new("/a b/\\\"$`%f")).unwrap();
        assert!(entry.contains("Exec=\"/a b/\\\\\\\\\\\\\"\\\\$\\\\`%%f\" --garia-background\n"));
        assert!(desktop_entry(Path::new("/bad\npath")).is_err());
    }

    #[test]
    fn desktop_switched_off_entries_count_as_off() {
        let root = Scratch::new("hidden");
        let entry = root.0.join("Garia.desktop");
        for (body, on) in [
            ("[Desktop Entry]\nExec=garia\n", true),
            ("[Desktop Entry]\nExec=garia\nHidden=true\n", false),
            (
                "[Desktop Entry]\nExec=garia\nX-GNOME-Autostart-enabled=false\n",
                false,
            ),
            (
                "[Desktop Entry]\nExec=garia\nX-GNOME-Autostart-enabled=true\n",
                true,
            ),
            // Keys in another group belong to an action, not the entry.
            (
                "[Desktop Entry]\nExec=garia\n[Desktop Action x]\nHidden=true\n",
                true,
            ),
        ] {
            fs::write(&entry, body).unwrap();
            assert_eq!(enabled_at(&entry).unwrap(), on, "{body}");
        }
    }

    #[test]
    fn startup_only_adds_the_background_flag() {
        let root = Scratch::new("flag");
        let entry = root.0.join("Garia.desktop");
        add_flag_at(&entry).unwrap();
        assert!(!entry.try_exists().unwrap());

        let legacy = "[Desktop Entry]\nType=Application\nExec=/real/garia\nName=Garia\n";
        fs::write(&entry, legacy).unwrap();
        add_flag_at(&entry).unwrap();
        assert_eq!(
            fs::read_to_string(&entry).unwrap(),
            "[Desktop Entry]\nType=Application\nExec=/real/garia --garia-background\nName=Garia\n"
        );
        let once = fs::read(&entry).unwrap();
        add_flag_at(&entry).unwrap();
        assert_eq!(fs::read(&entry).unwrap(), once);

        // The plugin's old entry had no trailing newline.
        fs::write(&entry, "[Desktop Entry]\nExec=/real/garia ").unwrap();
        add_flag_at(&entry).unwrap();
        assert_eq!(
            fs::read_to_string(&entry).unwrap(),
            "[Desktop Entry]\nExec=/real/garia --garia-background"
        );
    }
}
