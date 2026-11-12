use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=Garia\nExec=\"{exec}\" --garia-background\n"
    ))
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

fn current_entry(home: Option<&Path>) -> io::Result<PathBuf> {
    entry_path(std::env::var_os("XDG_CONFIG_HOME").as_deref(), home)
}

pub fn is_enabled(home: Option<&Path>) -> io::Result<bool> {
    current_entry(home)?.try_exists()
}

pub fn set_enabled(enabled: bool, home: Option<&Path>) -> io::Result<()> {
    let entry = current_entry(home)?;
    if enabled {
        let executable = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(Ok)
            .unwrap_or_else(std::env::current_exe)?;
        enable_at(&entry, &executable)
    } else {
        disable_at(&entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let root = std::env::temp_dir().join(format!(
            "garia-autostart-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let home = root.join("home");
        let default = entry_path(None, Some(&home)).unwrap();
        let custom = entry_path(Some(root.join("config").as_os_str()), Some(&home)).unwrap();
        enable_at(&default, Path::new("/real/garia")).unwrap();
        let original = fs::read(&default).unwrap();
        enable_at(&custom, Path::new("/test/garia")).unwrap();
        assert!(custom.try_exists().unwrap());
        assert_eq!(fs::read(&default).unwrap(), original);
        assert!(fs::read_to_string(&custom)
            .unwrap()
            .contains("Exec=\"/test/garia\" --garia-background"));
        disable_at(&custom).unwrap();
        disable_at(&custom).unwrap();
        assert!(!custom.try_exists().unwrap());
        assert_eq!(fs::read(&default).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executable_is_safely_quoted_for_desktop_exec() {
        let entry = desktop_entry(Path::new("/a b/\\\"$`%f")).unwrap();
        assert!(entry.contains("Exec=\"/a b/\\\\\\\\\\\\\"\\\\$\\\\`%%f\" --garia-background\n"));
        assert!(desktop_entry(Path::new("/bad\npath")).is_err());
    }

    #[test]
    fn public_operations_follow_xdg_without_refreshing_existing_entries() {
        let root =
            std::env::temp_dir().join(format!("garia-autostart-env-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let old_config = std::env::var_os("XDG_CONFIG_HOME");
        std::env::set_var("XDG_CONFIG_HOME", root.join("custom"));
        let home = root.join("home");
        let default = entry_path(None, Some(&home)).unwrap();
        enable_at(&default, Path::new("/real/garia")).unwrap();
        let original = fs::read(&default).unwrap();
        assert!(!is_enabled(Some(&home)).unwrap());
        set_enabled(true, Some(&home)).unwrap();
        assert!(is_enabled(Some(&home)).unwrap());
        let custom = root.join("custom/autostart/Garia.desktop");
        let contents = fs::read(&custom).unwrap();
        assert!(is_enabled(Some(&home)).unwrap());
        assert_eq!(fs::read(&custom).unwrap(), contents);
        set_enabled(false, Some(&home)).unwrap();
        assert!(!is_enabled(Some(&home)).unwrap());
        assert_eq!(fs::read(&default).unwrap(), original);
        match old_config {
            Some(value) => std::env::set_var("XDG_CONFIG_HOME", value),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
        fs::remove_dir_all(root).unwrap();
    }
}
