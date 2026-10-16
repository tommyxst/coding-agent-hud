param(
    [Parameter(Mandatory=$true)][uint32]$ProcessId,
    [Parameter(Mandatory=$true)][ValidateSet('Minimize', 'Hide', 'Lower', 'TrayClick', 'Move', 'Close', 'MoveAndClose')][string]$Action,
    [int]$X,
    [int]$Y
)
$ErrorActionPreference = 'Stop'
# Reuse window lookup and Win32 interop; restrict every action to the fixture PID.
. (Join-Path $PSScriptRoot 'read-window-state.ps1') -ProcessId $ProcessId | Out-Null
switch ($Action) {
    { $_ -in 'Move', 'MoveAndClose' } {
        if (-not [HudWindowState]::SetWindowPos($window, [IntPtr]::Zero, $X, $Y, 0, 0, 0x15)) { # NOSIZE | NOZORDER | NOACTIVATE
            throw [System.ComponentModel.Win32Exception]::new()
        }
        if ($Action -eq 'Move') { break }
    }
    { $_ -in 'Close', 'MoveAndClose' } {
        if (-not [HudWindowState]::PostMessage($window, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) { # WM_CLOSE
            throw [System.ComponentModel.Win32Exception]::new()
        }
    }
    'Minimize' { [HudWindowState]::ShowWindow($window, 7) | Out-Null } # SW_SHOWMINNOACTIVE
    'Hide' { [HudWindowState]::ShowWindow($window, 0) | Out-Null } # SW_HIDE
    'Lower' {
        if (-not [HudWindowState]::SetWindowPos($window, [IntPtr]1, 0, 0, 0, 0, 0x13)) { # HWND_BOTTOM, NOMOVE | NOSIZE | NOACTIVATE
            throw [System.ComponentModel.Win32Exception]::new()
        }
    }
    'TrayClick' {
        $tray = [HudWindowState]::FindClass($ProcessId, 'tray_icon_app')
        if ($tray -eq [IntPtr]::Zero) { throw 'Fixture tray window was not found' }
        # tray-icon 0.25.1 locked callback protocol: WM_USER_TRAYICON / WM_LBUTTONUP.
        if (-not [HudWindowState]::PostMessage($tray, 6002, [IntPtr]::Zero, [IntPtr]0x202)) {
            throw [System.ComponentModel.Win32Exception]::new()
        }
    }
}
