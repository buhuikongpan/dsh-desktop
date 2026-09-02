const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const { execSync, exec, spawn } = require('child_process')
const path = require('path')
const http = require('http')
const https = require('https')
const readline = require('readline')
const { buildEncodedCommand } = require('./dialog-watcher')

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

// The tokenized WebUI URL (http://127.0.0.1:PORT/?token=...) printed by
// `dsh web`. dsh web requires this token to establish the auth cookie before
// the real UI is served; loading the bare base URL yields a 401
// "authentication required" gate, not the app. We capture it from the child's
// stdout/stderr so the window can complete the token->cookie exchange.
let dshServerUrl = null

// URL the desktop window should actually load. Falls back to the bare base
// URL when no token has been captured yet (e.g. an external server we reused).
function currentServerUrl() {
  return dshServerUrl || DSH_URL
}

// Parse the tokenized WebUI URL out of a `dsh web` output line.
// The canonical readiness line is exactly:
//   dsh web: http://127.0.0.1:3080/?token=<...>
// Three hard guards (instead of a loose regex over the raw stream):
//   1. the line must start with the literal "dsh web:" prefix;
//   2. the trailing token must parse as a real URL;
//   3. it must share our base origin (scheme+port, host limited to
//      127.0.0.1 / localhost / the configured host) and carry a `token`
//      query parameter.
// So banner links (gofastmcp.com, horizon.prefect.io…) or any foreign
// "dsh web: https://evil…?token=…" line can never be accepted.
function parseServerUrl(line) {
  const text = String(line || '').trim()
  const m = /^dsh web:\s*(\S+)\s*$/.exec(text)
  if (!m) return null
  return isServerUrl(m[1]) ? m[1] : null
}

function isServerUrl(url) {
  let u
  try { u = new URL(url) } catch { return false }
  if (!u.searchParams.get('token')) return false
  const base = new URL(DSH_URL)
  if (u.protocol !== base.protocol || u.port !== base.port) return false
  const host = u.hostname
  return host === '127.0.0.1' || host === 'localhost' || host === base.hostname
}

// Start the DSH web server in the background, do not open a browser.
// Keeps a handle so the app can shut it down together on quit.
function startDshServer() {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', 'dsh', 'web', '--no-open'], {
      windowsHide: true,
      detached: false, // keep it tied to this app so it dies with it
      stdio: ['ignore', 'pipe', 'pipe'], // capture stdout+stderr to read the token URL
    })
    dshServerChild = child
    dshServerUrl = null
    // readline handles arbitrary chunk boundaries (no half-line splits); scan
    // stdout+stderr for the canonical "dsh web: <url>" line.
    const onLine = (line) => {
      if (dshServerUrl) return
      const url = parseServerUrl(line)
      if (url) dshServerUrl = url
    }
    const rlOut = readline.createInterface({ input: child.stdout })
    const rlErr = readline.createInterface({ input: child.stderr })
    rlOut.on('line', onLine)
    rlErr.on('line', onLine)
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

// ── Diagnostic / terminal helpers ──────────────────────────────────

// Whitelist of diagnostic commands the error page may open in a dedicated
// terminal. Only these exact keys resolve; anything else is ignored, so a
// compromised/buggy page cannot make the shell run arbitrary input.
const DIAGNOSTIC_COMMANDS = {
  // show the DSH web server front and its real output
  'dsh-web': 'dsh web',
  // show what DSH version the shell currently sees
  'dsh-version': 'dsh --version',
}

// Open a new console window that actually runs `command` and stays open, so
// the user can read the raw output instead of a swallowed error. Returns false
// when the command is not whitelisted or the shell cannot be spawned.
function openTerminalCommand(key) {
  const command = DIAGNOSTIC_COMMANDS[key]
  if (!command || typeof command !== 'string') return false
  try {
    // `start "title" cmd /k ...` opens a fresh cmd window titled "DSH
    // Diagnostic" that keeps running after the launcher detaches. The explicit
    // quoted title avoids `start` misreading the first token as a title.
    spawn('cmd.exe', ['/c', 'start', '"DSH Diagnostic"', 'cmd', '/k', command], {
      windowsHide: false, stdio: 'ignore',
    }).unref()
    return true
  } catch {
    return false
  }
}

