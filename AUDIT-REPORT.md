# Audit report: svg-viewer

> **Status (2026-11-15, fixed in 1.0.1):**
> - **H1 fixed.** Title-bar close only quits when it is the last window; otherwise the frontend's `onCloseRequested` runs the normal close path (session + Ctrl+Shift+T stack) and destroys just that window.
> - **M1 fixed.** `read_text_file`, `file_mtime` and `sibling_files` only accept `.svg` files (checked after following links). The `asset` handler only serves known image types from inside the folder of a document the app has opened (not the whole home folder), with `nosniff` and a restrictive CSP. The frontend drops image paths that leave the document folder.
> - **M2 fixed.** Sanitiser moved to `src/sanitize.js`: SVG + SVG-filter profiles only, `foreignObject`/`set`/`animate` forbidden, non-link `href`s limited to `#fragment` (plus data: images and local paths for `<image>`), CSS `@import` and remote `url()` neutralised. The standalone HTML now carries its own CSP. `<style>` is still allowed (real SVG exports depend on it) and is still global to the page: cosmetic only, scripts stay blocked by CSP.
> - **M3 fixed.** Outline no longer writes ids into the SVG.
> - **M4 partly fixed.** Syntax highlighting now waits until source view is shown. No size cap added.
> - **M5 fixed.** Sanitiser tests run the real DOMPurify on jsdom with the app's own config module, and cover foreignObject, SMIL href, remote/`file:`/`asset:`/UNC refs and CSS.
> - **M6 fixed.** Icon step removed (icons are committed). CI also uses `npm ci`, and builds without updater artifacts when `TAURI_SIGNING_PRIVATE_KEY` is not set (otherwise `tauri build` fails).
> - **M7 fixed.** `package-lock.json` and `src-tauri/Cargo.lock` committed. Found while doing this: a fresh resolve pulled Tauri 2.12, which needs `webview2-com` 0.39 / `windows` 0.62 (Cargo.toml had 0.38 / 0.61), now aligned.
> - **L1 partly fixed.** Zoom percentage is focusable and works with Enter/Space. Icon buttons already get their accessible name from `title`; the canvas focus ring was left as a design choice.
> - **L2 fixed.** README now mentions the startup update check and that `app:dev` has no hot reload.
> - **N1** confirmed (app commands without a manifest are allowed for every window); mitigated by the M1 scope limits. **N2 fixed** (DOCTYPE with internal subset stripped whole). **N3** not changed (no PR workflow added).


- Auditor: Grok 4.7
- Date: Thursday 12 November 2026
- Time: 2:40 AM Australia/Sydney (UTC+11)
- Kind: read-only code audit. No application code was changed.
- Scope: Source, tests, `package.json`, `src-tauri/Cargo.toml`, Tauri config and capabilities, CI, README, build and serve scripts, NSIS hooks. `node_modules`, `dist`, `dist-standalone`, `src-tauri/target`, and `.git` were not reviewed as source. `dist/` and `dist-standalone/` exist on disk. `src-tauri/target/` does not. This project has no `node_modules/`.
- Method: Read the files listed at the end and searched them with ripgrep. Line numbers are from those reads. Tests were not executed. DOMPurify was not executed. The app was not launched. No install, build, format, or git write was run. Dependency comments use the committed manifests only.

## Summary

No verified script-execution payload was found. The packaged app's CSP is `script-src 'self'` with no `'unsafe-inline'`, and the render path does pass SVG text through DOMPurify before `innerHTML`. The serious confirmed issue is elsewhere: the native close button terminates the whole process, so one window takes every other document window with it.

Opening an SVG is normal use, and that content is rendered in the same webview that can call unrestricted file-read commands. The custom `asset` handler will also read any file under the user's home directory when an SVG image URL points there. That is a local read, not a demonstrated remote theft: page script was not shown to be able to read those bytes back. The sanitizer turns on DOMPurify's HTML profile and does not forbid `style`, `foreignObject`, `image`, or `use`. Sanitizer tests cover scripts, a few event handlers, and `javascript:` hrefs, and they run on an in-repo DOM double, not a browser.

Release CI calls `npm run icon`, but the npm script is named `icons`, so a tagged release fails before tests or installers.

