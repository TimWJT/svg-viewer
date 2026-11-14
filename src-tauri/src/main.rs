// SVG Viewer — native shell.
//
// The entire UI is the same single HTML file the browser build produces. Rust
// only does the three things a web page cannot: read an arbitrary path off
// disk, report its mtime so the viewer can live-reload, and receive the file
// Windows/macOS hands us when someone double-clicks an .svg document.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashSet, VecDeque};
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{mpsc, Arc, Mutex};
use std::time::UNIX_EPOCH;

use tauri::{Emitter, Manager, State};

/// The file this process was launched with, if any. Taken exactly once by the
/// frontend during boot.
struct InitialFile(Mutex<Option<String>>);

/// Canonical folders of the SVG documents this process has opened. The `asset`
/// handler only serves images from inside one of these, so an SVG can show the
/// pictures that sit next to it but cannot pull other files off the disk.
#[derive(Clone, Default)]
struct OpenedDirs(Arc<Mutex<Vec<PathBuf>>>);

impl OpenedDirs {
    fn remember(&self, dir: PathBuf) {
        if let Ok(mut dirs) = self.0.lock() {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }

    fn snapshot(&self) -> Vec<PathBuf> {
        self.0.lock().map(|d| d.clone()).unwrap_or_default()
    }
}

fn is_svg_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
}

/// The real path of an SVG document, or an error if `path` (after following
/// links) is not an `.svg` file. The viewer never needs to read anything else.
fn svg_document(path: &str) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    if !is_svg_path(&real) {
        return Err(format!("{path}: not an SVG file"));
    }
    Ok(real)
}

// One worker owns routing and the unclaimed queue. Window creation must not run
// in a synchronous IPC command or window-event callback (WebView2 deadlocks).
struct ExternalOpens(mpsc::Sender<OpenMessage>);

enum OpenMessage {
    Open(Option<String>),
    Ready(String),
    Destroyed(String),
    Claim {
        label: String,
        path: String,
        reply: mpsc::Sender<bool>,
    },
}

struct PendingOpen {
    path: String,
    recipient: Option<String>,
    notified: bool,
}

fn select_recipient<'a>(
    labels: impl IntoIterator<Item = &'a str>,
    unavailable: &HashSet<String>,
) -> Option<&'a str> {
    labels
        .into_iter()
        .filter(|label| {
            !unavailable.contains(*label) && (*label == "main" || label.starts_with("doc-"))
        })
        .min_by_key(|label| (*label != "main", *label))
}

fn external_recipient(
    app: &tauri::AppHandle,
    unavailable: &HashSet<String>,
) -> Option<tauri::WebviewWindow> {
    let mut windows = app.webview_windows();
    let label = select_recipient(windows.keys().map(String::as_str), unavailable)?.to_owned();
    windows.remove(&label)
}

fn revoke_recipient(pending: &mut VecDeque<PendingOpen>, label: &str) {
    for request in pending {
        if request.recipient.as_deref() == Some(label) {
            request.recipient = None;
            request.notified = false;
        }
    }
}

fn claim_pending(pending: &mut VecDeque<PendingOpen>, label: &str, path: &str, live: bool) -> bool {
    let index = pending.iter().position(|request| {
        live && request.recipient.as_deref() == Some(label)
            && request.path == path
            && request.notified
    });
    if let Some(index) = index {
        pending.remove(index);
        true
    } else {
        false
    }
}

