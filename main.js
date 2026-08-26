const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = require('electron')
const { execSync, exec, spawn } = require('child_process')
const path = require('path')
const http = require('http')
const https = require('https')

// DSH WebUI URL
const DSH_URL = process.env.DSH_URL || 'http://127.0.0.1:3080'
const IS_DEV = process.argv.includes('--dev')

// Extract the port from a URL like http://127.0.0.1:3080
function getPortFromUrl(url) {
  try {
    const parsed = new URL(url)
    return Number(parsed.port) || 3080
  } catch {
    return 3080
  }
}

let mainWindow = null
let quitting = false

// ── DSH environment checks ──────────────────────────────────────────

// Check if the DSH web server is already running
function isDshServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(DSH_URL, { timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// cmd /c gives us the system shell with full PATH
function shellExec(command, timeout = 10000) {
  try {
    return execSync(`cmd /c ${command}`, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function getDshVersion() {
  // 1. Try PATH first (fast, no network)
  const out = shellExec('dsh --version')
  if (out) {
    const m = out.match(/(\d+\.\d+\.\d+[-\w.]*)/)
    if (m) return m[1]
  }

  // 2. Fallback: query the npm global root directly (PATH may be broken / non-default prefix)
  try {
    const listed = shellExec('npm list -g @deepseek-ai/dsh --depth=0', 15000)
    if (listed && listed.includes('@deepseek-ai/dsh')) {
      const m = listed.match(/@deepseek-ai\/dsh@([\d.]+)/)
      if (m) return m[1]
    }
  } catch { /* fall through */ }

  return null
}

// Query npm registry. Reads the full package document and returns the highest
// version found across ALL dist-tags (latest and next), so RCs published
// under the "next" tag (like rc.8) are not missed.
function getNpmLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get('https://registry.npmjs.org/@deepseek-ai/dsh', { timeout: 8000 }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          const doc = JSON.parse(data)
          const tags = doc['dist-tags'] || {}
          let best = null
          for (const tag of Object.values(tags)) {
            if (typeof tag !== 'string' || !/^\d+\.\d+\.\d+/.test(tag)) continue
            if (!best || compareVersions(tag, best) > 0) best = tag
          }
          resolve(best)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// Query GitHub releases (pre-release aware) and return the highest semver.
// Tags look like "dsh-v0.1.0-rc.8" — strip the "dsh-" prefix and leading "v"
// CORRECTLY (no substring truncation) to avoid the false-positive bug.
function getGithubLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get('https://api.github.com/repos/deepseek-ai/deepseek-harness/releases', {
      timeout: 8000,
      headers: { 'User-Agent': 'dsh-desktop', 'Accept': 'application/vnd.github+json' },
    }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          const releases = JSON.parse(data)
          let best = null
          for (const rel of releases) {
            if (rel.draft) continue
            let tag = rel.tag_name || ''
            // strip "dsh-" prefix, then a single leading "v" — anchored, not global replace
            if (tag.startsWith('dsh-')) tag = tag.slice(4)
            if (tag.startsWith('v')) tag = tag.slice(1)
            if (!/^\d+\.\d+\.\d+/.test(tag)) continue
            if (!best || compareVersions(tag, best) > 0) best = tag
          }
          resolve(best)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// Latest known version: query GitHub AND npm in parallel, take the overall max.
// This is consistent — even if one source fails (rate limit / network), the
// other still reports the newest RC, so the update prompt is reliable.
async function getLatestVersion() {
  const [gh, npm] = await Promise.all([getGithubLatestVersion(), getNpmLatestVersion()])
  let best = null
  for (const v of [gh, npm]) {
    if (v && (!best || compareVersions(v, best) > 0)) best = v
  }
  return best
}

// Proper semver comparison, including pre-release ordering
// (so 0.1.0-rc.8 > 0.1.0-rc.7, and 0.1.0-rc.7 < 0.1.0).
function parseVersion(v) {
  const dash = v.indexOf('-')
  const core = (dash === -1 ? v : v.slice(0, dash)).split('.').map(Number)
  const pre = dash === -1 ? [] : v.slice(dash + 1).split('.')
  return { core, pre }
}

function comparePreRelease(preA, preB) {
  const len = Math.max(preA.length, preB.length)
  for (let i = 0; i < len; i++) {
    const a = preA[i]
    const b = preB[i]
    if (a === undefined) return 1   // fewer segments is greater
    if (b === undefined) return -1  // more segments is lower
    const aNum = /^\d+$/.test(a)
    const bNum = /^\d+$/.test(b)
    if (aNum && bNum) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1
    } else if (aNum) {
      return -1 // numeric identifier < alphanumeric
    } else if (bNum) {
      return 1
    } else if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return 0
}

function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if ((pa.core[i] || 0) < (pb.core[i] || 0)) return -1
    if ((pa.core[i] || 0) > (pb.core[i] || 0)) return 1
  }
  // Same core: no pre-release > has pre-release
  if (pa.pre.length === 0 && pb.pre.length > 0) return 1
  if (pa.pre.length > 0 && pb.pre.length === 0) return -1
  return comparePreRelease(pa.pre, pb.pre)
}

async function runStartupChecks() {
  // Called only when server is NOT running
  const issues = []

  const currentVersion = getDshVersion()
  if (!currentVersion) {
    issues.push({ type: 'not_installed', title: 'DSH 未安装', detail: '未检测到 DSH 命令。请先安装 DSH 后再启动。', action: 'install' })
    return { issues, currentVersion: null, latestVersion: null }
  }

  const latestVersion = await getLatestVersion()
  if (latestVersion && compareVersions(currentVersion, latestVersion) < 0) {
    issues.push({ type: 'update_available', title: '发现新版本', detail: `当前版本: ${currentVersion}\n最新版本: ${latestVersion}`, action: 'update' })
  }

  return { issues, currentVersion, latestVersion }
}

// Run `npm install` as a child process, streaming each output line to
// `onOutput` live (instead of buffering until the whole command finishes).
// Resolves true when the command exits 0.
function runNpmInstall(args, onOutput, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', 'npm', 'install', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], // capture stdout + stderr
    })
    let buf = ''
    const handle = (chunk) => {
      buf += chunk.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        try { onOutput(line.replace(/\r$/, '')) } catch { /* ignore */ }
      }
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); resolve(false) } }, timeoutMs)
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false) } })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { if (buf.trim()) onOutput(buf.trim()) } catch { /* ignore */ }
      resolve(code === 0)
    })
  })
}

