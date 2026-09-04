/// Services → Download with Garia. A selected URL in another app is an
/// instruction, the same as `garia://add` — they chose the menu item.

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
use tauri::Manager;

use crate::catch;
use crate::dispatch_catch;

static APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = AnyThread]
    #[name = "GariaServiceProvider"]
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

fn take_pasteboard(pboard: &NSPasteboard) {
    let text = unsafe {
        pboard
            .stringForType(NSPasteboardTypeString)
            .or_else(|| pboard.stringForType(NSPasteboardTypeURL))
    }
    .map(|s| s.to_string());
    let Some(text) = text else { return };
    let Some(url) = catch::url_from_selection(&text) else { return };
    let Ok(guard) = APP.lock() else { return };
    if let Some(app) = guard.as_ref() {
        dispatch_catch(app, url, "scheme");
    }
}

/// Held so the provider outlives `setServicesProvider`. Dropping it would
/// leave AppKit talking to freed memory the next time someone picks the item.
#[allow(dead_code)]
struct ProviderHold(Retained<ServiceProvider>);

pub fn install(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut slot) = APP.lock() {
        *slot = Some(app.clone());
    }
    let mtm = MainThreadMarker::new().ok_or("Services have to be registered on the main thread")?;
    let provider = ServiceProvider::create();
    let ns_app = NSApplication::sharedApplication(mtm);
    let as_object: &AnyObject = provider.as_ref();
    unsafe { ns_app.setServicesProvider(Some(as_object)) };
    app.manage(ProviderHold(provider));
    NSUpdateDynamicServices();
    Ok(())
}
