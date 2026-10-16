use crate::{
    app::{publish, Shared},
    claude::Telemetry,
    codex::{self, Update},
    codex_live::{self, LiveState, Observer},
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
    time::{Duration, Instant},
};
use tauri::AppHandle;

const DEFAULT_STARTUP_SCAN_LIMIT: usize = 32;
const CREATE_NO_WINDOW: u32 = 0x08000000;

enum Signal {
    Files(notify::Result<Event>),
    Exit(u32),
    CodexLive(codex_live::Event),
}
struct Tracked {
    tail: JsonlTail,
    session: Option<Session>,
    owner: u32,
    ended: bool,
}

#[derive(Default)]
struct CodexObserver {
    live: LiveState,
    observer: Option<Observer>,
    last_attempt: Option<Instant>,
}

impl CodexObserver {
    fn connect(
        &mut self,
        shared: &Shared,
        tx: &mpsc::Sender<Signal>,
        tracked: &BTreeMap<PathBuf, Tracked>,
    ) -> Result<(), String> {
        // File events trigger retries; no periodic polling or timeout-based status inference.
        const RETRY_INTERVAL: Duration = Duration::from_secs(5);
        if self.observer.is_some()
            || self
                .last_attempt
                .is_some_and(|at| at.elapsed() < RETRY_INTERVAL)
        {
            return Ok(());
        }
        self.last_attempt = Some(Instant::now());
        let processes = native::processes()?;
        let candidates = tracked.values().map(|entry| entry.owner).chain(
            processes
                .iter()
                .filter(|(_, (_, name))| name.eq_ignore_ascii_case("codex.exe"))
                .map(|(pid, _)| *pid),
        );
        let mut seen = HashSet::new();
        for pid in candidates {
            if !seen.insert(pid) {
                continue;
            }
            let Ok(executable) = native::process_image(pid) else {
                continue;
            };
            let tx = tx.clone();
            self.observer = Some(Observer::start(&executable, move |event| {
                let _ = tx.send(Signal::CodexLive(event));
            })?);
            status(
                shared,
                "codex-live",
                "connecting",
                "正在连接已有 Codex daemon；不会启动服务或 Agent",
            )?;
            return Ok(());
        }
        status(
            shared,
            "codex-live",
            "unavailable",
            "未发现原生 Codex 进程；仅 rollout，无法确认实时审批",
        )
    }
}

