# DSH Desktop Shell

> A lightweight, native, **plugin-free** desktop launcher for the DSH WebUI.

It wraps the DSH WebUI in a native Electron window, so you don't need a browser tab.

**[简体中文](README.md) | [English](README.en.md)**

---

## Plugin-free by design

The shell binds nothing: **no bundled plugins, no extra dependencies, no configuration layer.** It simply loads the DSH WebUI like a browser does, so every DSH plugin keeps working exactly as it does in the browser — while the shell itself stays small and native.

## Features

- Native window with a clean title bar (icon + brand only)
- **No more blank screens on startup failure**: on a load failure it shows the real cause (reason / error code / description / URL) and offers one-click retry, copy error, open terminal for troubleshooting, and quit
- **Crash-aware**: a renderer crash or unresponsive UI shows a clear crash page (with exit code) instead of a silent white window
- **Visible install/update progress**: the progress window streams output live like a terminal, and on failure gives a copyable manual command
- Automatic retry if the DSH server isn't ready yet
- **Native picker raised to the front**: the Windows "Select Workspace Directory" dialog, which DSH opens from a background process, is automatically brought to the foreground, centered over the main window and adopted as its owned dialog — no more hiding behind the interface
- External links open in your system browser
- Shortcuts: `Ctrl+R` reload, `F12` devtools, `Ctrl+Q` quit
- Zoom: `Ctrl+` / `Ctrl-`
- **Single-instance**: launching again just focuses the existing window, never re-spawning the shared DSH service
- Only stops the DSH server **it spawned itself** — never force-kills a server another instance or an external process is using

## Quick Start

```bash
# Install dependencies (first time only)
npm install

# Launch
npm start

# Or just double-click start.bat
```

## Configuration

| Environment Variable | Default | Description |
| --- | --- | --- |
| `DSH_URL` | `http://127.0.0.1:3080` | The DSH WebUI URL to load |

Example with a custom URL:

```bash
set DSH_URL=http://localhost:4000
npm start
```

## Development

```bash
npm run dev
```

Launches the app with DevTools open for debugging.

## Build

```bash
npm run build        # NSIS installer (win x64)
npm run build:portable
npm run build:nsis
```

## License

[MIT](LICENSE)
