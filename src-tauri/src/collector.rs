use crate::{
    app::{publish, Shared},
    codex::{self, Update},
    hooks::{self, HookEvent},
    model::{Activity, AttentionState, CollectorStatus, Session},
    native,
    tail::JsonlTail,
};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc,
};
use tauri::AppHandle;

const DEFAULT_STARTUP_SCAN_LIMIT: usize = 32;
const CREATE_NO_WINDOW: u32 = 0x08000000;

enum Signal {
    Files(notify::Result<Event>),
    Exit(u32),
}
struct Tracked {
    tail: JsonlTail,
    session: Option<Session>,
    owner: u32,
    ended: bool,
}

fn status(
    shared: &Shared,
    agent: &str,
    state: &str,
    message: impl Into<String>,
) -> Result<(), String> {
    shared.lock().map_err(|e| e.to_string())?.collectors.insert(
        agent.into(),
        CollectorStatus {
            agent: agent.into(),
            state: state.into(),
            message: message.into(),
        },
    );
    Ok(())
}

pub fn start(app: AppHandle, shared: Shared) {
    std::thread::spawn(move || {
        if let Err(error) = collect(&app, &shared) {
            if let Err(lock_error) = status(&shared, "codex", "error", error) {
                eprintln!("HUD registry: {lock_error}");
            }
            if let Err(error) = publish(&app, &shared) {
                eprintln!("HUD publish: {error}");
            }
        }
    });
}

fn codex_directory() -> Result<PathBuf, String> {
    let home = match std::env::var_os("CODEX_HOME") {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(
            std::env::var_os("USERPROFILE").ok_or("USERPROFILE unavailable; set CODEX_HOME")?,
        )
        .join(".codex"),
    };
    Ok(home.join("sessions"))
}

fn files(directory: &Path, extension: &str, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| format!("read collector directory: {e}"))? {
        let entry = entry.map_err(|e| format!("read collector entry: {e}"))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("stat collector entry: {e}"))?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files(&entry.path(), extension, out)?;
        } else if entry.path().extension().is_some_and(|ext| ext == extension) {
            out.push(entry.path());
        }
    }
    Ok(())
}

