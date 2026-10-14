use coding_agent_hud_lib::{
    hooks::{event_dir, HookEvent, MAX_HOOK_BYTES},
    native,
};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    time::{SystemTime, UNIX_EPOCH},
};

fn forward() -> Result<(), String> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_HOOK_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|e| format!("read hook input: {e}"))?;
    let pid = native::agent_ancestor("claude")?;
    let event = HookEvent::from_input(&input, pid)?;
    let directory = event_dir()?;
    fs::create_dir_all(&directory).map_err(|e| format!("create HUD event directory: {e}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock: {e}"))?
        .as_nanos();
    let file_name = format!("{}-{nonce}", std::process::id());
    let pending = directory.join(format!("{file_name}.pending"));
    let ready = directory.join(format!("{file_name}.json"));
    let bytes = serde_json::to_vec(&event).map_err(|e| format!("serialize metadata: {e}"))?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending)
        .map_err(|e| format!("create event: {e}"))?;
    file.write_all(&bytes)
        .map_err(|e| format!("write metadata: {e}"))?;
    drop(file);
    fs::rename(pending, ready).map_err(|e| format!("publish metadata: {e}"))?;
    Ok(())
}

fn main() {
    if let Err(error) = forward() {
        // Never use exit code 2: a telemetry failure must not deny an Agent tool.
        eprintln!("agent-hud-hook: {error}");
        std::process::exit(1);
    }
}
