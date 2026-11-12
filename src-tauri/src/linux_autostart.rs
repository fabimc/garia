use std::io;
use std::path::{Path, PathBuf};

fn entry_path(config: Option<&Path>, home: Option<&Path>) -> io::Result<PathBuf> {
    let base = config
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .or_else(|| home.map(|path| path.join(".config")))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Home directory not found"))?;
    Ok(base.join("autostart").join("Garia.desktop"))
}

fn path() -> io::Result<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let home = dirs::home_dir();
    entry_path(config.as_deref(), home.as_deref())
}

fn desktop_exec(executable: &Path) -> io::Result<String> {
    let text = executable.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Executable path is not UTF-8")
    })?;
    if text.chars().any(|c| c.is_control()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid executable path",
        ));
    }
    let mut quoted = String::from("\"");
    for c in text.chars() {
        match c {
            '\\' => quoted.push_str("\\\\\\\\"),
            '"' | '$' | '`' => {
                quoted.push_str("\\\\");
                quoted.push(c);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

pub fn enabled() -> io::Result<bool> {
    match std::fs::metadata(path()?) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

pub fn set(enabled: bool, executable: &Path) -> io::Result<()> {
    set_entry(&path()?, enabled, executable)
}

fn set_entry(file: &Path, enabled: bool, executable: &Path) -> io::Result<()> {
    if enabled {
        let exec = desktop_exec(executable)?;
        std::fs::create_dir_all(file.parent().unwrap())?;
        std::fs::write(file, format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Garia\nComment=Garia startup script\nExec={exec} --garia-background\nStartupNotify=false\nTerminal=false\n"
        ))
    } else {
        match std::fs::remove_file(file) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xdg_config_home_or_home_fallback() {
        let home = Path::new("/home/test");
        assert_eq!(
            entry_path(Some(Path::new("/tmp/config")), Some(home)).unwrap(),
            Path::new("/tmp/config/autostart/Garia.desktop")
        );
        assert_eq!(
            entry_path(Some(Path::new("relative")), Some(home)).unwrap(),
            Path::new("/home/test/.config/autostart/Garia.desktop")
        );
        assert!(entry_path(None, None).is_err());
    }

    #[test]
    fn executable_is_quoted_for_desktop_entry() {
        assert_eq!(
            desktop_exec(Path::new("/opt/My App/garia")).unwrap(),
            "\"/opt/My App/garia\""
        );
        assert_eq!(
            desktop_exec(Path::new("/a%/b\\c\"$`")).unwrap(),
            "\"/a%%/b\\\\\\\\c\\\\\"\\\\$\\\\`\""
        );
        assert!(desktop_exec(Path::new("/bad\npath")).is_err());
    }

    #[test]
    fn enable_and_disable_only_touch_the_selected_entry() {
        let root = std::env::temp_dir().join(format!(
            "garia-autostart-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = root.join("home");
        let config = root.join("custom");
        let selected = entry_path(Some(&config), Some(&home)).unwrap();
        let other = entry_path(None, Some(&home)).unwrap();
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, "unchanged").unwrap();

        set_entry(&selected, true, Path::new("/opt/My App/garia")).unwrap();
        let contents = std::fs::read_to_string(&selected).unwrap();
        assert!(contents.contains("Exec=\"/opt/My App/garia\" --garia-background\n"));
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "unchanged");
        set_entry(&selected, false, Path::new("/unused")).unwrap();
        set_entry(&selected, false, Path::new("/unused")).unwrap();
        assert!(!selected.exists());
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "unchanged");
        std::fs::remove_dir_all(root).unwrap();
    }
}