fn collect(app: &AppHandle, shared: &Shared) -> Result<(), String> {
    let directory = codex_directory()?;
    let events = hooks::event_dir()?;
    fs::create_dir_all(&events).map_err(|e| format!("create HUD events: {e}"))?;
    let (tx, rx) = mpsc::channel();
    let event_tx = tx.clone();
    let mut watcher = notify::recommended_watcher(move |event| {
        // Receiver closes only when the collector shuts down.
        let _ = event_tx.send(Signal::Files(event));
    })
    .map_err(|e| format!("create file observer: {e}"))?;
    watcher
        .watch(&events, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch HUD events: {e}"))?;
    status(
        shared,
        "claude",
        "watching",
        "Hook 入口就绪；需按 README 显式配置 Claude Hooks",
    )?;
    let watch_root = if directory.is_dir() {
        Some(directory.clone())
    } else {
        directory
            .parent()
            .filter(|parent| parent.is_dir())
            .map(Path::to_path_buf)
    };
    if let Some(root) = watch_root {
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("watch Codex sessions: {e}"))?;
        status(
            shared,
            "codex",
            "watching",
            "文件事件采集已就绪；仅显示已验证的活跃进程",
        )?;
    } else {
        status(
            shared,
            "codex",
            "unavailable",
            "未找到 Codex 数据目录；首次运行 Codex 后重启 HUD",
        )?;
    }
    let mut tracked = BTreeMap::new();
    let mut observed = HashSet::new();
    if directory.is_dir()
        && native::processes()?
            .values()
            .any(|(_, name)| name.eq_ignore_ascii_case("codex.exe"))
    {
        let limit = match std::env::var("HUD_STARTUP_SCAN_LIMIT") {
            Ok(value) => value
                .parse::<usize>()
                .map_err(|e| format!("HUD_STARTUP_SCAN_LIMIT: {e}"))?,
            Err(std::env::VarError::NotPresent) => DEFAULT_STARTUP_SCAN_LIMIT,
            Err(error) => return Err(format!("HUD_STARTUP_SCAN_LIMIT: {error}")),
        };
        let mut candidates = Vec::new();
        files(&directory, "jsonl", &mut candidates)?;
        let mut dated = candidates
            .into_iter()
            .map(|path| {
                let time = fs::metadata(&path)
                    .and_then(|meta| meta.modified())
                    .map_err(|e| format!("stat rollout candidate: {e}"))?;
                Ok((time, path))
            })
            .collect::<Result<Vec<_>, String>>()?;
        dated.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
        for (_, path) in dated.into_iter().take(limit) {
            if let Err(error) = rollout(&path, shared, &tx, &mut tracked, &mut observed) {
                status(shared, "codex", "error", error)?;
            }
        }
    }
    let mut pending = Vec::new();
    files(&events, "json", &mut pending)?;
    pending.sort();
    for path in pending {
        hook(&path, shared, &tx, &mut observed)?;
    }
    publish(app, shared)?;
    for signal in rx {
        match signal {
            Signal::Exit(pid) => {
                observed.remove(&pid);
                tracked.retain(|_, entry| entry.owner != pid);
                shared
                    .lock()
                    .map_err(|e| e.to_string())?
                    .sessions
                    .retain(|_, session| {
                        session
                            .workspace
                            .as_ref()
                            .is_none_or(|workspace| workspace.agent_pid != pid)
                    });
            }
            Signal::Files(Err(error)) => {
                status(shared, "codex", "error", format!("file observer: {error}"))?;
            }
            Signal::Files(Ok(event)) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                for path in event.paths {
                    if path.starts_with(&events)
                        && path.extension().is_some_and(|ext| ext == "json")
                        && path.is_file()
                    {
                        if let Err(error) = hook(&path, shared, &tx, &mut observed) {
                            status(shared, "claude", "error", error)?;
                        }
                    } else if path.starts_with(&directory)
                        && path.extension().is_some_and(|ext| ext == "jsonl")
                    {
                        if path.is_file() {
                            if let Err(error) =
                                rollout(&path, shared, &tx, &mut tracked, &mut observed)
                            {
                                status(shared, "codex", "error", error)?;
                            }
                        } else if let Some(entry) = tracked.remove(&path) {
                            if let Some(session) = entry.session {
                                shared
                                    .lock()
                                    .map_err(|e| e.to_string())?
                                    .sessions
                                    .remove(&session.id);
                            }
                        }
                    }
                }
            }
        }
        publish(app, shared)?;
    }
    Ok(())
}

fn observe(pid: u32, tx: &mpsc::Sender<Signal>, observed: &mut HashSet<u32>) -> Result<(), String> {
    if !observed.contains(&pid) {
        let tx = tx.clone();
        native::on_process_exit(pid, move || {
            let _ = tx.send(Signal::Exit(pid));
        })?;
        observed.insert(pid);
    }
    Ok(())
}

