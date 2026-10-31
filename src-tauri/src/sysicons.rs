//! File symbols of the operating system (Explorer on Windows, Finder on the
//! Mac) for the setting "Dateisymbole des Systems". The symbol is looked up by
//! file extension only, so it works for files on a server as well. Results are
//! PNG images, cached per extension, and served to the interface through the
//! "fileicon" URI scheme (see lib.rs).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Edge length of the symbols in pixels on the Mac (the lists scale them down).
#[allow(dead_code)]
const SIZE: u32 = 64;

fn cache() -> &'static Mutex<HashMap<String, Option<Vec<u8>>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<Vec<u8>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// PNG of the system symbol for a file extension ("jpg", "py" …), or None
/// when the system has none or the platform is not supported.
pub fn png_for_ext(ext: &str) -> Option<Vec<u8>> {
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect::<String>().to_ascii_lowercase();
    if let Some(hit) = cache().lock().ok()?.get(&ext) {
        return hit.clone();
    }
    let png = lookup(&ext);
    if let Ok(mut c) = cache().lock() {
        c.insert(ext, png.clone());
    }
    png
}

/// Encodes straight RGBA pixels as PNG.
#[allow(dead_code)]
fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

/// PNG of the Finder symbol of one item (an app's own icon, a library's icon …),
/// cached per path. Mac only; elsewhere None.
pub fn png_for_path(uri_path: &str) -> Option<Vec<u8>> {
    let decoded = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8().ok()?.into_owned();
    let key = format!("path:{decoded}");
    if let Some(hit) = cache().lock().ok()?.get(&key) {
        return hit.clone();
    }
    #[cfg(target_os = "macos")]
    let png = mac_icon::lookup_path(&crate::paths::to_native(&decoded).to_string_lossy());
    #[cfg(not(target_os = "macos"))]
    let png: Option<Vec<u8>> = None;
    if let Ok(mut c) = cache().lock() {
        c.insert(key, png.clone());
    }
    png
}

#[cfg(windows)]
fn lookup(ext: &str) -> Option<Vec<u8>> {
    windows_icon::lookup(ext)
}

