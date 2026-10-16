use crate::{
    app::{publish, Shared},
    model::CollectorStatus,
    native,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    time::Duration,
};
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow,
};

const CONFIG_VERSION: u32 = 1;
const MAX_CONFIG_BYTES: u64 = 4096;
const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);
const COLLECTOR: &str = "window-placement";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedPosition {
    version: u32,
    monitor: String,
    x: f64,
    y: f64,
}

impl SavedPosition {
    fn validate(&self) -> Result<(), String> {
        if self.version != CONFIG_VERSION {
            return Err(format!(
                "unsupported window position version: {}",
                self.version
            ));
        }
        if self.monitor.trim().is_empty() || !self.x.is_finite() || !self.y.is_finite() {
            return Err("invalid monitor or relative window position".into());
        }
        Ok(())
    }
}

struct Display {
    name: String,
    origin: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
}

impl TryFrom<&Monitor> for Display {
    type Error = String;

    fn try_from(monitor: &Monitor) -> Result<Self, String> {
        Ok(Self {
            name: monitor
                .name()
                .ok_or("display identifier unavailable")?
                .clone(),
            origin: monitor.work_area().position,
            size: monitor.work_area().size,
            scale: monitor.scale_factor(),
        })
    }
}

impl Display {
    fn identified(monitor: &Monitor) -> Result<Self, String> {
        let mut display = Self::try_from(monitor)?;
        display.name = native::monitor_id(&display.name)?;
        Ok(display)
    }
}

fn capture(position: PhysicalPosition<i32>, display: &Display) -> SavedPosition {
    SavedPosition {
        version: CONFIG_VERSION,
        monitor: display.name.clone(),
        x: (f64::from(position.x) - f64::from(display.origin.x)) / display.scale,
        y: (f64::from(position.y) - f64::from(display.origin.y)) / display.scale,
    }
}

fn bounded_position(
    x: f64,
    y: f64,
    size: PhysicalSize<u32>,
    display: &Display,
) -> PhysicalPosition<i32> {
    // If the window exceeds the work area, keep its top-left drag handle reachable.
    let max_x =
        f64::from(display.origin.x) + f64::from(display.size.width.saturating_sub(size.width));
    let max_y =
        f64::from(display.origin.y) + f64::from(display.size.height.saturating_sub(size.height));
    PhysicalPosition::new(
        x.clamp(f64::from(display.origin.x), max_x).round() as i32,
        y.clamp(f64::from(display.origin.y), max_y).round() as i32,
    )
}

fn restored_position(
    saved: &SavedPosition,
    display: &Display,
    size: LogicalSize<f64>,
) -> PhysicalPosition<i32> {
    bounded_position(
        f64::from(display.origin.x) + saved.x * display.scale,
        f64::from(display.origin.y) + saved.y * display.scale,
        size.to_physical(display.scale),
        display,
    )
}

fn select_display<'a>(name: &str, displays: &'a [Display]) -> Result<Option<&'a Display>, String> {
    let mut matches = displays.iter().filter(|display| display.name == name);
    let first = matches.next();
    if matches.next().is_some() {
        return Err("display identifier is ambiguous; position was not restored".into());
    }
    Ok(first)
}

fn load(path: &Path) -> Result<Option<SavedPosition>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read window position: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read window position: {error}"))?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err("window position file exceeds size limit".into());
    }
    let saved: SavedPosition = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse window position: {error}"))?;
    saved.validate()?;
    Ok(Some(saved))
}

fn save(path: &Path, saved: &SavedPosition) -> Result<(), String> {
    saved.validate()?;
    let bytes = serde_json::to_vec(saved).map_err(|error| error.to_string())?;
    let directory = path.parent().ok_or("window position directory missing")?;
    fs::create_dir_all(directory).map_err(|error| format!("create position directory: {error}"))?;
    let pending = path.with_extension(format!("{}.pending", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)
        .map_err(|error| format!("create pending position: {error}"))?;
    let result = (|| {
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("write window position: {error}"))?;
        drop(file);
        fs::rename(&pending, path).map_err(|error| format!("replace window position: {error}"))
    })();
    if result.is_err() {
        fs::remove_file(&pending)
            .map_err(|error| format!("{result:?}; remove pending position: {error}"))?;
    }
    result
}

