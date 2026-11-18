//! Finished downloads, kept by garia across relaunches.
//!
//! aria2's session file holds unfinished work only, and its list of stopped
//! downloads lives in memory: a quit, a SIGTERM, or a restart for new settings
//! empties it. This is the record of what landed, written the moment a
//! download is seen finishing — never only at Quit — so a process that is
//! killed keeps every row it had already seen.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

/// aria2's own `max-download-result`: the history keeps as many finished rows
/// as aria2 itself would have before a relaunch.
pub const MAX_ENTRIES: usize = 1000;

pub const TICK: std::time::Duration = std::time::Duration::from_secs(1);

/// What the list and the inspector read from a finished row. `bitfield` is
/// left out: a finished file is every piece, and on a big torrent it is most
/// of the record.
pub const KEYS: &[&str] = &[
    "gid",
    "status",
    "totalLength",
    "completedLength",
    "downloadSpeed",
    "dir",
    "errorCode",
    "errorMessage",
    "seeder",
    "uploadLength",
    "uploadSpeed",
    "connections",
    "infoHash",
    "followedBy",
    "following",
    "numPieces",
    "pieceLength",
    "files",
    "bittorrent",
];

/// Enough of a row to tell whether it has finished, without its files.
pub const PEEK_KEYS: &[&str] = &[
    "gid",
    "status",
    "totalLength",
    "completedLength",
    "seeder",
    "followedBy",
];

pub struct History {
    file: PathBuf,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Oldest first, the order they finished in.
    entries: Vec<Value>,
    rev: u64,
    /// Gids let go of in this run. A look at aria2 that was already under way
    /// when the user cleared a row must not write it back.
    forgotten: HashSet<String>,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub rev: u64,
    /// Absent when the caller already has this revision.
    pub entries: Option<Vec<Value>>,
}

fn text<'a>(item: &'a Value, key: &str) -> &'a str {
    item.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn number(item: &Value, key: &str) -> u64 {
    text(item, key).parse().unwrap_or(0)
}

fn gid_of(item: &Value) -> &str {
    text(item, "gid")
}

/// aria2's download of a magnet's `.torrent`. It finishes the moment the real
/// torrent starts, and is not a file the user asked for.
fn metadata(item: &Value) -> bool {
    let followed = item
        .get("followedBy")
        .and_then(Value::as_array)
        .is_some_and(|gids| !gids.is_empty());
    let leaf = item
        .get("files")
        .and_then(|f| f.get(0))
        .map(|f| text(f, "path"))
        .unwrap_or_default();
    let leaf = leaf.rsplit('/').next().unwrap_or(leaf);
    followed || leaf.starts_with("[METADATA]")
}

/// The rows the list calls finished: done, seeding, or a torrent whose seeding
/// was stopped with every byte in (aria2 files that as `removed`).
pub fn finished(item: &Value) -> bool {
    if gid_of(item).is_empty() || metadata(item) {
        return false;
    }
    match text(item, "status") {
        "complete" => true,
        "active" => text(item, "seeder") == "true",
        "removed" => {
            let total = number(item, "totalLength");
            total > 0 && number(item, "completedLength") == total
        }
        _ => false,
    }
}

/// The row as a later launch should show it: finished, and not moving.
fn entry_of(item: &Value, finished_at: i64) -> Value {
    let mut entry = serde_json::Map::new();
    for key in KEYS {
        if let Some(v) = item.get(*key) {
            entry.insert((*key).to_string(), v.clone());
        }
    }
    entry.insert("status".into(), "complete".into());
    for key in ["downloadSpeed", "uploadSpeed", "connections"] {
        entry.insert(key.into(), "0".into());
    }
    entry.remove("seeder");
    entry.insert("finishedAt".into(), finished_at.into());
    Value::Object(entry)
}

