//! Menu of the app icon: the jump list of the Windows taskbar and the Dock menu on the Mac.
//!
//! Both offer the same short list as the status icon's menu (see tray.rs): a new tab, quick
//! connect and the saved servers. The entries are taken from the status menu the interface
//! describes, so there is one list for all three places.
//!
//! - Windows starts Bitcrane again with `--tray-action <id>` for a jump list entry; the single
//!   instance handler (or `take_start_action` at a first start) hands the id to the interface.
//!   The taskbar shows a jump list only for the app ID of its button: the installer's shortcuts
//!   carry the bundle identifier as app ID, so the process and the list use it too.
//! - On the Mac the Dock asks the app delegate for `applicationDockMenu:`; Tauri's delegate gets
//!   that method and one for the clicks (`bitcraneDockItem:`) added at the first update.

use tauri::AppHandle;

use crate::tray::TrayItem;

/// Command line flag of a jump list entry.
pub const ACTION_FLAG: &str = "--tray-action";

/// One entry: the action id of the status menu and its text.
#[derive(Clone, PartialEq)]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
struct Entry {
    id: String,
    label: String,
}

/// Tasks first, then the servers (with the heading of their submenu).
#[derive(Clone, PartialEq, Default)]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
struct Content {
    tasks: Vec<Entry>,
    servers_title: String,
    servers: Vec<Entry>,
}

fn content(items: &[TrayItem]) -> Content {
    let entry = |i: &TrayItem| Entry { id: i.id.clone(), label: i.label.clone() };
    let mut c = Content::default();
    for item in items {
        match item.id.as_str() {
            "newTab" | "quick" => c.tasks.push(entry(item)),
            "servers" => {
                c.servers_title = item.label.clone();
                c.servers = item.items.iter().flatten().map(entry).collect();
            }
            _ => {}
        }
    }
    c
}

static LAST: std::sync::Mutex<Option<Content>> = std::sync::Mutex::new(None);

/// Sets the icon menu from the status menu; nothing happens while the list is unchanged
/// (the status menu itself changes with every transfer).
pub fn update(app: &AppHandle, items: &[TrayItem]) {
    let next = content(items);
    {
        let mut last = LAST.lock().unwrap();
        if last.as_ref() == Some(&next) {
            return;
        }
        *last = Some(next.clone());
    }
    platform::apply(app, next);
}

/// The action given with `--tray-action` when Bitcrane was started from the jump list.
pub fn action_arg(args: &[String]) -> Option<String> {
    let at = args.iter().position(|a| a == ACTION_FLAG)?;
    args.get(at + 1).cloned()
}

#[cfg(windows)]
pub use platform::set_app_id;

