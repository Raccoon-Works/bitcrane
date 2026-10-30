//! Git in folders of this computer (after ForkLift): the state of a working
//! copy for the file list (branch, ahead/behind, changed files) and the
//! everyday commands — add, commit, pull, push. Uses the installed `git`
//! command, so the user's configuration, credential helper and SSH keys apply;
//! without git (or outside a repository) there is simply no git display.

use crate::error::{AppError, AppResult};
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

/// Parses `git status --porcelain=v1 -b -z`.
pub fn parse_status(out: &str) -> GitStatus {
    let mut st = GitStatus::default();
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    while let Some(p) = parts.next() {
        if let Some(head) = p.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" or "No commits yet on main".
            let (name, rest) = head.split_once(' ').map(|(a, b)| (a, b)).unwrap_or((head, ""));
            let name = name.split("...").next().unwrap_or(name);
            st.branch = if head.starts_with("No commits yet on ") { head.trim_start_matches("No commits yet on ").to_string() } else { name.to_string() };
            for (key, field) in [("ahead ", &mut st.ahead), ("behind ", &mut st.behind)] {
                if let Some(i) = rest.find(key) {
                    *field = rest[i + key.len()..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0);
                }
            }
            continue;
        }
        if p.len() < 4 {
            continue;
        }
        let (xy, path) = (&p[..2], &p[3..]);
        let x = xy.chars().next().unwrap_or(' ');
        let y = xy.chars().nth(1).unwrap_or(' ');
        // Renames and copies carry the old path as the next entry.
        if x == 'R' || x == 'C' {
            parts.next();
        }
        let letter = if xy == "??" {
            "?"
        } else if x == 'U' || y == 'U' || xy == "AA" || xy == "DD" {
            "U"
        } else if x == 'D' || y == 'D' {
            "D"
        } else if x == 'A' {
            "A"
        } else if x == 'R' || x == 'C' {
            "R"
        } else {
            "M"
        };
        st.files.insert(path.trim_end_matches('/').to_string(), letter.to_string());
    }
    st
}

/// State of the working copy `dir` lies in; None outside a repository or without git.
pub fn status(dir: &str) -> Option<GitStatus> {
    let native = to_native(dir);
    let top = git(&native).args(["rev-parse", "--show-toplevel"]).output().ok().filter(|o| o.status.success())?;
    let root = String::from_utf8_lossy(&top.stdout).trim().to_string();
    let out = git(std::path::Path::new(&root)).args(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal"]).output().ok().filter(|o| o.status.success())?;
    let mut st = parse_status(&String::from_utf8_lossy(&out.stdout));
    st.root = to_ui(std::path::Path::new(&root));
    Some(st)
}

/// Runs an everyday command in the working copy `root`: "add" (the given
/// paths, relative to root), "addAll", "commit" (with `message`; `all` stages
/// every change first), "pull" (fast-forward only) or "push". Returns git's
/// output for the log.
pub fn action(root: &str, what: &str, paths: &[String], message: &str, all: bool) -> AppResult<String> {
    let native = to_native(root);
    let run = |args: &[&str]| -> AppResult<String> {
        let out = git(&native).args(args).output().map_err(|e| AppError::other("Git ist auf diesem Computer nicht installiert.").with_detail(e.to_string()))?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string();
        if out.status.success() {
            Ok(text)
        } else {
            Err(AppError::other(format!("Git: {}", text.lines().find(|l| !l.trim().is_empty()).unwrap_or("fehlgeschlagen"))).with_detail(text))
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
    fn parses_porcelain() {
        let out = "## main...origin/main [ahead 2, behind 1]\0 M src/a.rs\0?? neu.txt\0A  b.txt\0R  c.txt\0alt.txt\0UU d.txt\0 D e.txt\0";
        let st = parse_status(out);
        assert_eq!((st.branch.as_str(), st.ahead, st.behind), ("main", 2, 1));
        let get = |k: &str| st.files.get(k).map(String::as_str);
        assert_eq!((get("src/a.rs"), get("neu.txt"), get("b.txt"), get("c.txt"), get("d.txt"), get("e.txt")), (Some("M"), Some("?"), Some("A"), Some("R"), Some("U"), Some("D")));
        assert!(get("alt.txt").is_none());
        assert_eq!(parse_status("## No commits yet on main\0").branch, "main");
    }

    #[test]
    fn real_repository() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ui = to_ui(dir.path());
        assert!(status(&ui).is_none(), "not a repository");
        let g = |args: &[&str]| assert!(git(dir.path()).args(args).output().unwrap().status.success(), "{args:?}");
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "Test"]);
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        let st = status(&ui).unwrap();
        assert_eq!(st.files.get("a.txt").map(String::as_str), Some("?"));
        action(&st.root, "commit", &[], "erster", true).unwrap();
        assert!(status(&ui).unwrap().files.is_empty());
        std::fs::write(dir.path().join("a.txt"), "b").unwrap();
        assert_eq!(status(&ui).unwrap().files.get("a.txt").map(String::as_str), Some("M"));
        assert!(action(&st.root, "commit", &[], "  ", false).is_err());
    }
}