/// Only the keys asked for, the way aria2 answers `tellStatus` with a key list.
fn project(entry: &Value, keys: Option<&Value>) -> Value {
    let Some(keys) = keys.and_then(Value::as_array).filter(|k| !k.is_empty()) else {
        return entry.clone();
    };
    let mut out = serde_json::Map::new();
    for key in keys.iter().filter_map(Value::as_str) {
        if let Some(v) = entry.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    Value::Object(out)
}

fn read(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<Value>(&raw) else {
        eprintln!(
            "[garia] {} is not readable JSON; starting a new history",
            path.display()
        );
        return Vec::new();
    };
    let mut seen = HashSet::new();
    root.get("entries")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|e| {
                    e.is_object() && seen.insert(gid_of(e).to_string()) && !gid_of(e).is_empty()
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// A new file renamed over the old one, flushed first: a kill in the middle of
/// a write leaves the last good history, never half of one.
fn write(path: &Path, entries: &[Value]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_vec(&serde_json::json!({ "entries": entries }))
        .map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent().and_then(|p| fs::File::open(p).ok()) {
        let _ = dir.sync_all();
    }
    Ok(())
}

impl History {
    pub fn load(file: PathBuf) -> Self {
        let entries = read(&file);
        History {
            file,
            inner: Mutex::new(Inner {
                entries,
                rev: 1,
                forgotten: HashSet::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Not yet written down, and not cleared by the user in this run.
    pub fn wants(&self, gid: &str) -> bool {
        let inner = self.lock();
        !inner.forgotten.contains(gid) && !inner.entries.iter().any(|e| gid_of(e) == gid)
    }

    /// Writes down every finished row it has not seen. Answers whether the
    /// history changed; an error means the file on disk is behind.
    pub fn record<I: IntoIterator<Item = Value>>(
        &self,
        items: I,
        finished_at: i64,
    ) -> Result<bool, String> {
        let mut inner = self.lock();
        let mut changed = false;
        for item in items {
            let gid = gid_of(&item);
            if !finished(&item)
                || inner.forgotten.contains(gid)
                || inner.entries.iter().any(|e| gid_of(e) == gid)
            {
                continue;
            }
            inner.entries.push(entry_of(&item, finished_at));
            changed = true;
        }
        if !changed {
            return Ok(false);
        }
        let excess = inner.entries.len().saturating_sub(MAX_ENTRIES);
        inner.entries.drain(..excess);
        inner.rev += 1;
        write(&self.file, &inner.entries)?;
        Ok(true)
    }

    /// Lets go of a row for good. Answers whether the history had it.
    pub fn forget(&self, gid: &str) -> bool {
        if gid.is_empty() {
            return false;
        }
        let mut inner = self.lock();
        inner.forgotten.insert(gid.to_string());
        let before = inner.entries.len();
        inner.entries.retain(|e| gid_of(e) != gid);
        if inner.entries.len() == before {
            return false;
        }
        inner.rev += 1;
        if let Err(e) = write(&self.file, &inner.entries) {
            eprintln!("[garia] Could not update {}: {e}", self.file.display());
        }
        true
    }

    pub fn snapshot(&self, known_rev: u64) -> Snapshot {
        let inner = self.lock();
        Snapshot {
            rev: inner.rev,
            entries: (known_rev != inner.rev).then(|| inner.entries.clone()),
        }
    }

    fn entry(&self, gid: &str) -> Option<Value> {
        self.lock()
            .entries
            .iter()
            .find(|e| gid_of(e) == gid)
            .cloned()
    }

    /// What aria2 cannot say about a row it has never heard of. `failed` is
    /// whether aria2 refused the call. Some only when the answer changes.
    fn stand_in(&self, method: &str, params: &Value, failed: bool) -> Option<Value> {
        let gid = params.get(0).and_then(Value::as_str).unwrap_or_default();
        match method {
            "aria2.removeDownloadResult" => {
                let had = self.forget(gid);
                (failed && had).then(|| Value::from("OK"))
            }
            "aria2.tellStatus" if failed => self.entry(gid).map(|e| project(&e, params.get(1))),
            _ => None,
        }
    }

    /// aria2's answer to a call from the list, with the rows only the history
    /// knows filled in: forgetting one, and asking about one. aria2 refuses a
    /// single call with an HTTP 400, which arrives here as an `Err`.
    pub fn answer(
        &self,
        method: &str,
        params: &Value,
        out: Result<Value, String>,
    ) -> Result<Value, String> {
        if method != "system.multicall" {
            let failed = out.as_ref().map_or(true, |v| v.get("error").is_some());
            return match self.stand_in(method, params, failed) {
                Some(result) => {
                    Ok(serde_json::json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
                }
                None => out,
            };
        }
        let mut out = out?;
        let Some(calls) = params.get(0).and_then(Value::as_array) else {
            return Ok(out);
        };
        let Some(results) = out.get_mut("result").and_then(Value::as_array_mut) else {
            return Ok(out);
        };
        for (call, result) in calls.iter().zip(results.iter_mut()) {
            let method = text(call, "methodName");
            let params = call.get("params").cloned().unwrap_or(Value::Null);
            if let Some(value) = self.stand_in(method, &params, !result.is_array()) {
                *result = serde_json::json!([value]);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("garia-history-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("history.json")
    }

    fn done(gid: &str) -> Value {
        json!({
            "gid": gid, "status": "complete", "totalLength": "10", "completedLength": "10",
            "downloadSpeed": "0", "dir": "/tmp",
            "files": [{ "path": format!("/tmp/{gid}.bin"), "uris": [{ "uri": format!("https://example.com/{gid}.bin") }] }],
        })
    }

    #[test]
    fn a_finished_row_survives_a_relaunch() {
        let file = temp_file("relaunch");
        let history = History::load(file.clone());
        assert!(history.record([done("aaa"), done("bbb")], 42).unwrap());

        let again = History::load(file.clone());
        let rows = again.snapshot(0).entries.unwrap();
        assert_eq!(
            rows.iter().map(|r| gid_of(r)).collect::<Vec<_>>(),
            ["aaa", "bbb"]
        );
        assert_eq!(rows[0]["finishedAt"], 42);
        assert_eq!(rows[0]["files"][0]["path"], "/tmp/aaa.bin");
        assert!(!file.with_extension("json.tmp").exists());
    }

    #[test]
    fn only_finished_rows_are_written_down() {
        let history = History::load(temp_file("finished"));
        let running = json!({ "gid": "run", "status": "active", "totalLength": "10", "completedLength": "3" });
        let seeding =
            json!({ "gid": "seed", "status": "active", "seeder": "true", "uploadSpeed": "900" });
        let unseeded = json!({ "gid": "unseed", "status": "removed", "totalLength": "10", "completedLength": "10" });
        let cancelled = json!({ "gid": "cancel", "status": "removed", "totalLength": "10", "completedLength": "4" });
        let failed = json!({ "gid": "err", "status": "error" });
        let meta = json!({ "gid": "meta", "status": "complete", "followedBy": ["seed"] });
        let meta_file = json!({ "gid": "meta2", "status": "complete", "files": [{ "path": "/d/[METADATA]abc.torrent" }] });
        history
            .record(
                [
                    running, seeding, unseeded, cancelled, failed, meta, meta_file,
                ],
                1,
            )
            .unwrap();

        let rows = history.snapshot(0).entries.unwrap();
        assert_eq!(
            rows.iter().map(|r| gid_of(r)).collect::<Vec<_>>(),
            ["seed", "unseed"]
        );
        assert!(rows
            .iter()
            .all(|r| r["status"] == "complete" && r.get("seeder").is_none()));
        assert_eq!(rows[0]["uploadSpeed"], "0");
    }

    #[test]
    fn a_row_is_written_down_once() {
        let history = History::load(temp_file("once"));
        assert!(history.record([done("aaa")], 1).unwrap());
        assert!(!history.record([done("aaa")], 2).unwrap());
        assert!(!history.wants("aaa"));
        assert_eq!(history.snapshot(0).entries.unwrap()[0]["finishedAt"], 1);
    }

    #[test]
    fn a_cleared_row_stays_cleared() {
        let file = temp_file("cleared");
        let history = History::load(file.clone());
        history.record([done("aaa"), done("bbb")], 1).unwrap();
        assert!(history.forget("aaa"));
        // A look at aria2 that started before the clear must not undo it.
        assert!(!history.record([done("aaa")], 2).unwrap());
        assert!(!history.wants("aaa"));

        let rows = History::load(file).snapshot(0).entries.unwrap();
        assert_eq!(rows.iter().map(|r| gid_of(r)).collect::<Vec<_>>(), ["bbb"]);
    }

    #[test]
    fn the_oldest_rows_go_first() {
        let history = History::load(temp_file("cap"));
        let rows: Vec<Value> = (0..MAX_ENTRIES + 3)
            .map(|i| done(&format!("g{i}")))
            .collect();
        history.record(rows, 1).unwrap();
        let kept = history.snapshot(0).entries.unwrap();
        assert_eq!(kept.len(), MAX_ENTRIES);
        assert_eq!(gid_of(&kept[0]), "g3");
    }

    #[test]
    fn an_unchanged_history_is_not_sent_again() {
        let history = History::load(temp_file("rev"));
        let first = history.snapshot(0);
        assert!(first.entries.is_some());
        assert!(history.snapshot(first.rev).entries.is_none());
        history.record([done("aaa")], 1).unwrap();
        assert!(history.snapshot(first.rev).entries.is_some());
    }

    #[test]
    fn a_broken_file_is_an_empty_history() {
        let file = temp_file("broken");
        fs::write(&file, "{ not json").unwrap();
        assert!(History::load(file).snapshot(0).entries.unwrap().is_empty());
    }

    /// How aria2 refuses one call: an HTTP 400, which `aria2_request` reports
    /// as an error string.
    fn refused() -> Result<Value, String> {
        Err("aria2 request failed: http://127.0.0.1:6800/jsonrpc: status code 400".into())
    }

    #[test]
    fn forgetting_a_row_only_the_history_knows_is_ok() {
        let history = History::load(temp_file("purge"));
        history.record([done("old")], 1).unwrap();
        let out = history
            .answer("aria2.removeDownloadResult", &json!(["old"]), refused())
            .unwrap();
        assert_eq!(out["result"], "OK");
        assert!(history.snapshot(0).entries.unwrap().is_empty());

        // A gid nobody knows is still aria2's refusal to pass on.
        let out = history.answer("aria2.removeDownloadResult", &json!(["nobody"]), refused());
        assert!(out.is_err());
    }

    #[test]
    fn forgetting_through_aria2_forgets_here_too() {
        let history = History::load(temp_file("both"));
        history.record([done("live")], 1).unwrap();
        let ok = json!({ "jsonrpc": "2.0", "id": 1, "result": "OK" });
        assert_eq!(
            history.answer(
                "aria2.removeDownloadResult",
                &json!(["live"]),
                Ok(ok.clone())
            ),
            Ok(ok)
        );
        assert!(history.snapshot(0).entries.unwrap().is_empty());
    }

    #[test]
    fn a_batch_of_forgets_answers_each_call() {
        let history = History::load(temp_file("batch"));
        history.record([done("old")], 1).unwrap();
        let calls = json!([[
            { "methodName": "aria2.removeDownloadResult", "params": ["old"] },
            { "methodName": "aria2.removeDownloadResult", "params": ["nobody"] },
        ]]);
        let fault = json!({ "code": 1, "message": "not found" });
        let out = json!({ "jsonrpc": "2.0", "id": 1, "result": [fault, fault] });
        let out = history.answer("system.multicall", &calls, Ok(out)).unwrap();
        assert_eq!(out["result"][0], json!(["OK"]));
        assert_eq!(out["result"][1], fault);
    }

    #[test]
    fn asking_about_an_old_row_answers_from_the_history() {
        let history = History::load(temp_file("status"));
        history.record([done("old")], 1).unwrap();
        let out = history
            .answer(
                "aria2.tellStatus",
                &json!(["old", ["status", "dir"]]),
                refused(),
            )
            .unwrap();
        assert_eq!(
            out["result"],
            json!({ "status": "complete", "dir": "/tmp" })
        );

        // aria2's own answer always wins.
        let live = json!({ "jsonrpc": "2.0", "id": 1, "result": { "status": "active" } });
        assert_eq!(
            history.answer("aria2.tellStatus", &json!(["old"]), Ok(live.clone())),
            Ok(live)
        );
        assert!(history
            .answer("aria2.tellStatus", &json!(["nobody"]), refused())
            .is_err());
    }
}