// Copy a string to the system clipboard (via PowerShell, no extra deps).
function copyToClipboard(text) {
  return new Promise((resolve) => {
    try {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command',
        // UTF-8 via stdin to survive CJK and special chars; [Console]::Out.Write wraps piped stdout, so go through [Windows.Forms] clipboard directly.
        `$t = [Console]::In.ReadToEnd(); try { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText($t) } catch { [System.IO.File]::WriteAllText("$env:TEMP\\dsh-copy.txt", $t) }`,
      ], {
        windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      })
      child.stdin.write(text)
      child.stdin.end()
      child.on('close', () => resolve(true))
      child.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
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

// Wait a moment for the tokenized URL `dsh web` prints at readiness, so the
// window can complete the token->cookie exchange instead of hitting the 401
// auth gate. Falls back to null (base URL) if it never appears.
function waitForServerUrl(timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (dshServerUrl) return resolve(dshServerUrl)
    const start = Date.now()
    const t = setInterval(() => {
      if (dshServerUrl) { clearInterval(t); return resolve(dshServerUrl) }
      if (Date.now() - start > timeoutMs) { clearInterval(t); return resolve(null) }
    }, 200)
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(currentServerUrl())
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
        const ok = await showProgressAndRun('正在安装 DSH …', (onLine) => installDsh(onLine), 'npm install -g @deepseek-ai/dsh')
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
        const ok = await showProgressAndRun('正在更新 DSH …', (onLine) => updateDsh(checkResult.latestVersion, onLine), `npm install -g @deepseek-ai/dsh@${checkResult.latestVersion || 'latest'}`)
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
// `failureHint` (optional) is a copyable command shown on failure so the user
// can act from the window instead of reopening a terminal.
async function showProgressAndRun(title, fn, failureHint) {
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
    ${failureHint ? `<div id="hint" style="display:none;padding:8px 14px;border-top:1px solid #313244;background:#181825;font-size:12px;color:#f9e2af">
      <div style="margin-bottom:6px">⚠ 失败时的手动操作命令（可复制后到终端执行）：</div>
      <code style="display:block;padding:6px 8px;background:#11111b;border-radius:4px;white-space:pre-wrap;word-break:break-all">${escapeHtml(failureHint)}</code>
      <button onclick="copyHint()" style="margin-top:8px;font-family:inherit;font-size:12px;padding:4px 12px;border:1px solid #45475a;border-radius:4px;background:#313244;color:#cdd6f4;cursor:pointer">复制命令</button>
    </div>` : ''}
    <script>
      const log = document.getElementById('log')
      const state = document.getElementById('state')
      const spin = document.getElementById('spin')
      function append(t){ if(!t) return; log.textContent += t + '\\n'; log.scrollTop = log.scrollHeight }
      function copyHint(){
        try { window.dshProgress.copyText(document.querySelector('#hint code').textContent) }
        catch(e){ append('无法复制命令，请手动复制上方命令。') }
      }
      window.dshProgress.onLine((t)=>append(t))
      window.dshProgress.onDone((ok)=>{
        spin.classList.add(ok?'ok':'bad')
        if (ok) {
          state.textContent = '完成 ✓'
        } else {
          state.textContent = '失败 ✗'
          append('')
          append('⚠ 操作失败，请查看上方日志。')
          const h = document.getElementById('hint')
          if (h) h.style.display = 'block'
          append('窗口保持打开，可复制日志排查或按上方命令手动操作；关闭窗口后继续。')
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

// Escape text for safe embedding inside an HTML attribute/text node (used when
// interpolating user/log text into inline status pages).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── Native dialog foreground fixer ──────────────────────────────────

// Hidden PowerShell process that pulls the DSH native folder picker to the
// front whenever DSH opens it (see dialog-watcher.js for why it's needed).
let dlgWatcherChild = null

function stopDialogWatcher() {
  const child = dlgWatcherChild
  dlgWatcherChild = null
  if (!child || !child.pid) return
  try {
    execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', timeout: 5000 })
  } catch { /* already gone */ }
}

function startDialogWatcher() {
  if (process.platform !== 'win32') return
  if (!mainWindow || mainWindow.isDestroyed()) return
  stopDialogWatcher()
  const hwnd = mainWindow.getNativeWindowHandle().readBigUInt64LE(0)
  dlgWatcherChild = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', buildEncodedCommand(hwnd, process.pid),
  ], { windowsHide: true, stdio: 'ignore' })
  dlgWatcherChild.unref()
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

  mainWindow.loadURL(currentServerUrl())

  // Watch for DSH's native folder picker and keep it in front of this window.
  startDialogWatcher()

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

  // Visible status pages: waiting (while server boots), error (after retries),
  // and crash (renderer died). All of them surface real information instead of
  // a blank white window, and offer copy / open-terminal / retry actions.
  let retryCount = 0
  const maxRetries = 10

  // Collapse a Chromium load errorCode into a short human label.
  const errorLabel = (code) => {
    const map = {
      '-102': '连接被拒绝', '-105': '无法解析主机', '-106': '网络已断开',
      '-109': '地址不可达', '-111': '连接超时', '-118': '连接被重置',
      '-6': '文件不存在', '-3': '加载被中断', '-2': '加载失败',
    }
    return map[String(code)] || `错误码 ${code}`
  }

  // Build a copyable plain-text summary from a status detail object.
  const buildDetailText = (detail) => {
    const lines = []
    lines.push(`[${new Date().toLocaleString()}]`)
    if (detail.title) lines.push(`标题: ${detail.title}`)
    if (detail.mode === 'error') {
      lines.push(`类型: 页面加载失败`)
      if (detail.errorLabel) lines.push(`原因: ${detail.errorLabel}`)
      if (detail.errorCode != null) lines.push(`错误码: ${detail.errorCode}`)
      if (detail.errorDescription) lines.push(`描述: ${detail.errorDescription}`)
      if (detail.url) lines.push(`地址: ${detail.url}`)
    } else if (detail.mode === 'crash') {
      lines.push(`类型: 渲染进程崩溃`)
      if (detail.reason) lines.push(`原因: ${detail.reason}`)
      if (detail.exitCode != null) lines.push(`退出码: ${detail.exitCode}`)
    }
    if (detail.extra) lines.push(detail.extra)
    return lines.join('\n')
  }

  const showStatusPage = (mode, detail) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const d = detail || {}
    const waiting = mode === 'waiting'
    const crash = mode === 'crash'
    const escapedTitle = escapeHtml(d.title || (crash ? '界面崩溃' : '无法连接到 DSH 服务器'))
    const escapedLabel = escapeHtml(d.errorLabel || (crash ? (d.reason || '') : ''))
    const escapedDesc = escapeHtml(d.errorDescription || '')
    const escapedUrl = escapeHtml(d.url || '')
    // JSON-safe copy of everything, computed for the "复制错误" button.
    const copyPayload = JSON.stringify(buildDetailText({ ...d, mode }))
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:Segoe UI,system-ui,sans-serif;height:100vh;display:flex;align-items:center;justify-content:center;
        background:#f5f5f5;color:#333}
      .card{text-align:left;max-width:560px;width:100%;padding:28px 32px;background:#fff;border:1px solid #e0e0e0;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
      .head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
      ${waiting ? '.spinner{width:30px;height:30px;border:3px solid #d0d0d0;border-top-color:#4a90d9;border-radius:50%;animation:spin .9s linear infinite;flex:none}@keyframes spin{to{transform:rotate(360deg)}}'
        : `.icon{font-size:34px;line-height:1;flex:none}${crash ? '.icon{color:#e07b39}' : '.icon{color:#c0392b}'}`}
      h1{font-size:17px;font-weight:600;margin:0}
      p{font-size:13px;color:#666;line-height:1.5;margin:0}
      .meta{margin-top:12px;padding:12px;background:#fafafa;border:1px solid #eee;border-radius:6px;font-family:Consolas,'Cascadia Mono',monospace;font-size:12px;line-height:1.6;color:#444;white-space:pre-wrap;word-break:break-all}
      .meta b{color:#222;font-weight:600}
      .buttons{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px}
      button{font-family:Segoe UI,system-ui,sans-serif;font-size:13px;padding:8px 16px;border:1px solid #ccc;
        border-radius:4px;background:#fff;color:#333;cursor:pointer}
      button.primary{background:#4a90d9;border-color:#4a90d9;color:#fff}
      button:hover{filter:brightness(.97)}
      #copied{margin-right:auto;font-size:12px;color:#2e9b4f;visibility:hidden;align-self:center}
    </style></head><body><div class="card">
      <div class="head">
        ${waiting ? '<div class="spinner"></div>' : `<div class="icon">${crash ? '💥' : '⚠️'}</div>`}
        <div><h1>${escapedTitle}</h1>${waiting ? `<p>正在等待 DSH 服务器…<br/>重试中（${retryCount}/${maxRetries}）</p>` : `<p>${escapeHtml((crash ? '界面渲染进程意外退出' : 'DSH WebUI 未能成功加载') + '。以下是检测到的错误信息。')}</p>`}</div>
      </div>
      ${waiting ? '' : `<div class="meta">
        ${escapedLabel ? `<div><b>原因</b>: ${escapedLabel}</div>` : ''}
        ${d.errorCode != null ? `<div><b>错误码</b>: ${escapeHtml(String(d.errorCode))}</div>` : ''}
        ${crash && d.exitCode != null ? `<div><b>退出码</b>: ${escapeHtml(String(d.exitCode))}</div>` : ''}
        ${escapedDesc ? `<div><b>描述</b>: ${escapedDesc}</div>` : ''}
        ${escapedUrl ? `<div><b>地址</b>: ${escapedUrl}</div>` : ''}
        ${(crash && d.exitCode != null) || d.errorDescription ? '' : '<div>如需排查，可点“打开终端”运行命令查看真实输出。</div>'}
      </div>`}
      <div class="buttons">
        <span id="copied">✓ 已复制</span>
        ${waiting ? `<button onclick="retry()">立即重试</button>` : (crash ? `<button class="primary" onclick="retry()">重新加载</button>` : `<button class="primary" onclick="retry()">重新检测</button>`)}
        ${waiting ? '' : '<button onclick="copyErr()">复制错误</button>'}
        ${waiting ? '' : '<button onclick="openDiag()">打开终端排查</button>'}
        <button onclick="quit()">退出</button>
      </div>
    </div><script>
      const PAYLOAD = '${copyPayload}'
      function retry(){
        if (window.dshDesktop && window.dshDesktop.retry) window.dshDesktop.retry()
        else window.location.reload()
      }
      function quit(){
        if (window.dshDesktop && window.dshDesktop.quit) window.dshDesktop.quit()
      }
      function copyErr(){
        try {
          if (window.dshDesktop && window.dshDesktop.copyText) window.dshDesktop.copyText(PAYLOAD)
          var c = document.getElementById('copied'); if (c) c.style.visibility = 'visible'
        } catch(e){}
      }
      function openDiag(){
        if (window.dshDesktop && window.dshDesktop.openDiagnostic) window.dshDesktop.openDiagnostic('dsh-web')
      }
    </script></body></html>`
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  }

  // Helper used by the retry IPC: reload the page (remember the current status).
  const reloadMain = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(currentServerUrl())
  }

  // Guard against showing the error page for transient interruptions: anything
  // that isn't a real failure (-3 = ABORTED, e.g. user navigated away) rolls
  // through the retry ladder first. Every other code is surfaced at the end.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return // aborted / superseded navigation, not a fault
    retryCount++
    const detail = {
      title: '无法连接到 DSH 服务器',
      errorCode,
      errorLabel: errorLabel(errorCode),
      errorDescription: errorDescription || '',
      url: validatedURL || currentServerUrl(),
    }
    if (retryCount < maxRetries) {
      showStatusPage('waiting', detail)
      setTimeout(reloadMain, 2000)
    } else {
      showStatusPage('error', detail)
    }
  })

  // Renderer crashed (bad page script / OOM / renderer bug) — show a real
  // crash page instead of a silent white window.
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    showStatusPage('crash', {
      title: '界面已崩溃',
      reason: details.reason || '未知原因',
      exitCode: details.exitCode != null ? details.exitCode : null,
    })
  })

  // Renderer stopped responding — offer a way out instead of a frozen blank UI.
  mainWindow.webContents.on('unresponsive', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    showStatusPage('crash', { title: '界面无响应', reason: '渲染进程无响应' })
  })

  mainWindow.webContents.on('responsive', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(currentServerUrl())
  })
}

// ── Auto-update (electron-updater) ──────────────────────────────────

// Ask the user something via a message box attached to the main window (or a
// standalone dialog if no window is open yet). Returns the chosen index.
function askBox(message, detail, buttons) {
  const opts = { type: 'info', title: 'DSH Desktop', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 }
  return dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, opts)
}

let updateDialogOpen = false

// Wire up the auto-updater. Only runs in a packaged app — in development the
// updater has no `latest.yml` to read and `checkForUpdates()` throws, so we
// skip it there. Updates are checked in the background and surfaced through
// native dialogs; we never block startup on the network.
function initAutoUpdater() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false   // ask the user before downloading
  autoUpdater.autoInstallOnAppQuit = true
  // Quiet logger: keep electron-builder's verbose console output out of the
  // UI, but still surface real errors. electron-updater calls these methods
  // (optionally) — provide a minimal implementation so no null access occurs.
  autoUpdater.logger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: (msg) => console.error('[update]', msg),
  }

  autoUpdater.on('update-available', async (info) => {
    if (updateDialogOpen) { autoUpdater.downloadUpdate(); return }
    updateDialogOpen = true
    try {
      const { response } = await askBox(
        `发现新版本 ${info.version}（当前 ${app.getVersion()}）`,
        '是否立即下载并安装？',
        ['立即下载', '稍后'],
      )
      if (response === 0) autoUpdater.downloadUpdate()
    } finally {
      updateDialogOpen = false
    }
  })

  autoUpdater.on('download-progress', (p) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const pct = Math.round(p.percent || 0)
    mainWindow.setProgressBar(pct / 100)
  })

  autoUpdater.on('update-downloaded', async (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1)
    const { response } = await askBox(
      `新版本 ${info.version} 已下载完毕`,
      '重启应用即可完成安装。是否立即重启？',
      ['立即重启', '退出时安装'],
    )
    if (response === 0) autoUpdater.quitAndInstall(false, true)
  })

  autoUpdater.on('update-not-available', async () => {
    // Only tell the user when they explicitly asked (menu '检查更新').
    if (autoUpdater.__manualCheck) {
      await askBox('已是最新版本', `当前版本 ${app.getVersion()}，无需更新。`, ['好的'])
    }
  })

  autoUpdater.on('error', async (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1)
    if (autoUpdater.__manualCheck) {
      await askBox('检查更新失败', `无法获取更新信息。\n${err && err.message ? err.message : String(err)}`, ['好的'])
    }
    // silent on automatic check — a network hiccup shouldn't bother the user
  })

  // Manual check from the menu / IPC: remember for the next event, then run.
  autoUpdater.__manualCheck = false
}

function checkForUpdates(manual) {
  if (!app.isPackaged) {
    if (manual) askBox('开发模式', '开发模式下不检查更新。仅打包后的应用支持自动更新。', ['好的'])
    return
  }
  autoUpdater.__manualCheck = !!manual
  autoUpdater.checkForUpdates().catch(() => { /* network/offline errors are handled by the 'error' event */ })
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
        { label: '打开终端排查 (dsh web)', click: () => openTerminalCommand('dsh-web') },
        { type: 'separator' },
        { label: '检查更新', click: () => checkForUpdates(true) },
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
    // Capture the tokenized URL (printed when the web UI is ready) before
    // opening the window, so the auth cookie can be established.
    await waitForServerUrl()
  }

  // 3. Server is up (already running or just started) → open the window.
  createWindow()
}

// IPC from the built-in waiting/error status pages + progress/preload
ipcMain.on('dsh-desktop:quit', () => app.quit())
ipcMain.on('dsh-desktop:retry', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadURL(currentServerUrl())
})
ipcMain.on('dsh-desktop:copy', (_e, text) => { copyToClipboard(String(text || '')) })
ipcMain.on('dsh-desktop:open-diagnostic', (_e, key) => { openTerminalCommand(key) })

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
    initAutoUpdater()
    await launch()

    // Background auto-update check a few seconds after startup; never blocks
    // the window from opening.
    setTimeout(() => checkForUpdates(false), 8000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Stop only the server we spawned. `will-quit` also catches quit paths that
  // never opened a window (e.g. a startup failure after the server was spawned),
  // which would otherwise leak that process.
  app.on('will-quit', () => {
    stopDialogWatcher()
    stopDshServer()
  })

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
