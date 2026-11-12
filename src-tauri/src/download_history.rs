use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use serde_json::Value;

pub fn read(path: &Path) -> Vec<Value> {
    let rows = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
        .unwrap_or_default();
    rows.into_iter().filter(is_completed).collect()
}

pub fn write(path: &Path, rows: &[Value]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(rows).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("tmp");
    let result = (|| {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(data.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result.map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record(rows: &mut Vec<Value>, incoming: &[Value]) -> bool {
    let mut changed = false;
    for row in incoming.iter().filter(|row| is_completed(row)) {
        let mut row = row.clone();
        if let Some(object) = row.as_object_mut() {
            object.remove("historyOnly");
        }
        let gid = row.get("gid").and_then(Value::as_str).unwrap_or_default();
        if gid.is_empty() {
            continue;
        }
        if let Some(saved) = rows
            .iter_mut()
            .find(|saved| saved.get("gid").and_then(Value::as_str) == Some(gid))
        {
            if *saved != row {
                *saved = row;
                changed = true;
            }
        } else {
            rows.push(row);
            changed = true;
        }
    }
    changed
}

pub fn forget(rows: &mut Vec<Value>, gids: &[String]) -> bool {
    let before = rows.len();
    rows.retain(|row| {
        !row.get("gid")
            .and_then(Value::as_str)
            .is_some_and(|gid| gids.iter().any(|forgotten| forgotten == gid))
    });
    rows.len() != before
}

fn is_completed(row: &Value) -> bool {
    row.get("gid")
        .and_then(Value::as_str)
        .is_some_and(|gid| !gid.is_empty())
        && row
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| matches!(status, "complete" | "seeding"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("garia-download-history-{}", std::process::id()))
            .join(name)
    }

    #[test]
    fn completed_rows_survive_relaunch_and_can_be_cleared() {
        let path = temp_file("download-history.json");
        let _ = fs::remove_dir_all(path.parent().unwrap());
        let downloaded_file = path.parent().unwrap().join("downloaded-file");
        fs::create_dir_all(downloaded_file.parent().unwrap()).unwrap();
        fs::write(&downloaded_file, b"downloaded").unwrap();
        let mut rows = Vec::new();
        assert!(record(
            &mut rows,
            &[
                serde_json::json!({"gid":"finished", "status":"complete", "files":[{"path":downloaded_file}]}),
                serde_json::json!({"gid":"seeding", "status":"seeding"}),
                serde_json::json!({"gid":"unfinished", "status":"active"}),
            ],
        ));
        write(&path, &rows).unwrap();

        // A new process reads the store as-is; no shutdown hook is needed.
        let mut relaunched = read(&path);
        assert_eq!(relaunched.len(), 2);
        assert_eq!(relaunched[0]["gid"], "finished");
        assert_eq!(
            relaunched[0]["files"][0]["path"],
            downloaded_file.display().to_string()
        );
        assert_eq!(relaunched[1]["status"], "seeding");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        assert!(forget(
            &mut relaunched,
            &["finished".into(), "seeding".into()]
        ));
        write(&path, &relaunched).unwrap();
        assert!(read(&path).is_empty());
        assert!(downloaded_file.exists());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn recording_updates_a_row_once_and_ignores_invalid_statuses() {
        let mut rows =
            vec![serde_json::json!({"gid":"finished", "status":"complete", "name":"old"})];
        assert!(record(
            &mut rows,
            &[
                serde_json::json!({"gid":"finished", "status":"complete", "name":"new", "historyOnly":true}),
                serde_json::json!({"gid":"unfinished", "status":"paused"}),
                serde_json::json!({"status":"complete"}),
            ],
        ));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "new");
        assert!(rows[0].get("historyOnly").is_none());
        let unchanged = rows[0].clone();
        assert!(!record(&mut rows, &[unchanged]));
    }
}
