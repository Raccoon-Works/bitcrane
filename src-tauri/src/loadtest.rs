//! Load test: many files, a file larger than 4 GB, paused and continued
//! transfers and parallel transfers on one connection, against the local test
//! servers. Ignored by default (it writes many gigabytes); run with
//!
//!   BITCRANE_LOAD=1 cargo test --release --lib loadtest -- --ignored --nocapture
//!
//! plus the usual BITCRANE_TEST_* variables of the protocol tests. Sizes can
//! be changed with BITCRANE_LOAD_FILES (default 20000) and BITCRANE_LOAD_GB (5).

use crate::error::ErrorKind;
use crate::paths::remote_join;
use crate::remote::Remote;
use crate::ssh::{AuthParams, ConnectParams, KnownHosts};
use crate::transfer::{TransferOptions, PAUSE, RUN};
use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Instant;

fn ui(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Content of test file `i`: a few kilobytes that differ per file.
fn content(i: usize) -> Vec<u8> {
    let len = 512 + (i * 7919) % 4096;
    (0..len).map(|j| ((i * 31 + j * 7) % 251) as u8).collect()
}

/// Runs `jobs` with at most `n` at a time (like the app's parallel transfers).
async fn parallel<F, Fut>(count: usize, n: usize, job: F)
where
    F: Fn(usize) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    use futures_util::StreamExt;
    futures_util::stream::iter((0..count).map(&job)).buffer_unordered(n).collect::<Vec<()>>().await;
}

