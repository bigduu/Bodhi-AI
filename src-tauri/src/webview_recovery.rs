use block2::RcBlock;
use objc2_app_kit::{NSView, NSWorkspace, NSWorkspaceScreensDidWakeNotification};
use objc2_foundation::{
    ns_string, NSDistributedNotificationCenter, NSNotification, NSOperationQueue,
};
use std::{cell::RefCell, ffi::CString, ptr::NonNull};
use tauri::{AppHandle, Manager, Runtime};

pub(crate) const RELOAD_MENU_ID: &str = "reload-main-page";

// WKWebView hosts the page's layers separately from its AppKit background.
// Change the page's opacity briefly to request a new composited frame while
// keeping the document, input focus and in-memory state intact.
const REPAINT_SCRIPT: &str =
    "document.documentElement?.animate([{ opacity: 0.995 }, { opacity: 1 }], 50);";

type ObserverCleanup = Box<dyn FnOnce()>;

thread_local! {
    static REMOVE_OBSERVERS: RefCell<Option<ObserverCleanup>> = const { RefCell::new(None) };
}

fn record(message: &str) {
    // Finder launches can discard stderr. Record the event in the system log.
    if let Ok(message) = CString::new(message) {
        // Both pointers are NUL-terminated, and the format string is static.
        unsafe {
            libc::syslog(
                libc::LOG_NOTICE,
                c"[webview-recovery] %s".as_ptr(),
                message.as_ptr(),
            );
        }
    }
}

pub(crate) fn observe<R: Runtime>(app: &AppHandle<R>) {
    remove_observers();
    let app = app.clone();
    let redraw = RcBlock::new(move |notification: NonNull<NSNotification>| {
        // The notification center keeps this object alive during the call.
        let name = unsafe { notification.as_ref() }.name();
        request_redraw(&app, &name.to_string());
    });

    let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
    let distributed = NSDistributedNotificationCenter::defaultCenter();
    let queue = NSOperationQueue::mainQueue();
    // The block captures a Send + Sync AppHandle and dispatches on AppKit's main
    // queue. Display wake can precede authentication, so also listen for the
    // loginwindow signal, including unlocks where the display never slept.
    let (wake, unlock) = unsafe {
        (
            workspace.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceScreensDidWakeNotification),
                None,
                Some(&queue),
                &redraw,
            ),
            distributed.addObserverForName_object_queue_usingBlock(
                Some(ns_string!("com.apple.screenIsUnlocked")),
                None,
                Some(&queue),
                &redraw,
            ),
        )
    };
    REMOVE_OBSERVERS.set(Some(Box::new(move || unsafe {
        workspace.removeObserver(wake.as_ref());
        distributed.removeObserver(unlock.as_ref());
    })));
}

pub(crate) fn remove_observers() {
    if let Some(remove) = REMOVE_OBSERVERS.take() {
        remove();
    }
}

fn request_redraw<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if !matches!(window.is_visible(), Ok(true)) || !matches!(window.is_minimized(), Ok(false)) {
        return;
    }

    let result = window.ns_view().and_then(|content_view| {
        // Tauri lends the live window's content view on AppKit's main queue.
        let view = unsafe { &*content_view.cast::<NSView>() };
        view.setNeedsDisplay(true);
        // Wry places the WKWebView directly inside this content view.
        for subview in view.subviews().iter() {
            subview.setNeedsDisplay(true);
        }
        window.eval(REPAINT_SCRIPT)
    });

    match result {
        Ok(()) => record(&format!("Redraw requested after {reason}")),
        Err(error) => record(&format!("Redraw failed after {reason} ({error})")),
    }
}

pub(crate) fn reload<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        match window.reload() {
            Ok(()) => record("Reload requested from the application menu"),
            Err(error) => record(&format!("Menu reload failed ({error})")),
        }
    }
}
