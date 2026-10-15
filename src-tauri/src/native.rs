use crate::model::Workspace;
use std::{
    collections::{HashMap, HashSet},
    mem::{size_of, zeroed},
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr,
    sync::OnceLock,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_MORE_DATA, ERROR_SUCCESS, HWND, INVALID_HANDLE_VALUE, LPARAM, LRESULT,
        WPARAM,
    },
    Foundation::{GetLastError, SetLastError},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        RestartManager::{
            RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
            RM_PROCESS_INFO,
        },
        Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE},
    },
    UI::{
        Input::KeyboardAndMouse::{VK_LMENU, VK_MENU, VK_RMENU},
        WindowsAndMessaging::{
            CallNextHookEx, EnumWindows, GetMessageW, GetWindowLongPtrW, GetWindowThreadProcessId,
            IsWindowVisible, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos,
            SetWindowsHookExW, ShowWindow, UnhookWindowsHookEx, GWL_EXSTYLE, HWND_TOP,
            KBDLLHOOKSTRUCT, MSG, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SWP_NOZORDER, SW_RESTORE, SW_SHOWNOACTIVATE, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
            WM_SYSKEYDOWN, WM_SYSKEYUP, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        },
    },
};

fn hud_extended_style(style: isize) -> isize {
    (style & !(WS_EX_APPWINDOW as isize)) | WS_EX_TOOLWINDOW as isize | WS_EX_NOACTIVATE as isize
}