fn focus_recipient(window: &tauri::WebviewWindow) {
    if let Err(error) = window.unminimize() {
        eprintln!("could not unminimise external-open recipient: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("could not focus external-open recipient: {error}");
    }
}

fn route_external_opens(app: tauri::AppHandle, receiver: mpsc::Receiver<OpenMessage>) {
    let mut ready = HashSet::new();
    // Failed labels stay excluded as well as destroyed ones. With the existing
    // label+path claim interface, reusing a failed label could let a delayed URL
    // or event claim a later assignment. A fresh label avoids that ambiguity.
    let mut unavailable = HashSet::new();
    let mut pending: VecDeque<PendingOpen> = VecDeque::new();
    let mut next_window = 0_u64;

    while let Ok(message) = receiver.recv() {
        match message {
            OpenMessage::Open(path) => {
                if let Some(path) = path {
                    pending.push_back(PendingOpen {
                        path,
                        recipient: None,
                        notified: false,
                    });
                } else if let Some(window) = external_recipient(&app, &unavailable) {
                    focus_recipient(&window);
                }
            }
            OpenMessage::Ready(label) => {
                // Failed-window callbacks must not trigger another retry cycle.
                if unavailable.contains(&label) {
                    continue;
                }
                ready.insert(label);
            }
            OpenMessage::Destroyed(label) => {
                // In particular, destroying our own partial build must not
                // turn persistent creation failure into a message-driven loop.
                if unavailable.contains(&label) {
                    continue;
                }
                ready.remove(&label);
                unavailable.insert(label.clone());
                revoke_recipient(&mut pending, &label);
            }
            OpenMessage::Claim { label, path, reply } => {
                if unavailable.contains(&label) {
                    let _ = reply.send(false);
                    continue;
                }
                // The frontend must claim BEFORE opening. An old event from a
                // destroyed recipient cannot claim a reassigned request. Each
                // repeated path remains a separate queue entry.
                let live = app.get_webview_window(&label).is_some();
                let claimed = claim_pending(&mut pending, &label, &path, live);
                // Acceptance transfers ownership to this frontend. Never retry
                // an accepted open: it may already have spawned another window.
                if reply.send(claimed).is_err() && claimed {
                    eprintln!("external-open recipient disconnected after accepting a request");
                }
            }
        }

        // Recover missing recipients even if their Destroyed message was lost
        // or has not arrived yet. Only unclaimed queue entries can be revoked.
        let missing: HashSet<_> = pending
            .iter()
            .filter_map(|request| request.recipient.as_ref())
            .filter(|label| app.get_webview_window(label).is_none())
            .cloned()
            .collect();
        for label in missing {
            eprintln!("external-open recipient {label} disappeared; revoking unclaimed requests");
            revoke_recipient(&mut pending, &label);
            ready.remove(&label);
            unavailable.insert(label);
        }

        // One initial attempt and at most one immediate retry per message.
        // Persistent failures remain unassigned until another routing message.
        for attempt in 0..2 {
            let mut failed = None;
            let mut failed_creation = false;
            if pending.iter().any(|request| request.recipient.is_none()) {
                let window = match external_recipient(&app, &unavailable) {
                    Some(window) => Some(window),
                    None => {
                        // Never collide with a frontend-created or partial window.
                        let label = loop {
                            next_window += 1;
                            let label = format!("doc-external-{next_window}");
                            if !unavailable.contains(&label)
                                && app.get_webview_window(&label).is_none()
                            {
                                break label;
                            }
                        };
                        let request = pending
                            .iter_mut()
                            .find(|request| request.recipient.is_none())
                            .expect("an unassigned request exists");
                        // Tauri's URL dependency escapes Unicode, &, and #.
                        let mut url = tauri::Url::parse("https://localhost/index.html")
                            .expect("static base URL is valid");
                        url.query_pairs_mut()
                            .append_pair("file", &request.path)
                            .append_pair("externalOpen", "1");
                        let relative = format!("index.html?{}", url.query().unwrap_or_default());
                        request.recipient = Some(label.clone());
                        request.notified = true; // URL notification, not acceptance.
                        match tauri::WebviewWindowBuilder::new(
                            &app,
                            &label,
                            tauri::WebviewUrl::App(relative.into()),
                        )
                        .title("SVG Viewer")
                        .inner_size(1100.0, 820.0)
                        .zoom_hotkeys_enabled(PAGE_RECEIVES_PINCH)
                        .build()
                        {
                            Ok(window) => Some(window),
                            Err(error) => {
                                eprintln!(
                                    "could not create external-open recipient {label}: {error}"
                                );
                                // A partial window may still boot. Quarantine its
                                // label and revoke its URL claim before retrying;
                                // never treat a failed build as a displayed file.
                                failed_creation = true;
                                failed = Some(label);
                                None
                            }
                        }
                    }
                };
                if let Some(window) = window {
                    focus_recipient(&window);
                    for request in &mut pending {
                        if request.recipient.is_none() {
                            request.recipient = Some(window.label().to_owned());
                        }
                    }
                }
            }

            if failed.is_none() {
                for request in &mut pending {
                    let Some(label) = request.recipient.as_deref() else {
                        continue;
                    };
                    if request.notified || !ready.contains(label) {
                        continue;
                    }
                    // JS registers with this same explicit target. Successful
                    // emit is not acceptance; only Claim removes the entry.
                    match app.emit_to(
                        tauri::EventTarget::webview_window(label),
                        "open-file",
                        request.path.clone(),
                    ) {
                        Ok(()) => request.notified = true,
                        Err(error) => {
                            eprintln!("external-open notification to {label} failed: {error}");
                            failed = Some(label.to_owned());
                            break;
                        }
                    }
                }
            }

            let Some(label) = failed else {
                break;
            };
            // Claims are processed by this worker, so none can be accepted
            // between a failed operation and revocation. Previously accepted
            // opens are already absent and can never be retried here.
            revoke_recipient(&mut pending, &label);
            ready.remove(&label);
            unavailable.insert(label.clone());
            // Clean up only a failed build, never an existing document window
            // whose emit failed: it may contain previously accepted opens.
            // Revocation comes first, so even a surviving partial URL is stale.
            if failed_creation {
                if let Some(window) = app.get_webview_window(&label) {
                    if let Err(error) = window.destroy() {
                        eprintln!("could not remove partial external-open window {label}: {error}");
                    }
                }
            }
            if attempt == 1 {
                eprintln!("external-open recovery failed twice; unclaimed requests retained unassigned for the next routing message");
            }
        }
    }
}

#[cfg(test)]
mod external_open_tests {
    use super::*;

    fn assigned(path: &str, label: &str, notified: bool) -> PendingOpen {
        PendingOpen {
            path: path.into(),
            recipient: Some(label.into()),
            notified,
        }
    }

    #[test]
    fn selection_prefers_main_then_sorted_documents_and_excludes_failed_labels() {
        let labels = ["settings", "doc-b", "main", "doc-a"];
        let mut unavailable = HashSet::new();
        assert_eq!(select_recipient(labels, &unavailable), Some("main"));
        unavailable.insert("main".into());
        assert_eq!(select_recipient(labels, &unavailable), Some("doc-a"));
        unavailable.insert("doc-a".into());
        unavailable.insert("doc-b".into());
        assert_eq!(select_recipient(labels, &unavailable), None);
    }

    #[test]
    fn failed_creation_revokes_partial_url_before_fresh_assignment() {
        let mut pending = VecDeque::from([assigned("a.svg", "doc-old", true)]);
        revoke_recipient(&mut pending, "doc-old");
        assert!(pending[0].recipient.is_none());
        assert!(!pending[0].notified);
        assert!(!claim_pending(&mut pending, "doc-old", "a.svg", true));
        pending[0].recipient = Some("doc-new".into());
        pending[0].notified = true;
        assert!(!claim_pending(&mut pending, "doc-old", "a.svg", true));
        assert!(claim_pending(&mut pending, "doc-new", "a.svg", true));
        assert!(!claim_pending(&mut pending, "doc-new", "a.svg", true));
    }

    #[test]
    fn emit_failure_revokes_only_unclaimed_work_for_that_recipient() {
        let mut pending = VecDeque::from([
            assigned("completed.svg", "main", true),
            assigned("sent.svg", "main", true),
            assigned("failed.svg", "main", false),
            assigned("other.svg", "doc-other", true),
        ]);
        assert!(claim_pending(&mut pending, "main", "completed.svg", true));
        revoke_recipient(&mut pending, "main");
        assert_eq!(pending.len(), 3);
        for request in pending.iter().take(2) {
            assert!(request.recipient.is_none());
            assert!(!request.notified);
        }
        assert!(!claim_pending(&mut pending, "main", "sent.svg", true));
        assert!(!claim_pending(&mut pending, "main", "completed.svg", true));
        assert!(claim_pending(&mut pending, "doc-other", "other.svg", true));
    }

    #[test]
    fn claims_require_live_notified_assignment_and_consume_one_repeated_path() {
        let mut pending = VecDeque::from([
            assigned("same.svg", "main", false),
            assigned("same.svg", "main", true),
        ]);
        assert!(!claim_pending(&mut pending, "main", "same.svg", false));
        assert!(!claim_pending(&mut pending, "doc-other", "same.svg", true));
        assert!(!claim_pending(&mut pending, "main", "different.svg", true));
        assert!(claim_pending(&mut pending, "main", "same.svg", true));
        assert_eq!(pending.len(), 1);
        assert!(!claim_pending(&mut pending, "main", "same.svg", true));
        pending[0].notified = true;
        assert!(claim_pending(&mut pending, "main", "same.svg", true));
        assert!(pending.is_empty());
    }
}

#[tauri::command]
fn external_open_ready(
    window: tauri::WebviewWindow,
    state: State<'_, ExternalOpens>,
) -> Result<(), String> {
    state
        .0
        .send(OpenMessage::Ready(window.label().to_owned()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn claim_external_open(
    window: tauri::WebviewWindow,
    path: String,
    state: State<'_, ExternalOpens>,
) -> Result<bool, String> {
    let (reply, receiver) = mpsc::channel();
    state
        .0
        .send(OpenMessage::Claim {
            label: window.label().to_owned(),
            path,
            reply,
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// First non-flag argument. Windows passes the document path this way when a
/// file association launches us.
fn first_file_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && !a.is_empty())
}

// A sync command runs inline on the WebView2 UI thread, so every one of these
// filesystem commands is async and hands the blocking std::fs work to
// `spawn_blocking` — the same shape `claim_external_open` uses above.
#[tauri::command]
async fn read_text_file(path: String, opened: State<'_, OpenedDirs>) -> Result<String, String> {
    let opened = opened.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let real = svg_document(&path)?;
        let text = std::fs::read_to_string(&real).map_err(|e| format!("{path}: {e}"))?;
        if let Some(dir) = real.parent() {
            opened.remember(dir.to_path_buf());
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Milliseconds since the epoch, so the frontend can compare it the same way it
/// compares `File.lastModified` in the browser build.
#[tauri::command]
async fn file_mtime(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(svg_document(&path)?).map_err(|e| e.to_string())?;
        let modified = meta.modified().map_err(|e| e.to_string())?;
        let ms = modified
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        Ok(ms as u64)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn initial_file(state: State<'_, InitialFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

/// SVG files sitting next to `path`, sorted, so the frontend can offer
/// next/previous navigation through a folder.
#[tauri::command]
async fn sibling_files(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        const EXTS: [&str; 1] = ["svg"];

        let file = std::path::Path::new(&path);
        if !is_svg_path(file) {
            return Err("not an SVG file".to_string());
        }
        let dir = file
            .parent()
            .ok_or_else(|| "no parent directory".to_string())?;

        let mut out: Vec<String> = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let p = entry.path();
                if !p.metadata().map(|m| m.is_file()).unwrap_or(false) {
                    return None;
                }
                let ext = p.extension()?.to_str()?.to_ascii_lowercase();
                if !EXTS.contains(&ext.as_str()) {
                    return None;
                }
                Some(p.to_string_lossy().into_owned())
            })
            .collect();

        // Case-insensitive so the order matches what a file manager shows.
        out.sort_by_key(|s| s.to_lowercase());
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Trackpad pinch on Windows. WebView2 reports a pinch to the page as a
// ctrl+wheel WheelEvent, which the frontend claims (src/main.js, capture phase,
// passive: false) to zoom the document on its own transform. That event only
// exists while ICoreWebView2Settings5::IsPinchZoomEnabled is true.
const PAGE_RECEIVES_PINCH: bool = cfg!(target_os = "windows");

// Windows print. wry's `print()` only evaluates `window.print()` in the page,
// which WebView2 does not implement, so printing is a silent no-op here. This
// calls the native WebView2 print dialog instead; macOS and Linux keep wry's
// real native print path and never reach it.
#[cfg(target_os = "windows")]
fn show_print_ui(window: &tauri::WebviewWindow) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER,
    };
    use windows::core::Interface;

    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let result = (|| unsafe {
                let core = webview.controller().CoreWebView2()?;
                let core16 = core.cast::<ICoreWebView2_16>()?;
                core16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER)
            })();
            let _ = sender.send(result.map_err(|e| e.to_string()));
        })
        .map_err(|e| e.to_string())?;

    receiver.recv().map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "windows"))]
fn show_print_ui(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Err("this platform prints through the webview's own print path".to_string())
}

/// Windows-only: opens the native WebView2 print dialog.
#[tauri::command]
async fn print_windows(window: tauri::WebviewWindow) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || show_print_ui(&window))
        .await
        .map_err(|e| e.to_string())?
}

