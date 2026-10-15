//! Read-only observer for the existing Codex shared daemon (protocol 0.162.1).
//! No thread subscription, turn mutation, approval response, or daemon bootstrap.
use crate::model::{Activity, AttentionState, Session};
use serde::{de::IgnoredAny, Deserialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, BufReader, Read, Write},
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread::JoinHandle,
};
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

const MAX_FRAME_BYTES: u64 = 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadStatus {
    NotLoaded,
    Idle,
    SystemError,
    #[serde(rename_all = "camelCase")]
    Active {
        active_flags: Vec<ActiveFlag>,
    },
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ActiveFlag {
    WaitingOnApproval,
    WaitingOnUserInput,
}

// Unknown fields (including preview, turns, and item bodies) are discarded by serde.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    id: String,
    cwd: String,
    created_at: i64,
    updated_at: i64,
    status: ThreadStatus,
}
impl Metadata {
    fn session(&self) -> Result<Session, String> {
        if self.id.is_empty() || !Path::new(&self.cwd).is_absolute() {
            return Err("invalid Codex thread metadata; content omitted".into());
        }
        let created = self
            .created_at
            .checked_mul(1000)
            .ok_or("invalid Codex timestamp")?;
        let updated = self
            .updated_at
            .checked_mul(1000)
            .ok_or("invalid Codex timestamp")?;
        let mut session = Session::new("codex", &self.id, &self.cwd, created);
        session.runtime.updated_at = updated;
        Ok(session)
    }
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    thread: Option<Metadata>,
    thread_id: Option<String>,
    status: Option<ThreadStatus>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    data: Option<Vec<String>>,
    next_cursor: Option<String>,
    thread: Option<Metadata>,
}
#[derive(Deserialize)]
struct Envelope {
    id: Option<u64>,
    method: Option<String>,
    params: Option<Params>,
    result: Option<Response>,
    error: Option<IgnoredAny>,
}

