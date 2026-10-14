param(
    [Parameter(Mandatory=$true)][string]$AppPath,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [int]$StartupTimeoutMs = 15000
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HudSmoke {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc fn, IntPtr param);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public static IntPtr Find(uint pid, string expectedTitle) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) => {
            uint owner; GetWindowThreadProcessId(h, out owner);
            if (owner == pid) {
                var title = new StringBuilder(expectedTitle.Length + 1);
                GetWindowText(h, title, title.Capacity);
                if (title.ToString() == expectedTitle) { found = h; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
$config = Get-Content (Join-Path $PSScriptRoot '../src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$title = ($config.app.windows | Where-Object { $_.label -eq 'hud' }).title
$root = Join-Path $OutputDirectory ('native-window-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory (Join-Path $root 'codex/sessions') -Force | Out-Null
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = (Resolve-Path $AppPath).Path
$info.EnvironmentVariables['CODEX_HOME'] = Join-Path $root 'codex'
$info.EnvironmentVariables['HUD_EVENT_DIR'] = Join-Path $root 'events'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardError = $true
$before = [HudSmoke]::GetForegroundWindow()
$process = [System.Diagnostics.Process]::Start($info)
try {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($StartupTimeoutMs)
    do {
        if ($process.HasExited) { throw "HUD exited: $($process.StandardError.ReadToEnd())" }
        $window = [HudSmoke]::Find([uint32]$process.Id, $title)
        if ($window -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    $ready = $window -ne [IntPtr]::Zero
    if (-not $ready) { throw 'HUD window was not found' }
    Start-Sleep -Milliseconds 500
    $style = [HudSmoke]::GetWindowLongPtr($window, -20).ToInt64()
    $result = [ordered]@{
        ready = $ready
        pid = $process.Id
        hiddenWithoutSessions = -not [HudSmoke]::IsWindowVisible($window)
        topmost = [bool]($style -band 0x8)
        toolWindow = [bool]($style -band 0x80)
        noActivate = [bool]($style -band 0x8000000)
        foregroundUnchanged = ([HudSmoke]::GetForegroundWindow() -eq $before)
        style = ('0x{0:X}' -f $style)
    }
    $result | ConvertTo-Json
    if (-not $result.hiddenWithoutSessions -or -not $result.topmost -or -not $result.toolWindow -or -not $result.noActivate -or -not $result.foregroundUnchanged) {
        throw 'Native smoke assertion failed'
    }
} finally {
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $errorText = $process.StandardError.ReadToEnd()
    if ($errorText) { Write-Output "HUD stderr: $errorText" }
    $process.Dispose()
}
