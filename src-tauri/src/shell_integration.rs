//! "Mit Bitcrane hochladen" in the Explorer and Finder context menu (after
//! Transmit's "Send to" and WinSCP's Explorer extension).
//!
//! - Windows: an entry for files and folders in the classic context menu
//!   (Windows 11: "Weitere Optionen anzeigen"), written to HKEY_CURRENT_USER, so
//!   no administrator rights are needed. Explorer starts Bitcrane with
//!   `--upload <path>` once per selected item; a running Bitcrane receives the
//!   paths through the single-instance plugin.
//! - macOS: a Quick Action ("Schnellaktion") in ~/Library/Services. It hands the
//!   selected paths to Bitcrane as a `bitcrane://upload/<base64>` link.
//!
//! Switching it off removes the entry again.

use crate::error::{AppError, AppResult};

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn fail(e: impl ToString) -> AppError {
    AppError::other("Der Eintrag im Kontextmenü konnte nicht geändert werden.").with_detail(e.to_string())
}

#[cfg(windows)]
fn reg(args: &[&str]) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("reg").args(args).creation_flags(0x0800_0000).output().map_err(fail)?;
    if out.status.success() {
        Ok(())
    } else {
        Err(fail(String::from_utf8_lossy(&out.stderr)))
    }
}

/// Adds or removes the entry; `label` is the menu text in the interface language.
#[cfg(windows)]
pub fn set(enable: bool, label: &str) -> AppResult<()> {
    const KEYS: [&str; 2] = [r"HKCU\Software\Classes\*\shell\Bitcrane.Upload", r"HKCU\Software\Classes\Directory\shell\Bitcrane.Upload"];
    if !enable {
        for k in KEYS {
            let _ = reg(&["delete", k, "/f"]);
        }
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(fail)?;
    let exe = exe.to_string_lossy();
    let command = format!("\"{exe}\" --upload \"%1\"");
    for k in KEYS {
        reg(&["add", k, "/v", "MUIVerb", "/d", label, "/f"])?;
        reg(&["add", k, "/v", "Icon", "/d", &format!("\"{exe}\",0"), "/f"])?;
        reg(&["add", &format!(r"{k}\command"), "/ve", "/d", &command, "/f"])?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn workflow_dir() -> std::path::PathBuf {
    crate::paths::home().join("Library/Services/Bitcrane – hochladen.workflow")
}

/// Adds or removes the Quick Action; `label` is its name in the Finder menu.
#[cfg(target_os = "macos")]
pub fn set(enable: bool, label: &str) -> AppResult<()> {
    let dir = workflow_dir();
    if !enable {
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(fail)?;
        }
        refresh_services();
        return Ok(());
    }
    let contents = dir.join("Contents");
    std::fs::create_dir_all(&contents).map_err(fail)?;
    let label = xml_escape(label);
    std::fs::write(contents.join("Info.plist"), INFO_PLIST.replace("{LABEL}", &label)).map_err(fail)?;
    std::fs::write(contents.join("document.wflow"), DOCUMENT_WFLOW.replace("{COMMAND}", &xml_escape(SCRIPT))).map_err(fail)?;
    refresh_services();
    Ok(())
}

#[cfg(target_os = "macos")]
fn refresh_services() {
    let _ = std::process::Command::new("/System/Library/CoreServices/pbs").arg("-update").output();
}

#[cfg(target_os = "macos")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The Quick Action's script: all selected paths, one per line, as one link.
#[cfg(target_os = "macos")]
const SCRIPT: &str = r#"list=""
for f in "$@"; do list="$list$f
"; done
data=$(printf '%s' "$list" | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')
open "bitcrane://upload/$data""#;

#[cfg(target_os = "macos")]
const INFO_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>{LABEL}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.item</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
"#;

#[cfg(target_os = "macos")]
const DOCUMENT_WFLOW: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>{COMMAND}</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/bash</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>A1B2C3D4-0000-4000-8000-0000B17C0001</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
				</array>
				<key>OutputUUID</key>
				<string>A1B2C3D4-0000-4000-8000-0000B17C0002</string>
				<key>UUID</key>
				<string>A1B2C3D4-0000-4000-8000-0000B17C0003</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict/>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:253.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleIDsByPath</key>
		<dict/>
		<key>applicationPaths</key>
		<array/>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>15</integer>
		<key>processesInput</key>
		<false/>
		<key>serviceApplicationBundleID</key>
		<string>com.apple.finder</string>
		<key>serviceApplicationPath</key>
		<string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<false/>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<false/>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
"#;

#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn set(_enable: bool, _label: &str) -> AppResult<()> {
    Ok(())
}

/// Paths given with `--upload` (Explorer starts Bitcrane once per selected item).
pub fn upload_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--upload" {
            if let Some(p) = it.next() {
                out.push(p.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_upload_arguments() {
        let a: Vec<String> = ["bitcrane.exe", "--upload", r"C:\Users\x\a b.txt", "--autostart"].iter().map(|s| s.to_string()).collect();
        assert_eq!(super::upload_args(&a), vec![r"C:\Users\x\a b.txt".to_string()]);
    }
}
