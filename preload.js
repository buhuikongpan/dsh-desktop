// preload.js - Minimal preload script for DSH Desktop Shell
// The DSH WebUI runs in the webview with full access, just like in a browser.
// This preload exists as an extension point if you need to bridge
// native capabilities to the web page in the future.

const { contextBridge, ipcRenderer } = require('electron')

// Expose a minimal API to the web page
contextBridge.exposeInMainWorld('dshDesktop', {
  isDesktopShell: true,
  platform: process.platform,
  // Used by the built-in waiting/error status pages
  quit: () => ipcRenderer.send('dsh-desktop:quit'),
  retry: () => ipcRenderer.send('dsh-desktop:retry'),
  // Copy an arbitrary string to the system clipboard (used by the error page)
  copyText: (text) => ipcRenderer.send('dsh-desktop:copy', String(text || '')),
  // Open a console (cmd window) that runs the given diagnostic command so the
  // user can see the real output. The command is validated against a whitelist
  // in the main process; unknown commands are ignored.
  openDiagnostic: (commandKey) => ipcRenderer.send('dsh-desktop:open-diagnostic', String(commandKey || '')),
  // Re-request the main process to capture the current page title/size for
  // crash reports (best-effort, no-op on failure).
  onStatusChange: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('dsh-desktop:status', listener)
    return () => ipcRenderer.removeListener('dsh-desktop:status', listener)
  },
})