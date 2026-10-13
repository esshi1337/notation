#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--engine-worker") {
        notation_lib::engine_process::worker_main();
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        notation_lib::mcp::stdio_main();
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--script-worker") {
        notation_lib::automation::worker_main();
        return;
    }
    // WebKit's DMA-BUF renderer fails on some NVIDIA drivers (including the
    // development workstation). Use its compatible rendering path there,
    // before GTK starts, while respecting an explicit user override.
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/sys/module/nvidia").exists()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    #[cfg(feature = "desktop")]
    notation_lib::run();
    #[cfg(not(feature = "desktop"))]
    eprintln!("Build with --features desktop to launch the Notation editor.");
}
