use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Which child a request talks to. `request()` holds that pipe's lock for the whole exchange, and for
/// a run the exchange IS the run — so short calls need their own pipe or they queue for minutes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pipe {
    /// Held for the entire duration of a run.
    Run,
    /// Short request/response: capabilities, and (S4.3) createTask. Answers while a run is in flight.
    Query,
}

/// Sidecar state. TWO children: `proc` (the run pipe) is held for a whole run, `query_proc` serves
/// short calls so they never queue behind one. `buffer`/`active`/`child_pid`/`cancelled` use SEPARATE
/// locks so re-attach (api_run_backlog / api_active_run) and cancel read them WHILE a run holds `proc`.
/// `child_pid` is the RUN child's only — see `publish_run_pid`.
/// See docs/specs/subsystem-0.5-sidecar-hardening.md §Concurrency.
#[derive(Default)]
pub struct Sidecar {
    proc: Mutex<Option<SidecarProc>>,
    /// Second child for short calls, so they never wait on the run pipe. Same `vanguard __sidecar`
    /// binary — no protocol change, no multiplexing, no async reader. Just a pipe that isn't busy.
    query_proc: Mutex<Option<SidecarProc>>,
    /// Per-run event backlog for re-attach. Keyed by runId; last few completed runs retained.
    buffer: Mutex<HashMap<String, Vec<serde_json::Value>>>,
    /// Completed-run ids in finish order, for bounded eviction.
    order: Mutex<Vec<String>>,
    /// The in-flight run (runId, repoPath), or None when idle. repoPath rides along so the
    /// desktop can tell WHICH project's Inspector a re-attach belongs to (S8 item 4).
    active: Mutex<Option<(String, String)>>,
    /// The running child's PID, readable without the `proc` lock so cancel works during a run.
    child_pid: Mutex<Option<u32>>,
    /// A runId for which cancel was requested — its terminal is `run-cancelled`, not `run-error`.
    cancelled: Mutex<Option<String>>,
    /// In-flight `__complete` children keyed by the renderer's call id, so the doc chat's Stop button
    /// (`api_cancel_complete`) can kill exactly its own turn's child. PID only — kill-by-id is the
    /// ENTIRE surface: never the run child, never an arbitrary caller-supplied pid.
    complete_pids: Mutex<HashMap<String, u32>>,
    counter: AtomicU64,
}

/// Completed runs kept in the backlog buffer before eviction.
const RETAINED_RUNS: usize = 4;
/// Per-run event cap (crash guard) — a real run emits ~dozens; beyond this the oldest are dropped.
const MAX_EVENTS_PER_RUN: usize = 2000;

pub struct SidecarProc {
    /// Held so the process stays alive and its pipes stay open; never read directly (Drop detaches
    /// it on app shutdown). stdin/reader below own the actual I/O.
    #[allow(dead_code)]
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
}

/// Spawn the sidecar if it isn't already running. Launch through a fixed `sh -c` string (no config
/// value is interpolated) so
/// `vanguard` resolves on the same PATH the CLI shell-out uses, inheriting the app environment (so
/// operator LLM/platform credentials pass through). `exec` replaces the shell so the child owns the
/// stdio pipes directly.
fn ensure(proc: &mut Option<SidecarProc>) -> Result<(), String> {
    if proc.is_some() {
        return Ok(());
    }
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("exec vanguard __sidecar")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn vanguard __sidecar: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    *proc = Some(SidecarProc {
        child,
        stdin,
        reader: BufReader::new(stdout),
    });
    Ok(())
}

/// Whether a hung exchange may be killed. NOT a detail — killing a NON-IDEMPOTENT exchange is worse than
/// letting it hang: the child dies, the caller reports failure, and the user retries something that may
/// already have happened. For `createTask` that means a second real, un-deletable issue.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    /// Idempotent read — kill it if it hangs and respawn a clean child.
    Timed,
    /// Do not kill. Either the exchange IS the work (a run), or repeating it would duplicate a write.
    Untimed,
}

/// Write one request line, then read lines until the matching `result`/`error`. `on_event` fires per
/// event line. Holds the selected pipe's lock for the whole exchange; a closed child is dropped so the
/// next call respawns.
fn request(
    state: &Sidecar,
    pipe: Pipe,
    bound: Bound,
    req: serde_json::Value,
    mut on_event: impl FnMut(serde_json::Value),
) -> Result<serde_json::Value, String> {
    let lock = match pipe {
        Pipe::Run => &state.proc,
        Pipe::Query => &state.query_proc,
    };
    let mut guard = lock.lock().map_err(|e| e.to_string())?;
    ensure(&mut guard)?;
    let mut watchdog = None;
    if let Some(proc) = guard.as_ref() {
        publish_run_pid(state, pipe, proc.child.id());
        if bound == Bound::Timed {
            watchdog = Some(Watchdog::arm(proc.child.id()));
        }
    }
    let outcome = {
        let proc = guard.as_mut().ok_or("sidecar down")?;
        writeln!(proc.stdin, "{req}").map_err(|e| e.to_string())?;
        proc.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        loop {
            line.clear();
            if proc.reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                break Err::<serde_json::Value, String>("sidecar closed".into());
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Only protocol messages count. Anything else on stdout (a stray log line that escaped the
            // stderr redirect, non-JSON noise) is skipped, never misread as a terminal.
            let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            if v.get("event").is_some() {
                on_event(v);
            } else if v.get("result").is_some() || v.get("error").is_some() {
                break Ok(v);
            } else {
                continue;
            }
        }
    };
    drop(watchdog); // exchange finished in time — cancel the kill
    if outcome.is_err() {
        *guard = None;
        clear_run_pid(state, pipe);
    }
    outcome
}

/// Wall clock for a QUERY exchange. Not applied to the run pipe, where the exchange IS the run and
/// minutes are normal. A query child that hangs mid-response would otherwise block its caller forever —
/// the same silent-failure class as the Linear watcher hang and the doc-chat hang.
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);

