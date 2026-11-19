//! Git in folders of this computer (after ForkLift): the state of a working
//! copy for the file list (branch, ahead/behind, changed files) and the
//! everyday commands — add, commit, pull, push. Uses the installed `git`
//! command, so the user's configuration, credential helper and SSH keys apply;
//! without git (or outside a repository) there is simply no git display.

use crate::error::{AppError, AppResult, Message, Param};
use crate::paths::{to_native, to_ui};
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Top folder of the working copy (interface path).
    pub root: String,
    pub branch: String,
    /// Commits not yet pushed / not yet pulled (against the upstream branch).
    pub ahead: u32,
    pub behind: u32,
    /// Changed files relative to `root` → one letter: M changed, A added,
    /// D deleted, R renamed, ? new (untracked), U conflict.
    pub files: HashMap<String, String>,
}

fn git(dir: &std::path::Path) -> Command {
    let mut c = Command::new("git");
    c.arg("-C").arg(dir);
    // Never wait for a password prompt in a hidden terminal; status must not take locks.
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up.
    }
    c
}

/// Git for the automatic display, which runs as soon as a folder is opened. A downloaded repository
/// brings its own `.git/config`, and `git status` would run programs named there (`core.fsmonitor`, the
/// clean filters of `.gitattributes` when it re-reads changed files). So the display uses plumbing
/// commands that only compare the index with the folder's file times and the commits, never re-read
/// file contents, and switches the file system monitor off. A file that was touched but not changed
/// therefore shows as changed until git itself refreshes the index.
fn git_readonly(dir: &std::path::Path) -> Command {
    let mut c = git(dir);
    c.args(["-c", "core.fsmonitor=false"]);
    c
}

/// Output of a read-only git command; None when git is missing or the command failed.
fn read(dir: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = git_readonly(dir).args(args).output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One letter per changed file from the staged (`x`) and the unstaged (`y`) state, as `git status`
/// shows them: U conflict, D deleted, A added, R renamed, else M changed.
fn letter(x: char, y: char) -> &'static str {
    if x == 'U' || y == 'U' {
        "U"
    } else if x == 'D' || y == 'D' {
        "D"
    } else if x == 'A' {
        "A"
    } else if x == 'R' || x == 'C' {
        "R"
    } else {
        "M"
    }
}

/// Parses `--name-status -z` output into path → status letter. Renames and copies carry the old path
/// first; the new path is the one shown.
fn parse_name_status(out: &str) -> Vec<(String, char)> {
    let mut list = Vec::new();
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    while let Some(code) = parts.next() {
        let kind = code.chars().next().unwrap_or('M');
        if kind == 'R' || kind == 'C' {
            parts.next();
        }
        if let Some(path) = parts.next() {
            list.push((path.to_string(), kind));
        }
    }
    list
}

/// Builds the file letters from the staged changes, the unstaged changes and the untracked entries.
fn changed_files(staged: &str, unstaged: &str, untracked: &str) -> HashMap<String, String> {
    let mut states: HashMap<String, (char, char)> = HashMap::new();
    for (path, kind) in parse_name_status(staged) {
        states.entry(path).or_insert((' ', ' ')).0 = kind;
    }
    for (path, kind) in parse_name_status(unstaged) {
        states.entry(path).or_insert((' ', ' ')).1 = kind;
    }
    let mut files: HashMap<String, String> =
        states.into_iter().map(|(path, (x, y))| (path, letter(x, y).to_string())).collect();
    for path in untracked.split('\0').filter(|p| !p.is_empty()) {
        files.insert(path.trim_end_matches('/').to_string(), "?".to_string());
    }
    files
}

/// Parses `git rev-list --left-right --count HEAD...@{upstream}`: "ahead<TAB>behind".
fn parse_counts(out: &str) -> (u32, u32) {
    let mut n = out.split_whitespace().map(|v| v.parse().unwrap_or(0));
    (n.next().unwrap_or(0), n.next().unwrap_or(0))
}