async fn many_files(conn: &Remote, base: &str, count: usize) {
    let local = tempfile::tempdir().unwrap();
    // Half the files in one big folder, the rest spread over 40 folders.
    let rel = |i: usize| if i % 2 == 0 { format!("flach/f{i:06}.txt") } else { format!("tief/d{:02}/u{:02}/f{i:06}.bin", i % 40, i % 7) };
    for i in 0..count {
        let p = local.path().join(rel(i));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content(i)).unwrap();
    }
    let opts = TransferOptions::default();
    let t = Instant::now();
    let failed = AtomicU64::new(0);
    parallel(count, 4, |i| {
        let (src, dst) = (ui(&local.path().join(rel(i))), remote_join(base, &rel(i)));
        let opts = &opts;
        let failed = &failed;
        async move {
            if let Err(e) = crate::transfer::upload(conn, &src, &dst, opts, &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await {
                eprintln!("upload {dst}: {e:?}");
                failed.fetch_add(1, Ordering::Relaxed);
            }
        }
    })
    .await;
    assert_eq!(failed.load(Ordering::Relaxed), 0, "{}: uploads failed", conn.protocol());
    let up = t.elapsed();

    let t = Instant::now();
    let flat = conn.list(&remote_join(base, "flach")).await.unwrap();
    let list = t.elapsed();
    assert_eq!(flat.len(), count.div_ceil(2), "{}: big folder listed completely", conn.protocol());

    let t = Instant::now();
    let all = conn.walk(base).await.unwrap();
    let walk = t.elapsed();
    assert_eq!(all.len(), count, "{}: every file found", conn.protocol());

    let back = tempfile::tempdir().unwrap();
    let t = Instant::now();
    parallel(count, 4, |i| {
        let (src, dst) = (remote_join(base, &rel(i)), ui(&back.path().join(rel(i))));
        let opts = &opts;
        let failed = &failed;
        async move {
            if let Err(e) = crate::transfer::download(conn, &src, &dst, opts, &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await {
                eprintln!("download {src}: {e:?}");
                failed.fetch_add(1, Ordering::Relaxed);
            }
        }
    })
    .await;
    let down = t.elapsed();
    assert_eq!(failed.load(Ordering::Relaxed), 0, "{}: downloads failed", conn.protocol());
    for i in 0..count {
        assert_eq!(std::fs::read(back.path().join(rel(i))).unwrap(), content(i), "{}: file {i} intact", conn.protocol());
    }
    eprintln!(
        "{}: {count} files up {:.1}s ({:.0}/s), list of {} {:.2}s, walk {:.2}s, down {:.1}s ({:.0}/s)",
        conn.protocol(),
        up.as_secs_f64(),
        count as f64 / up.as_secs_f64(),
        flat.len(),
        list.as_secs_f64(),
        walk.as_secs_f64(),
        down.as_secs_f64(),
        count as f64 / down.as_secs_f64()
    );
}

/// A sparse local file of `gb` gigabytes with marks at the start, beyond 4 GiB
/// and at the end (so a wrong offset shows in the checksum).
fn big_file(dir: &std::path::Path, gb: u64) -> std::path::PathBuf {
    let path = dir.join("gross.bin");
    let size = gb * 1_000_000_000 + 12_345;
    let mut f = std::fs::File::create(&path).unwrap();
    f.set_len(size).unwrap();
    for (at, seed) in [(0u64, 1u8), ((1u64 << 32) + 777, 2), (size - 4096, 3)] {
        if at + 4096 <= size {
            f.seek(SeekFrom::Start(at)).unwrap();
            f.write_all(&(0..4096u32).map(|j| (j as u8).wrapping_mul(seed).wrapping_add(seed)).collect::<Vec<u8>>()).unwrap();
        }
    }
    path
}

async fn big_transfer(conn: &Remote, base: &str, gb: u64) {
    let dir = tempfile::tempdir().unwrap();
    let local = big_file(dir.path(), gb);
    let size = std::fs::metadata(&local).unwrap().len();
    let target = remote_join(base, "gross.bin");
    let opts = TransferOptions::default();

    // Pause at about a third, then continue.
    let flag = Arc::new(AtomicU8::new(RUN));
    let f2 = flag.clone();
    let t = Instant::now();
    let pause_at = size / 3;
    let paused = crate::transfer::upload(conn, &ui(&local), &target, &opts, &move |d, _| if d >= pause_at { f2.store(PAUSE, Ordering::Relaxed) }, flag).await;
    assert_eq!(paused.err().map(|e| e.kind), Some(ErrorKind::Cancelled), "{}: paused", conn.protocol());
    let first = AtomicU64::new(u64::MAX);
    crate::transfer::upload(conn, &ui(&local), &target, &opts, &|d, _| { let _ = first.compare_exchange(u64::MAX, d, Ordering::Relaxed, Ordering::Relaxed); }, Arc::new(AtomicU8::new(RUN))).await.unwrap();
    let up = t.elapsed();
    let resumed = first.load(Ordering::Relaxed);
    if conn.can_append(&target) {
        assert!(resumed >= pause_at - 64 * 1024 * 1024, "{}: continued at {resumed}, paused at {pause_at}", conn.protocol());
    }
    assert_eq!(conn.stat(&target).await.unwrap().size, size, "{}: full size on the server", conn.protocol());

    // Download, also paused once (downloads continue where the partial file ends).
    let back = dir.path().join("zurueck.bin");
    let flag = Arc::new(AtomicU8::new(RUN));
    let f2 = flag.clone();
    let t = Instant::now();
    let pause_at = size / 2;
    let paused = crate::transfer::download(conn, &target, &ui(&back), &opts, &move |d, _| if d >= pause_at { f2.store(PAUSE, Ordering::Relaxed) }, flag).await;
    assert_eq!(paused.err().map(|e| e.kind), Some(ErrorKind::Cancelled), "{}: download paused", conn.protocol());
    crate::transfer::download(conn, &target, &ui(&back), &opts, &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await.unwrap();
    let down = t.elapsed();
    assert_eq!(std::fs::metadata(&back).unwrap().len(), size);
    assert_eq!(crate::local::checksum(&ui(&back)).unwrap(), crate::local::checksum(&ui(&local)).unwrap(), "{}: big file intact", conn.protocol());
    conn.remove_file(&target).await.unwrap();
    let mb = size as f64 / 1e6;
    eprintln!("{}: {:.2} GB up {:.1}s ({:.0} MB/s, with a pause), down {:.1}s ({:.0} MB/s)", conn.protocol(), size as f64 / 1e9, up.as_secs_f64(), mb / up.as_secs_f64(), down.as_secs_f64(), mb / down.as_secs_f64());
}

async fn run(conn: Remote, home: &str, files: usize, gb: u64) {
    let base = remote_join(home, &format!("bitcrane-last-{}", uuid::Uuid::new_v4().simple()));
    conn.mkdir_all(&base).await.unwrap();
    if files > 0 {
        many_files(&conn, &base, files).await;
    }
    if gb > 0 {
        big_transfer(&conn, &base, gb).await;
    }
    conn.remove(&base).await.unwrap();
}

fn env_num(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn load_sftp() {
    if std::env::var("BITCRANE_LOAD").is_err() {
        return;
    }
    let target = std::env::var("BITCRANE_TEST_SSH").expect("BITCRANE_TEST_SSH");
    let (host, port) = target.split_once(':').unwrap();
    let dir = tempfile::tempdir().unwrap();
    let known = Arc::new(KnownHosts::load(dir.path().join("known.json")));
    let p = |trust: Option<String>| ConnectParams { timeout: None,
        host: host.into(), port: port.parse().unwrap(), user: "test".into(),
        auth: AuthParams::Key { path: std::env::var("BITCRANE_TEST_KEY").unwrap(), passphrase: None },
        trust, keepalive: true, scp: false, jump: None, proxy: None,
    };
    let fp = crate::ssh::connect(&p(None), known.clone()).await.err().unwrap().host_key.unwrap().fingerprint;
    let c = crate::ssh::connect(&p(Some(fp)), known).await.unwrap();
    let home = c.home.clone();
    run(Remote::Sftp(c), &home, env_num("BITCRANE_LOAD_FILES", 20_000) as usize, env_num("BITCRANE_LOAD_GB", 5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn load_ftp() {
    if std::env::var("BITCRANE_LOAD").is_err() {
        return;
    }
    let v = std::env::var("BITCRANE_TEST_FTP").expect("BITCRANE_TEST_FTP");
    let (host, ports) = v.split_once(':').unwrap();
    let port: u16 = ports.split(',').next().unwrap().parse().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let known = Arc::new(KnownHosts::load(dir.path().join("known.json")));
    let p = crate::ftp::FtpParams { timeout: None,
        host: host.into(), port, user: "test".into(), password: Some("geheim123".into()), tls: "none".into(), tls13_only: false,
        encoding: "utf8".into(), tz_offset_min: 0, mode: "binary".into(), trust: None, proxy: None,
    };
    let c = crate::ftp::FtpConn::connect(p, known).await.unwrap();
    let home = c.home.clone();
    run(Remote::Ftp(Arc::new(c)), &home, env_num("BITCRANE_LOAD_FTP_FILES", 3_000) as usize, env_num("BITCRANE_LOAD_GB", 5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn load_dav_and_s3() {
    if std::env::var("BITCRANE_LOAD").is_err() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let known = Arc::new(KnownHosts::load(dir.path().join("known.json")));
    if let Ok(urls) = std::env::var("BITCRANE_TEST_DAV") {
        let url = urls.split(',').next().unwrap();
        let p = crate::dav::DavParams { timeout: None, url: url.into(), user: "test".into(), password: Some("geheim123".into()), tls13_only: false, trust: None, proxy: None };
        let c = crate::dav::DavConn::connect(p, known.clone()).await.unwrap();
        let home = c.home.clone();
        run(Remote::Dav(c), &home, env_num("BITCRANE_LOAD_DAV_FILES", 1_000) as usize, env_num("BITCRANE_LOAD_DAV_GB", 1)).await;
    }
    if let Ok(endpoint) = std::env::var("BITCRANE_TEST_S3") {
        let params = |bucket: &str| crate::s3::S3Params { timeout: None, endpoint: endpoint.clone(), region: "eu-central-1".into(), bucket: bucket.into(), access_key: "test".into(), secret: Some("geheim".into()), path_style: true, tls13_only: false, trust: None, proxy: None };
        let bucket = format!("bitcrane-last-{}", uuid::Uuid::new_v4().simple());
        crate::s3::S3Conn::connect(params(""), known.clone()).await.unwrap().mkdir(&format!("/{bucket}")).await.unwrap();
        let c = crate::s3::S3Conn::connect(params(&bucket), known.clone()).await.unwrap();
        // The S3 test server keeps everything in memory: many files, no giant file.
        run(Remote::S3(Arc::new(c)), "/", env_num("BITCRANE_LOAD_S3_FILES", 1_000) as usize, 0).await;
    }
}
