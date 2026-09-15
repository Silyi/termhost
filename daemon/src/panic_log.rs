//! Panic/event logging for the two background binaries.
//!
//! Why this exists: `termhostd` and `pty-host` are console binaries spawned with
//! `CREATE_NO_WINDOW`, so their stderr goes to a console window nobody can see.
//! That silently threw away the one thing needed to diagnose a crash.
//!
//! It cost a real outage: pty-host aborted (0xC0000409, subcode 7 = `abort()`,
//! which is what a Rust panic does under `panic = "abort"`) and all we had was
//! the WER exception code — no message, no file, no line. A deterministic crash
//! at the same code offset across two different builds, and nothing to read.
//!
//! So: panics are appended to `%LOCALAPPDATA%\TermHost\<name>.log` with the
//! location and payload, and `log_line` is available for non-panic events that
//! matter (e.g. "pty-host connection lost").
//!
//! No dependencies: the timestamp is formatted here.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static LOG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// `%LOCALAPPDATA%\TermHost\<name>.log`, created on first use. `None` when the
/// directory can't be resolved or created — logging is best-effort and must
/// never take a process down.
fn resolve(name: &str) -> Option<PathBuf> {
    let dir = dirs::data_local_dir()?.join("TermHost");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{name}.log")))
}

/// Append one line. Best-effort by construction: every failure is dropped.
pub fn log_line(name: &str, line: &str) {
    let path = LOG_PATH.get_or_init(|| resolve(name));
    let Some(path) = path else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {}", timestamp(), line);
        let _ = f.flush();
    }
}

/// Install a panic hook that writes the panic to `<name>.log` (and still to
/// stderr, as the default hook would). Call this first thing in `main`.
///
/// The hook runs *before* the process aborts, so under `panic = "abort"` this is
/// the only chance to record anything.
pub fn install(name: &'static str) {
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "<unknown location>".to_string());

        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };

        let thread = std::thread::current();
        let thread = thread.name().unwrap_or("<unnamed>");

        let line = format!("PANIC in thread '{thread}' at {location}: {payload}");
        log_line(name, &line);
        // Keep the default behaviour too, in case stderr is ever visible again.
        eprintln!("{line}");
    }));
}

/// RFC3339-ish UTC timestamp, dependency-free.
///
/// Days→civil date is Howard Hinnant's `civil_from_days` algorithm.
fn timestamp() -> String {
    let secs = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => return "????-??-??T??:??:??Z".to_string(),
    };
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // civil_from_days: shift the epoch to 0000-03-01 so leap days land at the end.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The timestamp must at least be well-formed and roughly plausible — the
    /// point of the formatter is to avoid a dependency, not to be clever.
    #[test]
    fn timestamp_is_well_formed() {
        let t = timestamp();
        assert_eq!(t.len(), 20, "unexpected timestamp {t}");
        assert!(t.ends_with('Z'));
        let year: i32 = t[..4].parse().expect("year");
        assert!((2024..2100).contains(&year), "implausible year in {t}");
    }
}