## Finding counts

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 7 |
| Low | 2 |
| Note | 3 |

Critical = exploitable script execution or data loss in normal use. High = serious security or correctness with a plausible path. Medium = real bug or hardening gap. Low = limited impact. Note = observation, not a defect.

## Findings

### [H1] Title-bar close quits every window

- Severity: High
- Category: Correctness
- Confidence: High
- Location: `src-tauri/src/main.rs:678`
- Evidence: `on_window_event` handles `CloseRequested` for every window by calling `api.prevent_close()` and then `window.app_handle().exit(0)` (`src-tauri/src/main.rs:678-682`). The frontend's close path is different: `closeWindow` records the paths and calls `destroyWindow` (`src/main.js:1536-1544`), and `destroyWindow` deletes only this window's session entry and calls `getCurrentWindow().destroy()` (`src/main.js:1603-1607`). `tests/tab-lifecycle.test.mjs:90` describes that JS path as closing only this window. Nothing in `src/main.js` listens for the native close request, so the title-bar button never runs `rememberClosed` (`src/main.js:1577-1581`).
- Impact: With "Open files in: New window", closing one document from the title bar kills the process. Every other window goes with it. Those windows do not get the JS close path, so their paths are not pushed onto the Ctrl+Shift+T stack. This is not file deletion; the viewer does not edit the SVG.
- Suggested direction: On close, destroy that one window. Exit the process only when the last window is actually going away, and run the same session bookkeeping the JS close path already has.
- Verify: Open two SVGs in two windows. Click the second window's X. Confirm whether the first window dies immediately. Repeat with Ctrl+W / Ctrl+Shift+W and compare `svgv.session` and `svgv.closed` in local storage.

### [M1] SVG image loads can read any file under the home directory

- Severity: Medium
- Category: Privacy
- Confidence: High
- Location: `src/main.js:646`
- Evidence: `resolveImages` rewrites `<img src>`, `<image href>`, and `<image xlink:href>` through `convertFileSrc` unless the URL already starts with `http(s)`, `data:`, `blob:`, `asset:`, `tauri:`, `file:`, or `#` (`src/main.js:646-657`). Relative paths are joined with `state.docDir`, and `..` is popped with no root check (`src/main.js:626-634`). Absolute paths are passed through (`src/main.js:637-638`). The Rust `asset` handler decodes that path, allows any absolute path under the home directory, canonicalizes, checks the home prefix again, and returns the raw bytes (`src-tauri/src/main.rs:533-551`, `src-tauri/src/main.rs:572-599`). Unknown extensions are `application/octet-stream`; `.svg` is `image/svg+xml` (`src-tauri/src/main.rs:554-569`). The response has no `Content-Security-Policy` header. CSP `img-src` explicitly allows `asset:` and `http://asset.localhost` (`src-tauri/tauri.conf.json:13`). A separate path, `read_text_file`, reads any path the frontend sends, with no home or extension check (`src-tauri/src/main.rs:404-409`). `file_mtime` (`src-tauri/src/main.rs:415-417`) and `sibling_files` (`src-tauri/src/main.rs:437-446`) are the same. There is no `tauri-plugin-fs` in `src-tauri/Cargo.toml`. A clicked SVG link whose path ends in `.svg` calls `openPath` → `read_text_file` (`src/main.js:689-697`, `src/main.js:733-734`, `src/main.js:1049`).
- Impact: Opening a malicious SVG is enough for a no-click read of files under the home directory, including paths outside the SVG's folder, as long as the webview requests them as images. Private images can be painted into the graphic. Non-images are still read in Rust and returned to the webview; this audit did not show page script reading those bytes back. `default-src 'self'` should block `fetch` of `asset.localhost`, and a cross-origin image should taint canvas, but `convertFileSrc`'s exact URL was not executed. `file:` URLs are left untouched (`src/main.js:651`); whether WebView2 loads them was not tested. A click on a `.svg` link can additionally open any SVG path on disk, including after `..`, because `read_text_file` is not limited to the home directory.
- Suggested direction: Resolve image paths and reject anything outside the SVG's directory (or a user-picked folder) before `convertFileSrc`. Serve only image bytes, with `nosniff` and a CSP that blocks scripts. Keep `read_text_file` limited to files the user chose or to `.svg` paths under an explicit root.
- Verify: From an SVG in `Downloads`, reference an image by absolute path under the home directory and by a relative path that uses `..` to leave the folder. Confirm the `asset` request status and body. Repeat with a path outside the home directory and expect 403 (`src-tauri/src/main.rs:583-591`). Then click `<a href="../secret.svg">` and confirm `read_text_file` is not limited to the home directory.