/// Kills the child if the exchange outlives QUERY_TIMEOUT. We cannot simply abandon a blocking read on a
/// LONG-LIVED pipe — a late reply would desync every future request on it. Killing is what makes the
/// abandonment safe: stdout closes, the blocked `read_line` returns 0, `request` drops the pipe, and the
/// next call respawns a clean child. Cancelled by Drop on the happy path.
///
/// Single-shot SIGTERM, no SIGKILL escalation. That is sufficient only because the Node sidecar does not
/// trap SIGTERM — if it ever installs a handler, this must escalate, or `request` stays blocked forever
/// with no second attempt. Applies to Bound::Timed reads only; a write is never killed (see Bound).
struct Watchdog(Option<mpsc::Sender<()>>);

impl Watchdog {
    fn arm(pid: u32) -> Self {
        let (tx, rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            if rx.recv_timeout(QUERY_TIMEOUT) != Err(mpsc::RecvTimeoutError::Timeout) {
                return; // exchange finished in time
            }
            // Confirm the pid is still OUR child before signalling it. The timer captured the pid 60s
            // ago; if that child exited on its own right at the deadline and the OS recycled the number,
            // an unchecked `kill` would hit an unrelated process.
            //
            // Keyed on the `__sidecar` ARGUMENT, not the product name. `ensure` spawns
            // `exec vanguard __sidecar`, so that token is in the child's argv by construction, wherever
            // the binary lives. Matching "vanguard" instead only worked here by accident — the repo path
            // contains it — and would have silently turned QUERY_TIMEOUT into "never" on any machine
            // where it does not, which is a WORSE failure than the pid reuse it guards against.
            let still_ours = Command::new("ps")
                .args(["-p", &pid.to_string(), "-o", "command="])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("__sidecar"))
                .unwrap_or(false);
            if still_ours {
                let _ = Command::new("kill").arg(pid.to_string()).status();
            }
        });
        Self(Some(tx))
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        drop(self.0.take()); // closing the channel cancels the kill
    }
}

/// `child_pid` is what `api_cancel` SIGUSR2s, so it must ALWAYS be the run child — never the query one.
///
/// Before the query pipe existed this lived inline in `request()` and published unconditionally. With
/// two pipes that is a silent, happy-path bug: a board/`createTask` query during a run would overwrite
/// `child_pid` with the *query* child's pid, and cancel would then signal the wrong process. The run
/// would not stop (the query child's `cancelCurrent()` is a no-op when idle, so the signal vanishes
/// without a word), and because `api_cancel` sets the `cancelled` flag *before* signalling, the run's
/// eventual terminal would be mislabelled `run-cancelled` for a run nobody cancelled.
fn publish_run_pid(state: &Sidecar, pipe: Pipe, pid: u32) {
    if pipe != Pipe::Run {
        return;
    }
    if let Ok(mut slot) = state.child_pid.lock() {
        *slot = Some(pid);
    }
}

/// Same rule in reverse: a dying QUERY child must not disarm cancel for a live run.
fn clear_run_pid(state: &Sidecar, pipe: Pipe) {
    if pipe != Pipe::Run {
        return;
    }
    if let Ok(mut slot) = state.child_pid.lock() {
        *slot = None;
    }
}

/// The pure capability surface (providers/flows/transports/defaults). No stdout scraping.
///
/// The body stays sync — `request` holds a std Mutex across a blocking `read_line`, which would stall
/// the shared async runtime if this were an `async fn`. But it must NOT be a plain `#[tauri::command]`:
/// tauri-macros compiles a sync body with no attribute as `ExecutionContext::Blocking`, i.e. it runs on
/// the MAIN thread, where a blocking read freezes the webview. `(async)` on a sync fn is the third
/// option — tauri dispatches it to the blocking threadpool ("sync_threadpool"), which is what the
/// comment here previously (wrongly) claimed a plain command already did.
#[tauri::command(async)]
pub fn api_capabilities(state: State<'_, Sidecar>) -> Result<serde_json::Value, String> {
    let resp = request(
        &state,
        Pipe::Query, // never behind a live run
        Bound::Timed, // pure read: safe to kill and retry
        serde_json::json!({ "id": "cap", "method": "capabilities" }),
        |_| {},
    )?;
    resp.get("result").cloned().ok_or_else(|| "no result".to_string())
}

