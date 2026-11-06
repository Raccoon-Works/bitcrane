//! sftp:// links: Bitcrane as the program that opens them (opt-in in the settings).
//!
//! - Windows: the handler is written to HKEY_CURRENT_USER when the setting is switched on
//!   and removed again when it is switched off, but only if it is still Bitcrane's own. Other
//!   programs (WinSCP, PuTTY) often register the scheme for all users; an entry for this user
//!   takes precedence without touching theirs, and removing it hands the links back to them.
//!   A link starts Bitcrane with the address as its only argument, or reaches the running
//!   Bitcrane through the single-instance plugin.
//! - macOS: the scheme is declared in the app bundle (Info.plist) and links arrive through the
//!   deep-link plugin, so there is nothing to register here.

use crate::error::AppResult;

/// Registry path of the scheme for this user.
#[cfg(windows)]
const KEY: &str = r"Software\Classes\sftp";

#[cfg(windows)]
fn fail(e: impl ToString) -> crate::error::AppError {
    crate::error::AppError::other("Die Einstellung für sftp://-Links konnte nicht geändert werden.")
        .with_detail(e.to_string())
}

/// Command line Windows runs for a link, the form the deep-link plugin also writes.
#[cfg(windows)]
fn open_command(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

/// Registers Bitcrane for sftp:// links of this user, or removes its own registration.
#[cfg(windows)]
pub fn set(enable: bool) -> AppResult<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let exe = std::env::current_exe().map_err(fail)?;
    let exe = exe.to_string_lossy();
    let command = open_command(&exe);
    if enable {
        let (key, _) = user.create_subkey(KEY).map_err(fail)?;
        key.set_value("", &"URL:SFTP").map_err(fail)?;
        key.set_value("URL Protocol", &"").map_err(fail)?;
        let (icon, _) = key.create_subkey("DefaultIcon").map_err(fail)?;
        icon.set_value("", &format!("\"{exe}\",0")).map_err(fail)?;
        let (open, _) = key.create_subkey(r"shell\open\command").map_err(fail)?;
        open.set_value("", &command).map_err(fail)?;
        return Ok(());
    }
    let registered: Option<String> =
        user.open_subkey(format!(r"{KEY}\shell\open\command")).ok().and_then(|k| k.get_value("").ok());
    if registered.is_some_and(|c| c.eq_ignore_ascii_case(&command)) {
        user.delete_subkey_all(KEY).map_err(fail)?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set(_enable: bool) -> AppResult<()> {
    Err(crate::error::AppError::other("sftp://-Links werden nur unter Windows eingetragen."))
}

/// The sftp:// address among the program arguments: Windows passes a link as the only one.
pub fn link_arg(args: &[String]) -> Option<String> {
    match args {
        [_, link] if link.to_ascii_lowercase().starts_with("sftp://") => Some(link.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::link_arg;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_link_is_the_only_argument() {
        assert_eq!(
            link_arg(&args(&["bitcrane.exe", "sftp://deploy@web.example/srv"])).as_deref(),
            Some("sftp://deploy@web.example/srv")
        );
        assert_eq!(link_arg(&args(&["bitcrane.exe", "SFTP://web.example"])).as_deref(), Some("SFTP://web.example"));
        assert_eq!(link_arg(&args(&["bitcrane.exe"])), None);
        assert_eq!(link_arg(&args(&["bitcrane.exe", "--upload", "sftp://x"])), None);
        assert_eq!(link_arg(&args(&["bitcrane.exe", "https://web.example"])), None);
    }
}