function installDsh(onOutput) {
  return runNpmInstall(['-g', '@deepseek-ai/dsh'], onOutput, 180000)
}

// Install a specific version. updateDsh must NOT rely on the "latest" tag —
// RCs like rc.8 live under the "next" tag, so we target the exact detected version.
function updateDsh(version, onOutput) {
  const spec = version ? `@deepseek-ai/dsh@${version}` : '@deepseek-ai/dsh'
  return runNpmInstall(['-g', spec], onOutput, 240000)
}

// The DSH web server child we spawned (so we can stop it when the app quits).
let dshServerChild = null

// Start the DSH web server in the background, do not open a browser.
// Keeps a handle so the app can shut it down together on quit.
function startDshServer() {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', 'dsh', 'web', '--no-open'], {
      windowsHide: true,
      detached: false, // keep it tied to this app so it dies with it
      stdio: 'ignore',
    })
    dshServerChild = child
    child.on('error', (err) => { dshServerChild = null; resolve(false) })
    child.on('exit', () => { if (dshServerChild === child) dshServerChild = null })
    child.unref()
    // Give it a moment to fail fast if the binary is missing
    setTimeout(() => resolve(true), 500)
  })
}

// Stop ONLY the DSH web server we spawned (its whole process tree), so the
// service closes together with the app instead of lingering in the background.
// Never kills an external server we merely reused at launch. Blocking
// (`execSync`) so the taskkill actually completes before the app exits.
function stopDshServer() {
  const child = dshServerChild
  dshServerChild = null
  if (!child || !child.pid) return
  try {
    execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', timeout: 5000 })
  } catch { /* already gone */ }
}

