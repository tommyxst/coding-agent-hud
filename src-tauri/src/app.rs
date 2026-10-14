use crate::{
    collector,
    model::{AttentionState, CollectorStatus, Session, Snapshot},
    native,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, State,
};

#[derive(Default)]
pub struct HudState {
    pub sessions: BTreeMap<String, Session>,
    pub collectors: BTreeMap<String, CollectorStatus>,
    pub show_detail: bool,
    pub requested_click_through: bool,
    pub alt: bool,
    pub interactive: bool,
    pub force_show: bool,
    last_snapshot: Option<Snapshot>,
}
pub type Shared = Arc<Mutex<HudState>>;

impl HudState {
    fn snapshot(&self) -> Snapshot {
        let mut sessions: Vec<_> = self.sessions.values().cloned().collect();
        if !self.show_detail {
            for session in &mut sessions {
                session.runtime.detail = None;
            }
        }
        Snapshot {
            sessions,
            collectors: self.collectors.values().cloned().collect(),
        }
    }
    fn visible(&self) -> bool {
        !self.sessions.is_empty() || self.force_show
    }
    fn click_through(&self) -> bool {
        self.requested_click_through
            && !self.alt
            && !self.interactive
            && !self.sessions.values().any(|s| {
                matches!(
                    s.attention.state,
                    AttentionState::WaitingUser | AttentionState::Error
                )
            })
    }
}