/// One-shot doc-chat completion (Subsystem 3). Deliberately NOT on the `Sidecar` — it spawns a fresh
/// `vanguard __complete` per call, so an interactive chat turn never queues behind the run pipe's
/// mutex. Writes the request, closes stdin (EOF), reads the single JSON response line. The API key
/// is read from the inherited env inside the child; it never touches the webview or app.json.
///
/// `baseUrl` is NOT taken from the request. `__complete` points the SDK's `ANTHROPIC_BASE_URL` at it
/// while passing the inherited credential, so a per-request value would make the destination of the
/// OAuth token a parameter of an IPC call. It is read from `app.json` here instead, so config — not
/// the caller — decides where the credential goes, and there is one source of truth for it.
/// `app.json` is repo content, though, so `__complete` itself refuses any origin other than the
/// Anthropic API unless the operator lists it in `VANGUARD_CHAT_ALLOWED_ORIGINS` (src/api/complete.ts).
///
/// Scope of the substitution, stated honestly: it is hygiene, not a security boundary.
/// `write_app_config` accepts a whole AppConfig from the renderer, so a caller can persist a
/// `chatBaseUrl` and then complete (the origin allowlist above still applies). And `spawn_run` hands
/// the renderer arbitrary process execution anyway — the webview is a TRUSTED surface in this
/// app, and anything able to execute JS in it already has the machine. What that trust rests on is
/// that nothing rendered can *become* JS: `Markdown` is react-markdown with no `rehype-raw`, so HTML in
/// model output and task data is escaped, not executed. Keep it that way; adding `rehype-raw` to that
/// component would turn every one of these IPC commands into an exploit primitive.
///
/// `#[tauri::command(async)]`, not a plain command: a sync handler runs on the MAIN thread (tauri-macros
/// `ExecutionContext::Blocking`), and this one blocks on the child for up to COMPLETE_TIMEOUT. On the
/// main thread that freezes the whole webview for the entire wait. `(async)` on a sync fn dispatches it
/// to the blocking threadpool instead.
#[tauri::command(async)]
pub fn api_complete(
    state: State<'_, Sidecar>,
    repo_path: String,
    call_id: Option<String>,
    req: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut req = req;
    let trusted = crate::appconfig::read(std::path::Path::new(&repo_path)).chat_base_url;
    set_base_url(&mut req, trusted)?;
    set_asset_root(&mut req, &repo_path)?;
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("exec vanguard __complete")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn vanguard __complete: {e}"))?;
    // Publish this child's pid under the caller's id so the Stop button can kill THIS turn's child
    // and no other. `exec` in the shell means child.id() is already the `vanguard` pid (sh replaced
    // itself), same as the run child — so a plain SIGTERM tears down the whole completion.
    register_complete(&state, call_id.as_deref(), child.id());
    // Run the exchange, then ALWAYS kill + reap the child — an early `?` return (or a timeout, where
    // the child is still waiting on a stalled network call) would otherwise leave a zombie: Child's
    // Drop neither waits nor kills on Unix. On the happy path the child has already self-terminated
    // on stdin EOF and the kill is a no-op. A Stop-killed child is already dead here; the kill is a
    // no-op too, and `complete_exchange` has already returned Err (stdout closed → no response line).
    let result = complete_exchange(&mut child, &req);
    // Unregister BEFORE the child is reaped so the registry never maps an id to a reaped pid. This
    // narrows the reuse window but does not close it — a Stop that read the pid before this line
    // kills after the reap — so `api_cancel_complete` ALSO verifies ownership (ps argv check)
    // before signalling (review r2). Killing via the still-owned Child handle below is reuse-safe.
    unregister_complete(&state, call_id.as_deref());
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// Record the pid of an in-flight `__complete` child under its call id (no-op when the caller sent
/// no id — the auto-title completion, say, is fire-and-forget and never cancelled).
fn register_complete(state: &Sidecar, call_id: Option<&str>, pid: u32) {
    if let Some(id) = call_id {
        if let Ok(mut m) = state.complete_pids.lock() {
            m.insert(id.to_string(), pid);
        }
    }
}

/// Drop a finished completion's pid so a later Stop for a reused id can't signal a stale process.
fn unregister_complete(state: &Sidecar, call_id: Option<&str>) {
    if let Some(id) = call_id {
        if let Ok(mut m) = state.complete_pids.lock() {
            m.remove(id);
        }
    }
}

/// Kill the in-flight `__complete` child for a doc-chat call id — the Stop button. Kill-by-id is the
/// WHOLE surface: it can only signal a child this process spawned for `api_complete` and tracked
/// under `call_id`. An unknown id (already finished, never started) signals nothing. It never
/// touches the run child (`api_cancel` owns that, out-of-band via SIGUSR2) — the two registries are
/// separate. The killed child closes stdout, `complete_exchange`'s reader hits EOF, and the turn
/// resolves with no response line; the renderer maps that to a cancelled turn, not an error.
#[tauri::command]
pub fn api_cancel_complete(state: State<'_, Sidecar>, call_id: String) -> Result<(), String> {
    let pid = state
        .complete_pids
        .lock()
        .map_err(|e| e.to_string())?
        .get(&call_id)
        .copied();
    if let Some(pid) = pid {
        // The pid was read under the lock, but the child can self-terminate and be reaped between
        // that read and the kill — the OS may then recycle the pid to a stranger. Mirror the query
        // watchdog's ownership guard (ps argv check, sidecar.rs Watchdog::arm) before signalling:
        // `exec vanguard __complete` puts that token in the child's argv by construction.
        let still_ours = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("__complete"))
            .unwrap_or(false);
        if still_ours {
            // Plain SIGTERM, like the query watchdog: `__complete` installs no signal handler, so
            // one signal is enough. No libc dep — shell `kill` (the child is spawned via `sh -c`).
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    }
    Ok(())
}

/// Drop any caller-supplied `baseUrl` and substitute the one from `app.json` (or none). Split out so
/// the "the renderer cannot choose where the credential goes" property is directly testable.
fn set_base_url(req: &mut serde_json::Value, trusted: Option<String>) -> Result<(), String> {
    let obj = req.as_object_mut().ok_or("invalid request")?;
    obj.remove("baseUrl");
    if let Some(base_url) = trusted {
        obj.insert("baseUrl".to_string(), serde_json::Value::String(base_url));
    }
    Ok(())
}

/// Stamp the TRUSTED image-containment root over anything the renderer sent (same discipline as
/// `set_base_url`): `__complete` refuses any image path that does not canonicalize under this
/// drafts dir, and the renderer must not be able to choose the root it is checked against.
fn set_asset_root(req: &mut serde_json::Value, repo_path: &str) -> Result<(), String> {
    let obj = req.as_object_mut().ok_or("invalid request")?;
    let root = std::path::Path::new(repo_path).join(".vanguard").join("drafts");
    obj.insert(
        "assetRoot".to_string(),
        serde_json::Value::String(root.to_string_lossy().into_owned()),
    );
    Ok(())
}

/// Wall-clock cap on one doc-chat turn. Without it a stalled Anthropic call (network hang, rate-limit
/// stall) blocks the read forever, the `invoke` promise never settles, and the chat is stuck on
/// "thinking…" with no way back. Generous — a long reply is normal.
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(180);

fn complete_exchange(child: &mut Child, req: &serde_json::Value) -> Result<serde_json::Value, String> {
    let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    {
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
        // stdin drops here → the child sees EOF.
    }
    let stdout = child.stdout.take().ok_or("no stdout")?;

    // Read on a helper thread so the blocking read_line can be abandoned on timeout. The thread is not
    // leaked: the caller kills the child, which closes stdout, which ends the read.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut resp = String::new();
        loop {
            resp.clear();
            match reader.read_line(&mut resp) {
                Ok(0) | Err(_) => break, // EOF or read error → send nothing; the recv sees a closed channel
                Ok(_) => {}
            }
            // The agent SDK spawns its own child inside __complete. Console output is redirected to
            // stderr, but anything written straight to stdout would land on this pipe — so skip lines
            // that aren't the JSON response rather than misreading noise as the reply.
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(resp.trim()) {
                let _ = tx.send(v);
                return;
            }
        }
    });

    match rx.recv_timeout(COMPLETE_TIMEOUT) {
        Ok(v) => Ok(v),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
            "doc chat timed out after {}s",
            COMPLETE_TIMEOUT.as_secs()
        )),
        // Channel closed without a value: the child exited without writing a parseable response line.
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("vanguard __complete produced no response".to_string())
        }
    }
}

