use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use crate::sidecar::Sidecar;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub name: String,
    pub run_count: usize,
    pub task_count: usize,
    pub total_cost_usd: f64,
    pub failed_count: usize,
    pub last_run: Option<String>,
    /// In-flight runs right now (from active sessions).
    pub running_count: usize,
    /// Completed runs whose timestamp is within the last 24h (velocity).
    pub runs_last_24h: usize,
    /// Configured per-project color (`#rrggbb`), or None → the UI derives one from the path.
    pub color: Option<String>,
}

fn projects_file(config_dir: &Path) -> PathBuf {
    config_dir.join("projects.json")
}

/// The persisted project list is just an array of repo paths; metrics are recomputed on read.
pub fn load_paths(config_dir: &Path) -> io::Result<Vec<String>> {
    match fs::read_to_string(projects_file(config_dir)) {
        // Surface a corrupt store as an error — do NOT default to empty, or the next
        // add/remove would save_paths over it and wipe the user's whole project list.
        Ok(s) => serde_json::from_str(&s).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

pub fn save_paths(config_dir: &Path, paths: &[String]) -> io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(paths).map_err(io::Error::other)?;
    fs::write(projects_file(config_dir), json)
}

/// Aggregate a repo's `.vanguard/runs` into a dashboard summary (+ live running count).
pub fn aggregate(state: &Sidecar, repo_path: &Path) -> Project {
    let summaries = crate::runs::list_runs(state, repo_path).unwrap_or_default();
    aggregate_at(repo_path, &summaries, Utc::now())
}

fn aggregate_at(repo_path: &Path, summaries: &[serde_json::Value], now: DateTime<Utc>) -> Project {
    let name = repo_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo_path.to_string_lossy().into_owned());
    let cutoff = now - Duration::hours(24);

    let mut tasks = BTreeSet::new();
    let mut total_cost_usd = 0.0;
    let mut failed_count = 0;
    let mut runs_last_24h = 0;
    let mut last_run: Option<String> = None;
    let mut run_count = 0;
    for s in summaries {
        let (Some(task_id), Some(timestamp)) = (s["taskId"].as_str(), s["timestamp"].as_str()) else { continue };
        run_count += 1;
        tasks.insert(task_id);
        total_cost_usd += s["totalCostUsd"].as_f64().unwrap_or(0.0);
        if s["anyFailed"].as_bool().unwrap_or(false) {
            failed_count += 1;
        }
        if last_run.as_deref().is_none_or(|l| timestamp > l) {
            last_run = Some(timestamp.to_string());
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(timestamp) {
            if dt.with_timezone(&Utc) >= cutoff {
                runs_last_24h += 1;
            }
        }
    }

    let running_count = crate::active::list_active(repo_path).map(|a| a.len()).unwrap_or(0);

    Project {
        path: repo_path.to_string_lossy().into_owned(),
        name,
        run_count,
        task_count: tasks.len(),
        total_cost_usd,
        failed_count,
        last_run,
        running_count,
        runs_last_24h,
        color: crate::appconfig::read(repo_path).color,
    }
}

pub fn list(state: &Sidecar, config_dir: &Path) -> io::Result<Vec<Project>> {
    Ok(load_paths(config_dir)?
        .iter()
        .map(|p| aggregate(state, Path::new(p)))
        .collect())
}

pub fn add(state: &Sidecar, config_dir: &Path, path: &str) -> io::Result<Vec<Project>> {
    let mut paths = load_paths(config_dir)?;
    if !paths.iter().any(|p| p == path) {
        paths.push(path.to_string());
    }
    save_paths(config_dir, &paths)?;
    list(state, config_dir)
}

pub fn remove(state: &Sidecar, config_dir: &Path, path: &str) -> io::Result<Vec<Project>> {
    let paths: Vec<String> = load_paths(config_dir)?
        .into_iter()
        .filter(|p| p != path)
        .collect();
    save_paths(config_dir, &paths)?;
    list(state, config_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_list_remove_roundtrip() {
        let cfg = tempfile::tempdir().unwrap();
        let repo_tmp = tempfile::tempdir().unwrap();
        let repo = repo_tmp.path().join("proj-a");
        fs::create_dir_all(&repo).unwrap();
        let repo_str = repo.to_string_lossy().into_owned();

        let after_add = add(&Sidecar::default(), cfg.path(), &repo_str).unwrap();
        assert_eq!(after_add.len(), 1);
        assert_eq!(after_add[0].path, repo_str);

        // dedup: adding the same path again keeps a single entry
        assert_eq!(add(&Sidecar::default(), cfg.path(), &repo_str).unwrap().len(), 1);

        let after_remove = remove(&Sidecar::default(), cfg.path(), &repo_str).unwrap();
        assert!(after_remove.is_empty());
    }

    #[test]
    fn missing_store_lists_empty() {
        let cfg = tempfile::tempdir().unwrap();
        assert!(list(&Sidecar::default(), cfg.path()).unwrap().is_empty());
    }

    #[test]
    fn corrupt_store_errors_and_does_not_wipe() {
        let cfg = tempfile::tempdir().unwrap();
        let store = projects_file(cfg.path());
        fs::write(&store, "{ not valid json").unwrap();
        // load errors instead of defaulting to empty...
        assert!(load_paths(cfg.path()).is_err());
        // ...and a failed add leaves the original bytes intact (no overwrite/wipe).
        assert!(add(&Sidecar::default(), cfg.path(), "/some/repo").is_err());
        assert_eq!(fs::read_to_string(&store).unwrap(), "{ not valid json");
    }

    #[test]
    fn aggregates_forwarded_summaries() {
        let now = DateTime::parse_from_rfc3339("2026-07-06T20:00:00Z").unwrap().with_timezone(&Utc);
        let summaries = [
            serde_json::json!({"taskId":"a","timestamp":"2026-07-06T19:00:00Z","totalCostUsd":0.1,"anyFailed":false}),
            serde_json::json!({"taskId":"b","timestamp":"2026-07-04T19:00:00Z","totalCostUsd":0.2,"anyFailed":true,"prUrl":"url"}),
        ];
        let p = aggregate_at(Path::new("/repo/proj"), &summaries, now);
        assert_eq!((p.run_count, p.task_count, p.failed_count, p.runs_last_24h), (2, 2, 1, 1));
        assert!((p.total_cost_usd - 0.3).abs() < 1e-9);
        assert_eq!(p.last_run.as_deref(), Some("2026-07-06T19:00:00Z"));
        assert_eq!((p.name.as_str(), p.path.as_str()), ("proj", "/repo/proj"));
    }

    #[test]
    fn empty_summaries_preserve_project() {
        let p = aggregate_at(Path::new("/repo/proj"), &[], Utc::now());
        assert_eq!((p.run_count, p.task_count, p.failed_count, p.runs_last_24h, p.running_count), (0, 0, 0, 0, 0));
        assert_eq!(p.total_cost_usd, 0.0);
        assert_eq!(p.last_run, None);
        assert_eq!((p.name.as_str(), p.path.as_str()), ("proj", "/repo/proj"));
    }

    #[test]
    fn skips_incomplete_summaries_and_defaults_invalid_costs() {
        let summaries = [
            serde_json::json!({"taskId":"a"}),
            serde_json::json!({"timestamp":"ts"}),
            serde_json::json!({"taskId":"b","timestamp":"ts"}),
            serde_json::json!({"taskId":"c","timestamp":"ts","totalCostUsd":"bad"}),
        ];
        let p = aggregate_at(Path::new("/repo/proj"), &summaries, Utc::now());
        assert_eq!((p.run_count, p.task_count), (2, 2));
        assert_eq!(p.total_cost_usd, 0.0);
    }
}
