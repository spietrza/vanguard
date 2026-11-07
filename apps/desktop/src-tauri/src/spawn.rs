use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const OUTPUT_EVENT: &str = "spawn:output";
pub const EXIT_EVENT: &str = "spawn:exit";

pub(crate) struct SpawnEntry {
    child: Child,
    cwd: String,
    command: String,
}

/// Child processes launched from the UI, keyed by OS pid — held so they stay alive and can be killed.
#[derive(Default)]
pub struct SpawnState(pub Mutex<HashMap<u32, SpawnEntry>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    pid: u32,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    pid: u32,
    code: Option<i32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpawnInfo {
    pub pid: u32,
    pub cwd: String,
    pub command: String,
}

/// Returns info about all currently-running spawned processes.
pub fn list_spawns(state: &SpawnState) -> Vec<SpawnInfo> {
    state
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|(pid, entry)| SpawnInfo {
            pid: *pid,
            cwd: entry.cwd.clone(),
            command: entry.command.clone(),
        })
        .collect()
}

/// Build the child for `argv` (program first) in `cwd` — run directly, NO shell. The argv is built
/// from project config (`.vanguard/app.json` is repo content), so each element must stay one
/// argument: shell metacharacters in a value are passed through literally, never interpreted.
/// `argv[0]` resolves on the inherited PATH, as it would in a shell. stdout and stderr are both piped
/// and merged by the readers (what `2>&1` did under the old `sh -c` launcher).
fn command_for(cwd: &str, argv: &[String]) -> std::io::Result<Command> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty argv"))?;
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(cwd).stdout(Stdio::piped()).stderr(Stdio::piped());
    Ok(cmd)
}

/// Spawn `argv` in `cwd` without a shell (see `command_for`), inheriting the app's environment (so
/// operator LLM/platform credentials pass through — §12). Streams merged stdout+stderr as
/// `spawn:output`; emits `spawn:exit` on end.
pub fn spawn(app: AppHandle, cwd: String, argv: Vec<String>) -> std::io::Result<u32> {
    let mut child = command_for(&cwd, &argv)?.spawn()?;
    let pid = child.id();
    // Display only (list_spawns / the launch panel) — never executed.
    let command = argv.join(" ");

    // One reader per stream; `readers` counts the live ones and the exit path waits for zero, so it
    // never waits on a reader that doesn't exist.
    let readers = Arc::new(AtomicUsize::new(0));
    let stdout = child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>);
    let stderr = child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>);
    for stream in [stdout, stderr].into_iter().flatten() {
        readers.fetch_add(1, Ordering::AcqRel);
        let app_out = app.clone();
        let live = readers.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_out.emit(OUTPUT_EVENT, OutputEvent { pid, line });
            }
            live.fetch_sub(1, Ordering::AcqRel);
        });
    }

    app.state::<SpawnState>().0.lock().unwrap().insert(pid, SpawnEntry { child, cwd, command });

    // Waiter: poll try_wait under the lock so it coexists with kill(); emit exit + drop on end.
    // Before emitting exit, wait (bounded) for the stdout reader to drain so the exit line doesn't
    // race ahead of the final output lines in the UI.
    let app_wait = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(300));
        let state = app_wait.state::<SpawnState>();
        let mut map = state.0.lock().unwrap();
        match map.get_mut(&pid) {
            Some(entry) => match entry.child.try_wait() {
                Ok(Some(status)) => {
                    map.remove(&pid);
                    drop(map);
                    await_drain(&readers);
                    let _ = app_wait.emit(EXIT_EVENT, ExitEvent { pid, code: status.code() });
                    break;
                }
                Ok(None) => {}
                Err(_) => {
                    map.remove(&pid);
                    drop(map);
                    await_drain(&readers);
                    let _ = app_wait.emit(EXIT_EVENT, ExitEvent { pid, code: None });
                    break;
                }
            },
            None => break,
        }
    });

    Ok(pid)
}

/// Wait for the output readers to hit EOF so exit doesn't beat the last output lines — but bounded
/// (~2s), so a grandchild that inherits stdout and outlives the run can't stall the exit event
/// forever. After the cap we emit exit anyway; at worst a few trailing lines lag (cosmetic).
fn await_drain(live_readers: &AtomicUsize) {
    for _ in 0..40 {
        if live_readers.load(Ordering::Acquire) == 0 {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Kill a spawned run. The waiter thread then observes the exit and emits `spawn:exit`.
pub fn kill(state: &SpawnState, pid: u32) {
    if let Some(entry) = state.0.lock().unwrap().get_mut(&pid) {
        let _ = entry.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_argv_is_rejected() {
        assert!(command_for(".", &[]).is_err());
    }

    #[test]
    fn shell_metacharacters_stay_one_literal_argument() {
        let dir = std::env::temp_dir().join(format!("vanguard-spawn-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("injected");
        let payload = format!("claude; touch {} #", marker.display());
        let out = command_for(dir.to_str().unwrap(), &argv(&["printf", "%s", &payload]))
            .unwrap()
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), payload);
        assert!(!marker.exists(), "payload must not be interpreted by a shell");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stderr_is_captured_too() {
        let out = command_for(".", &argv(&["ls", "/definitely-not-a-path-vanguard"])).unwrap().output().unwrap();
        assert!(!out.stderr.is_empty());
    }
}
