// Keeps the DSH native folder picker visible and usable inside the shell.
//
// On Windows DSH opens its "Select Workspace Directory" dialog from a
// background node child process (IFileOpenDialog shown with no owner), so the
// foreground lock keeps the dialog BEHIND our window — it only flashes in the
// taskbar. This watcher (a single hidden PowerShell process) adopts every such
// dialog as an owned window of the shell window (it then always sits above us,
// moves and minimizes with us), centers it over the shell window, and pulls it
// to the foreground via the AttachThreadInput dance that bypasses the lock.
//
// The dialog is identified by class #32770 + DSH's fixed DIALOG_TITLE
// (@deepseek-ai/dsh-host-directory-picker-native), which is set programmatically
// and not localized by the OS. Each dialog hwnd is handled exactly once, so the
// watcher never fights the user afterwards.

const DLG_TITLE = 'Select Workspace Directory'

// Placeholders __OWNER_HWND__ / __PARENT_PID__ are substituted before the
// script is handed to powershell via -EncodedCommand (avoids all quoting).
const scriptTemplate = `$ErrorActionPreference = 'SilentlyContinue'
$owner = [IntPtr]__OWNER_HWND__
$parent = $null
try { if (__PARENT_PID__ -gt 0) { $parent = [System.Diagnostics.Process]::GetProcessById(__PARENT_PID__) } } catch { $parent = $null }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DshDlgWatch {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static IntPtr SetOwner(IntPtr hWnd, IntPtr owner) {
    if (IntPtr.Size == 8) return SetWindowLongPtr64(hWnd, -8, owner);
    return (IntPtr)SetWindowLong32(hWnd, -8, owner.ToInt32());
  }
  public static List<IntPtr> FindDialogs(string className, string title) {
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (IsWindowVisible(hWnd)) {
        var cls = new StringBuilder(256); GetClassNameW(hWnd, cls, 256);
        if (cls.ToString() == className) {
          var txt = new StringBuilder(512); GetWindowTextW(hWnd, txt, 512);
          if (txt.ToString() == title) found.Add(hWnd);
        }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

[void][DshDlgWatch]::SetProcessDPIAware()
$processed = @{}
while ($true) {
  if ($parent -ne $null) {
    try { $parent.Refresh(); if ($parent.HasExited) { break } } catch { break }
  }
  foreach ($h in [DshDlgWatch]::FindDialogs('#32770', '__DLG_TITLE__')) {
    $key = $h.ToString()
    if ($processed.ContainsKey($key)) { continue }
    $processed[$key] = $true
    if ($owner -ne [IntPtr]::Zero) { [void][DshDlgWatch]::SetOwner($h, $owner) }
    # Center over the shell window (skipped while it is minimized: its rect
    # collapses to -32000 off-screen coordinates).
    $dr = New-Object 'DshDlgWatch+RECT'
    $or2 = New-Object 'DshDlgWatch+RECT'
    [void][DshDlgWatch]::GetWindowRect($h, [ref]$dr)
    if ($owner -ne [IntPtr]::Zero) {
      [void][DshDlgWatch]::GetWindowRect($owner, [ref]$or2)
      if ($or2.Left -gt -20000 -and $or2.Right -gt $or2.Left) {
        $x = [int]((($or2.Left + $or2.Right) / 2) - (($dr.Right - $dr.Left) / 2))
        $y = [int]((($or2.Top + $or2.Bottom) / 2) - (($dr.Bottom - $dr.Top) / 2))
        # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
        [void][DshDlgWatch]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, 0, 0, 0x1 -bor 0x4 -bor 0x10)
      }
    }
    # Foreground the dialog despite the background-process lock: attach the
    # input queues of the current foreground thread and the dialog thread.
    $fg = [DshDlgWatch]::GetForegroundWindow()
    $fgTid = [uint32]0
    $dlgTid = [uint32]0
    if ($fg -ne [IntPtr]::Zero) { [void][DshDlgWatch]::GetWindowThreadProcessId($fg, [ref]$fgTid) }
    [void][DshDlgWatch]::GetWindowThreadProcessId($h, [ref]$dlgTid)
    $attached = $false
    if ($fgTid -ne 0 -and $dlgTid -ne 0 -and $fgTid -ne $dlgTid) {
      $attached = [DshDlgWatch]::AttachThreadInput($fgTid, $dlgTid, $true)
    }
    [void][DshDlgWatch]::SetForegroundWindow($h)
    [void][DshDlgWatch]::SetActiveWindow($h)
    [void][DshDlgWatch]::SetFocus($h)
    if ($attached) { [void][DshDlgWatch]::AttachThreadInput($fgTid, $dlgTid, $false) }
  }
  Start-Sleep -Milliseconds 150
}`

// Build the base64 payload for `powershell -EncodedCommand`.
function buildEncodedCommand(ownerHwnd, parentPid) {
  const script = scriptTemplate
    .replaceAll('__OWNER_HWND__', String(ownerHwnd))
    .replaceAll('__PARENT_PID__', String(parentPid))
    .replaceAll('__DLG_TITLE__', DLG_TITLE)
  return Buffer.from(script, 'utf16le').toString('base64')
}

module.exports = { DLG_TITLE, scriptTemplate, buildEncodedCommand }