fn same_component(a: Component<'_>, b: Component<'_>) -> bool {
    if cfg!(windows) {
        a.as_os_str().to_string_lossy().to_lowercase()
            == b.as_os_str().to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

fn is_under(path: &Path, root: &Path) -> bool {
    let mut path = path.components();
    root.components()
        .all(|r| path.next().is_some_and(|p| same_component(p, r)))
}

/// The absolute local path `raw` names, with `.` and `..` resolved without
/// touching the disk, or None if it is relative or a network or device path.
fn local_image_path(raw: &str) -> Option<PathBuf> {
    let b = raw.as_bytes();
    if b.len() >= 2 && matches!(b[0], b'\\' | b'/') && matches!(b[1], b'\\' | b'/') {
        return None;
    }
    let mut out = PathBuf::new();
    for c in Path::new(raw).components() {
        match c {
            Component::Prefix(p) if matches!(p.kind(), Prefix::Disk(_)) => out.push(c),
            Component::Prefix(_) => return None,
            Component::RootDir => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(s) => out.push(s),
        }
    }
    out.is_absolute().then_some(out)
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    Some(match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg" | "jfif") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        _ => return None,
    })
}

/// Serves an image for `<image href>` in a rendered SVG. Only image files
/// inside the folder of a document the app has opened are returned.
fn asset_response(uri_path: &str, roots: &[PathBuf]) -> tauri::http::Response<Vec<u8>> {
    let status = |code: u16| {
        tauri::http::Response::builder()
            .status(code)
            .body(Vec::new())
            .expect("static response is valid")
    };
    let raw = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();
    let Some(path) = local_image_path(&raw) else {
        return status(403);
    };
    let Ok(real) = std::fs::canonicalize(&path) else {
        return status(404);
    };
    if !roots.iter().any(|root| is_under(&real, root)) {
        return status(403);
    }
    let Some(mime) = image_mime(&real) else {
        return status(403);
    };
    match std::fs::read(&real) {
        Ok(bytes) => tauri::http::Response::builder()
            .header("Content-Type", mime)
            .header("X-Content-Type-Options", "nosniff")
            .header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
            )
            .body(bytes)
            .expect("image response is valid"),
        Err(_) => status(404),
    }
}

