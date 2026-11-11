# SVG Viewer

An SVG **viewer**. Not an illustrator, not a design suite, not a converter. It renders an `.svg` file, lets you zoom up to 3200%, toggles backdrops, inspects elements or XML source, and stays out of the way.

The whole UI is one self-contained HTML file — sanitiser, syntax highlighting and styles all inlined. No network requests, ever. Your files never leave the machine.

## Run from source

```bash
npm install
npm start
```

Then open <http://localhost:4174>. That serves the web build — the fastest loop for working on the UI.

To build the desktop app:

```bash
npm run app:build
```

Installers land in `src-tauri/target/release/bundle/`. `npm run app:dev` runs it with hot reload.

## What it does

| | |
|---|---|
| **Zoom** | Continuous scale transform (`10%` – `3200%`), like browser pinch-zoom: no reflow, GPU-composited. Pinch, `Ctrl`+scroll, `Ctrl` `+`/`-`, or the toolbar. Persists between sessions. |
| **Pan** | Drag with the left mouse button on the canvas, middle mouse button, or `Alt`+drag. |
| **Live reload** | Edit the SVG in any editor or generator and the view updates in under a second. Zoom and pan position are kept. |
| **Backdrops** | Checkerboard, light, dark, or auto (follows theme) — so white icons and dark strokes are always visible. |
| **Bounds & grid** | Toggle a dashed `viewBox` frame and 16px grid overlay (`g`). |
| **XML source** | Toggle syntax-highlighted SVG XML source (`s`) with one-click copy and `Ctrl`+`F` search. |
| **Elements** | Sidebar (`o`) built from the SVG element hierarchy (`<svg>`, `<g>`, `<path>`, `<circle>`, `<rect>`, `<text>`…), click any node to highlight it on the stage. |
| **Themes** | Auto (follows OS), light, dark (`t`). |
| **Print** | `Ctrl`+`P` opens the native print dialog so you can print or save a PDF. |
| **Find** | `Ctrl`+`F` searches text and XML source, with match counts and wrap-around navigation. |
| **Tabs** | Open SVGs sit in a tab strip, each keeping its own scroll/pan position. The strip hides itself when only one document is open. |
| **Tab or window** | A setting decides whether an opened file joins this window as a tab or gets a window of its own. |
| **Folder navigation** | `[` and `]` step through the `.svg` files in the same folder. |
| **Fit to window** | One click (`Ctrl`+`9`) scales the SVG to fit comfortably inside the window. |
| **Metadata** | Intrinsic `width × height`, `viewBox`, element count, and file size in the toolbar. |

Opens files by drag-and-drop, the Open button, double-clicking `.svg` files in Explorer, or pasting SVG markup straight from the clipboard.

## Keyboard

| Key | Action |
|-----|--------|
| `Ctrl` `O` | Open an SVG file |
| `Ctrl` `+` / `Ctrl` `-` | Zoom in / out (`+`/`=` and `-` on their own work too) |
| `Ctrl` `0` | Reset zoom to 100% |
| `Ctrl` `9` | Fit to window |
| `[` / `]` | Previous / next `.svg` file in the folder |
| `Ctrl` `Tab` | Next tab (`Shift` for previous) |
| `Ctrl` `PgDn` / `Ctrl` `PgUp` | Next / previous tab |
| `Ctrl` `1`–`8` | Jump to tab |
| `Ctrl` `W` | Close tab, or the whole window — see settings |
| `Ctrl` `Shift` `W` | Close the window and all its tabs |
| `Ctrl` `Shift` `T` | Reopen the last closed tab, window, or previous session (desktop only) |
| `o` | Toggle elements outline |
| `b` | Cycle canvas backdrop (checkerboard / light / dark / auto) |
| `g` | Toggle bounds & grid overlay |
| `s` | Toggle XML source view |
| `t` | Cycle theme (auto / light / dark) |
| `Ctrl` `F` | Find in SVG |
| `F3` | Next match |
| `F5` / `Ctrl` `R` | Force reload from disk |
| `,` | Open settings |
| `Esc` | Clear highlight, or close find / settings |
| `Ctrl` `P` | Print or save as PDF |

## License

Free for personal and other noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE).