/// Append an event to a run's backlog buffer (bounded ring — drops the oldest past the cap so the
/// terminal event is always retained).
fn buffer_push(state: &Sidecar, run_id: &str, event: &serde_json::Value) {
    if let Ok(mut buf) = state.buffer.lock() {
        let events = buf.entry(run_id.to_string()).or_default();
        events.push(event.clone());
        if events.len() > MAX_EVENTS_PER_RUN {
            // Evict the SECOND-oldest, never index 0: the first event is `run-accepted`, the only
            // event allowed to seed a strip (the reducer's narrowed adoption rule, S8 item 4) —
            // evicting it would make a >cap run's re-attach fold nothing while blocking New-run.
            // Known cost: index 1 is usually `run-start`, so an over-cap re-attach renders with
            // no stage names — accepted (the run still attaches, terminates, and unblocks).
            events.remove(1);
        }
    }
}

/// Decide a run's invoke outcome + whether Rust must synthesize a terminal event. Success (the resp
/// carries `result`) needs none — the pipeline already streamed `run-end`. Any other case (in-band
/// `{id,error}` envelope from validation / a mid-run throw / a cancel-induced abort, OR a hard
/// `Err` from child death) has emitted no terminal, so one is synthesized: `run-cancelled` when this
/// run was cancelled, else `run-error`. This is the C1 fix — the in-band error envelope arrives as
/// `Ok(resp-without-result)`, not `Err`, so both must be handled here.
fn resolve_terminal(
    outcome: Result<serde_json::Value, String>,
    was_cancelled: bool,
) -> (Result<serde_json::Value, String>, Option<serde_json::Value>) {
    let err_msg = match &outcome {
        Ok(resp) => {
            if let Some(result) = resp.get("result") {
                return (Ok(result.clone()), None);
            }
            resp.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| "run failed".to_string())
        }
        Err(msg) => msg.clone(),
    };
    let terminal = if was_cancelled {
        serde_json::json!({ "type": "run-cancelled" })
    } else {
        serde_json::json!({ "type": "run-error", "message": err_msg })
    };
    (Err(err_msg), Some(terminal))
}

/// Whether a run's buffer already holds a terminal event, so we don't emit a second one.
fn has_terminal(state: &Sidecar, run_id: &str) -> bool {
    let Ok(buf) = state.buffer.lock() else {
        return false;
    };
    buf.get(run_id).is_some_and(|events| {
        events.iter().any(|e| {
            e.get("event")
                .and_then(|ev| ev.get("type"))
                .and_then(|t| t.as_str())
                .is_some_and(|t| matches!(t, "run-end" | "run-error" | "run-cancelled"))
        })
    })
}

/// Emit + buffer a `{runId, event}` payload on the `api:event` channel.
fn emit_event(app: &AppHandle, state: &Sidecar, run_id: &str, event: serde_json::Value) {
    let payload = serde_json::json!({ "runId": run_id, "event": event });
    buffer_push(state, run_id, &payload);
    let _ = app.emit("api:event", &payload);
}