enum Pending {
    Initialize,
    List,
    Metadata { id: String, revision: u64 },
}
#[derive(Default)]
struct Known {
    metadata: Option<Metadata>,
    status: Option<(ThreadStatus, i64)>,
    revision: u64,
    closed: bool,
}
#[derive(Default)]
struct Protocol {
    next_id: u64,
    pending: BTreeMap<u64, Pending>,
    threads: BTreeMap<String, Known>,
    cursors: BTreeSet<String>,
}
#[derive(Clone)]
pub enum Event {
    Ready,
    Thread {
        session: Box<Session>,
        status: ThreadStatus,
        at: i64,
    },
    Closed(String),
    Disconnected(String),
}
impl Protocol {
    fn request(&mut self, pending: Pending, method: &str, params: Value) -> Value {
        self.next_id += 1;
        self.pending.insert(self.next_id, pending);
        json!({"id":self.next_id,"method":method,"params":params})
    }
    fn initialize(&mut self) -> Value {
        self.request(
            Pending::Initialize,
            "initialize",
            json!({
                "clientInfo":{"name":"coding-agent-hud","version":env!("CARGO_PKG_VERSION")}
            }),
        )
    }
    fn read(&mut self, id: &str, requests: &mut Vec<Value>) {
        let known = self.threads.entry(id.into()).or_default();
        if known.closed
            || self
                .pending
                .values()
                .any(|pending| matches!(pending, Pending::Metadata {id: other, ..} if other == id))
        {
            return;
        }
        let revision = known.revision;
        requests.push(self.request(
            Pending::Metadata {
                id: id.into(),
                revision,
            },
            "thread/read",
            json!({"threadId":id,"includeTurns":false}),
        ));
    }
    fn emit(&self, id: &str, events: &mut Vec<Event>) -> Result<(), String> {
        let known = &self.threads[id];
        if !known.closed {
            if let (Some(metadata), Some((status, at))) = (&known.metadata, &known.status) {
                events.push(Event::Thread {
                    session: Box::new(metadata.session()?),
                    status: status.clone(),
                    at: *at,
                });
            }
        }
        Ok(())
    }
    fn receive(&mut self, bytes: &[u8], at: i64) -> Result<(Vec<Value>, Vec<Event>), String> {
        let frame: Envelope = serde_json::from_slice(bytes)
            .map_err(|_| "invalid Codex observer frame; content omitted")?;
        let mut requests = Vec::new();
        let mut events = Vec::new();
        if let Some(method) = frame.method {
            if frame.id.is_some() {
                return Err(
                    "Codex observer received a server request; disconnected without responding"
                        .into(),
                );
            }
            let params = frame.params.unwrap_or_default();
            match method.as_str() {
                "thread/started" => {
                    let metadata = params.thread.ok_or("missing Codex thread metadata")?;
                    let id = metadata.id.clone();
                    let known = self.threads.entry(id.clone()).or_default();
                    known.revision += 1;
                    known.closed = false;
                    known.status = Some((metadata.status.clone(), at));
                    known.metadata = Some(metadata);
                    self.emit(&id, &mut events)?;
                }
                "thread/status/changed" => {
                    let id = params.thread_id.ok_or("missing Codex thread id")?;
                    let status = params.status.ok_or("missing Codex thread status")?;
                    let known = self.threads.entry(id.clone()).or_default();
                    known.revision += 1;
                    if status == ThreadStatus::NotLoaded {
                        known.closed = true;
                        events.push(Event::Closed(format!("windows:codex:{id}")));
                    } else {
                        known.closed = false;
                        known.status = Some((status, at));
                        if known.metadata.is_none() {
                            self.read(&id, &mut requests);
                        }
                        self.emit(&id, &mut events)?;
                    }
                }
                "thread/closed" => {
                    let id = params.thread_id.ok_or("missing Codex thread id")?;
                    let known = self.threads.entry(id.clone()).or_default();
                    known.revision += 1;
                    known.closed = true;
                    events.push(Event::Closed(format!("windows:codex:{id}")));
                }
                _ => {}
            }
        } else if let Some(id) = frame.id {
            let pending = self
                .pending
                .remove(&id)
                .ok_or("unexpected Codex response id")?;
            if frame.error.is_some() {
                if let Pending::Metadata { id, revision } = pending {
                    // A newer loaded notification may have arrived while this failed read was pending.
                    if self.threads.get(&id).is_some_and(|known| {
                        !known.closed && known.metadata.is_none() && known.revision != revision
                    }) {
                        self.read(&id, &mut requests);
                    }
                    return Ok((requests, events));
                }
                return Err("Codex observer handshake/list rejected; content omitted".into());
            }
            let response = frame.result.ok_or("missing Codex response")?;
            match pending {
                Pending::Initialize => {
                    requests.push(json!({"method":"initialized","params":{}}));
                    requests.push(self.request(Pending::List, "thread/loaded/list", json!({})));
                    events.push(Event::Ready);
                }
                Pending::List => {
                    for id in response.data.ok_or("missing Codex loaded threads")? {
                        self.read(&id, &mut requests);
                    }
                    if let Some(cursor) = response.next_cursor {
                        if !self.cursors.insert(cursor.clone()) {
                            return Err("Codex loaded-list cursor repeated".into());
                        }
                        requests.push(self.request(
                            Pending::List,
                            "thread/loaded/list",
                            json!({"cursor":cursor}),
                        ));
                    }
                }
                Pending::Metadata { id, revision } => {
                    let metadata = response.thread.ok_or("missing Codex thread metadata")?;
                    if metadata.id != id {
                        return Err("Codex metadata identity mismatch".into());
                    }
                    let known = self
                        .threads
                        .get_mut(&id)
                        .ok_or("missing Codex pending thread")?;
                    if !known.closed && known.metadata.is_none() {
                        if known.status.is_none() && known.revision == revision {
                            known.status = Some((metadata.status.clone(), at));
                        }
                        known.metadata = Some(metadata);
                        self.emit(&id, &mut events)?;
                    }
                }
            }
        } else {
            return Err("invalid Codex observer envelope; content omitted".into());
        }
        Ok((requests, events))
    }
}

