use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

pub fn read(path: &Path) -> Result<serde_json::Value, String> {
    match fs::read(path) {
        Ok(data) => {
            serde_json::from_slice(&data).map_err(|e| format!("Invalid download history: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(serde_json::json!({ "rows": [], "parts": [] }))
        }
        Err(e) => Err(format!("Cannot read download history: {e}")),
    }
}

pub fn write(path: &Path, history: &serde_json::Value) -> Result<(), String> {
    let data = serde_json::to_vec(history).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.new");
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    file.write_all(&data)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_round_trip_and_clear_keep_downloaded_file() {
        let dir = std::env::current_dir()
            .unwrap()
            .join(format!(".history-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.json");
        let downloaded = dir.join("download.bin");
        fs::write(&downloaded, b"download").unwrap();
        let value = serde_json::json!({"rows": [{"gid": "one"}], "parts": []});
        assert_eq!(
            read(&path).unwrap(),
            serde_json::json!({"rows": [], "parts": []})
        );
        write(&path, &value).unwrap();
        assert_eq!(read(&path).unwrap(), value);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        write(&path, &serde_json::json!({"rows": [], "parts": []})).unwrap();
        assert_eq!(fs::read(&downloaded).unwrap(), b"download");
        fs::write(&path, b"bad json").unwrap();
        assert!(read(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
