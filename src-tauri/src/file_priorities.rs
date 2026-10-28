//! Per-torrent file priority overrides. aria2 has no per-file piece priority;
//! garia remembers High / Normal / Low / Off by info hash so a relaunch keeps
//! the user's intent.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub type PriorityMap = HashMap<String, HashMap<String, String>>;

pub fn read(path: &Path) -> PriorityMap {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return PriorityMap::new(),
    };
    serde_json::from_str(&raw).unwrap_or_else(|_| PriorityMap::new())
}

pub fn write(path: &Path, map: &PriorityMap) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(path, perms);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("garia-fp-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("file-priorities.json");
        let mut map = PriorityMap::new();
        let mut inner = HashMap::new();
        inner.insert("1".into(), "high".into());
        map.insert("bt:abc".into(), inner);
        write(&path, &map).unwrap();
        let back = read(&path);
        assert_eq!(back.get("bt:abc").and_then(|m| m.get("1")).map(String::as_str), Some("high"));
        let _ = fs::remove_dir_all(dir);
    }
}