// Find the PID(s) listening on `port` (e.g. 3080) via netstat.
// Returns an array of numeric PIDs; empty when nothing is listening.
function findPidOnPort(port) {
  try {
    const out = execSync(`cmd /c netstat -ano | findstr :${port}`, {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const pids = new Set()
    for (const line of out.split(/\r?\n/)) {
      // e.g. "  TCP    0.0.0.0:3080    ...    LISTENING     12345"
      if (!/LISTENING/i.test(line)) continue
      const m = /\s+(\d+)\s*$/.exec(line.trim())
      if (m) pids.add(Number(m[1]))
    }
    return [...pids]
  } catch {
    return []
  }
}

// Force-kill every process listening on `port`. Used after a DSH update so the
// currently-running server (whether the shell spawned it or an external one)
// cannot keep serving stale code that triggers the standing-generation clash.
async function killServerOnPort(port) {
  for (const pid of findPidOnPort(port)) {
    if (dshServerChild && dshServerChild.pid === pid) dshServerChild = null
    try {
      spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      }).unref()
    } catch { /* already gone */ }
  }
  // wait a moment for the sockets to free
  await new Promise((r) => setTimeout(r, 600))
}

// Poll the port until the server responds, or timeout
function waitForServer(timeoutMs = 30000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const probe = () => {
      isDshServerRunning().then((up) => {
        if (up) return resolve(true)
        if (Date.now() - start > timeoutMs) return resolve(false)
        setTimeout(probe, 800)
      })
    }
    probe()
  })
}

// Manually clear a stale server (e.g. one left running from an external
// `npm install -g` upgrade) and start a fresh one, then reload the window.
async function restartDshServer() {
  await killServerOnPort(getPortFromUrl(DSH_URL))
  const started = await startDshServer()
  if (!started) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'DSH Desktop',
      message: '重启 DSH 服务失败',
      detail: '无法启动 DSH 服务。请尝试手动运行: dsh web',
    })
    return
  }
  const ready = await waitForServer(30000)
  if (!ready) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'DSH Desktop',
      message: 'DSH 服务未就绪',
      detail: '等待 DSH WebUI 就绪超时，请确认服务已启动后重试。',
    })
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(DSH_URL)
}

// ── Startup dialog ──────────────────────────────────────────────────

// Handle blocking issues (not installed / update available).
// Returns true to proceed, false to quit.
async function handleBlockingIssues(checkResult) {
  const { issues } = checkResult

  for (const issue of issues) {
    if (issue.action === 'install') {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'DSH Desktop',
        message: issue.title,
        detail: issue.detail + '\n\n是否现在自动安装？',
        buttons: ['自动安装', '取消启动'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) {
        const ok = await showProgressAndRun('正在安装 DSH …', (onLine) => installDsh(onLine))
        if (!ok) {
          await dialog.showMessageBox({
            type: 'error',
            title: 'DSH Desktop',
            message: '安装失败',
            detail: '请手动运行: npm install -g @deepseek-ai/dsh',
          })
          return false
        }
        const recheck = await runStartupChecks()
        return handleBlockingIssues(recheck)
      }
      return false
    }

    if (issue.action === 'update') {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'DSH Desktop',
        message: issue.title,
        detail: issue.detail + '\n\n是否更新到最新版本？',
        buttons: ['立即更新', '跳过，直接启动'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) {
        // Clear a stale server (ours or an external one) BEFORE the upgrade so
        // no old-code process keeps the port / the global module files while
        // npm rewrites them; launch() restarts a fresh process on the new
        // version afterwards.
        await killServerOnPort(getPortFromUrl(DSH_URL))
        const ok = await showProgressAndRun('正在更新 DSH …', (onLine) => updateDsh(checkResult.latestVersion, onLine))
        // Re-check the actually installed version to show in the result.
        const after = getDshVersion()

        if (ok) {
          // Update command succeeded → always pop the "更新完成" dialog.
          // If the version re-check works, mention it; otherwise keep it generic.
          const reachedLatest = after && checkResult.latestVersion && compareVersions(after, checkResult.latestVersion) >= 0

          // Critical: an in-place npm upgrade leaves the already-running DSH
          // server (external or shell-spawned) on stale code, which on resume
          // can hit the standing-generation 'Service already registered' clash.
          // Kill whatever holds the port so launch() starts a fresh process.
          if (reachedLatest) {
            await killServerOnPort(getPortFromUrl(DSH_URL))
          }

          await dialog.showMessageBox({
            type: 'info',
            title: 'DSH Desktop',
            message: '更新完成',
            detail: reachedLatest
              ? `已升级到 ${after}\n（目标：${checkResult.latestVersion}）\n已重启 DSH 服务以应用新版本。`
              : `更新命令已执行完成。\n当前版本：${after || '未知'}${checkResult.latestVersion ? `，目标 ${checkResult.latestVersion}` : ''}`,
          })
        } else {
          await dialog.showMessageBox({
            type: 'warning',
            title: 'DSH Desktop',
            message: '更新失败',
            detail: `未能升级到 ${checkResult.latestVersion}。\n可稍后重试，或手动运行: npm install -g @deepseek-ai/dsh@${checkResult.latestVersion}`,
          })
        }
        return true
      }
      return true
    }
  }

  return true
}

