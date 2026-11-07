use std::fs;
use std::io;
use std::path::Path;

use crate::sidecar::{board_request, Sidecar};

pub fn runs_dir(repo_path: &Path) -> std::path::PathBuf {
    repo_path.join(".vanguard").join("runs")
}

/// Read a file's text but refuse a symlinked leaf: a repo under inspection could plant a
/// `.diff`/`.transcript.log`/`.jsonl` pointing at an arbitrary file and have its contents shown in
/// the UI. ponytail: guards the leaf symlink only — a symlinked *parent dir* still resolves, and a
/// hardlink isn't caught at all (needs dev/inode/nlink checks, not canonicalize). Acceptable for the
/// operator's-own-repo model (the agent could exfil directly anyway); revisit if trust ever lowers.
pub fn read_text_no_symlink(path: &Path) -> io::Result<String> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "refusing to read a symlinked file"));
    }
    fs::read_to_string(path)
}

fn list_runs_params(root: &Path) -> serde_json::Value {
    serde_json::json!({ "repoPath": root.to_string_lossy() })
}

pub(crate) fn read_run_params(root: &Path, task_id: &str, timestamp: &str) -> serde_json::Value {
    serde_json::json!({ "repoPath": root.to_string_lossy(), "taskId": task_id, "timestamp": timestamp })
}

/// Query-pipe forward to the single core reader.
pub fn list_runs(state: &Sidecar, root: &Path) -> Result<Vec<serde_json::Value>, String> {
    let result = board_request(state, "listRuns", list_runs_params(root))?;
    result.as_array().cloned().ok_or_else(|| "listRuns returned a non-array result".to_string())
}

pub fn read_run(state: &Sidecar, root: &Path, task_id: &str, timestamp: &str) -> Result<serde_json::Value, String> {
    board_request(state, "readRun", read_run_params(root, task_id, timestamp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwards_params_verbatim() {
        let root = Path::new("/repo/cache root");
        assert_eq!(list_runs_params(root), serde_json::json!({"repoPath": "/repo/cache root"}));
        assert_eq!(read_run_params(root, "task-1", "ts"), serde_json::json!({"repoPath": "/repo/cache root", "taskId": "task-1", "timestamp": "ts"}));
    }

    #[test]
    fn contains_no_record_reader() {
        let source = include_str!("runs.rs");
        for forbidden in [concat!("Run", "Record"), concat!("proof", ".json"), concat!(".visual-", "proof", ".json"), concat!("sanitize_", "timestamp")] {
            assert!(!source.contains(forbidden));
        }
    }

    #[cfg(unix)]
    #[test]
    fn read_text_no_symlink_rejects_symlinked_leaf() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real.diff");
        fs::write(&real, "diff body").unwrap();
        assert_eq!(read_text_no_symlink(&real).unwrap(), "diff body");

        let link = tmp.path().join("link.diff");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(read_text_no_symlink(&link).is_err()); // must not follow the symlink
    }
}