### [M2] Sanitizer allows embedded HTML, and styles are global

- Severity: Medium
- Category: Security
- Confidence: Medium
- Location: `src/main.js:619`
- Evidence: `SVG_PURIFY` sets `USE_PROFILES` to `{ svg: true, svgFilters: true, html: true }` and forbids only `script`, `iframe`, `object`, `embed`, and `form` (`src/main.js:619-624`). `style`, `foreignObject`, `image`, `use`, `img`, and `video` are not forbidden. `render` assigns the sanitized string with `stage.innerHTML` (`src/main.js:812-816`). That node is in the app document, not a shadow root. Packaged CSP allows inline CSS (`style-src 'self' 'unsafe-inline'`) while blocking inline script (`src-tauri/tauri.conf.json:13`). `src/index.html` has no CSP meta element, so the standalone file and `serve.mjs` do not get the Tauri policy. `resolveImages` deliberately keeps `https:`, `data:`, and `file:` URLs (`src/main.js:651`). `tests/render.test.mjs:73-85` expects an `https://example.com` href to still be in the document after sanitizing. DOMPurify was not executed in this audit (`node_modules` is absent here). The usual DOMPurify 3 svg profile includes `style`, `foreignObject`, `image`, and `use`, and the html profile includes general HTML. Treat that as unverified until the payload below is run.
- Impact: If `<style>` survives, its rules apply to the whole viewer, not just the SVG, including under the Tauri CSP. A document can restyle or cover the real toolbar. If `foreignObject` and HTML `<a href="https://...">` survive, a click is handled by `openUrl` / `window.open` (`src/main.js:724-730`), so a control drawn inside the graphic can send the user to an external site. In the standalone file and the dev server, a surviving `<image href="https://...">` or CSS `url(https://...)` loads remote resources with no CSP. That contradicts the README line "No network requests, ever" (`README.md:5`). This is not a demonstrated script gadget. The in-repo tests do show `<script>`, `onload` / `onclick`, and `javascript:` hrefs being removed for the cases they include.
- Suggested direction: Use the svg and svgFilters profiles only. Forbid `style`, `foreignObject`, `iframe`, and embedded HTML. Keep `href` only for same-document fragments unless the user clicks a link the app already classifies. Add a CSP meta element to the standalone file that matches the Tauri policy at least for `script-src` and `img-src`.
- Verify: Sanitize and render `<svg xmlns="http://www.w3.org/2000/svg"><style>body{background:red !important}</style><foreignObject width="200" height="40"><a xmlns="http://www.w3.org/1999/xhtml" href="https://example.com">x</a></foreignObject><image href="https://example.com/x.png" width="10" height="10"/></svg>`. Check whether `style`, `foreignObject`, and the `https` image href are still in `.svg-stage`, and whether the viewer background changes. Repeat inside the Tauri webview and in `dist-standalone/SVG Viewer.html`.

### [M3] Outline id assignment can duplicate real ids

- Severity: Medium
- Category: Correctness
- Confidence: High
- Location: `src/main.js:857`
- Evidence: For the first 200 outline candidates, an element with no `id` gets one from `slugify(title)` (`src/main.js:857-863`). `describeElement` uses the bare tag name when there is no id (`src/main.js:797-805`), so the first `<path>` without an id becomes `id="path"`, the first `<g>` becomes `id="g"`, and the root `<svg>` becomes `id="svg"`. Existing ids are recorded only when that element is visited (`used.has(existingId)`). The new id is written onto the live SVG (`el.setAttribute('id', id)`). A later element that already has that id is left unchanged, so the document now contains two of the same id. Only `OUTLINE_TAGS` are candidates (`src/main.js:781-785`).
- Impact: `url(#path)`, `<use href="#g">`, clip paths, masks, and gradients can bind to the synthetic id instead of the author's id. Valid SVGs can render with the wrong paint or clip after open. The toolbar count still reports every element (`src/main.js:877`); the outline itself stops at 200 (`src/main.js:857`).
- Suggested direction: Do not write ids into the SVG. Point outline rows at the element object, which the click handler already keeps (`src/main.js:931`). If an id is required, scan existing ids first and skip any value already present.
- Verify: Render `<svg><path d="M0 0h10"/><linearGradient id="path"><stop offset="0" stop-color="#000"/></linearGradient></svg>`. Inspect the first path's `id` and `document.querySelectorAll('#path').length`. A gradient or `<use href="#path">` in the same file should be checked visually.