#[cfg(windows)]
mod platform {
    use super::{Content, ACTION_FLAG};
    use tauri::AppHandle;
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, SHStrDupW, ShellLink};

    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    /// Gives the process the app ID of the installer's shortcuts, also when it was started
    /// directly (at login, from the command line), so its taskbar button and jump list match.
    pub fn set_app_id(identifier: &str) {
        if let Err(e) = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(identifier)) } {
            log::warn!("app user model id: {e}");
        }
    }

    pub fn apply(app: &AppHandle, content: Content) {
        let app_id = HSTRING::from(app.config().identifier.as_str());
        // COM wants a thread of its own; the list is written in a few milliseconds.
        std::thread::spawn(move || {
            if let Err(e) = unsafe { write(&app_id, &content) } {
                log::warn!("jump list: {e}");
            }
        });
    }

    unsafe fn write(app_id: &HSTRING, content: &Content) -> windows::core::Result<()> {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let exe = HSTRING::from(std::env::current_exe().unwrap_or_default().as_os_str());
        let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        list.SetAppID(app_id)?;
        let mut slots = 0u32;
        let _removed: IObjectArray = list.BeginList(&mut slots)?;
        let servers = collection(&exe, content.servers.iter().take(slots as usize))?;
        if !content.servers.is_empty() {
            list.AppendCategory(&HSTRING::from(content.servers_title.as_str()), &servers)?;
        }
        list.AddUserTasks(&collection(&exe, content.tasks.iter())?)?;
        list.CommitList()
    }

    unsafe fn collection<'a>(exe: &HSTRING, entries: impl Iterator<Item = &'a super::Entry>) -> windows::core::Result<IObjectArray> {
        let items: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        for e in entries {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(exe)?;
            link.SetArguments(&HSTRING::from(format!("{ACTION_FLAG} \"{}\"", e.id)))?;
            link.SetIconLocation(exe, 0)?;
            let props: IPropertyStore = link.cast()?;
            let mut title = PROPVARIANT::default();
            (*title.Anonymous.Anonymous).vt = VT_LPWSTR;
            (*title.Anonymous.Anonymous).Anonymous.pwszVal = SHStrDupW(&HSTRING::from(e.label.as_str()))?;
            let set = props.SetValue(&PKEY_Title, &title).and_then(|_| props.Commit());
            let _ = PropVariantClear(&mut title);
            set?;
            items.AddObject(&link)?;
        }
        items.cast()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Content;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Imp, Sel};
    use objc2::{sel, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
    use objc2_foundation::NSString;
    use std::cell::RefCell;
    use std::sync::OnceLock;
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    thread_local! {
        /// The Dock menu, kept alive here and handed out on request (main thread only).
        static MENU: RefCell<Option<Retained<NSMenu>>> = const { RefCell::new(None) };
    }

    pub fn apply(app: &AppHandle, content: Content) {
        let first = APP.set(app.clone()).is_ok();
        let _ = app.run_on_main_thread(move || {
            let mtm = MainThreadMarker::new().expect("run_on_main_thread runs on the main thread");
            if first {
                unsafe { install(mtm) };
            }
            let menu = unsafe { build(mtm, &content) };
            MENU.with(|m| *m.borrow_mut() = Some(menu));
        });
    }

    /// Adds the two methods to the class of Tauri's application delegate.
    unsafe fn install(mtm: MainThreadMarker) {
        let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
            log::warn!("dock menu: no application delegate");
            return;
        };
        let class = objc2::ffi::object_getClass((&*delegate as *const _ as *const AnyObject).cast()) as *mut _;
        let dock: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut NSMenu = dock_menu;
        let click: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSMenuItem) = clicked;
        let added = objc2::ffi::class_addMethod(class, sel!(applicationDockMenu:), std::mem::transmute::<_, Imp>(dock), c"@@:@".as_ptr()).as_bool()
            && objc2::ffi::class_addMethod(class, sel!(bitcraneDockItem:), std::mem::transmute::<_, Imp>(click), c"v@:@".as_ptr()).as_bool();
        if !added {
            log::warn!("dock menu: the application delegate already has these methods");
        }
    }

    unsafe fn build(mtm: MainThreadMarker, content: &Content) -> Retained<NSMenu> {
        let menu = NSMenu::new(mtm);
        let delegate = NSApplication::sharedApplication(mtm).delegate();
        let add = |id: &str, label: &str| {
            let item = NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str(label), Some(sel!(bitcraneDockItem:)), &NSString::from_str(""));
            item.setTarget(delegate.as_deref().map(|d| d.as_ref()));
            item.setRepresentedObject(Some(&NSString::from_str(id)));
            menu.addItem(&item);
        };
        for e in &content.servers {
            add(&e.id, &e.label);
        }
        if !content.servers.is_empty() && !content.tasks.is_empty() {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        }
        for e in &content.tasks {
            add(&e.id, &e.label);
        }
        menu
    }

    unsafe extern "C-unwind" fn dock_menu(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> *mut NSMenu {
        MENU.with(|m| m.borrow().as_ref().map_or(std::ptr::null_mut(), |menu| Retained::as_ptr(menu) as *mut NSMenu))
    }

    unsafe extern "C-unwind" fn clicked(_this: *mut AnyObject, _cmd: Sel, item: *mut NSMenuItem) {
        let Some(item) = item.as_ref() else { return };
        let Some(id) = item.representedObject().and_then(|o| o.downcast::<NSString>().ok()) else { return };
        if let Some(app) = APP.get() {
            crate::tray::on_menu(app, &id.to_string());
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    pub fn apply(_app: &tauri::AppHandle, _content: super::Content) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, label: &str, items: Option<Vec<TrayItem>>) -> TrayItem {
        TrayItem { id: id.into(), label: label.into(), enabled: true, checked: None, items }
    }

    #[test]
    fn takes_tasks_and_servers_from_the_status_menu() {
        let menu = vec![
            item("status", "Bereit", None),
            item("newTab", "Neuer Tab", None),
            item("quick", "Schnell verbinden …", None),
            item("servers", "Server öffnen", Some(vec![item("server:a", "Webshop", None)])),
            item("quit", "Bitcrane beenden", None),
        ];
        let c = content(&menu);
        assert_eq!(c.tasks.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["newTab", "quick"]);
        assert_eq!(c.servers_title, "Server öffnen");
        assert_eq!(c.servers.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["Webshop"]);
    }

    #[test]
    fn reads_the_action_of_a_jump_list_start() {
        let args: Vec<String> = ["bitcrane.exe", "--tray-action", "server:a"].iter().map(|s| s.to_string()).collect();
        assert_eq!(action_arg(&args).as_deref(), Some("server:a"));
        assert_eq!(action_arg(&["bitcrane.exe".to_string()]), None);
    }
}