enum WriteRequest {
    Update(SavedPosition),
    Flush(Sender<Result<(), String>>),
}

pub(crate) struct PlacementWriter(Option<Sender<WriteRequest>>);

impl PlacementWriter {
    pub(crate) fn flush(&self) -> Result<(), String> {
        if let Some(sender) = &self.0 {
            let (tx, rx) = mpsc::channel();
            sender
                .send(WriteRequest::Flush(tx))
                .map_err(|error| format!("flush position writer: {error}"))?;
            rx.recv()
                .map_err(|error| format!("wait for position writer: {error}"))??;
        }
        Ok(())
    }
}

fn write_loop(
    receiver: Receiver<WriteRequest>,
    initial: Option<SavedPosition>,
    mut persist: impl FnMut(&SavedPosition) -> Result<(), String>,
) {
    let mut last_saved = initial;
    let mut pending = None;
    loop {
        let request = if pending.is_some() {
            receiver.recv_timeout(SAVE_DEBOUNCE)
        } else {
            receiver.recv().map_err(|_| RecvTimeoutError::Disconnected)
        };
        match request {
            Ok(WriteRequest::Update(saved)) => pending = Some(saved),
            request => {
                let result = if let Some(saved) = pending
                    .take()
                    .filter(|saved| Some(saved) != last_saved.as_ref())
                {
                    persist(&saved).map(|()| last_saved = Some(saved))
                } else {
                    Ok(())
                };
                match request {
                    Ok(WriteRequest::Flush(reply)) => {
                        // The caller may have exited; it no longer needs the acknowledgement.
                        let _ = reply.send(result);
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {}
                    Ok(WriteRequest::Update(_)) => unreachable!(),
                }
            }
        }
    }
}

fn report(app: &AppHandle, shared: &Shared, state: &str, message: String) {
    eprintln!("HUD placement: {message}");
    let result = (|| {
        shared
            .lock()
            .map_err(|error| error.to_string())?
            .collectors
            .insert(
                COLLECTOR.into(),
                CollectorStatus {
                    agent: COLLECTOR.into(),
                    state: state.into(),
                    message,
                },
            );
        publish(app, shared)
    })();
    if let Err(error) = result {
        eprintln!("HUD placement diagnostic: {error}");
    }
}

pub(crate) fn keep_visible(window: &WebviewWindow) -> Result<(), String> {
    if window.is_minimized().map_err(|error| error.to_string())? {
        return Ok(());
    }
    let monitor = match window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        Some(monitor) => monitor,
        None => {
            eprintln!("HUD placement: current display missing; recovering to primary work area");
            window
                .primary_monitor()
                .map_err(|error| error.to_string())?
                .ok_or("primary display unavailable")?
        }
    };
    let display = Display::try_from(&monitor)?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let bounded = bounded_position(f64::from(position.x), f64::from(position.y), size, &display);
    if bounded != position {
        window
            .set_position(bounded)
            .map_err(|error| format!("recover HUD position: {error}"))?;
    }
    Ok(())
}

fn restore(window: &WebviewWindow, saved: &SavedPosition) -> Result<bool, String> {
    let displays = window
        .available_monitors()
        .map_err(|error| error.to_string())?
        .iter()
        .map(Display::identified)
        .collect::<Result<Vec<_>, _>>()?;
    let primary;
    let (display, recovered) = match select_display(&saved.monitor, &displays)? {
        Some(display) => (display, false),
        None => {
            let monitor = window
                .primary_monitor()
                .map_err(|error| error.to_string())?
                .ok_or("saved display missing and primary display unavailable")?;
            primary = Display::identified(&monitor)?;
            (&primary, true)
        }
    };
    let logical = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|error| error.to_string())?);
    window
        .set_position(restored_position(saved, display, logical))
        .map_err(|error| format!("restore HUD position: {error}"))?;
    window
        .set_size(logical)
        .map_err(|error| format!("restore HUD logical size: {error}"))?;
    keep_visible(window)?;
    Ok(recovered)
}