pub(crate) fn configure_hud_window(window: HWND) -> Result<(), String> {
    unsafe {
        SetLastError(0);
        let style = GetWindowLongPtrW(window, GWL_EXSTYLE);
        if style == 0 && GetLastError() != 0 {
            return Err(format!(
                "read HUD window style: {}",
                std::io::Error::last_os_error()
            ));
        }
        let desired = hud_extended_style(style);
        if desired == style {
            return Ok(());
        }
        SetLastError(0);
        if SetWindowLongPtrW(window, GWL_EXSTYLE, desired) == 0 && GetLastError() != 0 {
            return Err(format!(
                "set HUD window style: {}",
                std::io::Error::last_os_error()
            ));
        }
        if SetWindowPos(
            window,
            ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
        ) == 0
        {
            return Err(format!(
                "apply HUD window style: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

pub(crate) fn reveal_hud_window(window: HWND) -> Result<(), String> {
    configure_hud_window(window)?;
    unsafe {
        // show() can be a cached no-op; restore and raise only on an explicit reveal request.
        ShowWindow(window, SW_SHOWNOACTIVATE);
        if SetWindowPos(
            window,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
        ) == 0
        {
            return Err(format!(
                "reveal HUD window: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

pub fn processes() -> Result<HashMap<u32, (u32, String)>, String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(format!(
                "process snapshot: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut result = HashMap::new();
        let mut present = Process32FirstW(snapshot, &mut entry);
        while present != 0 {
            let end = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            result.insert(
                entry.th32ProcessID,
                (
                    entry.th32ParentProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..end]),
                ),
            );
            present = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        Ok(result)
    }
}

pub fn ancestors(pid: u32, processes: &HashMap<u32, (u32, String)>) -> Vec<(u32, String)> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut next = pid;
    while seen.insert(next) {
        let Some((parent, name)) = processes.get(&next) else {
            break;
        };
        result.push((next, name.clone()));
        next = *parent;
    }
    result
}

pub fn agent_ancestor(agent: &str) -> Result<u32, String> {
    ancestors(std::process::id(), &processes()?)
        .into_iter()
        .find(|(_, name)| name.eq_ignore_ascii_case(&format!("{agent}.exe")))
        .map(|(pid, _)| pid)
        .ok_or_else(|| format!("no verified {agent}.exe ancestor; no event written"))
}

/// Read-only Restart Manager query. Never calls shutdown or restart APIs.
pub fn file_owners(path: &Path) -> Result<Vec<u32>, String> {
    struct Session(u32);
    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                RmEndSession(self.0);
            }
        }
    }
    unsafe {
        let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        let mut handle = 0;
        let code = RmStartSession(&mut handle, 0, key.as_mut_ptr());
        if code != ERROR_SUCCESS {
            return Err(format!("Restart Manager start: {code}"));
        }
        let session = Session(handle);
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let resource = path.as_ptr();
        let code = RmRegisterResources(session.0, 1, &resource, 0, ptr::null(), 0, ptr::null());
        if code != ERROR_SUCCESS {
            return Err(format!("Restart Manager register: {code}"));
        }
        let mut needed = 0;
        let mut count = 0;
        let mut reason = 0;
        let code = RmGetList(
            session.0,
            &mut needed,
            &mut count,
            ptr::null_mut(),
            &mut reason,
        );
        if code == ERROR_SUCCESS {
            return Ok(Vec::new());
        }
        if code != ERROR_MORE_DATA {
            return Err(format!("Restart Manager query: {code}"));
        }
        loop {
            let mut list: Vec<RM_PROCESS_INFO> = vec![zeroed(); needed as usize];
            count = needed;
            let code = RmGetList(
                session.0,
                &mut needed,
                &mut count,
                list.as_mut_ptr(),
                &mut reason,
            );
            if code == ERROR_MORE_DATA {
                continue;
            }
            if code != ERROR_SUCCESS {
                return Err(format!("Restart Manager list: {code}"));
            }
            list.truncate(count as usize);
            return Ok(list
                .into_iter()
                .map(|info| info.Process.dwProcessId)
                .collect());
        }
    }
}

pub fn codex_owner(path: &Path) -> Result<Option<u32>, String> {
    let processes = processes()?;
    let owners: Vec<_> = file_owners(path)?
        .into_iter()
        .filter(|pid| {
            processes
                .get(pid)
                .is_some_and(|(_, name)| name.eq_ignore_ascii_case("codex.exe"))
        })
        .collect();
    Ok(if owners.len() == 1 {
        owners.first().copied()
    } else {
        None
    })
}

struct WindowQuery {
    pid: u32,
    window: HWND,
}
unsafe extern "system" fn enum_window(window: HWND, parameter: LPARAM) -> i32 {
    let query = &mut *(parameter as *mut WindowQuery);
    let mut pid = 0;
    GetWindowThreadProcessId(window, &mut pid);
    if pid == query.pid && IsWindowVisible(window) != 0 {
        query.window = window;
        return 0;
    }
    1
}
fn visible_window(pid: u32) -> Option<HWND> {
    let mut query = WindowQuery {
        pid,
        window: ptr::null_mut(),
    };
    unsafe {
        EnumWindows(Some(enum_window), &mut query as *mut WindowQuery as LPARAM);
    }
    if query.window.is_null() {
        None
    } else {
        Some(query.window)
    }
}

const TERMINALS: &[&str] = &[
    "windowsterminal.exe",
    "powershell.exe",
    "pwsh.exe",
    "cmd.exe",
    "mintty.exe",
    "wezterm-gui.exe",
    "alacritty.exe",
    "conemu64.exe",
];

pub fn workspace(agent_pid: u32) -> Result<Workspace, String> {
    let parent_chain = ancestors(agent_pid, &processes()?);
    let terminal = parent_chain.into_iter().find(|(pid, name)| {
        TERMINALS.contains(&name.to_ascii_lowercase().as_str()) && visible_window(*pid).is_some()
    });
    let (terminal_pid, terminal_type) = match terminal {
        Some((pid, name)) => (Some(pid), Some(name)),
        None => (None, None),
    };
    Ok(Workspace {
        agent_pid,
        terminal_pid,
        terminal_type,
    })
}

pub fn return_to_workspace(workspace: &Workspace) -> Result<(), String> {
    let pid = workspace
        .terminal_pid
        .ok_or("未绑定可靠的 Terminal 窗口；请从任务栏返回工作现场")?;
    let processes = processes()?;
    let (_, name) = processes.get(&pid).ok_or("已绑定的 Terminal 进程已退出")?;
    if Some(name) != workspace.terminal_type.as_ref() {
        return Err("Terminal 进程身份已变化；拒绝唤醒其他窗口".into());
    }
    let window = visible_window(pid).ok_or("Terminal 没有可唤醒的窗口")?;
    unsafe {
        ShowWindow(window, SW_RESTORE);
        if SetForegroundWindow(window) == 0 {
            return Err("Windows 拒绝切换前台窗口；请从任务栏返回".into());
        }
    }
    Ok(())
}

pub fn on_process_exit(pid: u32, callback: impl FnOnce() + Send + 'static) -> Result<(), String> {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return Err(format!(
            "observe process {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    // The owned handle is transferred to exactly one waiter and closed there.
    let owned_handle = handle as usize;
    std::thread::spawn(move || {
        unsafe {
            WaitForSingleObject(owned_handle as _, INFINITE);
            CloseHandle(owned_handle as _);
        }
        callback();
    });
    Ok(())
}

type AltCallback = Box<dyn Fn(bool) + Send + Sync>;
static ALT_CALLBACK: OnceLock<AltCallback> = OnceLock::new();
unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let key = (*(lparam as *const KBDLLHOOKSTRUCT)).vkCode;
        if [VK_MENU as u32, VK_LMENU as u32, VK_RMENU as u32].contains(&key) {
            let message = wparam as u32;
            if [WM_KEYDOWN, WM_SYSKEYDOWN, WM_KEYUP, WM_SYSKEYUP].contains(&message) {
                if let Some(callback) = ALT_CALLBACK.get() {
                    callback([WM_KEYDOWN, WM_SYSKEYDOWN].contains(&message));
                }
            }
        }
    }
    // Observe Alt only: never block, rewrite, store, or transmit keyboard input.
    CallNextHookEx(ptr::null_mut(), code, wparam, lparam)
}

pub fn start_alt_hook(callback: impl Fn(bool) + Send + Sync + 'static) -> Result<(), String> {
    ALT_CALLBACK
        .set(Box::new(callback))
        .map_err(|_| "Alt observer already started")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || unsafe {
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), ptr::null_mut(), 0);
        if hook.is_null() {
            let _ = tx.send(Err(format!(
                "Alt observer: {}",
                std::io::Error::last_os_error()
            )));
            return;
        }
        let _ = tx.send(Ok(()));
        let mut message: MSG = zeroed();
        while GetMessageW(&mut message, ptr::null_mut(), 0, 0) > 0 {}
        UnhookWindowsHookEx(hook);
    });
    rx.recv().map_err(|e| format!("Alt observer start: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ancestry_stops_at_missing_parent_and_cycle() {
        let p = HashMap::from([(1, (2, "codex.exe".into())), (2, (1, "cmd.exe".into()))]);
        assert_eq!(ancestors(1, &p).len(), 2);
        assert!(ancestors(3, &p).is_empty());
    }
    #[test]
    fn process_snapshot_contains_self() {
        assert!(processes().unwrap().contains_key(&std::process::id()));
    }
    #[test]
    fn historical_file_without_codex_owner_is_not_live() {
        let path =
            std::env::temp_dir().join(format!("hud-historical-{}.jsonl", std::process::id()));
        std::fs::write(&path, b"{}\n").unwrap();
        assert_eq!(codex_owner(&path).unwrap(), None);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn fixture_process() {
        use std::io::{Read, Write};
        let Some(path) = std::env::var_os("HUD_NATIVE_FIXTURE_FILE") else {
            return;
        };
        let _file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        println!("HUD_FIXTURE_READY");
        std::io::stdout().flush().unwrap();
        std::io::stdin().read_exact(&mut [0u8]).unwrap();
    }

    #[test]
    fn verifies_live_file_owner_and_process_exit() {
        use std::{
            io::{BufRead, BufReader, Write},
            process::{Command, Stdio},
            time::Duration,
        };
        let directory =
            std::env::temp_dir().join(format!("hud-native-fixture-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let executable = directory.join("codex.exe");
        let rollout = directory.join("fixture.jsonl");
        // Synthetic local process only; never invokes the real Agent or any model.
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        std::fs::write(&rollout, b"{}\n").unwrap();
        let mut child = Command::new(&executable)
            .args(["--exact", "native::tests::fixture_process", "--nocapture"])
            .env("HUD_NATIVE_FIXTURE_FILE", &rollout)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "fixture exited before readiness"
            );
            if line.contains("HUD_FIXTURE_READY") {
                break;
            }
        }
        let owner = codex_owner(&rollout);
        let (tx, rx) = std::sync::mpsc::channel();
        let observation = on_process_exit(child.id(), move || {
            tx.send(()).unwrap();
        });
        child.stdin.take().unwrap().write_all(b"x").unwrap();
        let exit = child.wait().unwrap();
        let notified = rx.recv_timeout(Duration::from_secs(5));
        std::fs::remove_file(&rollout).unwrap();
        std::fs::remove_file(&executable).unwrap();
        std::fs::remove_dir(&directory).unwrap();
        assert!(exit.success());
        assert_eq!(owner.unwrap(), Some(child.id()));
        observation.unwrap();
        notified.unwrap();
    }
}

#[cfg(test)]
mod window_style_tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{WS_EX_TOPMOST, WS_EX_TRANSPARENT};
    #[test]
    fn tool_window_preserves_ghost_and_topmost_without_app_window() {
        let style =
            hud_extended_style((WS_EX_APPWINDOW | WS_EX_TOPMOST | WS_EX_TRANSPARENT) as isize);
        assert_eq!(style & WS_EX_APPWINDOW as isize, 0);
        for required in [
            WS_EX_TOOLWINDOW,
            WS_EX_NOACTIVATE,
            WS_EX_TOPMOST,
            WS_EX_TRANSPARENT,
        ] {
            assert_ne!(style & required as isize, 0);
        }
    }
}