/// Mark a run finished: clear `active`, record it for eviction, drop the oldest beyond RETAINED_RUNS.
fn finish_run(state: &Sidecar, run_id: &str) {
    // Disarm cancel and open the gate under ONE `active` lock scope — the same discipline
    // `api_create_run`'s check-and-set already uses, and for the same reason.
    //
    // The success path never cleared `child_pid` (only the error path did, via `request`), so a
    // finished run's pid lingered. But clearing it as a separate step is a TOCTOU: `active` IS the
    // single-in-flight gate, and Tauri runs commands on a thread pool, not serialized. Clear it after
    // releasing `active` and you get:
    //
    //   A: finish_run releases `active`          (gate open; child_pid still A's)
    //   B: api_create_run passes the gate, sets `active = B`, publishes child_pid = B
    //   A: clear_run_pid()                       -> child_pid = None, wiping B's
    //
    // ...leaving B live with no pid, so api_cancel finds nothing and the kill silently no-ops — the
    // exact "signal vanishes without a word" failure this change exists to prevent, moved to the
    // handoff boundary. Holding `active` across both writes means no B can pass the gate in between,
    // and the `run_id` guard means a finishing run can never disarm a successor that already took over.
    if let Ok(mut active) = state.active.lock() {
        if active.as_ref().map(|(id, _)| id.as_str()) == Some(run_id) {
            clear_run_pid(state, Pipe::Run);
            *active = None;
        }
    }
    // Clear a stale cancel flag for this run so it can't leak onto a later run's terminal.
    if let Ok(mut c) = state.cancelled.lock() {
        if c.as_deref() == Some(run_id) {
            *c = None;
        }
    }
    let evict = {
        let mut order = match state.order.lock() {
            Ok(o) => o,
            Err(_) => return,
        };
        order.push(run_id.to_string());
        if order.len() > RETAINED_RUNS {
            Some(order.remove(0))
        } else {
            None
        }
    };
    if let Some(old) = evict {
        if let Ok(mut buf) = state.buffer.lock() {
            buf.remove(&old);
        }
    }
}

/// RAII: runs `finish_run` when the run's scope ends, however it ends. `api_create_run`'s busy guard
/// *returns* on `active.is_some()`, so a leaked `active` would reject every later run forever — a
/// permanent brick. A guard makes the release unconditional, including on an unwinding panic.
struct RunGuard<'a> {
    state: &'a Sidecar,
    run_id: String,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        finish_run(self.state, &self.run_id);
    }
}

/// Start a run. Mints a runId, emits `run-accepted` + every event as `{runId, event}` (buffered for
/// re-attach), and guarantees exactly one terminal event (run-end from the stream on success, else a
/// synthesized run-error / run-cancelled). Returns the run's result, or an error string.
///
/// `(async)` for the same reason as `api_capabilities`, and far more urgently: this call blocks for the
/// WHOLE run (minutes). As a plain sync command that is the main thread, so the webview would be frozen
/// for the entire run — the live event strip this powers could never paint a single frame.
#[tauri::command(async)]
pub fn api_create_run(
    app: AppHandle,
    state: State<'_, Sidecar>,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // Single-in-flight guard: reject a second concurrent run instead of overwriting `active` (which
    // would orphan the first run's re-attach). Check-and-set under ONE lock scope so two concurrent
    // api_create_run calls (Tauri runs commands on a thread pool, not serialized) can't both pass the
    // check before either sets — a check-then-release-then-set would be a TOCTOU race.
    // repoPath is required BEFORE minting: full validation is Node-side and runs after Rust has
    // stamped `active` and emitted `run-accepted` — rejecting here keeps the stamped repoPath (and
    // the run-accepted payload the reducer filters on) always a string (S8 item 4).
    let repo_path = params
        .get("repoPath")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "repoPath is required and must be a non-blank string".to_string())?
        .to_string();
    let run_id = {
        let mut active = state.active.lock().map_err(|e| e.to_string())?;
        if active.is_some() {
            return Err("a run is already in flight (single-in-flight)".to_string());
        }
        // Mint the id inside the lock, after the early-return, so a rejected call doesn't burn one.
        let id = format!("run-{}", state.counter.fetch_add(1, Ordering::SeqCst));
        *active = Some((id.clone(), repo_path.clone()));
        id
    };
    // From here on, every exit path releases `active` via RunGuard's Drop.
    let _guard = RunGuard { state: &state, run_id: run_id.clone() };
    emit_event(&app, &state, &run_id, serde_json::json!({ "type": "run-accepted", "repoPath": repo_path }));

    let outcome = request(
        &state,
        Pipe::Run,     // holds the run pipe for the whole run
        Bound::Untimed, // the exchange IS the run; minutes are normal
        serde_json::json!({ "id": "run", "method": "createRun", "params": params }),
        |v| {
            // Sidecar events arrive as `{id, event}`; re-wrap as `{runId, event}` and buffer.
            if let Some(event) = v.get("event") {
                emit_event(&app, &state, &run_id, event.clone());
            }
        },
    );

    // Was this run cancelled? (api_cancel records the active runId.) Take the flag if it matches.
    let was_cancelled = state
        .cancelled
        .lock()
        .map(|mut c| {
            let hit = c.as_deref() == Some(&run_id);
            if hit {
                *c = None;
            }
            hit
        })
        .unwrap_or(false);

    let (result, terminal) = resolve_terminal(outcome, was_cancelled);
    if let Some(terminal) = terminal {
        // Any non-success run (error envelope or child death) synthesizes its terminal so a
        // re-attaching strip reaches a terminal state instead of hanging on "accepted" — unless a
        // terminal was already streamed (e.g. run-end emitted, then a teardown throw), to keep the
        // "exactly one terminal" guarantee.
        if !has_terminal(&state, &run_id) {
            emit_event(&app, &state, &run_id, terminal);
        }
    }
    result
}

/// The in-flight run `{runId, repoPath}`, or None when idle. Reads only the `active` lock, so it
/// works during a run. repoPath lets the Inspector skip a re-attach that belongs to another
/// project (S8 item 4 — the cross-project strip bleed).
#[tauri::command]
pub fn api_active_run(state: State<'_, Sidecar>) -> Option<serde_json::Value> {
    state
        .active
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .map(|(run_id, repo_path)| serde_json::json!({ "runId": run_id, "repoPath": repo_path }))
}

/// The buffered event backlog for a run, for a re-attaching strip. Reads only the `buffer` lock.
#[tauri::command]
pub fn api_run_backlog(state: State<'_, Sidecar>, run_id: String) -> Vec<serde_json::Value> {
    state
        .buffer
        .lock()
        .ok()
        .and_then(|b| b.get(&run_id).cloned())
        .unwrap_or_default()
}

