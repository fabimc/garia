//! Process helpers: capped runs, probe cancel, ffmpeg progress.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub fn is_executable(path: &str) -> bool {
    Path::new(path).is_file()
}

/// Runs a command, killing it if it outstays `secs`. `Command` has no timeout
/// of its own, and a yt-dlp waiting on a site that never answers would
/// otherwise hang the probe until the app quits.
pub fn run_capped(
    program: &str,
    args: &[String],
    secs: u64,
) -> Result<std::process::Output, String> {
    run_capped_env(program, args, secs, &[])
}

pub fn run_capped_env(
    program: &str,
    args: &[String],
    secs: u64,
    env: &[(&str, &str)],
) -> Result<std::process::Output, String> {
    run_watched(program, args, secs, env, false)
}

/// Bumped when the Add dialog closes. A probe started before the bump is no
/// longer wanted, and yt-dlp reading a slow page can take a minute to say so.
pub static PROBES_CANCELLED: AtomicU64 = AtomicU64::new(0);

pub fn cancel_video_probes() {
    PROBES_CANCELLED.fetch_add(1, Ordering::SeqCst);
}

pub fn run_watched(
    program: &str,
    args: &[String],
    secs: u64,
    env: &[(&str, &str)],
    cancellable: bool,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        command.env(k, v);
    }
    let started = PROBES_CANCELLED.load(Ordering::SeqCst);
    let child = command
        .spawn()
        .map_err(|e| format!("could not run {program}: {e}"))?;

    let done = watchdog(child.id(), secs, cancellable.then_some(started));
    let output = child
        .wait_with_output()
        .map_err(|e| format!("{program} failed: {e}"));
    let _ = done.send(());
    output
}

/// Kills `pid` once `secs` have passed — or, given the cancel count a probe
/// started under, once that has moved — unless told first that it finished.
/// Being told is what stops it, so a run that ends on time can never have its
/// pid killed after the fact, when the number may belong to something else.
pub fn watchdog(pid: u32, secs: u64, cancel_from: Option<u64>) -> std::sync::mpsc::Sender<()> {
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                break;
            }
            match done_rx.recv_timeout(left.min(Duration::from_millis(100))) {
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                _ => return,
            }
            if cancel_from.is_some_and(|n| PROBES_CANCELLED.load(Ordering::SeqCst) != n) {
                break;
            }
        }
        #[cfg(unix)]
        let _ = Command::new("kill").arg(pid.to_string()).status();
    });
    done_tx
}

/// ffmpeg with its own account of how far it has got: `-progress` writes
/// `out_time_us=` to stdout as it goes, and the inputs' durations are on
/// stderr before the first of those. The fraction goes to `on_progress`;
/// stderr comes back whole, for the error message.
pub fn run_ffmpeg_with_progress(
    ffmpeg: &str,
    args: &[String],
    secs: u64,
    mut on_progress: impl FnMut(f64),
) -> Result<std::process::Output, String> {
    use std::io::{BufRead, BufReader};

    let mut child = Command::new(ffmpeg)
        .args(["-progress", "pipe:1", "-nostats"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {ffmpeg}: {e}"))?;
    let done = watchdog(child.id(), secs, None);

    let total_us = std::sync::Arc::new(AtomicU64::new(0));
    let stderr = child.stderr.take();
    let seen = total_us.clone();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        for line in stderr.map(BufReader::new).into_iter().flat_map(|r| r.lines()) {
            let Ok(line) = line else { break };
            if let Some(us) = ffmpeg_duration_us(&line) {
                seen.fetch_max(us, Ordering::SeqCst);
            }
            text.push_str(&line);
            text.push('\n');
        }
        text
    });

    for line in child.stdout.take().map(BufReader::new).into_iter().flat_map(|r| r.lines()) {
        let Ok(line) = line else { break };
        let Some(Ok(us)) = line.strip_prefix("out_time_us=").map(str::parse::<u64>) else {
            continue;
        };
        let total = total_us.load(Ordering::SeqCst);
        if total > 0 {
            on_progress((us as f64 / total as f64).clamp(0.0, 1.0));
        }
    }

    let status = child.wait().map_err(|e| format!("{ffmpeg} failed: {e}"));
    let _ = done.send(());
    let stderr = errors.join().unwrap_or_default().into_bytes();
    Ok(std::process::Output { status: status?, stdout: Vec::new(), stderr })
}

/// `  Duration: 00:03:21.45, start: 0.000000, bitrate: 128 kb/s` → µs.
/// A live input says `N/A`, which is no duration at all.
pub fn ffmpeg_duration_us(line: &str) -> Option<u64> {
    let rest = line.trim_start().strip_prefix("Duration: ")?;
    let clock = rest.split(',').next()?.trim();
    let mut parts = clock.split(':');
    let (h, m, s) = (parts.next()?, parts.next()?, parts.next()?);
    let secs = h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?;
    (secs > 0.0).then_some((secs * 1_000_000.0) as u64)
}
