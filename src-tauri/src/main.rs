// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // `bitcrane upload …` and the other commands run without a window.
  if let Some(code) = bitcrane_lib::cli::run_from_args() {
    std::process::exit(code);
  }
  bitcrane_lib::run();
}