#[cfg(target_os = "macos")]
fn lookup(ext: &str) -> Option<Vec<u8>> {
    mac_icon::lookup(ext)
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn lookup(_ext: &str) -> Option<Vec<u8>> {
    None
}

/// Windows: the shell's symbol for the extension from the system image list
/// ("extra large", 48 px), with the 32 px icon as fallback; converted from an
/// HICON into RGBA pixels.
#[cfg(windows)]
mod windows_icon {
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;
    use windows_sys::core::GUID;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::Controls::{ImageList_GetIcon, HIMAGELIST, ILD_TRANSPARENT};
    use windows_sys::Win32::UI::Shell::{
        SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SYSICONINDEX, SHGFI_USEFILEATTRIBUTES, SHIL_EXTRALARGE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    /// IID of IImageList (commoncontrols.h).
    const IID_IIMAGELIST: GUID = GUID::from_u128(0x46eb5926_582e_4017_9fdf_e8998daa0950);

    pub fn lookup(ext: &str) -> Option<Vec<u8>> {
        // A made-up file name: with SHGFI_USEFILEATTRIBUTES the shell only looks at the extension.
        let name: Vec<u16> = format!("datei.{ext}").encode_utf16().chain(Some(0)).collect();
        unsafe {
            // The shell's image lists want COM on this thread; a second call is harmless.
            let _ = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
            let mut info: SHFILEINFOW = zeroed();
            let mut icon: HICON = null_mut();
            if SHGetFileInfoW(name.as_ptr(), FILE_ATTRIBUTE_NORMAL, &mut info, size_of::<SHFILEINFOW>() as u32, SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES) != 0 {
                let mut list: *mut core::ffi::c_void = null_mut();
                if SHGetImageList(SHIL_EXTRALARGE as i32, &IID_IIMAGELIST, &mut list) >= 0 && !list.is_null() {
                    // An IImageList pointer may be used as HIMAGELIST (documented by Microsoft).
                    icon = ImageList_GetIcon(list as HIMAGELIST, info.iIcon, ILD_TRANSPARENT);
                }
            }
            if icon.is_null() {
                let mut small: SHFILEINFOW = zeroed();
                if SHGetFileInfoW(name.as_ptr(), FILE_ATTRIBUTE_NORMAL, &mut small, size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES) != 0 {
                    icon = small.hIcon;
                }
            }
            if icon.is_null() {
                return None;
            }
            let png = icon_to_png(icon);
            DestroyIcon(icon);
            png
        }
    }

    /// Reads the colour and mask bitmaps of an icon as 32-bit top-down pixels.
    unsafe fn icon_to_png(icon: HICON) -> Option<Vec<u8>> {
        let mut ii: ICONINFO = zeroed();
        if GetIconInfo(icon, &mut ii) == 0 {
            return None;
        }
        let result = (|| {
            let mut bm: BITMAP = zeroed();
            if ii.hbmColor.is_null() || GetObjectW(ii.hbmColor, size_of::<BITMAP>() as i32, &mut bm as *mut _ as *mut _) == 0 {
                return None;
            }
            let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
            if w <= 0 || h <= 0 || w > 512 || h > 512 {
                return None;
            }
            let color = read_bits(ii.hbmColor, w, h)?;
            let mut rgba = Vec::with_capacity((w * h * 4) as usize);
            let has_alpha = color.chunks_exact(4).any(|p| p[3] != 0);
            // Old icons without alpha: the mask says which pixels are transparent.
            let mask = if has_alpha { None } else { read_bits(ii.hbmMask, w, h) };
            for (i, p) in color.chunks_exact(4).enumerate() {
                let a = if has_alpha { p[3] } else if mask.as_ref().map(|m| m[i * 4] == 0).unwrap_or(true) { 255 } else { 0 };
                rgba.extend_from_slice(&[p[2], p[1], p[0], a]);
            }
            super::encode_png(w as u32, h as u32, &rgba)
        })();
        if !ii.hbmColor.is_null() {
            DeleteObject(ii.hbmColor);
        }
        if !ii.hbmMask.is_null() {
            DeleteObject(ii.hbmMask);
        }
        result
    }

    unsafe fn read_bits(bitmap: *mut core::ffi::c_void, w: i32, h: i32) -> Option<Vec<u8>> {
        let mut bmi: BITMAPINFO = zeroed();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..zeroed()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = CreateCompatibleDC(null_mut());
        let lines = GetDIBits(dc, bitmap, 0, h as u32, buf.as_mut_ptr() as *mut _, &mut bmi, DIB_RGB_COLORS);
        DeleteDC(dc);
        (lines == h).then_some(buf)
    }
}

/// macOS: NSWorkspace's symbol for the extension, rendered at 64 px and
/// written as PNG.
#[cfg(target_os = "macos")]
mod mac_icon {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    pub fn lookup(ext: &str) -> Option<Vec<u8>> {
        let ws = NSWorkspace::sharedWorkspace();
        #[allow(deprecated)]
        let image = ws.iconForFileType(&NSString::from_str(ext));
        to_png(&image)
    }

    /// The Finder symbol of one file or package (apps show their own icon).
    pub fn lookup_path(path: &str) -> Option<Vec<u8>> {
        let ws = NSWorkspace::sharedWorkspace();
        let image = ws.iconForFile(&NSString::from_str(path));
        to_png(&image)
    }

    fn to_png(image: &objc2_app_kit::NSImage) -> Option<Vec<u8>> {
        let side = super::SIZE as f64;
        let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(side, side));
        // SAFETY: `rect` is a valid pointer for the duration of the call; no context or hints.
        let cg = unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
        let rep: Retained<NSBitmapImageRep> = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
        let props: Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> = NSDictionary::new();
        // SAFETY: an empty property dictionary of the documented key and value types.
        let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
        Some(data.to_vec())
    }
}