### [M4] Every render parses and highlights the whole file, with no size cap

- Severity: Medium
- Category: Performance
- Confidence: High
- Location: `src/main.js:808`
- Evidence: `render` always runs DOMPurify, `innerHTML`, `querySelectorAll('*')`, and `hljs.highlightElement` on the full source (`src/main.js:808-833`). The source block is built even when source view is hidden (`.svg-source { display: none }` at `src/app.css:270-271`). `showActiveTab` calls `render` on every tab switch (`src/main.js:1476-1478`). Live reload calls `setDoc` → `render` after a 700ms poll when mtime changes (`src/main.js:1173-1177`, `src/main.js:1214-1215`). The 900000-character cutoff only skips `localStorage` (`src/main.js:952-955`). `parseViewBox` accepts any finite positive width and height, and `normaliseSvgDimensions` writes those numbers onto the root as pixel `width` and `height` when the attributes are missing or not plain px (`src/main.js:749-778`).
- Impact: A multi-megabyte SVG, or one whose `viewBox` is huge and has no pixel size, does a full sanitize, DOM build, and syntax highlight on the UI thread. Switching tabs or saving the file in an editor repeats that work. The window can freeze. Zoom itself is a transform (`src/main.js:364-377`) and is not the expensive part.
- Suggested direction: Cap bytes and viewBox dimensions before building the DOM. Skip highlight.js until source view is turned on. Reuse the highlighted tree when the text has not changed.
- Verify: Open an SVG of several megabytes and switch tabs and source mode while watching the UI thread. Separately open `<svg viewBox="0 0 1000000000 1000000000"></svg>` and see whether `width`/`height` become `1000000000` and layout stalls.

### [M5] Sanitizer tests miss the SVG bypass classes and do not use a browser

- Severity: Medium
- Category: Testing
- Confidence: High
- Location: `tests/sanitise.test.mjs:10`
- Evidence: `tests/sanitise.test.mjs` checks `<script>`, `onload` / `onclick` / `onerror` / `onmouseover`, four `javascript:` href spellings, a benign gradient, and that `render` calls `DOMPurify.sanitize` (`tests/sanitise.test.mjs:24-75`). It does not mention `foreignObject`, `use`, `xlink:href`, `data:`, CSS, `@import`, `animate` / `set`, or external image URLs. The config object is copied into the test (`tests/sanitise.test.mjs:10-15`) rather than imported, so it can drift from `src/main.js:619-624`. The DOM is `tests/helpers/mini-dom.mjs`: `DOMParser.parseFromString` always parses HTML (`tests/helpers/mini-dom.mjs:515-523`), namespace follows a tag-name guess (`tests/helpers/mini-dom.mjs:443`), and `style` is raw text (`tests/helpers/mini-dom.mjs:13`). `tests/render.test.mjs:104-111` repeats the script and handler checks through `render`, still on that double. No test asserts that remote image URLs or `<style>` are removed. `loadCreateDOMPurify` falls back to another project's `node_modules` if this project has none (`tests/helpers/source-harness.mjs:7-14`).
- Impact: A green `npm test` does not show that the browser, WebView2, or WebKit kept a payload out. Mutation XSS and the cases in M2 are untested. CI's test step (`release.yml:57-59`) has the same gap, and today it is not reached because of M6.
- Suggested direction: Run the sanitizer assertions in a real browser DOM, and add the payloads from M2 plus `<set attributeName="href" to="javascript:alert(1)">`, `<use href="https://example.com/x.svg#a">`, and a `data:image/svg+xml` image.
- Verify: Compare `tests/sanitise.test.mjs` with `src/main.js:619-624`. Run the M2 payload in a browser console against the built page and again through `node --test tests/sanitise.test.mjs`. The node result alone should not be treated as a pass for script execution.

