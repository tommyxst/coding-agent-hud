mod app;
pub mod claude;
pub mod codex;
mod codex_live;
mod collector;
pub mod hooks;
pub mod model;
pub mod native;
mod placement;
mod tail;

pub fn run() {
    app::run();
}
