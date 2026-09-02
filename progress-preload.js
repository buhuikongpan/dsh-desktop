// preload for the live npm progress window.
// Exposes an IPC listener so the main process can stream output lines in
// real time (and announce completion) into the progress page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshProgress', {
  onLine: (cb) => ipcRenderer.on('dsh-progress:line', (_e, text) => cb(text)),
  onDone: (cb) => ipcRenderer.on('dsh-progress:done', (_e, ok) => cb(ok)),
  // Copy a string to the system clipboard (used by the failure-hint button).
  copyText: (text) => ipcRenderer.send('dsh-desktop:copy', String(text || '')),
})