### [M6] Release workflow runs a script that does not exist

- Severity: Medium
- Category: Build
- Confidence: High
- Location: `.github/workflows/release.yml:56`
- Evidence: The installers job runs `npm run icon` (`.github/workflows/release.yml:54-56`). `package.json` defines `"icons": "node create-icon.mjs"` (`package.json:13`) and has no `icon` script. `npm` exits on a missing script, and later steps (tests, `tauri-action`) do not run. Icons are already in `src-tauri/icons/`, so the step is not required for a build that uses the committed icons.
- Impact: `git tag v*` and `workflow_dispatch` fail before an installer or the standalone HTML asset is published. Local `npm run icons` is unaffected.
- Suggested direction: Call `npm run icons`, or drop the step if the committed icons are the ones that ship.
- Verify: `npm run icon` in this repo. Expect "Missing script: icon". `npm run icons --dry-run` or `npm run` should list `icons` only.

### [M7] Frontend and Rust dependencies are unpinned

- Severity: Medium
- Category: Dependencies
- Confidence: High
- Location: `package.json:17`
- Evidence: `package.json` uses caret ranges for DOMPurify, Tauri packages, and esbuild (`package.json:17-28`). `src-tauri/Cargo.toml` uses `tauri = "2"`, plugin crates at `"2"`, and similar (`src-tauri/Cargo.toml:15-34`). A glob of the repo found no `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, or `Cargo.lock`. CI runs `npm install` (`.github/workflows/release.yml:53`) and a floating Rust toolchain (`release.yml:39-40`). The updater trusts a minisign public key (`src-tauri/tauri.conf.json:38`) over whatever dependency set was compiled into that binary.
- Impact: A later install or tag build can resolve different Tauri, DOMPurify, or plugin code than this audit read. That includes the sanitizer and the IPC stack. No network audit was run, and no CVE is claimed from the manifests.
- Suggested direction: Commit `package-lock.json` and `Cargo.lock`, and install from the lockfile in CI (`npm ci`).
- Verify: Confirm those lockfiles are absent. Inspect `npm ls dompurify` and `cargo metadata` only after a local install; they are not available in this workspace today.

### [L1] Icon controls and the zoom readout are unnamed or unfocusable

- Severity: Low
- Category: Accessibility
- Confidence: High
- Location: `src/index.html:30`
- Evidence: Zoom in, zoom out, fit, backdrop, grid, source, theme, outline, and print are icon-only buttons with `title` and no `aria-label` (`src/index.html:20-64`). `#zoomval` is a `<span>` with a click handler (`src/index.html:33`, `src/main.js:1883`) and no button role, `tabindex`, or keyboard handler. CSS styles `#zoomval:focus-visible` (`src/app.css:108`) but the span cannot be focused. `#scroller` is `tabindex="0"` (`src/index.html:77`) and `#scroller:focus, #scroller:focus-visible { outline: none }` removes the ring (`src/app.css:119`). Reduced motion is handled (`src/app.css:465-472`). Tab close buttons are `tabIndex = -1` (`src/main.js:1420`) while the selected tab is in tab order and Delete/Backspace closes it (`src/main.js:1449-1452`).
- Impact: Keyboard and screen-reader users can miss zoom reset and the icon buttons. Focus on the canvas is invisible. This does not block the keyboard shortcuts documented in the README.
- Suggested direction: Use `<button>` with an accessible name for zoom percent and the icon actions. Restore a visible focus ring on `#scroller`.
- Verify: Tab from the start of the window. Confirm whether zoom in/out and the percent control are reached and announced, and whether the canvas shows a focus ring.

### [L2] README describes no network and hot reload; the app does not match that

