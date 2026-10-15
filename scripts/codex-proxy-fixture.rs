// Isolated native acceptance fixture. Never executes an Agent or model.
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    if args != ["app-server", "proxy"] {
        let _held =
            fs::File::open(env::var_os("HUD_NATIVE_FIXTURE_FILE").expect("held file")).unwrap();
        println!("HUD_FIXTURE_READY");
        io::stdout().flush().unwrap();
        io::stdin().read_exact(&mut [0]).unwrap();
        return;
    }
    let root = PathBuf::from(
        env::var_os("HUD_CODEX_PROXY_FIXTURE_DIR").expect("isolated fixture directory"),
    );
    fs::write(root.join("proxy.pid"), std::process::id().to_string()).unwrap();
    let output = Arc::new(Mutex::new(io::stdout()));
    let control = root.join("proxy-notifications.jsonl");
    let notifications = output.clone();
    std::thread::spawn(move || {
        let mut consumed = 0;
        loop {
            let bytes = fs::read(&control).unwrap();
            if bytes.len() > consumed {
                let mut output = notifications.lock().unwrap();
                output.write_all(&bytes[consumed..]).unwrap();
                output.flush().unwrap();
                consumed = bytes.len();
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    });
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("proxy-requests.jsonl"))
        .unwrap();
    let cwd = root
        .join("native-e2e-project")
        .to_str()
        .unwrap()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        writeln!(log, "{line}").unwrap();
        log.flush().unwrap();
        let id: String = line
            .split("\"id\":")
            .nth(1)
            .map(|rest| rest.chars().take_while(char::is_ascii_digit).collect())
            .unwrap_or_default();
        let response = if line.contains("\"method\":\"initialize\"") {
            format!("{{\"id\":{id},\"result\":{{\"userAgent\":\"fixture-only\"}}}}")
        } else if line.contains("\"method\":\"initialized\"") {
            continue;
        } else if line.contains("\"method\":\"thread/loaded/list\"") {
            format!(
                "{{\"id\":{id},\"result\":{{\"data\":[\"native-fixture\"],\"nextCursor\":null}}}}"
            )
        } else if line.contains("\"method\":\"thread/read\"")
            && line.contains("\"includeTurns\":false")
        {
            format!("{{\"id\":{id},\"result\":{{\"thread\":{{\"id\":\"native-fixture\",\"cwd\":\"{cwd}\",\"createdAt\":1,\"updatedAt\":2,\"status\":{{\"type\":\"idle\"}},\"preview\":\"PRIVATE_DAEMON_PROMPT\",\"turns\":[]}}}}}}")
        } else {
            panic!("observer sent a non-allowlisted request");
        };
        let mut output = output.lock().unwrap();
        writeln!(output, "{response}").unwrap();
        output.flush().unwrap();
    }
}