#[cfg(test)]
mod asset_tests {
    use super::*;

    #[test]
    fn network_and_device_paths_are_refused_before_any_disk_access() {
        for raw in [
            r"\\evil\share\x.svg",
            "//evil/share/x.svg",
            r"\/evil/share/x.svg",
            r"\\?\C:\Users\Tim\x.svg",
            r"\\.\C:\Users\Tim\x.svg",
            r"\\?\UNC\evil\share\x.svg",
        ] {
            assert_eq!(local_image_path(raw), None, "{raw}");
        }
    }

    #[test]
    fn only_absolute_paths_are_allowed_and_dots_resolve_lexically() {
        assert_eq!(local_image_path("x.svg"), None);
        if cfg!(windows) {
            assert_eq!(
                local_image_path(r"c:\users\tim\docs\..\pics\x.svg"),
                Some(PathBuf::from(r"c:\users\tim\pics\x.svg"))
            );
        } else {
            assert_eq!(
                local_image_path("/home/tim/docs/../pics/x.svg"),
                Some(PathBuf::from("/home/tim/pics/x.svg"))
            );
        }
    }

    fn uri(path: &Path) -> String {
        percent_encoding::utf8_percent_encode(
            &path.to_string_lossy(),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string()
    }

    #[test]
    fn asset_serves_only_images_inside_an_opened_document_folder() {
        let base = std::env::temp_dir().join(format!("svgv-asset-test-{}", std::process::id()));
        let docs = base.join("docs");
        std::fs::create_dir_all(docs.join("img")).unwrap();
        std::fs::write(docs.join("img").join("pic.png"), b"png").unwrap();
        std::fs::write(docs.join("notes.txt"), b"secret").unwrap();
        std::fs::write(base.join("outside.png"), b"png").unwrap();
        let roots = vec![std::fs::canonicalize(&docs).unwrap()];

        let ok = asset_response(&uri(&docs.join("img").join("pic.png")), &roots);
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.body(), b"png");
        assert_eq!(ok.headers()["x-content-type-options"], "nosniff");

        let dotdot = docs.join("img").join("..").join("..").join("outside.png");
        assert_eq!(asset_response(&uri(&dotdot), &roots).status(), 403);
        assert_eq!(asset_response(&uri(&base.join("outside.png")), &roots).status(), 403);
        assert_eq!(asset_response(&uri(&docs.join("notes.txt")), &roots).status(), 403);
        assert_eq!(asset_response(&uri(&docs.join("img").join("pic.png")), &[]).status(), 403);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_svg_documents_can_be_read() {
        let base = std::env::temp_dir().join(format!("svgv-doc-test-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("a.SVG"), b"<svg/>").unwrap();
        std::fs::write(base.join("b.txt"), b"secret").unwrap();
        assert!(svg_document(&base.join("a.SVG").to_string_lossy()).is_ok());
        assert!(svg_document(&base.join("b.txt").to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}

fn main() {
    let initial = first_file_arg(std::env::args());
    let (open_sender, open_receiver) = mpsc::channel();

    tauri::Builder::default()
        .manage(ExternalOpens(open_sender))
        // Must be registered first: a second launch forwards its argv here
        // instead of opening a second window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Err(error) = app
                .state::<ExternalOpens>()
                .0
                .send(OpenMessage::Open(first_file_arg(argv)))
            {
                eprintln!("could not queue external file open: {error}");
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("asset", |ctx, request, responder| {
            let roots = ctx.app_handle().state::<OpenedDirs>().snapshot();
            let uri_path = request.uri().path().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(asset_response(&uri_path, &roots));
            });
        })
        .on_window_event(|window, event| {
            // Title bar / Alt+F4. Closing the last window quits the whole
            // program (its session is kept for the next launch). Any other
            // window closes on its own: the frontend's onCloseRequested
            // handler runs the same bookkeeping as Ctrl+Shift+W and destroys
            // only that window.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().webview_windows().len() <= 1 {
                    api.prevent_close();
                    window.app_handle().exit(0);
                }
                return;
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(next) = external_recipient(
                    window.app_handle(),
                    &HashSet::from([window.label().to_owned()]),
                ) {
                    focus_recipient(&next);
                }
                if let Err(error) = window
                    .state::<ExternalOpens>()
                    .0
                    .send(OpenMessage::Destroyed(window.label().to_owned()))
                {
                    eprintln!("could not update external-open recipient state: {error}");
                }
            }
        })
        .setup(move |_app| {
            let handle = _app.handle().clone();
            std::thread::spawn(move || route_external_opens(handle, open_receiver));
            #[cfg(desktop)]
            _app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let config = _app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .ok_or("tauri.conf.json has no main window")?
                .clone();
            tauri::WebviewWindowBuilder::from_config(_app.handle(), &config)?
                .zoom_hotkeys_enabled(PAGE_RECEIVES_PINCH)
                .build()?;
            Ok(())
        })
        .manage(InitialFile(Mutex::new(initial)))
        .manage(OpenedDirs::default())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            file_mtime,
            initial_file,
            sibling_files,
            external_open_ready,
            claim_external_open,
            print_windows
        ])
        .build(tauri::generate_context!())
        .expect("failed to start SVG Viewer")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for path in urls.into_iter().filter_map(|url| url.to_file_path().ok()) {
                    let path = path.to_string_lossy().into_owned();
                    if let Err(error) = _app
                        .state::<ExternalOpens>()
                        .0
                        .send(OpenMessage::Open(Some(path)))
                    {
                        eprintln!("could not queue external file open: {error}");
                    }
                }
            }
        });
}
