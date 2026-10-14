mod app;
pub mod codex;
mod collector;
pub mod hooks;
pub mod model;
pub mod native;
mod tail;

pub fn run() {
    app::run();
}
