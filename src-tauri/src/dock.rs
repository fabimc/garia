/// Right-click on the dock icon. AppKit asks the delegate for that menu
/// via `applicationDockMenu:` — there is no setter — so we add the method
/// to Tao's delegate class after launch. The verbs match the menu-bar extra.

use std::ffi::c_char;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{define_class, ffi, msg_send, sel, AnyThread, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
use objc2::MainThreadMarker;
use tauri::{Emitter, Manager};

use crate::bring_to_front;

static APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
static MENU_PTR: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = AnyThread]
    #[name = "GariaDockTarget"]
    struct DockTarget;

    impl DockTarget {
        #[unsafe(method(newDownload:))]
        fn new_download(&self, _sender: Option<&AnyObject>) {
            fire("new-download");
        }

        #[unsafe(method(pauseAll:))]
        fn pause_all(&self, _sender: Option<&AnyObject>) {
            fire("pause-all");
        }

        #[unsafe(method(resumeAll:))]
        fn resume_all(&self, _sender: Option<&AnyObject>) {
            fire("resume-all");
        }

        #[unsafe(method(openFolder:))]
        fn open_folder(&self, _sender: Option<&AnyObject>) {
            fire("open-folder");
        }
    }

    unsafe impl NSObjectProtocol for DockTarget {}
);

impl DockTarget {
    fn create() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

fn fire(id: &str) {
    let Ok(guard) = APP.lock() else { return };
    let Some(app) = guard.as_ref() else { return };
    bring_to_front(app);
    let _ = app.emit("menu", id);
}

fn add_item(mtm: MainThreadMarker, menu: &NSMenu, target: &DockTarget, title: &str, action: Sel) {
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            Some(action),
            &NSString::from_str(""),
        )
    };
    unsafe { item.setTarget(Some(target)) };
    menu.addItem(&item);
}

/// AppKit does not retain the menu this returns; `DockHold` keeps it.
unsafe extern "C-unwind" fn application_dock_menu(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> *mut AnyObject {
    MENU_PTR.load(Ordering::Acquire)
}

fn attach_to_delegate(mtm: MainThreadMarker) -> Result<(), String> {
    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate = ns_app.delegate().ok_or("the app has no delegate yet")?;
    let class: &AnyClass = unsafe { &*Retained::as_ptr(&delegate).cast::<AnyObject>() }.class();
    let sel = sel!(applicationDockMenu:);
    let types = c"@@:@";
    let imp: objc2::runtime::Imp = unsafe {
        std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject,
            objc2::runtime::Imp,
        >(application_dock_menu)
    };
    let added = unsafe {
        ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel,
            imp,
            types.as_ptr() as *const c_char,
        )
    };
    if !added.as_bool() {
        return Err("applicationDockMenu: is already on the delegate".into());
    }
    Ok(())
}

/// Held so the target and menu outlive the dock. Item `target` is not retained;
/// AppKit does not retain the menu `applicationDockMenu:` returns.
struct DockHold {
    _target: Retained<DockTarget>,
    _menu: MenuHold,
}

#[allow(dead_code)]
struct MenuHold(Retained<NSMenu>);
unsafe impl Send for MenuHold {}
unsafe impl Sync for MenuHold {}

pub fn install(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut slot) = APP.lock() {
        *slot = Some(app.clone());
    }
    let mtm = MainThreadMarker::new().ok_or("the dock menu has to be installed on the main thread")?;
    let target = DockTarget::create();
    let menu = NSMenu::new(mtm);
    add_item(mtm, &menu, &target, "New Download", sel!(newDownload:));
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    add_item(mtm, &menu, &target, "Pause All", sel!(pauseAll:));
    add_item(mtm, &menu, &target, "Resume All", sel!(resumeAll:));
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    add_item(mtm, &menu, &target, "Open Download Folder", sel!(openFolder:));

    MENU_PTR.store(Retained::as_ptr(&menu) as *mut AnyObject, Ordering::Release);
    attach_to_delegate(mtm)?;
    app.manage(DockHold {
        _target: target,
        _menu: MenuHold(menu),
    });
    Ok(())
}