// Live progress window: shows a spinner + streaming output log (like a
// terminal) and a clear done/failed state. fn(onOutput) must resolve boolean.
async function showProgressAndRun(title, fn) {
  const progressWin = new BrowserWindow({
    width: 520,
    height: 320,
    resizable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    title,
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'progress-preload.js'),
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
    </script>
  </body></html>`

  progressWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  progressWin.once('ready-to-show', () => progressWin.show())

  const send = (ch, payload) => {
    try {
      if (!progressWin.isDestroyed()) progressWin.webContents.send(ch, payload)
    } catch { /* renderer gone */ }
  }

  let ok = false
  try {
    ok = await fn((line) => send('dsh-progress:line', line))
    send('dsh-progress:done', ok)
    if (ok) {
      // Success: brief beat to show the ✓ state, then auto-close.
      await new Promise((r) => setTimeout(r, 1200))
    } else {
      // Failure: keep the window open so the user can read the log and act.
      // Wait until they close it (or it is destroyed) before continuing.
      await new Promise((resolve) => {
        if (progressWin.isDestroyed()) return resolve()
        progressWin.once('closed', () => resolve())
      })
    }
  } finally {
    if (!progressWin.isDestroyed()) hiddenClose(progressWin)
  }
  return ok
}

// Force-close a progress window without waiting for graceful close
function hiddenClose(win) {
  try { win.destroy() } catch { /* already gone */ }
}

// ── Main window ─────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness Desktop',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  // Keep the title bar to just the icon + brand name; don't let the loaded
  // page (conversation name etc.) overwrite it.
  mainWindow.setTitle('DeepSeek Harness Desktop')
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow.setTitle('DeepSeek Harness Desktop')
  })

  mainWindow.loadURL(DSH_URL)

  const isLocalUrl = (url) => url.includes('127.0.0.1') || url.includes('localhost')

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !isLocalUrl(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isLocalUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })

  if (IS_DEV) mainWindow.webContents.openDevTools()

  mainWindow.on('closed', () => { mainWindow = null })

  // Visible status pages: waiting (while server boots) and error (after retries)
  let retryCount = 0
  const maxRetries = 10

  const showStatusPage = (mode) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const waiting = mode === 'waiting'
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:Segoe UI,system-ui,sans-serif;height:100vh;display:flex;align-items:center;justify-content:center;
        background:#f5f5f5;color:#333}
      .card{text-align:center;max-width:420px;padding:32px}
      ${waiting ? '.spinner{width:36px;height:36px;border:3px solid #d0d0d0;border-top-color:#4a90d9;border-radius:50%;animation:spin .9s linear infinite;margin:0 auto 18px}@keyframes spin{to{transform:rotate(360deg)}}' : '.warn{font-size:44px;margin-bottom:12px}'}
      h1{font-size:18px;font-weight:600;margin-bottom:8px}
      p{font-size:13px;color:#666;margin-bottom:20px;line-height:1.5}
      .buttons{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
      button{font-family:Segoe UI,system-ui,sans-serif;font-size:13px;padding:8px 18px;border:1px solid #ccc;
        border-radius:4px;background:#fff;color:#333;cursor:pointer}
      button.primary{background:#4a90d9;border-color:#4a90d9;color:#fff}
      button:hover{filter:brightness(.97)}
    </style></head><body><div class="card">
      ${waiting
        ? `<div class="spinner"></div><h1>正在等待 DSH 服务器…</h1><p>重试中（${retryCount}/${maxRetries}）<br/>若长时间无响应，可点下方按钮重新检测</p><div class="buttons"><button onclick="retry()">立即重试</button>${'<button onclick="quit()">退出</button>'}</div>`
        : `<div class="warn">⚠️</div><h1>无法连接到 DSH 服务器</h1><p>DSH WebUI 未能在预期时间内就绪。<br/>请检查 DSH 服务是否已启动后再试。</p><div class="buttons"><button class="primary" onclick="retry()">重新检测</button>${'<button onclick="quit()">退出</button>'}</div>`}
    </div><script>
      function retry(){
        if (window.dshDesktop && window.dshDesktop.retry) window.dshDesktop.retry()
        else window.location.reload()
      }
      function quit(){
        if (window.dshDesktop && window.dshDesktop.quit) window.dshDesktop.quit()
      }
    </script></body></html>`
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  }

  mainWindow.webContents.on('did-fail-load', (event, errorCode) => {
    const isConnErr = errorCode === -102 || errorCode === -105
    if (!isConnErr) return
    if (retryCount < maxRetries) {
      retryCount++
      showStatusPage('waiting')
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(DSH_URL)
      }, 2000)
    } else {
      showStatusPage('error')
    }
  })
}