/// Cancel the in-flight run out-of-band: SIGUSR2 to the RUN child (an in-band stdio message would
/// queue behind the run it must cancel). Reads `child_pid`/`active` only — never the run-held `proc`
/// lock. The sidecar's handler aborts the run's AbortController without exiting.
///
/// `child_pid` is the run child's, and only the run child's — see `publish_run_pid`. Signalling the
/// query child instead would be silent: it is idle, so `cancelCurrent()` is a no-op there.
#[tauri::command]
pub fn api_cancel(state: State<'_, Sidecar>) -> Result<(), String> {
    let active = state.active.lock().map_err(|e| e.to_string())?.clone();
    let Some((run_id, _)) = active else {
        return Ok(()); // nothing running
    };
    if let Ok(mut c) = state.cancelled.lock() {
        *c = Some(run_id);
    }
    let pid = *state.child_pid.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = pid {
        // No libc dep: shell `kill -USR2` (Unix; the sidecar itself is Unix-only, spawned via `sh -c`).
        // SIGUSR2 not SIGUSR1 — SIGUSR1 is Node's reserved inspector-start signal.
        let _ = Command::new("kill").arg("-USR2").arg(pid.to_string()).status();
    }
    Ok(())
}

/// Create a task on the configured transport. THE FIRST WRITE TO AN EXTERNAL SYSTEM FROM THE APP, and
/// it cannot be undone from inside it — so the UI confirms first, and this never runs as a side effect.
///
/// `source`/`team`/`label` come from `app.json`, read HERE on the trusted side. The renderer supplies
/// only the title and body: it does not get to choose which tracker gets written to, or which team an
/// issue lands in. Same rule S3 established for `chatBaseUrl`, and it matters more here — a misdirected
/// write creates real work in the wrong place, with no undo.
///
/// Runs on the QUERY pipe, so it answers while a run is in flight — but UNTIMED (see Bound::Untimed at
/// the call): a killed write is an ambiguous write, and ambiguity here means a duplicate issue.
#[tauri::command(async)]
pub fn api_create_task(
    state: State<'_, Sidecar>,
    repo_path: String,
    title: String,
    body: String,
) -> Result<serde_json::Value, String> {
    let cfg = crate::appconfig::read(std::path::Path::new(&repo_path));
    let source = cfg.source.unwrap_or_else(|| "github".to_string());
    let mut params = serde_json::json!({
        "source": source,
        "repoPath": repo_path,
        "title": title,
        "body": body,
    });
    if let Some(team) = cfg.team {
        params["team"] = serde_json::Value::String(team);
    }
    if let Some(label) = cfg.label {
        params["labels"] = serde_json::json!([label]);
    }
    let resp = request(
        &state,
        Pipe::Query,
        // UNTIMED, deliberately. createTask is a non-idempotent network write. Killing it on a timeout
        // would not undo it: `gh issue create` may already have succeeded (its grandchild can outlive a
        // SIGTERM'd parent, or the write can land exactly as the read is killed). The user would see
        // "failed", retry, and create a SECOND real, un-deletable issue — the very failure this feature
        // is built to prevent, just triggered by a clock instead of a double-click. A hang is
        // recoverable; a duplicate issue is not.
        Bound::Untimed,
        serde_json::json!({ "id": "task", "method": "createTask", "params": params }),
        |_| {},
    )?;
    // The sidecar reports a caller mistake as an in-band {id, error} envelope, which `request` returns as
    // Ok(non-result). Surfacing "no result" here would bury an actionable message ("set a Linear team
    // key") under a meaningless one — on the one action the user cannot undo.
    if let Some(err) = resp.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("createTask failed");
        return Err(msg.to_string());
    }
    resp.get("result").cloned().ok_or_else(|| "createTask returned no result".to_string())
}

/// Shared exchange for the S5 flow-file methods. Timed on the query pipe: these are local,
/// idempotent file operations — same doc, same bytes, a watchdog-killed write retried converges,
/// and the sidecar's temp+rename write can't tear the target (spec D5). The in-band error envelope
/// is surfaced verbatim: a parse message or validation rejection must reach the UI, not collapse
/// to "no result" (same rule as api_create_task, for the same reason).
fn flow_request(state: &Sidecar, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let resp = request(
        state,
        Pipe::Query,
        Bound::Timed,
        serde_json::json!({ "id": method, "method": method, "params": params }),
        |_| {},
    )?;
    if let Some(err) = resp.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("flow request failed");
        return Err(msg.to_string());
    }
    resp.get("result").cloned().ok_or_else(|| format!("{method} returned no result"))
}

/// List `.vanguard/flows/*.hcl` — the flow editor's rail + the run builder's repo-flow dropdown.
#[tauri::command(async)]
pub fn api_list_flows(state: State<'_, Sidecar>, repo_path: String) -> Result<serde_json::Value, String> {
    flow_request(&state, "listFlows", serde_json::json!({ "repoPath": repo_path }))
}

/// Board exchange (S9): listTasks / fetchSpec ride the same Timed query-pipe contract as the
/// flow methods — remote idempotent reads; a watchdog-killed exchange retried converges, and the
/// in-band error envelope (auth, team key, no-source prompts) must reach the UI verbatim.
pub fn board_request(state: &Sidecar, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    flow_request(state, method, params)
}

/// List the repo's `customProviders` health (S6): healthy + error-flagged entries, index -1 for an
/// unparseable file. Names only — no baseUrl/keyEnv on the wire; Settings edits app.json directly.
#[tauri::command(async)]
pub fn api_list_providers(state: State<'_, Sidecar>, repo_path: String) -> Result<serde_json::Value, String> {
    flow_request(&state, "listProviders", serde_json::json!({ "repoPath": repo_path }))
}