- Severity: Low
- Category: Correctness
- Confidence: High
- Location: `README.md:5`
- Evidence: The README says "No network requests, ever. Your files never leave the machine." (`README.md:5`). `updateOnStart` defaults to true (`src/main.js:122`, `src/main.js:142`) and the main window calls `checkForUpdate` three seconds after boot (`src/main.js:2047-2051`). The updater endpoint is `https://github.com/TimWJT/svg-viewer/releases/latest/download/latest.json` (`src-tauri/tauri.conf.json:35-37`). The check does not upload the SVG. The README also says `npm run app:dev` runs with hot reload (`README.md:22`). `beforeDevCommand` is `npm run build`, a one-shot esbuild (`src-tauri/tauri.conf.json:8-9`, `build.mjs:23-32`).
- Impact: A desktop install contacts GitHub on startup unless the user turns the setting off. Frontend edits are not picked up by a watcher during `tauri dev`. File contents are not sent by the updater. Remote loads from SVG content are the separate issue in M2.
- Suggested direction: Say that startup update checks are on by default and can be disabled, and that `app:dev` builds once and then launches.
- Verify: With the default setting, watch network on launch for `latest.json`. Run `npm run app:dev` and change `src/main.js`; the running UI should stay on the previous build until a restart.

### [N1] Custom commands are not listed in the capability file

- Severity: Note
- Category: Security
- Confidence: Low
- Location: `src-tauri/capabilities/default.json:9`
- Evidence: The capability lists plugin and core permissions (`src-tauri/capabilities/default.json:9-25`) and windows `main` and `doc-*`. It does not mention `read_text_file`, `file_mtime`, `initial_file`, `sibling_files`, `external_open_ready`, `claim_external_open`, or `print_windows`, which are registered at `src-tauri/src/main.rs:721-728`. `src-tauri/gen/schemas/` is gitignored (`.gitignore:3`) and was not present, because `src-tauri/target/` has not been built here. This audit did not determine whether this Tauri 2 resolver denies unlisted application commands or allows them for every window in the capability.
- Impact: If they are denied, desktop open, live reload, folder next/previous, external open, and Windows print fail at IPC. If they are allowed for any page in those windows, a script that gets past CSP can call `read_text_file` on any path (see M1). Neither outcome was executed.
- Suggested direction: Generate the schema, name the seven `allow-*` permissions explicitly, and add a test that boots a webview and invokes `read_text_file`.
- Verify: `cargo check` in `src-tauri` and read `gen/schemas` for `allow-read-text-file`. Then invoke `read_text_file` from the webview console.

### [N2] Leading DOCTYPE strip stops at the first `>`

- Severity: Note
- Category: Security
- Confidence: Medium
- Location: `src/main.js:613`
- Evidence: `stripXmlPreamble` removes a leading `<!DOCTYPE` with `<!DOCTYPE[^>]*>` (`src/main.js:613-616`). An internal subset contains `>` before the DOCTYPE ends, so the strip leaves the tail of the subset in the string passed to DOMPurify. `tests/render.test.mjs:45-53` only covers a DOCTYPE without a subset. DOMPurify's default parser media type is HTML, which does not resolve external entities. That default was not re-checked against an installed DOMPurify, and this app does not parse the file with a DTD-resolving XML parser in Rust.
- Impact: No XXE path was shown. The leftover bytes are a sanitizer input quirk, not a confirmed entity expansion.
- Suggested direction: Drop the preamble with an XML-aware scan, or stop special-casing DOCTYPE and let the sanitizer see the original string.
- Verify: Render `<!DOCTYPE svg [<!ENTITY x "y">]><svg/>` and inspect what `stripXmlPreamble` returns. Confirm the document does not request a remote DTD.

### [N3] CI runs only for tags and manual dispatch

- Severity: Note
- Category: Build
- Confidence: High
- Location: `.github/workflows/release.yml:8`
- Evidence: `on` is `push` of tags `v*` and `workflow_dispatch` (`.github/workflows/release.yml:8-12`). There is no pull-request workflow. The same file is the only workflow under `.github/workflows/`.
- Impact: A branch can merge with failing tests or the M6 script error without a GitHub check. This is process coverage, not a product defect.
- Suggested direction: Run `npm test` on pull requests. Keep installer builds on tags.
- Verify: List `.github/workflows` and the `on:` keys.

## What looks solid

