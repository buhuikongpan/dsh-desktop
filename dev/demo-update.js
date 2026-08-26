// Demo of the live "update DSH" progress window.
// Simulates an npm install with streaming output (no real install happens).
// Run:  npx electron demo-update.js
const { app, BrowserWindow } = require('electron')
const path = require('path')

// Resources (icon.png, progress-preload.js) live in the project root (parent of dev/)
const root = path.join(__dirname, '..')

const DEMO_LINES = [
  '',
  'npm warn deprecated boolean@3.2.0: Package no longer supported.',
  '',
  'added 120 packages in 14s',
  '',
  'changed 5 packages in 14s',
  '',
  '⸻',
  '✔ 升级完成：@deepseek-ai/dsh 0.1.0-rc.8 → 0.1.0-rc.9',
  '✔ 已重启 DSH 服务以应用新版本',
]

function createProgressWindow(title) {
  const win = new BrowserWindow({
    width: 520,
    height: 320,
    resizable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    title,
    icon: path.join(root, 'icon.png'),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(root, 'progress-preload.js'),
    },
  })

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Segoe UI,system-ui,sans-serif;background:#1e1e2e;color:#cdd6f4;height:100vh;
      display:flex;flex-direction:column;overflow:hidden}
    .head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #313244;background:#181825}
    .spin{width:16px;height:16px;border:2px solid #45475a;border-top-color:#89b4fa;border-radius:50%;animation:sp .8s linear infinite}
    .spin.ok{border-color:#a6e3a1;animation:none}
    .spin.bad{border-color:#f38ba8;animation:none}
    @keyframes sp{to{transform:rotate(360deg)}}
    .t{font-size:13px;font-weight:600}
    .state{margin-left:auto;font-size:12px;color:#a6adc8}
    #log{flex:1;overflow:auto;padding:10px 14px;font-family:Consolas,'Cascadia Mono',monospace;font-size:12px;
      line-height:1.5;white-space:pre-wrap;word-break:break-all}
  </style></head><body>
    <div class="head"><div class="spin" id="spin"></div><div class="t">${title}</div><div class="state" id="state"></div></div>
    <div id="log"></div>
    <script>
      const log = document.getElementById('log')
      const state = document.getElementById('state')
      const spin = document.getElementById('spin')
      function append(t){ if(!t) return; log.textContent += t + '\\n'; log.scrollTop = log.scrollHeight }
      window.dshProgress.onLine((t)=>append(t))
      window.dshProgress.onDone((ok)=>{
        spin.classList.add(ok?'ok':'bad')
        if (ok) {
          state.textContent = '完成 ✓'
        } else {
          state.textContent = '失败 ✗'
          append('')
          append('⚠ 操作失败，请查看上方日志。')
          append('窗口保持打开，可复制日志排查或手动安装；关闭窗口后继续。')
        }
      })
      window.dshProgress.onTitle((t)=>{ state.textContent = t })
    </script>
  </body></html>`

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  win.once('ready-to-show', () => win.show())
  return win
}

async function runDemo() {
  const isFail = process.argv.includes('--fail')
  const win1 = createProgressWindow('正在更新 DSH …')

  const send = (win, ch, p) => {
    try { if (!win.isDestroyed()) win.webContents.send(ch, p) } catch { /* noop */ }
  }

  // Stream demo lines with a little delay (terminal-like)
  const lines = isFail
    ? [...DEMO_LINES, '', 'npm ERR! code ENOENT', 'npm ERR! syscall rename', 'npm ERR! path .../dsh/lib/bin.js']
    : DEMO_LINES
  for (const line of lines) {
    send(win1, 'dsh-progress:line', line)
    await new Promise((r) => setTimeout(r, 350))
  }

  // Announce done
  send(win1, 'dsh-progress:done', !isFail)
  if (isFail) {
    // Failure: window stays open until the user closes it
    await new Promise((resolve) => win1.once('closed', () => resolve()))
  } else {
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (!win1.isDestroyed()) win1.destroy()

  app.quit()
}

app.whenReady().then(runDemo)
app.on('window-all-closed', () => app.quit())