/// State of the working copy `dir` lies in; None outside a repository or without git.
pub fn status(dir: &str) -> Option<GitStatus> {
    let native = to_native(dir);
    let root = read(&native, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let top = std::path::Path::new(&root);
    // A branch without commits yet still has its name; a detached HEAD shows the short commit.
    let branch = read(top, &["symbolic-ref", "--short", "-q", "HEAD"])
        .or_else(|| read(top, &["rev-parse", "--short", "HEAD"]))
        .unwrap_or_default();
    let (ahead, behind) =
        read(top, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).map_or((0, 0), |o| parse_counts(&o));
    // Without a first commit everything in the index is new.
    let staged = read(top, &["diff-index", "--cached", "--name-status", "-z", "-M", "HEAD"])
        .or_else(|| {
            read(top, &["ls-files", "--cached", "-z"]).map(|o| o.split('\0').map(|p| format!("A\0{p}\0")).collect())
        })
        .unwrap_or_default();
    let unstaged = read(top, &["diff-files", "--name-status", "-z"]).unwrap_or_default();
    let untracked =
        read(top, &["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z"])
            .unwrap_or_default();
    Some(GitStatus {
        root: to_ui(top),
        branch: branch.trim().to_string(),
        ahead,
        behind,
        files: changed_files(&staged, &unstaged, &untracked),
    })
}

/// Runs an everyday command in the working copy `root`: "add" (the given
/// paths, relative to root), "addAll", "commit" (with `message`; `all` stages
/// every change first), "pull" (fast-forward only) or "push". Returns git's
/// output for the log. These run on a click, with the repository's hooks and
/// filters like in a terminal.
pub fn action(root: &str, what: &str, paths: &[String], message: &str, all: bool) -> AppResult<String> {
    let native = to_native(root);
    let run = |args: &[&str]| -> AppResult<String> {
        let out = git(&native).args(args).output().map_err(|e| {
            AppError::other("Git ist auf diesem Computer nicht installiert.").with_detail(e.to_string())
        })?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
            .trim()
            .to_string();
        if out.status.success() {
            Ok(text)
        } else {
            let reason = match text.lines().find(|l| !l.trim().is_empty()) {
                Some(line) => Param::from(line),
                None => Param::from(Message::new("fehlgeschlagen")),
            };
            Err(AppError::other("Git: {0}").param(reason).with_detail(text))
        }
    };
    match what {
        "add" => {
            let mut args = vec!["add", "--"];
            args.extend(paths.iter().map(String::as_str));
            run(&args)
        }
        "addAll" => run(&["add", "-A"]),
        "commit" => {
            if message.trim().is_empty() {
                return Err(AppError::other("Bitte eine Beschreibung für den Commit eingeben."));
            }
            if all {
                run(&["add", "-A"])?;
            }
            run(&["commit", "-m", message.trim()])
        }
        "pull" => run(&["pull", "--ff-only"]),
        "push" => run(&["push"]),
        _ => Err(AppError::other("Unbekannter Git-Befehl.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_from_staged_unstaged_and_untracked() {
        let staged = "M\0src/a.rs\0A\0b.txt\0R100\0alt.txt\0c.txt\0U\0d.txt\0";
        let unstaged = "M\0src/a.rs\0D\0e.txt\0U\0d.txt\0M\0f.txt\0";
        let files = changed_files(staged, unstaged, "neu.txt\0ordner/\0");
        let get = |k: &str| files.get(k).map(String::as_str);
        assert_eq!(
            (get("src/a.rs"), get("b.txt"), get("c.txt"), get("d.txt"), get("e.txt"), get("f.txt")),
            (Some("M"), Some("A"), Some("R"), Some("U"), Some("D"), Some("M"))
        );
        assert_eq!((get("neu.txt"), get("ordner")), (Some("?"), Some("?")));
        assert!(get("alt.txt").is_none());
        assert_eq!(parse_counts("2\t1\n"), (2, 1));
    }

    fn git_ok(dir: &std::path::Path, args: &[&str]) {
        assert!(git(dir).args(args).output().unwrap().status.success(), "{args:?}");
    }

    fn has_git() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    #[test]
    fn real_repository() {
        if !has_git() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ui = to_ui(dir.path());
        assert!(status(&ui).is_none(), "not a repository");
        let g = |args: &[&str]| git_ok(dir.path(), args);
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "Test"]);
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        let st = status(&ui).unwrap();
        assert_eq!(st.branch, "main");
        assert_eq!(st.files.get("a.txt").map(String::as_str), Some("?"));
        g(&["add", "a.txt"]);
        assert_eq!(
            status(&ui).unwrap().files.get("a.txt").map(String::as_str),
            Some("A"),
            "staged before the first commit"
        );
        action(&st.root, "commit", &[], "erster", true).unwrap();
        assert!(status(&ui).unwrap().files.is_empty());
        std::fs::write(dir.path().join("a.txt"), "b").unwrap();
        assert_eq!(status(&ui).unwrap().files.get("a.txt").map(String::as_str), Some("M"));
        assert!(action(&st.root, "commit", &[], "  ", false).is_err());
    }

    /// A downloaded repository must not run its own programs when the folder is only shown.
    #[test]
    fn showing_a_repository_runs_none_of_its_programs() {
        if !has_git() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let g = |args: &[&str]| git_ok(dir.path(), args);
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "Test"]);
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        g(&["add", "a.txt"]);
        g(&["commit", "-q", "-m", "erster"]);
        // The commands run in the working copy and leave a file there when they are started.
        g(&["config", "core.fsmonitor", "echo > fsmonitor-ran"]);
        g(&["config", "filter.trap.clean", "echo > filter-ran"]);
        std::fs::write(dir.path().join(".gitattributes"), "* filter=trap\n").unwrap();
        std::fs::write(dir.path().join("a.txt"), "changed").unwrap();
        let st = status(&to_ui(dir.path())).unwrap();
        assert_eq!(st.files.get("a.txt").map(String::as_str), Some("M"));
        assert!(!dir.path().join("fsmonitor-ran").exists(), "core.fsmonitor ran");
        assert!(!dir.path().join("filter-ran").exists(), "a clean filter ran");
    }
}