fn rollout(
    path: &Path,
    shared: &Shared,
    tx: &mpsc::Sender<Signal>,
    tracked: &mut BTreeMap<PathBuf, Tracked>,
    observed: &mut HashSet<u32>,
) -> Result<(), String> {
    if !tracked.contains_key(path) {
        let Some(owner) = native::codex_owner(path)? else {
            return Ok(());
        };
        observe(owner, tx, observed)?;
        tracked.insert(
            path.to_owned(),
            Tracked {
                tail: JsonlTail::default(),
                session: None,
                owner,
                ended: false,
            },
        );
    }
    let entry = tracked
        .get_mut(path)
        .ok_or("rollout registration missing")?;
    if entry.ended {
        return Ok(());
    }
    if fs::metadata(path)
        .map_err(|e| format!("stat rollout: {e}"))?
        .len()
        < entry.tail.offset
    {
        if let Some(session) = &entry.session {
            shared
                .lock()
                .map_err(|e| e.to_string())?
                .sessions
                .remove(&session.id);
        }
        entry.session = None;
    }
    let show_detail = shared.lock().map_err(|e| e.to_string())?.show_detail;
    let previous = entry.session.clone();
    entry.tail.read(path, |line| {
        if codex::apply(&mut entry.session, line, show_detail)? == Update::Ended {
            entry.ended = true;
        }
        Ok(())
    })?;
    if entry.ended {
        if let Some(s) = &entry.session {
            shared
                .lock()
                .map_err(|e| e.to_string())?
                .sessions
                .remove(&s.id);
        }
    } else if let Some(session) = entry.session.as_mut() {
        if previous == Some(session.clone()) {
            return Ok(());
        }
        if session.workspace.is_none() {
            session.workspace = Some(native::workspace(entry.owner)?);
        }
        let refresh_git = previous.is_none()
            || session.attention.state == AttentionState::Done
            || (previous
                .as_ref()
                .is_some_and(|s| s.runtime.state == Activity::ToolRunning)
                && session.runtime.state != Activity::ToolRunning);
        if refresh_git {
            git_project(session)?;
        }
        shared
            .lock()
            .map_err(|e| e.to_string())?
            .sessions
            .insert(session.id.clone(), session.clone());
        // Commands live only in the privacy-controlled registry, not tail history.
        session.runtime.detail = None;
    }
    Ok(())
}

fn hook(
    path: &Path,
    shared: &Shared,
    tx: &mpsc::Sender<Signal>,
    observed: &mut HashSet<u32>,
) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("stat hook event: {e}"))?;
    if metadata.len() > hooks::MAX_HOOK_BYTES {
        return Err("hook event exceeds size limit".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("read hook metadata: {e}"))?;
    let event: HookEvent =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid sanitized hook event: {e}"))?;
    fs::remove_file(path).map_err(|e| format!("consume hook event: {e}"))?;
    let processes = native::processes()?;
    if !processes
        .get(&event.agent_pid)
        .is_some_and(|(_, name)| name.eq_ignore_ascii_case("claude.exe"))
    {
        return Ok(());
    }
    observe(event.agent_pid, tx, observed)?;
    let id = format!("windows:claude:{}", event.session_id);
    let previous = shared
        .lock()
        .map_err(|e| e.to_string())?
        .sessions
        .get(&id)
        .cloned();
    let mut session = match previous {
        Some(session) => session,
        None => Session::new("claude", &event.session_id, &event.cwd, event.timestamp),
    };
    if event.apply(&mut session) {
        shared
            .lock()
            .map_err(|e| e.to_string())?
            .sessions
            .remove(&id);
    } else {
        session.workspace = Some(native::workspace(event.agent_pid)?);
        if matches!(
            event.kind,
            hooks::HookKind::SessionStart | hooks::HookKind::PostToolUse | hooks::HookKind::Stop
        ) {
            git_project(&mut session)?;
        }
        shared
            .lock()
            .map_err(|e| e.to_string())?
            .sessions
            .insert(id, session);
    }
    Ok(())
}

fn git_project(session: &mut Session) -> Result<(), String> {
    let output = Command::new("git")
        .creation_flags(CREATE_NO_WINDOW)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args([
            "-C",
            &session.project.cwd,
            "rev-parse",
            "--show-toplevel",
            "--abbrev-ref",
            "HEAD",
        ])
        .output()
        .map_err(|e| format!("Git observer: {e}"))?;
    if !output.status.success() {
        session.project.root = None;
        session.project.branch = None;
        return Ok(());
    }
    let text = String::from_utf8(output.stdout).map_err(|e| format!("Git observer UTF-8: {e}"))?;
    let mut lines = text.lines();
    session.project.root = lines.next().map(str::to_owned);
    session.project.branch = lines.next().map(str::to_owned);
    Ok(())
}