struct Job(usize);
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0 as _);
        }
    }
}
impl Job {
    fn attach(child: &Child) -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("create Codex observer job failed".into());
            }
            let job = Self(handle as usize);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
            {
                return Err("bind Codex observer job failed".into());
            }
            Ok(job)
        }
    }
}

pub struct Observer {
    child: Arc<Mutex<Child>>,
    reader: Option<JoinHandle<()>>,
    _job: Job,
}
impl Drop for Observer {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
fn send(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value).map_err(|_| "write Codex observer request")?;
    writer
        .write_all(b"\n")
        .map_err(|_| "write Codex observer delimiter")?;
    writer
        .flush()
        .map_err(|_| "flush Codex observer request".into())
}
fn exchange(
    reader: impl Read,
    mut writer: impl Write,
    emit: &impl Fn(Event),
) -> Result<(), String> {
    let mut protocol = Protocol::default();
    send(&mut writer, &protocol.initialize())?;
    let mut reader = BufReader::new(reader);
    loop {
        let mut bytes = Vec::new();
        let count = (&mut reader)
            .take(MAX_FRAME_BYTES + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| "read Codex observer frame")?;
        if count == 0 {
            return Err("Codex observer disconnected; rollout-only coverage".into());
        }
        if count as u64 > MAX_FRAME_BYTES {
            return Err("Codex observer frame exceeds metadata limit".into());
        }
        let (requests, events) = protocol.receive(&bytes, chrono::Utc::now().timestamp_millis())?;
        for request in requests {
            send(&mut writer, &request)?;
        }
        for event in events {
            emit(event);
        }
    }
}
impl Observer {
    pub fn start(executable: &Path, emit: impl Fn(Event) + Send + 'static) -> Result<Self, String> {
        if !executable.is_absolute()
            || !executable
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("codex.exe"))
        {
            return Err("Codex observer requires a verified absolute native executable".into());
        }
        let mut child = Command::new(executable)
            .args(["app-server", "proxy"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|_| "start Codex read-only proxy failed")?;
        let job = match Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let input = child.stdin.take().ok_or("missing Codex proxy input")?;
        let output = child.stdout.take().ok_or("missing Codex proxy output")?;
        let child = Arc::new(Mutex::new(child));
        let worker_child = child.clone();
        let reader = std::thread::spawn(move || {
            let error =
                exchange(output, input, &emit).expect_err("observer ends only on disconnect");
            if let Ok(mut child) = worker_child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            emit(Event::Disconnected(error));
        });
        Ok(Self {
            child,
            reader: Some(reader),
            _job: job,
        })
    }
}

