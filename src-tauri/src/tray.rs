//! Status icon in the macOS menu bar and the Windows notification area.
//!
//! The icon keeps Bitcrane reachable while the window is hidden and folder
//! watches keep running in the background. The frontend decides whether the
//! icon is shown (setting "Symbol in der Menüleiste", can be switched off) and
//! describes the whole menu (status, servers, watches, updates, settings …);
//! clicks are forwarded to the frontend as `tray-action` events.

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use std::sync::Mutex;

const TRAY_ID: &str = "bitcrane-tray";

/// The icon and the last menu built (to skip rebuilding an unchanged menu).
pub struct TrayState {
    pub icon: Mutex<Option<TrayIcon<Wry>>>,
    pub last_menu: Mutex<String>,
}

impl TrayState {
    pub fn new() -> Self {
        Self { icon: Mutex::new(None), last_menu: Mutex::new(String::new()) }
    }
}

/// One entry of the menu, described by the interface (texts in its language).
/// `id` empty and no label: a separator. `items`: a submenu.
#[derive(serde::Deserialize, Clone, Debug)]
pub struct TrayItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub items: Option<Vec<TrayItem>>,
}

fn yes() -> bool {
    true
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

/// Builds menu entries (recursively for submenus).
fn build_items(app: &AppHandle, items: &[TrayItem]) -> tauri::Result<Vec<Box<dyn IsMenuItem<Wry>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for it in items {
        if it.id.is_empty() && it.label.is_empty() {
            out.push(Box::new(PredefinedMenuItem::separator(app)?));
        } else if let Some(children) = &it.items {
            let built = build_items(app, children)?;
            let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|b| b.as_ref()).collect();
            out.push(Box::new(Submenu::with_id_and_items(app, &it.id, &it.label, it.enabled, &refs)?));
        } else if let Some(checked) = it.checked {
            out.push(Box::new(CheckMenuItem::with_id(app, &it.id, &it.label, it.enabled, checked, None::<&str>)?));
        } else {
            out.push(Box::new(MenuItem::with_id(app, &it.id, &it.label, it.enabled, None::<&str>)?));
        }
    }
    Ok(out)
}

fn build_menu(app: &AppHandle, items: &[TrayItem]) -> tauri::Result<Menu<Wry>> {
    let built = build_items(app, items)?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Menu actions. "open" is handled here; everything else goes to the interface
/// as a `tray-action` event, after bringing the window up when it needs it.
fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show_main_window(app),
        "quit" => {
            // The window saves unsaved changes and quits; if it does not answer, quit anyway.
            let _ = app.emit("tray-action", "quit");
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(20));
                handle.exit(0);
            });
        }
        // Done in the background, without opening the window.
        _ if id == "pauseAll" || id == "hideIcon" || id.starts_with("watch:") => {
            let _ = app.emit("tray-action", id);
        }
        _ => {
            show_main_window(app);
            let _ = app.emit("tray-action", id);
        }
    }
}

fn create(app: &AppHandle, menu: &Menu<Wry>) -> tauri::Result<()> {
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_image()?)
        .tooltip("Bitcrane")
        .menu(menu)
        // Windows: left click opens the window, right click shows the menu.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
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
    *app.state::<TrayState>().icon.lock().unwrap() = Some(icon);
    Ok(())
}

/// Shows or hides the status icon; sets its tooltip and menu.
pub fn update(app: &AppHandle, visible: bool, tooltip: &str, items: &[TrayItem]) -> tauri::Result<()> {
    let state = app.state::<TrayState>();
    if !visible {
        if let Some(icon) = state.icon.lock().unwrap().take() {
            let _ = icon.set_visible(false);
            app.remove_tray_by_id(TRAY_ID);
        }
        state.last_menu.lock().unwrap().clear();
        return Ok(());
    }
    let key = format!("{items:?}");
    let changed = *state.last_menu.lock().unwrap() != key;
    if state.icon.lock().unwrap().is_none() {
        let menu = build_menu(app, items)?;
        create(app, &menu)?;
    } else if changed {
        let menu = build_menu(app, items)?;
        if let Some(icon) = state.icon.lock().unwrap().as_ref() {
            icon.set_menu(Some(menu))?;
        }
    }
    *state.last_menu.lock().unwrap() = key;
    if let Some(icon) = state.icon.lock().unwrap().as_ref() {
        icon.set_tooltip(Some(format!("Bitcrane – {tooltip}")))?;
    }
    Ok(())
}
