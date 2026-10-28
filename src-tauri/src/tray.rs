//! Status icon in the macOS menu bar and the Windows notification area.
//!
//! The icon keeps Bitcrane reachable while the window is hidden and folder
//! watches keep running in the background. The frontend decides whether the
//! icon is shown (setting "Symbol in der Menüleiste") and updates its tooltip
//! and the pause entry; clicks on menu entries that need the user interface
//! are forwarded to the frontend as `tray-action` events.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use std::sync::Mutex;

const TRAY_ID: &str = "bitcrane-tray";

/// Menu entries whose text changes at runtime.
pub struct TrayState {
    pub icon: Mutex<Option<TrayIcon<Wry>>>,
    pub pause_item: Mutex<Option<MenuItem<Wry>>>,
    pub status_item: Mutex<Option<MenuItem<Wry>>>,
    pub open_item: Mutex<Option<MenuItem<Wry>>>,
    pub quit_item: Mutex<Option<MenuItem<Wry>>>,
}

impl TrayState {
    pub fn new() -> Self {
        Self { icon: Mutex::new(None), pause_item: Mutex::new(None), status_item: Mutex::new(None), open_item: Mutex::new(None), quit_item: Mutex::new(None) }
    }
}

/// Menu texts in the interface language (sent by the frontend).
#[derive(serde::Deserialize, Clone)]
pub struct TrayLabels {
    pub open: String,
    pub pause: String,
    pub resume: String,
    pub quit: String,
}

/// Brings the main window back to the front.
pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn icon_image() -> tauri::Result<Image<'static>> {
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = include_bytes!("../icons/tray/bitcrane-menuTemplate@2x.png");
    // Windows: only the B in the logo colours, filling the whole symbol (the app
    // symbol with its tile became tiny in the notification area). Most programs
    // there show coloured symbols, so the B keeps its colours on both a dark and
    // a light taskbar.
    #[cfg(windows)]
    let bytes: &[u8] = include_bytes!("../icons/tray/bitcrane-tray-farbe-32.png");
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let bytes: &[u8] = include_bytes!("../icons/32x32.png");
    Image::from_bytes(bytes)
}

fn create(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<TrayState>();
    let status = MenuItem::with_id(app, "status", "Keine Überwachung aktiv", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Bitcrane öffnen", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Alle Überwachungen pausieren", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Bitcrane beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &open, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_image()?)
        .tooltip("Bitcrane")
        .menu(&menu)
        // Windows: left click opens the window, right click shows the menu.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "pause" => {
                let _ = app.emit("tray-action", "pauseAll");
            }
            "quit" => {
                // The window saves unsaved changes and quits; if it does not answer, quit anyway.
                let _ = app.emit("tray-action", "quit");
                let handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if !cfg!(target_os = "macos") {
                    show_main_window(tray.app_handle());
                }
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    let icon = builder.build(app)?;

    *state.icon.lock().unwrap() = Some(icon);
    *state.pause_item.lock().unwrap() = Some(pause);
    *state.status_item.lock().unwrap() = Some(status);
    *state.open_item.lock().unwrap() = Some(open);
    *state.quit_item.lock().unwrap() = Some(quit);
    Ok(())
}

/// Shows or hides the status icon and updates its texts.
pub fn update(app: &AppHandle, visible: bool, status: &str, paused: bool, labels: Option<TrayLabels>) -> tauri::Result<()> {
    let state = app.state::<TrayState>();
    if !visible {
        if let Some(icon) = state.icon.lock().unwrap().take() {
            let _ = icon.set_visible(false);
            app.remove_tray_by_id(TRAY_ID);
        }
        return Ok(());
    }
    if state.icon.lock().unwrap().is_none() {
        create(app)?;
    }
    if let Some(icon) = state.icon.lock().unwrap().as_ref() {
        icon.set_tooltip(Some(format!("Bitcrane – {status}")))?;
    }
    if let Some(item) = state.status_item.lock().unwrap().as_ref() {
        item.set_text(status)?;
    }
    if let Some(item) = state.pause_item.lock().unwrap().as_ref() {
        let (pause, resume) = labels.as_ref().map(|l| (l.pause.as_str(), l.resume.as_str())).unwrap_or(("Alle Überwachungen pausieren", "Alle Überwachungen fortsetzen"));
        item.set_text(if paused { resume } else { pause })?;
    }
    if let Some(l) = &labels {
        if let Some(item) = state.open_item.lock().unwrap().as_ref() {
            item.set_text(&l.open)?;
        }
        if let Some(item) = state.quit_item.lock().unwrap().as_ref() {
            item.set_text(&l.quit)?;
        }
    }
    Ok(())
}