fn sync_codex(
    shared: &Shared,
    tracked: &BTreeMap<PathBuf, Tracked>,
    live: &LiveState,
) -> Result<(), String> {
    let mut registry = shared.lock().map_err(|e| e.to_string())?;
    registry
        .sessions
        .retain(|_, session| session.agent.r#type != "codex");
    for session in live.sessions() {
        registry
            .sessions
            .insert(session.id.clone(), live.decorate(session));
    }
    for entry in tracked.values().filter(|entry| !entry.ended) {
        if let Some(session) = &entry.session {
            registry
                .sessions
                .insert(session.id.clone(), live.decorate(session));
        }
    }
    Ok(())
}

#[derive(Default)]
struct ClaudeTracked {
    owner: u32,
    path: Option<PathBuf>,
    tail: JsonlTail,
    telemetry: Telemetry,
    model_updated_at: Option<i64>,
    context_after: Option<i64>,
}

#[derive(Default)]
struct ClaudeState {
    tracked: BTreeMap<String, ClaudeTracked>,
    ended: BTreeMap<String, i64>,
    watched: HashSet<PathBuf>,
}

impl ClaudeState {
    fn accepts(&self, event: &HookEvent, previous: Option<&Session>) -> bool {
        let id = format!("windows:claude:{}", event.session_id);
        if let Some(ended) = self.ended.get(&id) {
            if event.kind != hooks::HookKind::SessionStart || event.timestamp <= *ended {
                return false;
            }
        }
        if let Some(previous) = previous {
            if event.kind == hooks::HookKind::SessionStart
                && event.timestamp < previous.runtime.updated_at
            {
                return false;
            }
            if previous
                .workspace
                .as_ref()
                .is_some_and(|workspace| workspace.agent_pid != event.agent_pid)
                && event.kind != hooks::HookKind::SessionStart
            {
                return false;
            }
        }
        true
    }

    fn close(&mut self, id: &str, timestamp: i64) {
        self.tracked.remove(id);
        self.ended.insert(id.into(), timestamp);
    }

    fn prune_watches(&mut self, watcher: &mut impl Watcher) -> Result<(), String> {
        let unused: Vec<_> = self
            .watched
            .iter()
            .filter(|directory| {
                !self.tracked.values().any(|entry| {
                    entry.path.as_ref().and_then(|path| path.parent()) == Some(directory.as_path())
                })
            })
            .cloned()
            .collect();
        for directory in unused {
            watcher
                .unwatch(&directory)
                .map_err(|_| "unwatch Claude transcript directory")?;
            self.watched.remove(&directory);
        }
        Ok(())
    }
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
        "waiting",
        "等待首个已验证 HUD Hook 事件；尚不能确认接入。请检查 Hook 配置并启动新 Claude 会话",
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
    let mut claude = ClaudeState::default();
    let mut codex_observer = CodexObserver::default();
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
            if let Err(error) = rollout(
                &path,
                shared,
                &tx,
                &mut tracked,
                &mut observed,
                &codex_observer.live,
            ) {
                status(shared, "codex", "error", error)?;
            }
        }
    }
    let mut pending = Vec::new();
    files(&events, "json", &mut pending)?;
    pending.sort();
    let mut pending_events = Vec::new();
    for path in pending {
        match read_hook(&path) {
            Ok(event) => pending_events.push(event),
            Err(error) => status(shared, "claude", "error", error)?,
        }
    }
    pending_events.sort_by_key(|event| event.timestamp);
    for event in pending_events {
        if let Err(error) = hook(
            event,
            shared,
            &tx,
            &mut observed,
            &mut claude,
            &mut watcher,
            false,
        ) {
            status(shared, "claude", "error", error)?;
        }
    }
    if let Err(error) = codex_observer.connect(shared, &tx, &tracked) {
        status(shared, "codex-live", "unavailable", error)?;
    }
    publish(app, shared)?;
    for signal in rx {
        match signal {
            Signal::CodexLive(event) => {
                match &event {
                    codex_live::Event::Ready => status(
                        shared,
                        "codex-live",
                        "watching",
                        "已连接 Codex 只读全局状态；仅覆盖同一共享 daemon，不订阅工具/审批请求",
                    )?,
                    codex_live::Event::Disconnected(error) => {
                        codex_observer.observer = None;
                        status(shared, "codex-live", "unavailable", error.clone())?;
                    }
                    _ => {}
                }
                codex_observer.live.apply(event);
                sync_codex(shared, &tracked, &codex_observer.live)?;
            }
            Signal::Exit(pid) => {
                observed.remove(&pid);
                tracked.retain(|_, entry| entry.owner != pid);
                let ended: Vec<_> = claude
                    .tracked
                    .iter()
                    .filter(|(_, entry)| entry.owner == pid)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ended {
                    claude.close(&id, chrono::Utc::now().timestamp_millis());
                }
                claude.prune_watches(&mut watcher)?;
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
                sync_codex(shared, &tracked, &codex_observer.live)?;
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
                        let result = read_hook(&path).and_then(|event| {
                            hook(
                                event,
                                shared,
                                &tx,
                                &mut observed,
                                &mut claude,
                                &mut watcher,
                                true,
                            )
                        });
                        if let Err(error) = result {
                            status(shared, "claude", "error", error)?;
                        }
                    } else if claude
                        .tracked
                        .values()
                        .any(|entry| entry.path.as_ref() == Some(&path))
                    {
                        let ids: Vec<_> = claude
                            .tracked
                            .iter()
                            .filter(|(_, entry)| entry.path.as_ref() == Some(&path))
                            .map(|(id, _)| id.clone())
                            .collect();
                        for id in ids {
                            if let Err(error) = transcript(&id, shared, &mut claude) {
                                status(shared, "claude", "error", error)?;
                            }
                        }
                    } else if path.starts_with(&directory)
                        && path.extension().is_some_and(|ext| ext == "jsonl")
                    {
                        if path.is_file() {
                            if let Err(error) = rollout(
                                &path,
                                shared,
                                &tx,
                                &mut tracked,
                                &mut observed,
                                &codex_observer.live,
                            ) {
                                status(shared, "codex", "error", error)?;
                            }
                            if tracked.contains_key(&path) {
                                if let Err(error) = codex_observer.connect(shared, &tx, &tracked) {
                                    status(shared, "codex-live", "unavailable", error)?;
                                }
                            }
                        } else if let Some(entry) = tracked.remove(&path) {
                            if let Some(session) = entry.session {
                                shared
                                    .lock()
                                    .map_err(|e| e.to_string())?
                                    .sessions
                                    .remove(&session.id);
                            }
                            sync_codex(shared, &tracked, &codex_observer.live)?;
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
    live: &LiveState,
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
    if entry.tail.reset_if_changed(path)? {
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
        // The first read reconstructs state; do not present historical calls as new activity.
        if previous.is_none() {
            session.recent_tools.clear();
        }
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
            .insert(session.id.clone(), live.decorate(session));
        // Commands live only in the privacy-controlled registry, not tail history.
        session.runtime.detail = None;
    }
    Ok(())
}

fn read_hook(path: &Path) -> Result<HookEvent, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("stat hook event: {e}"))?;
    if metadata.len() > hooks::MAX_HOOK_BYTES {
        return Err("hook event exceeds size limit".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("read hook metadata: {e}"))?;
    let event = serde_json::from_slice(&bytes)
        .map_err(|_| "invalid sanitized hook metadata; no content logged")?;
    fs::remove_file(path).map_err(|e| format!("consume hook event: {e}"))?;
    Ok(event)
}

fn hook(
    event: HookEvent,
    shared: &Shared,
    tx: &mpsc::Sender<Signal>,
    observed: &mut HashSet<u32>,
    claude: &mut ClaudeState,
    watcher: &mut impl Watcher,
    live: bool,
) -> Result<(), String> {
    if let Some(expected) = event.agent_started_at {
        if native::process_started_at(event.agent_pid)? != expected {
            return Err("Claude Hook agent PID has been reused; event rejected".into());
        }
    }
    let processes = native::processes()?;
    if !processes
        .get(&event.agent_pid)
        .is_some_and(|(_, name)| name.eq_ignore_ascii_case("claude.exe"))
    {
        status(
            shared,
            "claude",
            "unavailable",
            "Hook 进程已结束或不是受支持的原生 claude.exe；请启动新会话",
        )?;
        return Ok(());
    }
    let id = format!("windows:claude:{}", event.session_id);
    let previous = shared
        .lock()
        .map_err(|e| e.to_string())?
        .sessions
        .get(&id)
        .cloned();
    if !claude.accepts(&event, previous.as_ref()) {
        return Ok(());
    }
    status(
        shared,
        "claude",
        "watching",
        "已验证 Claude Hook；Transcript 仅补充遥测，不推断运行状态",
    )?;
    observe(event.agent_pid, tx, observed)?;
    let new_owner = previous
        .as_ref()
        .and_then(|session| session.workspace.as_ref())
        .is_some_and(|workspace| workspace.agent_pid != event.agent_pid);
    let mut session = match previous {
        Some(session) if !new_owner => session,
        _ => Session::new("claude", &event.session_id, &event.cwd, event.timestamp),
    };
    if event.apply(&mut session) {
        shared
            .lock()
            .map_err(|e| e.to_string())?
            .sessions
            .remove(&id);
        claude.close(&id, event.timestamp);
        claude.prune_watches(watcher)?;
        return Ok(());
    }
    if !live {
        session.recent_tools.clear();
    }
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
        .insert(id.clone(), session);
    if new_owner {
        claude.tracked.remove(&id);
    }
    claude.ended.remove(&id);
    let entry = claude.tracked.entry(id.clone()).or_default();
    entry.owner = event.agent_pid;
    if event.model.is_some() {
        entry.model_updated_at = Some(match entry.model_updated_at {
            Some(previous) => previous.max(event.timestamp),
            None => event.timestamp,
        });
    }
    if matches!(
        event.kind,
        hooks::HookKind::PreCompact | hooks::HookKind::PostCompact
    ) {
        entry.context_after = Some(event.timestamp);
        entry.telemetry.invalidate_context(event.timestamp);
    }
    if let Some(path) = &event.transcript_path {
        let path = PathBuf::from(path);
        if !path.is_absolute()
            || path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
        {
            return Err("Claude transcript binding requires an absolute JSONL path".into());
        }
        if entry.path.as_ref() != Some(&path) {
            let directory = path
                .parent()
                .ok_or("Claude transcript has no parent directory")?;
            if !claude.watched.contains(directory) {
                watcher
                    .watch(directory, RecursiveMode::NonRecursive)
                    .map_err(|_| "watch Claude transcript directory")?;
                claude.watched.insert(directory.to_owned());
            }
            entry.path = Some(path);
            entry.tail = JsonlTail::default();
            entry.telemetry = Telemetry::default();
            if let Some(timestamp) = entry.context_after {
                entry.telemetry.invalidate_context(timestamp);
            }
        }
    }
    claude.prune_watches(watcher)?;
    transcript(&id, shared, claude)
}

fn transcript(id: &str, shared: &Shared, claude: &mut ClaudeState) -> Result<(), String> {
    let Some(entry) = claude.tracked.get_mut(id) else {
        return Ok(());
    };
    let Some(path) = &entry.path else {
        return Ok(());
    };
    let mut session = match shared
        .lock()
        .map_err(|e| e.to_string())?
        .sessions
        .get(id)
        .cloned()
    {
        Some(session) => session,
        None => return Ok(()),
    };
    if !path.is_file() {
        entry.tail = JsonlTail::default();
        entry.telemetry = Telemetry::default();
        session.tokens = None;
        session.context = None;
    } else {
        if fs::symlink_metadata(path)
            .map_err(|_| "stat Claude transcript")?
            .file_type()
            .is_symlink()
        {
            return Err("Claude transcript symlinks are not supported".into());
        }
        if entry.tail.reset_if_changed(path)? {
            entry.telemetry = Telemetry::default();
        }
        if let Some(timestamp) = entry.context_after {
            entry.telemetry.invalidate_context(timestamp);
        }
        let native_id = id
            .strip_prefix("windows:claude:")
            .ok_or("invalid Claude session binding")?;
        entry
            .tail
            .read(path, |line| entry.telemetry.consume(native_id, line))?;
        entry
            .telemetry
            .apply(&mut session, entry.model_updated_at)?;
    }
    // Update only a still-live session. File changes never register sessions.
    let mut registry = shared.lock().map_err(|e| e.to_string())?;
    if let Some(current) = registry.sessions.get_mut(id) {
        current.model = session.model;
        current.tokens = session.tokens;
        current.context = session.context;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::HudState;
    use std::sync::{Arc, Mutex};

    fn event(kind: &str, timestamp: i64) -> HookEvent {
        let input =
            serde_json::json!({"hook_event_name":kind,"session_id":"fixture","cwd":"C:/fixture"});
        let mut event = HookEvent::from_input(&serde_json::to_vec(&input).unwrap(), 1).unwrap();
        event.timestamp = timestamp;
        event
    }
    #[test]
    fn only_a_new_explicit_start_can_reopen_an_ended_session() {
        let mut state = ClaudeState::default();
        state.close("windows:claude:fixture", 10);
        assert!(!state.accepts(&event("PostToolUse", 11), None));
        assert!(!state.accepts(&event("SessionStart", 9), None));
        assert!(state.accepts(&event("SessionStart", 12), None));
        let mut session = Session::new("claude", "fixture", "C:/fixture", 20);
        session.workspace = Some(native::workspace(std::process::id()).unwrap());
        assert!(!ClaudeState::default().accepts(&event("PostToolUse", 21), Some(&session)));
        assert!(!ClaudeState::default().accepts(&event("SessionStart", 19), Some(&session)));
    }
    #[test]
    fn transcript_events_update_live_telemetry_but_cannot_register_or_reanimate_sessions() {
        let path =
            std::env::temp_dir().join(format!("hud-claude-collector-{}.jsonl", std::process::id()));
        let record = br#"{"type":"assistant","sessionId":"fixture","timestamp":"2026-10-15T01:00:00Z","message":{"id":"request","model":"fixture-model","usage":{"input_tokens":10,"output_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":20},"content":"PRIVATE BODY"}}\n"#;
        fs::write(&path, record.strip_suffix(br#"\n"#).unwrap()).unwrap();
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        let id = "windows:claude:fixture";
        let shared: Shared = Arc::new(Mutex::new(HudState::default()));
        let mut state = ClaudeState::default();
        state.tracked.insert(
            id.into(),
            ClaudeTracked {
                path: Some(path.clone()),
                owner: 1,
                ..Default::default()
            },
        );
        transcript(id, &shared, &mut state).unwrap();
        assert!(shared.lock().unwrap().sessions.is_empty());
        let mut session = Session::new("claude", "fixture", "C:/fixture", 0);
        session.attention(AttentionState::WaitingUser, "fixture", 100);
        shared
            .lock()
            .unwrap()
            .sessions
            .insert(id.into(), session.clone());
        transcript(id, &shared, &mut state).unwrap();
        let observed = shared.lock().unwrap().sessions[id].clone();
        assert_eq!(observed.attention, session.attention);
        assert_eq!(observed.runtime, session.runtime);
        assert_eq!(observed.context.unwrap().used, 30);
        assert_eq!(observed.tokens.unwrap().input, Some(10));
        shared.lock().unwrap().sessions.remove(id);
        transcript(id, &shared, &mut state).unwrap();
        assert!(shared.lock().unwrap().sessions.is_empty());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn codex_live_overlay_preserves_verified_workspace_and_disconnect_restores_rollout() {
        let shared: Shared = Arc::new(Mutex::new(HudState::default()));
        let mut base = Session::new("codex", "bound", "C:/fixture", 1);
        base.workspace = Some(native::workspace(std::process::id()).unwrap());
        let tracked = BTreeMap::from([(
            PathBuf::from("fixture.jsonl"),
            Tracked {
                tail: JsonlTail::default(),
                session: Some(base.clone()),
                owner: std::process::id(),
                ended: false,
            },
        )]);
        let mut live = LiveState::default();
        for id in ["bound", "daemon-only"] {
            live.apply(codex_live::Event::Thread {
                session: Box::new(Session::new("codex", id, "C:/fixture", 1)),
                status: codex_live::ThreadStatus::Active {
                    active_flags: vec![codex_live::ActiveFlag::WaitingOnApproval],
                },
                at: 20,
            });
        }
        sync_codex(&shared, &tracked, &live).unwrap();
        {
            let registry = shared.lock().unwrap();
            assert_eq!(registry.sessions[&base.id].workspace, base.workspace);
            assert_eq!(
                registry.sessions[&base.id].attention.state,
                AttentionState::WaitingUser
            );
            assert!(registry.sessions["windows:codex:daemon-only"]
                .workspace
                .is_none());
        }
        live.apply(codex_live::Event::Disconnected("fixture".into()));
        sync_codex(&shared, &tracked, &live).unwrap();
        let registry = shared.lock().unwrap();
        assert_eq!(registry.sessions.len(), 1);
        assert_eq!(registry.sessions[&base.id], base);
    }
}
