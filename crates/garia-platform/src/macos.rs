//! macOS-specific wiring: dock badge + Services (Download with Garia).
//!
//! Full dock *menu* (applicationDockMenu:) still needs the iced/winit
//! NSApplication delegate — deferred; tray covers the same verbs for now.

use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, AnyThread};
use objc2_app_kit::{
    NSApplication, NSPasteboard, NSPasteboardTypeString, NSPasteboardTypeURL,
    NSUpdateDynamicServices,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
use objc2::MainThreadMarker;

use garia_core::catch;

use crate::{Platform, PlatformEvent};

static PLATFORM: Mutex<Option<Platform>> = Mutex::new(None);

pub fn on_start(platform: &Platform) {
    if let Ok(mut g) = PLATFORM.lock() {
        *g = Some(platform.clone());
    }
    install_services();
}

pub fn set_badge(count: u32) {
    // NSDockTile badge label — best-effort; failure is silent.
    let label = if count == 0 {
        None
    } else {
        Some(count.to_string())
    };
    let _ = (|| -> Result<(), ()> {
        let mtm = MainThreadMarker::new().ok_or(())?;
        let app = NSApplication::sharedApplication(mtm);
        let tile = app.dockTile();
        if let Some(text) = label {
            let s = NSString::from_str(&text);
            unsafe { tile.setBadgeLabel(Some(&s)) };
        } else {
            unsafe { tile.setBadgeLabel(None) };
        }
        Ok(())
    })();
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = AnyThread]
    #[name = "GariaIcedServiceProvider"]
    struct ServiceProvider;

    impl ServiceProvider {
        #[unsafe(method(downloadSelection:userData:error:))]
        fn download_selection(
            &self,
            pboard: &NSPasteboard,
            _user_data: Option<&NSString>,
            _error: *mut *mut NSString,
        ) {
            take_pasteboard(pboard);
        }
    }

    unsafe impl NSObjectProtocol for ServiceProvider {}
);

impl ServiceProvider {
    fn create() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

fn install_services() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let provider = ServiceProvider::create();
    let app = NSApplication::sharedApplication(mtm);
    unsafe {
        app.setServicesProvider(Some(&*provider));
        // Leak the provider so AppKit can keep calling it.
        std::mem::forget(provider);
        NSUpdateDynamicServices();
    }
}

fn take_pasteboard(pboard: &NSPasteboard) {
    let text = unsafe {
        pboard
            .stringForType(NSPasteboardTypeURL)
            .or_else(|| pboard.stringForType(NSPasteboardTypeString))
    };
    let Some(ns) = text else { return };
    let raw = ns.to_string();
    let url = catch::url_from_selection(&raw)
        .or_else(|| catch::file_url_in(&raw))
        .or_else(|| catch::magnet_url(&raw));
    let Some(url) = url else { return };
    let Ok(guard) = PLATFORM.lock() else { return };
    let Some(platform) = guard.as_ref() else { return };
    platform.push(PlatformEvent::Catch(catch::CatchEvent {
        url,
        source: "service".into(),
        name: None,
        referrer: None,
        confirm: false,
        urls: Vec::new(),
    }));
}