/// Read one flow file: `{ doc, source }` (raw bytes; canonical form appears only after a write).
#[tauri::command(async)]
pub fn api_read_flow(state: State<'_, Sidecar>, repo_path: String, file: String) -> Result<serde_json::Value, String> {
    flow_request(&state, "readFlow", serde_json::json!({ "repoPath": repo_path, "file": file }))
}

/// Delete one flow file (S8). Timed on the query pipe: one local unlink, idempotent (core maps
/// ENOENT to success), so a watchdog-killed exchange retried converges — Untimed would instead
/// wedge the query mutex forever on a hang (cancel only reaches the RUN child).
#[tauri::command(async)]
pub fn api_delete_flow(state: State<'_, Sidecar>, repo_path: String, file: String) -> Result<serde_json::Value, String> {
    flow_request(&state, "deleteFlow", serde_json::json!({ "repoPath": repo_path, "file": file }))
}

/// Validate + emit + atomically write one flow file; returns `{ source }` (the canonical HCL).
#[tauri::command(async)]
pub fn api_write_flow(
    state: State<'_, Sidecar>,
    repo_path: String,
    file: String,
    doc: serde_json::Value,
) -> Result<serde_json::Value, String> {
    flow_request(&state, "writeFlow", serde_json::json!({ "repoPath": repo_path, "file": file, "doc": doc }))
}

/// Composer `@`-mention autocomplete (Editor UX 7/7): the repo's tracked files (`git ls-files`,
/// capped). Timed on the query pipe — a local idempotent read, same contract as the board methods.
#[tauri::command(async)]
pub fn api_list_repo_files(state: State<'_, Sidecar>, repo_path: String) -> Result<serde_json::Value, String> {
    board_request(&state, "listRepoFiles", serde_json::json!({ "repoPath": repo_path }))
}

/// Read one tracked file for mention inlining (Editor UX 7/7). `path` is repo-relative; core rejects
/// traversal and caps the read. Timed query-pipe exchange, like `api_read_flow`.
#[tauri::command(async)]
pub fn api_read_repo_file(state: State<'_, Sidecar>, repo_path: String, path: String) -> Result<serde_json::Value, String> {
    board_request(&state, "readRepoFile", serde_json::json!({ "repoPath": repo_path, "path": path }))
}