// ── Menu ────────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: 'DSH',
      submenu: [
        { label: 'About DSH Desktop', role: 'about' },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => mainWindow?.webContents.reloadIgnoringCache() },
        { label: 'Toggle DevTools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
        { label: '重启 DSH 服务', click: () => restartDshServer() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── App lifecycle ───────────────────────────────────────────────────

async function launch() {
  // 1. ALWAYS check version first at startup, so a new release (e.g. rc.8)
  //    prompts every launch — not only when the server happens to be down.
  const checkResult = await runStartupChecks()
  const okIssues = await handleBlockingIssues(checkResult)
  if (!okIssues) { app.quit(); return }

  // 2. If the server isn't already running, auto-start it silently.
  const serverRunning = await isDshServerRunning()
  if (!serverRunning) {
    const started = await startDshServer()
    if (!started) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'DSH Desktop',
        message: '启动 DSH 失败',
        detail: '无法启动 DSH 服务。请尝试手动运行: dsh web',
      })
      app.quit()
      return
    }
    const ready = await waitForServer(30000)
    if (!ready) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'DSH Desktop',
        message: 'DSH 服务未就绪',
        detail: '等待 DSH WebUI 就绪超时。请确认服务已启动后重试。',
      })
      app.quit()
      return
    }
  }

  // 3. Server is up (already running or just started) → open the window.
  createWindow()
}

// IPC from the built-in waiting/error status pages
ipcMain.on('dsh-desktop:quit', () => app.quit())
ipcMain.on('dsh-desktop:retry', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadURL(DSH_URL)
})

// Constrain the app to a single instance. A slow launch must not spawn extra
// processes on double-click — each extra window used to watch the same port,
// so closing one killed the shared server every other window relied on.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else if (app.isReady()) {
      createWindow()
    }
  })

  app.whenReady().then(async () => {
    buildMenu()
    await launch()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Stop only the server we spawned. `will-quit` also catches quit paths that
  // never opened a window (e.g. a startup failure after the server was spawned),
  // which would otherwise leak that process.
  app.on('will-quit', () => stopDshServer())

  // Windows: closing the last window ends the app. Tear down only the DSH
  // server we own — never force-kill whatever happens to hold the port (an
  // external server we reused, or another instance's server).
  app.on('window-all-closed', () => {
    if (quitting) return
    quitting = true
    stopDshServer()
    app.quit()
  })
}