#[derive(Default)]
pub struct LiveState {
    threads: BTreeMap<String, LiveThread>,
}
struct LiveThread {
    session: Session,
    status: ThreadStatus,
    at: i64,
    active_since: Option<i64>,
}
impl LiveState {
    pub fn apply(&mut self, event: Event) {
        match event {
            Event::Thread {
                session,
                status,
                at,
            } => {
                let previous = self.threads.get(&session.id);
                let active_since = if matches!(status, ThreadStatus::Active { .. }) {
                    previous
                        .filter(|entry| matches!(entry.status, ThreadStatus::Active { .. }))
                        .and_then(|entry| entry.active_since)
                        .or(Some(at))
                } else {
                    previous.and_then(|entry| entry.active_since)
                };
                self.threads.insert(
                    session.id.clone(),
                    LiveThread {
                        session: *session,
                        status,
                        at,
                        active_since,
                    },
                );
            }
            Event::Closed(id) => {
                self.threads.remove(&id);
            }
            Event::Disconnected(_) => self.threads.clear(),
            Event::Ready => {}
        }
    }
    pub fn sessions(&self) -> impl Iterator<Item = &Session> {
        self.threads.values().map(|entry| &entry.session)
    }
    pub fn decorate(&self, base: &Session) -> Session {
        let mut session = base.clone();
        let Some(live) = self.threads.get(&base.id) else {
            return session;
        };
        let at = live.at.max(base.runtime.updated_at);
        match &live.status {
            ThreadStatus::Active { active_flags } => {
                if active_flags.contains(&ActiveFlag::WaitingOnApproval) {
                    session.attention(
                        AttentionState::WaitingUser,
                        "Permission required (Codex daemon)",
                        at,
                    );
                } else if active_flags.contains(&ActiveFlag::WaitingOnUserInput) {
                    session.attention(
                        AttentionState::WaitingUser,
                        "Your input is needed (Codex daemon)",
                        at,
                    );
                } else if base.runtime.updated_at <= live.at
                    || base.attention.state != AttentionState::None
                {
                    session.activity(Activity::Thinking, None, at);
                }
            }
            ThreadStatus::Idle => {
                if live
                    .active_since
                    .is_none_or(|started| base.runtime.updated_at >= started)
                    && matches!(
                        base.attention.state,
                        AttentionState::Done | AttentionState::Error
                    )
                {
                    return session;
                }
                session.activity(Activity::Idle, None, at);
            }
            ThreadStatus::SystemError => session.attention(
                AttentionState::Error,
                "Codex daemon reports a system error",
                at,
            ),
            ThreadStatus::NotLoaded => {}
        }
        session
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn receive(protocol: &mut Protocol, frame: Value, at: i64) -> (Vec<Value>, Vec<Event>) {
        protocol
            .receive(&serde_json::to_vec(&frame).unwrap(), at)
            .unwrap()
    }
    fn metadata(id: &str, status: Value) -> Value {
        json!({"id":id,"cwd":"C:/fixture","createdAt":1,"updatedAt":2,"status":status,
            "preview":"PRIVATE PROMPT","turns":[{"text":"SECRET BODY"}]})
    }
    fn initialized() -> Protocol {
        let mut protocol = Protocol::default();
        assert_eq!(protocol.initialize()["method"], "initialize");
        let (requests, _) = receive(&mut protocol, json!({"id":1,"result":{}}), 10);
        assert_eq!(requests[0]["method"], "initialized");
        assert_eq!(requests[1]["method"], "thread/loaded/list");
        protocol
    }
    #[test]
    fn pagination_reads_only_metadata_and_discards_bodies() {
        let mut protocol = initialized();
        let (requests, _) = receive(
            &mut protocol,
            json!({"id":2,"result":{"data":["a"],"nextCursor":"next"}}),
            20,
        );
        assert_eq!(
            requests[0],
            json!({"id":3,"method":"thread/read","params":{"threadId":"a","includeTurns":false}})
        );
        assert_eq!(requests[1]["method"], "thread/loaded/list");
        let (_, events) = receive(
            &mut protocol,
            json!({"id":3,"result":{"thread":metadata("a",json!({"type":"idle"}))}}),
            30,
        );
        let Event::Thread { session, .. } = &events[0] else {
            panic!("missing thread")
        };
        let serialized = serde_json::to_string(session).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("SECRET"));
        assert!(session.workspace.is_none());
    }
    #[test]
    fn status_wins_over_older_read_and_closed_thread_cannot_resurrect() {
        let mut protocol = initialized();
        receive(
            &mut protocol,
            json!({"id":2,"result":{"data":["a","b"],"nextCursor":null}}),
            20,
        );
        receive(
            &mut protocol,
            json!({"method":"thread/status/changed","params":{"threadId":"a","status":{"type":"active","activeFlags":["waitingOnApproval"]}}}),
            30,
        );
        let (_, events) = receive(
            &mut protocol,
            json!({"id":3,"result":{"thread":metadata("a",json!({"type":"idle"}))}}),
            40,
        );
        assert!(
            matches!(&events[0], Event::Thread {status:ThreadStatus::Active {active_flags}, at:30,..} if active_flags == &vec![ActiveFlag::WaitingOnApproval])
        );
        receive(
            &mut protocol,
            json!({"method":"thread/closed","params":{"threadId":"b"}}),
            50,
        );
        let (_, events) = receive(
            &mut protocol,
            json!({"id":4,"result":{"thread":metadata("b",json!({"type":"idle"}))}}),
            60,
        );
        assert!(events.is_empty());
        let (_, events) = receive(
            &mut protocol,
            json!({"method":"thread/started","params":{"thread":metadata("b",json!({"type":"idle"}))}}),
            70,
        );
        assert_eq!(events.len(), 1);
    }
    #[test]
    fn loaded_status_reopens_a_closed_thread_without_a_started_notification() {
        for closed in [
            json!({"method":"thread/closed","params":{"threadId":"a"}}),
            json!({"method":"thread/status/changed","params":{"threadId":"a","status":{"type":"notLoaded"}}}),
        ] {
            let mut protocol = initialized();
            receive(
                &mut protocol,
                json!({"id":2,"result":{"data":["a"],"nextCursor":null}}),
                20,
            );
            receive(
                &mut protocol,
                json!({"id":3,"result":{"thread":metadata("a",json!({"type":"idle"}))}}),
                30,
            );
            receive(&mut protocol, closed, 40);
            let (_, events) = receive(
                &mut protocol,
                json!({"method":"thread/status/changed","params":{"threadId":"a","status":{"type":"active","activeFlags":["waitingOnApproval"]}}}),
                50,
            );
            assert!(
                matches!(events.as_slice(), [Event::Thread {status:ThreadStatus::Active {active_flags}, at:50,..}]
                if active_flags == &vec![ActiveFlag::WaitingOnApproval])
            );
            assert!(!protocol.threads["a"].closed);
        }
    }
    #[test]
    fn reopened_status_survives_an_old_metadata_success_or_error() {
        for failed in [false, true] {
            for closed in [
                json!({"method":"thread/closed","params":{"threadId":"a"}}),
                json!({"method":"thread/status/changed","params":{"threadId":"a","status":{"type":"notLoaded"}}}),
            ] {
                let mut protocol = initialized();
                receive(
                    &mut protocol,
                    json!({"id":2,"result":{"data":["a"],"nextCursor":null}}),
                    20,
                );
                receive(&mut protocol, closed, 30);
                let (requests, _) = receive(
                    &mut protocol,
                    json!({"method":"thread/status/changed","params":{"threadId":"a","status":{"type":"active","activeFlags":["waitingOnApproval"]}}}),
                    40,
                );
                assert!(
                    requests.is_empty(),
                    "the old metadata read is still pending"
                );
                let (requests, events) = if failed {
                    let (requests, events) = receive(
                        &mut protocol,
                        json!({"id":3,"error":{"message":"PRIVATE ERROR"}}),
                        50,
                    );
                    assert!(events.is_empty());
                    assert_eq!(
                        requests,
                        vec![
                            json!({"id":4,"method":"thread/read","params":{"threadId":"a","includeTurns":false}})
                        ]
                    );
                    receive(
                        &mut protocol,
                        json!({"id":4,"result":{"thread":metadata("a",json!({"type":"idle"}))}}),
                        60,
                    )
                } else {
                    receive(
                        &mut protocol,
                        json!({"id":3,"result":{"thread":metadata("a",json!({"type":"idle"}))}}),
                        50,
                    )
                };
                assert!(requests.is_empty());
                assert!(
                    matches!(events.as_slice(), [Event::Thread {status:ThreadStatus::Active {active_flags}, at:40,..}]
                    if active_flags == &vec![ActiveFlag::WaitingOnApproval])
                );
            }
        }
    }
    #[test]
    fn server_requests_never_receive_a_response_and_errors_are_redacted() {
        let mut written = Vec::new();
        let input = b"{\"id\":42,\"method\":\"item/commandExecution/requestApproval\",\"params\":{\"command\":\"PRIVATE\"}}\n";
        let error = exchange(&input[..], &mut written, &|_| {}).unwrap_err();
        assert!(!error.contains("PRIVATE"));
        let lines: Vec<Value> = written
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["method"], "initialize");
        let mut protocol = initialized();
        let error = protocol
            .receive(br#"{"id":2,"error":{"message":"SECRET"}}"#, 0)
            .err()
            .unwrap();
        assert!(!error.contains("SECRET"));
    }
    fn update(live: &mut LiveState, id: &str, status: ThreadStatus, at: i64) {
        live.apply(Event::Thread {
            session: Box::new(Session::new("codex", id, "C:/fixture", 1)),
            status,
            at,
        });
    }
    #[test]
    fn live_wait_clears_without_rollout_and_isolates_threads() {
        let mut live = LiveState::default();
        let base = Session::new("codex", "a", "C:/fixture", 1);
        update(
            &mut live,
            "a",
            ThreadStatus::Active {
                active_flags: vec![ActiveFlag::WaitingOnApproval],
            },
            20,
        );
        assert_eq!(
            live.decorate(&base).attention.state,
            AttentionState::WaitingUser
        );
        assert_eq!(
            live.decorate(&Session::new("codex", "b", "C:/fixture", 1))
                .attention
                .state,
            AttentionState::None
        );
        update(
            &mut live,
            "a",
            ThreadStatus::Active {
                active_flags: vec![],
            },
            30,
        );
        assert_eq!(live.decorate(&base).attention.state, AttentionState::None);
        assert_eq!(live.decorate(&base).runtime.state, Activity::Thinking);
        update(&mut live, "a", ThreadStatus::Idle, 40);
        assert_ne!(live.decorate(&base).attention.state, AttentionState::Done);
        live.apply(Event::Disconnected("fixture".into()));
        assert_eq!(live.decorate(&base), base);
        assert_eq!(live.sessions().count(), 0);
    }
    #[test]
    fn rollout_cannot_clear_live_wait_or_mutate_base_and_old_done_does_not_return() {
        let mut live = LiveState::default();
        let mut base = Session::new("codex", "a", "C:/fixture", 1);
        base.attention(AttentionState::Done, "completed", 10);
        update(
            &mut live,
            "a",
            ThreadStatus::Active {
                active_flags: vec![ActiveFlag::WaitingOnUserInput],
            },
            20,
        );
        assert_eq!(
            live.decorate(&base).attention.state,
            AttentionState::WaitingUser
        );
        assert_eq!(base.attention.state, AttentionState::Done);
        base.activity(Activity::ToolRunning, Some("Read".into()), 25);
        assert_eq!(
            live.decorate(&base).attention.state,
            AttentionState::WaitingUser
        );
        base.attention(AttentionState::Done, "completed", 10);
        update(&mut live, "a", ThreadStatus::Idle, 30);
        assert_eq!(live.decorate(&base).attention.state, AttentionState::None);
        base.attention(AttentionState::Done, "completed", 29);
        assert_eq!(live.decorate(&base).attention.state, AttentionState::Done);
        live.apply(Event::Closed(base.id.clone()));
        assert_eq!(live.sessions().count(), 0);
    }
    #[test]
    fn a_new_active_phase_invalidates_previous_turn_completion() {
        let mut live = LiveState::default();
        let mut base = Session::new("codex", "a", "C:/fixture", 1);
        update(
            &mut live,
            "a",
            ThreadStatus::Active {
                active_flags: vec![],
            },
            20,
        );
        base.attention(AttentionState::Done, "completed", 30);
        update(&mut live, "a", ThreadStatus::Idle, 40);
        assert_eq!(live.decorate(&base).attention.state, AttentionState::Done);
        update(
            &mut live,
            "a",
            ThreadStatus::Active {
                active_flags: vec![],
            },
            50,
        );
        update(&mut live, "a", ThreadStatus::Idle, 60);
        assert_eq!(live.decorate(&base).attention.state, AttentionState::None);
    }
    #[test]
    fn kill_on_close_job_terminates_the_controlled_fixture_child() {
        use std::{
            fs,
            io::BufRead,
            time::{Duration, Instant},
        };
        let path = std::env::temp_dir().join(format!("hud-job-fixture-{}", std::process::id()));
        fs::write(&path, "fixture").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native::tests::fixture_process", "--nocapture"])
            .env("HUD_NATIVE_FIXTURE_FILE", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        let job = Job::attach(&child).unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        while !line.contains("HUD_FIXTURE_READY") {
            assert!(output.read_line(&mut line).unwrap() > 0);
        }
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(5);
        let exited = loop {
            if child.try_wait().unwrap().is_some() {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if !exited {
            child.kill().unwrap();
        }
        child.wait().unwrap();
        fs::remove_file(path).unwrap();
        assert!(exited, "closing the HUD-owned job must terminate its proxy");
    }
}