/// Cheap client-side pre-flight: is `repo_path` a git work tree? Lets S1 fail a misconfigured project
/// at click instead of minutes into a run. `(async)` — it shells out to git, and process spawns do not
/// belong on the main thread even when they're fast.
#[tauri::command(async)]
pub fn api_repo_ok(repo_path: String) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{
        clear_run_pid, finish_run, publish_run_pid, register_complete, resolve_terminal,
        set_asset_root, set_base_url, unregister_complete, Pipe, RunGuard, Sidecar,
    };
    use serde_json::json;

    /// The bug the query pipe would have introduced, pinned.
    ///
    /// `child_pid` is what api_cancel SIGUSR2s. It must always be the RUN child. When pid publication
    /// lived inline in `request()` it fired for whichever pipe was talking — so a query during a run
    /// (the entire point of the second pipe) would repoint cancel at the query child. Cancel would then
    /// signal a process that ignores it, the run would keep going, and its terminal would come back
    /// mislabelled `run-cancelled` because api_cancel sets that flag before signalling.
    #[test]
    fn a_query_never_repoints_cancel_away_from_the_run_child() {
        let state = Sidecar::default();

        // A query while idle must not arm cancel at all.
        publish_run_pid(&state, Pipe::Query, 999);
        assert_eq!(*state.child_pid.lock().unwrap(), None);

        // A run arms it.
        publish_run_pid(&state, Pipe::Run, 123);
        assert_eq!(*state.child_pid.lock().unwrap(), Some(123));

        // A query DURING that run must not steal it — this is the happy path, not an edge case.
        publish_run_pid(&state, Pipe::Query, 999);
        assert_eq!(*state.child_pid.lock().unwrap(), Some(123));

        // And a dying query child must not disarm cancel for the live run.
        clear_run_pid(&state, Pipe::Query);
        assert_eq!(*state.child_pid.lock().unwrap(), Some(123));

        // Only the run pipe may clear it.
        clear_run_pid(&state, Pipe::Run);
        assert_eq!(*state.child_pid.lock().unwrap(), None);
    }

    /// The doc-chat Stop button's registry: `api_cancel_complete` can only ever kill a child that
    /// `api_complete` registered under the caller's id, and killing one leaves the others alone.
    #[test]
    fn complete_registry_is_kill_by_id_only() {
        let state = Sidecar::default();
        register_complete(&state, Some("a"), 111);
        register_complete(&state, Some("b"), 222);
        let pid = |id: &str| state.complete_pids.lock().unwrap().get(id).copied();
        assert_eq!(pid("a"), Some(111));
        assert_eq!(pid("b"), Some(222));
        assert_eq!(pid("missing"), None); // an unknown id (finished / never started) kills nothing

        // Finishing one turn drops only its own pid.
        unregister_complete(&state, Some("a"));
        assert_eq!(pid("a"), None);
        assert_eq!(pid("b"), Some(222));

        // A completion with no call id (fire-and-forget auto-title) registers nothing to cancel.
        register_complete(&state, None, 999);
        assert_eq!(state.complete_pids.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_finished_run_disarms_cancel() {
        // The success path never cleared child_pid, so a completed run's pid lingered. Only `active`
        // (also cleared by RunGuard) stopped it being signalled — a coincidence, not a design.
        let state = Sidecar::default();
        *state.active.lock().unwrap() = Some(("run-0".to_string(), "/repo".to_string()));
        publish_run_pid(&state, Pipe::Run, 123);
        {
            let _guard = RunGuard { state: &state, run_id: "run-0".to_string() };
        } // run ends normally
        assert_eq!(*state.child_pid.lock().unwrap(), None);
        assert_eq!(*state.active.lock().unwrap(), None);
    }

    /// A late `finish_run` from an OLD run must not disarm cancel for the run that succeeded it.
    ///
    /// `active` is the single-in-flight gate and Tauri runs commands on a thread pool, so a finishing
    /// run's cleanup can land after a newer run has already claimed the gate and published its pid.
    /// An unguarded `clear_run_pid` would blank it, leaving a LIVE run that cancel cannot signal.
    /// finish_run therefore clears the pid only while `active` still names ITS OWN run, and does both
    /// writes under one lock so no run can slip in between them.
    #[test]
    fn a_late_finish_cannot_disarm_the_run_that_replaced_it() {
        let state = Sidecar::default();

        // run-1 is live and armed (it already took over from run-0).
        *state.active.lock().unwrap() = Some(("run-1".to_string(), "/repo".to_string()));
        publish_run_pid(&state, Pipe::Run, 222);

        // run-0's cleanup finally lands. It owns neither `active` nor the pid any more.
        finish_run(&state, "run-0");

        assert_eq!(*state.child_pid.lock().unwrap(), Some(222), "run-1 must still be cancellable");
        assert_eq!(state.active.lock().unwrap().as_ref().map(|(id, _)| id.clone()), Some("run-1".to_string()), "run-1 still holds the gate");
    }

    #[test]
    fn run_guard_releases_active_even_on_panic() {
        let state = Sidecar::default();
        *state.active.lock().unwrap() = Some(("run-0".to_string(), "/repo".to_string()));
        let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = RunGuard { state: &state, run_id: "run-0".to_string() };
            panic!("run blew up");
        }));
        assert!(hit.is_err());
        // A leaked `active` would make the busy guard reject every subsequent run forever.
        assert_eq!(*state.active.lock().unwrap(), None);
    }

    #[test]
    fn set_base_url_ignores_a_renderer_supplied_base_url() {
        // The completion runs with the inherited Anthropic credential. If the webview could choose the
        // base URL it could redirect that token to any host, so the request's value is always dropped.
        let mut req = json!({ "messages": [], "baseUrl": "https://attacker.example" });
        set_base_url(&mut req, None).unwrap();
        assert_eq!(req.get("baseUrl"), None);

        let mut req = json!({ "messages": [], "baseUrl": "https://attacker.example" });
        set_base_url(&mut req, Some("https://proxy.internal".to_string())).unwrap();
        assert_eq!(req["baseUrl"], json!("https://proxy.internal")); // app.json wins, not the caller
    }

    #[test]
    fn set_asset_root_overwrites_a_renderer_supplied_root() {
        // The image containment check in __complete is only as strong as the root it checks
        // against — a renderer that could choose the root could point it at `/` and read anything.
        let mut req = json!({ "messages": [], "assetRoot": "/" });
        set_asset_root(&mut req, "/repo").unwrap();
        assert_eq!(
            req["assetRoot"],
            json!(std::path::Path::new("/repo")
                .join(".vanguard")
                .join("drafts")
                .to_string_lossy()
                .into_owned())
        );
    }

    #[test]
    fn success_result_needs_no_terminal() {
        // The success line from request() is the `{id, result}` envelope.
        let (result, terminal) = resolve_terminal(Ok(json!({ "id": "run", "result": { "prUrl": "x" } })), false);
        assert_eq!(result.unwrap(), json!({ "prUrl": "x" }));
        assert!(terminal.is_none()); // run-end was already streamed by the pipeline
    }

    #[test]
    fn in_band_error_envelope_synthesizes_run_error() {
        // The common failure path: Node writes {id,error}, which request() returns as Ok(non-result).
        let outcome = Ok(json!({ "error": { "message": "boom", "kind": "internal" } }));
        let (result, terminal) = resolve_terminal(outcome, false);
        assert!(result.is_err());
        assert_eq!(terminal.unwrap(), json!({ "type": "run-error", "message": "boom" }));
    }

    #[test]
    fn cancelled_run_synthesizes_run_cancelled() {
        let outcome = Ok(json!({ "error": { "message": "aborted" } }));
        let (_result, terminal) = resolve_terminal(outcome, true);
        assert_eq!(terminal.unwrap(), json!({ "type": "run-cancelled" }));
    }

    #[test]
    fn child_death_err_also_synthesizes_terminal() {
        let (result, terminal) = resolve_terminal(Err("sidecar closed".into()), false);
        assert!(result.is_err());
        assert_eq!(terminal.unwrap(), json!({ "type": "run-error", "message": "sidecar closed" }));
    }

    #[test]
    fn buffer_eviction_retains_the_accepted_marker() {
        // The reducer only adopts a runId from `run-accepted` (S8 item 4) — a >cap run whose
        // backlog lost its first event would re-attach to nothing while blocking New-run.
        let state = Sidecar::default();
        let accepted = serde_json::json!({ "type": "run-accepted", "repoPath": "/repo" });
        super::buffer_push(&state, "run-0", &accepted);
        for i in 0..(super::MAX_EVENTS_PER_RUN + 5) {
            super::buffer_push(&state, "run-0", &serde_json::json!({ "type": "cost", "usdSpent": i }));
        }
        let buf = state.buffer.lock().unwrap();
        let events = buf.get("run-0").unwrap();
        assert_eq!(events.len(), super::MAX_EVENTS_PER_RUN);
        assert_eq!(events[0]["type"], "run-accepted");
    }
}
