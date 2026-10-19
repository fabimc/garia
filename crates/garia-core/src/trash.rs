//! Move finished or cancelled download files to the system trash.

use std::path::{Path, PathBuf};

pub fn trash_files(paths: Vec<String>) -> Result<(), String> {
    for p in paths {
        let path = Path::new(&p);
        if !path.is_file() {
            continue;
        }
        trash::delete(path).map_err(|e| format!("could not move {p} to the Trash: {e}"))?;
        let control = PathBuf::from(format!("{p}.aria2"));
        if control.is_file() {
            let _ = trash::delete(&control);
        }
    }
    Ok(())
}