pub fn publish(app: &AppHandle, shared: &Shared) -> Result<(), String> {
    let (snapshot, visible, click_through) = {
        let mut state = shared.lock().map_err(|e| e.to_string())?;
        let snapshot = state.snapshot();
        if state.last_snapshot.as_ref() == Some(&snapshot) {
            return Ok(());
        }
        state.last_snapshot = Some(snapshot.clone());
        let visible = state.visible();
        (snapshot, visible, state.click_through())
    };
    let window = app.get_webview_window("hud").ok_or("HUD window missing")?;
    window
        .set_ignore_cursor_events(click_through)
        .map_err(|e| e.to_string())?;
    if visible {
        window.show().map_err(|e| e.to_string())?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    native::configure_hud_window(window.hwnd().map_err(|e| e.to_string())?.0 as _)?;
    app.emit("hud:snapshot", snapshot)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_snapshot(state: State<'_, Shared>) -> Result<Snapshot, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.snapshot())
}
#[tauri::command]
fn set_privacy(
    app: AppHandle,
    state: State<'_, Shared>,
    show_command_detail: bool,
) -> Result<(), String> {
    {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.show_detail = show_command_detail;
        if !show_command_detail {
            for s in state.sessions.values_mut() {
                s.runtime.detail = None;
            }
        }
    }
    publish(&app, &state)
}
#[tauri::command]
fn set_window_behavior(
    app: AppHandle,
    state: State<'_, Shared>,
    click_through: bool,
) -> Result<(), String> {
    let effective = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.requested_click_through = click_through;
        state.click_through()
    };
    let window = app.get_webview_window("hud").ok_or("HUD window missing")?;
    window
        .set_ignore_cursor_events(effective)
        .map_err(|e| e.to_string())?;
    native::configure_hud_window(window.hwnd().map_err(|e| e.to_string())?.0 as _)
}
#[tauri::command]
fn resize_window(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = app.get_webview_window("hud").ok_or("HUD window missing")?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("HUD monitor unavailable")?;
    let scale = monitor.scale_factor();
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > monitor.size().width as f64 / scale
        || height > monitor.size().height as f64 / scale
    {
        return Err("HUD size is outside monitor bounds".into());
    }
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn return_to_workspace(state: State<'_, Shared>, id: String) -> Result<(), String> {
    let workspace = state
        .lock()
        .map_err(|e| e.to_string())?
        .sessions
        .get(&id)
        .ok_or("会话已结束")?
        .workspace
        .clone()
        .ok_or("会话没有已确认的进程绑定")?;
    native::return_to_workspace(&workspace)
}

fn interaction(app: &AppHandle, shared: &Shared, alt: Option<bool>) -> Result<(), String> {
    let (enabled, click_through, visible) = {
        let mut state = shared.lock().map_err(|e| e.to_string())?;
        match alt {
            Some(pressed) if state.alt == pressed => return Ok(()),
            Some(pressed) => state.alt = pressed,
            None => {
                state.interactive = !state.interactive;
                state.force_show = state.interactive;
            }
        }
        (
            state.alt || state.interactive,
            state.click_through(),
            state.visible(),
        )
    };
    let window = app.get_webview_window("hud").ok_or("HUD window missing")?;
    window
        .set_ignore_cursor_events(click_through)
        .map_err(|e| e.to_string())?;
    if visible {
        window.show().map_err(|e| e.to_string())?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    native::configure_hud_window(window.hwnd().map_err(|e| e.to_string())?.0 as _)?;
    app.emit("hud:interaction", enabled)
        .map_err(|e| e.to_string())
}

fn tray(app: &AppHandle, shared: Shared) -> tauri::Result<()> {
    let show = MenuItem::with_id(
        app,
        "interaction",
        "显示 / 退出交互模式",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出 Coding Agent HUD", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut pixels = vec![0u8; 32 * 32 * 4];
    for y in 4..28 {
        for x in 4..28 {
            let index = (y * 32 + x) * 4;
            let accent = (7..11).contains(&x) || ((14..25).contains(&x) && (13..18).contains(&y));
            pixels[index..index + 4].copy_from_slice(if accent {
                &[217, 119, 87, 255]
            } else {
                &[20, 24, 31, 255]
            });
        }
    }
    let clicked_state = shared.clone();
    TrayIconBuilder::new()
        .icon(Image::new_owned(pixels, 32, 32))
        .tooltip("Coding Agent HUD · Alt 临时交互")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "interaction" => {
                if let Err(error) = interaction(app, &shared, None) {
                    eprintln!("HUD interaction: {error}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = interaction(tray.app_handle(), &clicked_state, None) {
                    eprintln!("HUD interaction: {error}");
                }
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    let shared = Arc::new(Mutex::new(HudState {
        requested_click_through: true,
        ..Default::default()
    }));
    let setup_state = shared.clone();
    tauri::Builder::default()
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            set_privacy,
            set_window_behavior,
            resize_window,
            return_to_workspace
        ])
        .setup(move |app| {
            tray(app.handle(), setup_state.clone())?;
            let window = app.get_webview_window("hud").ok_or("HUD window missing")?;
            native::configure_hud_window(window.hwnd()?.0 as _)?;
            let (tx, rx) = std::sync::mpsc::channel();
            let handle = app.handle().clone();
            let alt_state = setup_state.clone();
            std::thread::spawn(move || {
                for pressed in rx {
                    if let Err(error) = interaction(&handle, &alt_state, Some(pressed)) {
                        eprintln!("HUD Alt: {error}");
                    }
                }
            });
            native::start_alt_hook(move |pressed| {
                let _ = tx.send(pressed);
            })?;
            collector::start(app.handle().clone(), setup_state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Coding Agent HUD runtime failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attention_and_interaction_override_ghost() {
        let mut state = HudState {
            requested_click_through: true,
            ..Default::default()
        };
        assert!(state.click_through());
        let mut s = Session::new("claude", "test", "C:/demo", 0);
        s.attention(AttentionState::WaitingUser, "Permission required", 1);
        state.sessions.insert(s.id.clone(), s);
        assert!(!state.click_through());
        state.sessions.clear();
        state.alt = true;
        assert!(!state.click_through());
        state.alt = false;
        state.interactive = true;
        assert!(!state.click_through());
    }
    #[test]
    fn snapshots_redact_commands_by_default() {
        let mut state = HudState::default();
        let mut s = Session::new("codex", "test", "C:/demo", 0);
        s.runtime.detail = Some("PRIVATE COMMAND".into());
        state.sessions.insert(s.id.clone(), s);
        assert!(state.snapshot().sessions[0].runtime.detail.is_none());
        state.show_detail = true;
        assert_eq!(
            state.snapshot().sessions[0].runtime.detail.as_deref(),
            Some("PRIVATE COMMAND")
        );
    }
}

#[cfg(test)]
mod visibility_tests {
    use super::*;
    #[test]
    fn alt_does_not_reveal_a_sessionless_hud() {
        let mut state = HudState {
            alt: true,
            ..Default::default()
        };
        assert!(!state.visible());
        state.force_show = true;
        assert!(state.visible());
    }
}
