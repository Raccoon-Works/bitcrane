// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `bitcrane upload …` and the other commands run without a window.
    if let Some(code) = bitcrane_lib::cli::run_from_args() {
        std::process::exit(code);
    }
    if let Err(e) = bitcrane_lib::run() {
        eprintln!("Bitcrane could not start: {e}");
        std::process::exit(1);
    }
}