- Render goes through `DOMPurify.sanitize` before `innerHTML` (`src/main.js:812-816`). The forbid list includes `script`, `iframe`, `object`, `embed`, and `form`. In-repo tests do remove the script, event-handler, and `javascript:` cases they include.
- Packaged CSP is `script-src 'self'` with no `'unsafe-inline'`. `build.mjs` keeps the app script external for that reason (`build.mjs:63-77`) and escapes `</script` only in the inlined standalone copy (`build.mjs:56-58`).
- Link clicks are captured, `javascript:` and same-origin app URLs are not navigated, and same-window file opens of non-`.svg` targets are refused (`src/main.js:689-741`, `tests/render.test.mjs:68-101`). Form submit is cancelled (`src/main.js:743-746`).
- The `asset` handler rejects UNC and device paths before disk access, resolves `.` and `..` lexically, then canonicalizes and checks the home prefix again (`src-tauri/src/main.rs:533-599`). Rust unit tests cover those path cases (`src-tauri/src/main.rs:614-646`). `assetProtocol.enable` is false so the stock asset scope is not also on (`src-tauri/tauri.conf.json:14-16`).
- External-open routing claims a path before reading it, and the tests cover duplicate paths, failed window creation, and boot order (`src-tauri/src/main.rs:134-149`, `tests/external-open.test.mjs`).
- Live reload ignores stale reads after a tab switch or close (`src/main.js:1134-1143`, `tests/tab-lifecycle.test.mjs`).
- Theme is applied from `startup.js` in `<head>` before the bundle (`src/startup.js:1-18`, `src/index.html:8`).
- The updater has a public key, does not install until the user clicks Update, and is off the browser build (`src-tauri/tauri.conf.json:34-41`, `src/main.js:255-271`).
- The only `unsafe` block is the Windows WebView2 print call (`src-tauri/src/main.rs:490-494`).
- `build.mjs` refuses to delete a directory that is not its own `dist` or `dist-standalone` (`build.mjs:16-21`).
- Zoom is clamped to 0.1–32 (`src/main.js:289-299`), wheel listeners are non-passive capture (`src/main.js:456-463`), and `tests/zoom.test.mjs` checks that contract.

## Not verified

- `npm test` was not run. This project has no `node_modules`. The harness can import DOMPurify from a sibling project; that import was not used.
- The Tauri app was not built or launched. `src-tauri/target/` is absent, so the generated capability schema and the resolved allow-list for custom commands were not read (see N1). `core:default` was not expanded.
- DOMPurify was not executed in a browser, WebView2, or WebKit. M2's tag survival is from the config plus DOMPurify's usual profiles, not from a run here.
- `convertFileSrc` URL shape and whether page script can read `asset` responses were not executed.
- No network `npm audit` or crate advisory lookup was done.
- `dist/` and `dist-standalone/` exist and were not line-audited. Behavior was taken from `src/` and the build script.
- Whether WebView2 will navigate to or fetch `file:` from this origin was not tested.
- Installer behavior of `src-tauri/installer-hooks.nsh` and `src-tauri/nsis/English.nsh` was not executed. The hook text was read; no defect was confirmed in it.
- Mac `Opened` URL handling (`src-tauri/src/main.rs:733-744`) was not run.

## Files reviewed

- `package.json`
- `build.mjs`
- `serve.mjs`
- `create-icon.mjs`
- `README.md`
- `LICENSE` (presence only)
- `.gitignore`
- `.gitattributes`
- `.github/workflows/release.yml`
- `src/index.html`
- `src/main.js`
- `src/startup.js`
- `src/app.css`
- `src-tauri/src/main.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/build.rs`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`
- `src-tauri/installer-hooks.nsh`
- `src-tauri/nsis/English.nsh`
- `tests/sanitise.test.mjs`
- `tests/render.test.mjs`
- `tests/zoom.test.mjs`
- `tests/tab-lifecycle.test.mjs`
- `tests/startup-state.test.mjs`
- `tests/external-open.test.mjs`
- `tests/early-theme.test.mjs`
- `tests/helpers/source-harness.mjs`
- `tests/helpers/mini-dom.mjs`
- `sample.svg` (not used as evidence)
