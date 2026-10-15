param([Parameter(Mandatory=$true)][uint32]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HudWindowState {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc fn, IntPtr param);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder name, int count);
    public static IntPtr FindClass(uint pid, string expectedClass) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) => {
            uint owner; GetWindowThreadProcessId(h, out owner);
            var name = new StringBuilder(expectedClass.Length + 1);
            if (owner == pid && GetClassName(h, name, name.Capacity) != 0 && name.ToString() == expectedClass) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static int NormalZOrder(IntPtr target) {
        int rank = 0, found = -1;
        EnumWindows((h, p) => {
            if (IsWindowVisible(h) && !IsIconic(h) && (GetWindowLongPtr(h, -20).ToInt64() & 0x8) == 0) {
                if (h == target) { found = rank; return false; }
                rank++;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
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
$window = [HudWindowState]::Find($ProcessId, $title)
if ($window -eq [IntPtr]::Zero) { throw 'Target HUD window was not found' }
$style = [HudWindowState]::GetWindowLongPtr($window, -20).ToInt64()
[ordered]@{
    pid = $ProcessId
    visible = [HudWindowState]::IsWindowVisible($window)
    minimized = [HudWindowState]::IsIconic($window)
    foreground = [HudWindowState]::GetForegroundWindow().ToInt64().ToString('X')
    normalZOrder = [HudWindowState]::NormalZOrder($window)
    topmost = [bool]($style -band 0x8)
    toolWindow = [bool]($style -band 0x80)
    noActivate = [bool]($style -band 0x8000000)
    clickThrough = [bool]($style -band 0x20)
    style = ('0x{0:X}' -f $style)
} | ConvertTo-Json -Compress