pub(crate) fn install(app: &AppHandle, shared: Shared) -> Result<(), String> {
    let path = match std::env::var_os("HUD_PLACEMENT_FILE") {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() || path.file_name().is_none() {
                return Err("HUD_PLACEMENT_FILE must be an absolute file path".into());
            }
            path
        }
        None => app
            .path()
            .app_config_dir()
            .map_err(|error| error.to_string())?
            .join("window-position.json"),
    };
    let window = app.get_webview_window("hud").ok_or("HUD window missing")?;
    let initial = load(&path).and_then(|saved| {
        let recovered = match &saved {
            Some(saved) => restore(&window, saved)?,
            None => false,
        };
        keep_visible(&window)?;
        if recovered {
            report(
                app,
                &shared,
                "warning",
                "保存的显示器已移除；HUD 已恢复到主屏工作区".into(),
            );
        }
        Ok(saved)
    });
    let sender = match initial {
        Ok(saved) => {
            let (tx, rx) = mpsc::channel();
            let app = app.clone();
            let shared = shared.clone();
            std::thread::spawn(move || {
                write_loop(rx, saved, |saved| {
                    let result = save(&path, saved);
                    if let Err(error) = &result {
                        // Exit flush waits on this worker; diagnostics must not wait for the UI thread.
                        let diagnostic_app = app.clone();
                        let diagnostic_state = shared.clone();
                        let error = error.clone();
                        if let Err(dispatch_error) = app.run_on_main_thread(move || {
                            report(&diagnostic_app, &diagnostic_state, "error", error)
                        }) {
                            eprintln!("HUD placement diagnostic dispatch: {dispatch_error}");
                        }
                    }
                    result
                })
            });
            Some(tx)
        }
        Err(error) => {
            report(
                app,
                &shared,
                "error",
                format!("{error}；本次禁用位置保存，原文件不变。修复或删除位置文件后重启 HUD"),
            );
            keep_visible(&window)?;
            None
        }
    };
    app.manage(PlacementWriter(sender.clone()));
    let app = app.clone();
    let observed = window.clone();
    window.on_window_event(move |event| {
        let result = (|| {
            if observed.is_minimized().map_err(|error| error.to_string())? {
                return Ok(());
            }
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    keep_visible(&observed)
                }
                tauri::WindowEvent::Moved(_) => {
                    if let Some(sender) = &sender {
                        let monitor = observed
                            .current_monitor()
                            .map_err(|error| error.to_string())?
                            .ok_or("cannot save position without current display")?;
                        let display = Display::identified(&monitor)?;
                        let saved = capture(
                            observed
                                .outer_position()
                                .map_err(|error| error.to_string())?,
                            &display,
                        );
                        sender
                            .send(WriteRequest::Update(saved))
                            .map_err(|error| format!("queue window position: {error}"))?;
                    }
                    Ok(())
                }
                _ => Ok(()),
            }
        })();
        if let Err(error) = result {
            report(&app, &shared, "error", error);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    };

    fn display(scale: f64) -> Display {
        Display {
            name: "second".into(),
            origin: PhysicalPosition::new(-2560, -200),
            size: PhysicalSize::new(2560, 1400),
            scale,
        }
    }
    fn saved() -> SavedPosition {
        SavedPosition {
            version: CONFIG_VERSION,
            monitor: "second".into(),
            x: 80.0,
            y: 120.0,
        }
    }
    fn temp_file() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir()
            .join(format!(
                "hud-placement-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ))
            .join("position.json")
    }

    #[test]
    fn relative_position_round_trips_across_supported_dpi() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let display = display(scale);
            let position = restored_position(&saved(), &display, LogicalSize::new(372.0, 320.0));
            assert_eq!(capture(position, &display), saved());
        }
    }

    #[test]
    fn dpi_change_keeps_logical_offset_not_absolute_pixels() {
        let source = display(1.25);
        let target = display(2.0);
        let original = restored_position(&saved(), &source, LogicalSize::new(372.0, 320.0));
        let restored = restored_position(
            &capture(original, &source),
            &target,
            LogicalSize::new(372.0, 320.0),
        );
        assert_eq!(restored, PhysicalPosition::new(-2400, 40));
    }

    #[test]
    fn restore_clamps_to_work_area_after_growth_and_resolution_change() {
        let display = display(1.5);
        let mut saved = saved();
        saved.x = 5000.0;
        saved.y = 5000.0;
        assert_eq!(
            restored_position(&saved, &display, LogicalSize::new(372.0, 320.0)),
            PhysicalPosition::new(-558, 720)
        );
        saved.x = -5000.0;
        saved.y = -5000.0;
        assert_eq!(
            restored_position(&saved, &display, LogicalSize::new(372.0, 320.0)),
            display.origin
        );
    }

    #[test]
    fn oversized_window_keeps_drag_handle_inside_work_area() {
        let display = display(2.0);
        assert_eq!(
            restored_position(&saved(), &display, LogicalSize::new(2000.0, 2000.0)),
            display.origin
        );
    }

    #[test]
    fn missing_and_duplicate_display_ids_are_explicit() {
        let displays = [display(1.0)];
        assert!(select_display("removed", &displays).unwrap().is_none());
        assert_eq!(
            select_display("second", &displays).unwrap().unwrap().name,
            "second"
        );
        assert!(select_display("second", &[display(1.0), display(2.0)]).is_err());
    }

    #[test]
    fn configuration_round_trip_and_atomic_replacement() {
        let path = temp_file();
        assert_eq!(load(&path).unwrap(), None);
        save(&path, &saved()).unwrap();
        assert_eq!(load(&path).unwrap(), Some(saved()));
        let mut updated = saved();
        updated.x = 130.0;
        save(&path, &updated).unwrap();
        assert_eq!(load(&path).unwrap(), Some(updated));
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn invalid_or_oversized_configuration_is_not_modified() {
        let path = temp_file();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for bytes in [
            b"not json".to_vec(),
            br#"{"version":2,"monitor":"second","x":0,"y":0}"#.to_vec(),
            br#"{"version":1,"monitor":"","x":0,"y":0}"#.to_vec(),
            br#"{"version":1,"monitor":"second","x":0,"y":0,"prompt":"private"}"#.to_vec(),
            vec![b' '; MAX_CONFIG_BYTES as usize + 1],
        ] {
            fs::write(&path, &bytes).unwrap();
            assert!(load(&path).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        let mut invalid = saved();
        invalid.x = f64::NAN;
        assert!(save(&path, &invalid).is_err());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn burst_moves_coalesce_and_exit_flushes_latest_position() {
        let (tx, rx) = mpsc::channel();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let observed = writes.clone();
        let worker = std::thread::spawn(move || {
            write_loop(rx, None, |saved| {
                observed.lock().unwrap().push(saved.clone());
                Ok(())
            })
        });
        for x in 0..100 {
            tx.send(WriteRequest::Update(SavedPosition {
                x: f64::from(x),
                ..saved()
            }))
            .unwrap();
        }
        let writer = PlacementWriter(Some(tx));
        writer.flush().unwrap();
        assert_eq!(
            writes.lock().unwrap().as_slice(),
            &[SavedPosition { x: 99.0, ..saved() }]
        );
        drop(writer);
        worker.join().unwrap();
    }

    #[test]
    fn unchanged_position_does_not_write_and_flush_reports_failure() {
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            write_loop(rx, Some(saved()), |_| Err("write fixture error".into()))
        });
        tx.send(WriteRequest::Update(saved())).unwrap();
        let writer = PlacementWriter(Some(tx.clone()));
        writer.flush().unwrap();
        tx.send(WriteRequest::Update(SavedPosition { x: 1.0, ..saved() }))
            .unwrap();
        assert_eq!(writer.flush().unwrap_err(), "write fixture error");
        drop(writer);
        drop(tx);
        worker.join().unwrap();
    }
}
