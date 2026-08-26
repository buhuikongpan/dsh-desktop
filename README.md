# DSH Desktop Shell

A lightweight, native desktop launcher for the DSH WebUI. It wraps the web interface
in a single Electron window so you don't need a browser tab.

**Plugin-free by design.** The shell binds nothing — no bundled plugins, no extra
dependencies, no configuration layer. It simply loads the DSH WebUI like a browser
does, so every DSH plugin keeps working exactly as it does in the browser, and the
shell itself stays small and native.

## Features

- Native window with a clean title bar (icon + brand only)
- Automatic retry if the DSH server isn't ready yet
- External links open in your system browser
- Keyboard shortcuts: `Ctrl+R` (reload), `F12` (devtools), `Ctrl+Q` (quit)
- Zoom support (`Ctrl+` / `Ctrl-`)
- Single-instance: launching again just focuses the existing window
- Only stops the DSH server it spawned itself — never force-kills a server another
  instance or an external process is using

## Quick Start

```bash
# Install dependencies (first time only)
npm install

# Launch
npm start

# Or just double-click start.bat
```

## Configuration

| Environment Variable | Default                  | Description              |
| -------------------- | ------------------------ | ------------------------ |
| `DSH_URL`            | `http://127.0.0.1:3080` | The DSH WebUI URL to load |

Example with a custom URL:

```bash
set DSH_URL=http://localhost:4000
npm start
```

## Development

```bash
npm run dev
```

This launches the app with DevTools open for debugging.

## Build

```bash
npm run build      # NSIS installer (win x64)
npm run build:portable
npm run build:nsis
```

## License

[MIT](LICENSE)
