use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn read_message(reader: &mut impl BufRead) -> Option<Vec<u8>> {
    let mut length = None;
    let mut saw_header = false;
    loop {
        let mut line = Vec::new();
        let count = reader.read_until(b'\n', &mut line).unwrap();
        if count == 0 {
            assert!(!saw_header, "partial fake-server header");
            return None;
        }
        saw_header = true;
        assert!(line.ends_with(b"\r\n"), "native header was not CRLF framed");
        if line == b"\r\n" {
            break;
        }
        if line.starts_with(b"Content-Length: ") {
            let value = &line[b"Content-Length: ".len()..line.len() - 2];
            length = Some(
                std::str::from_utf8(value)
                    .unwrap()
                    .parse::<usize>()
                    .unwrap(),
            );
        }
    }
    let mut body = vec![0; length.expect("missing native Content-Length")];
    reader.read_exact(&mut body).unwrap();
    Some(body)
}

fn frame(body: &[u8]) -> Vec<u8> {
    let mut framed = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    framed.extend(body);
    framed
}

fn stay_alive() -> ! {
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

#[cfg(unix)]
fn ignore_sigterm() {
    extern "C" {
        fn signal(signal: i32, handler: usize) -> usize;
    }
    // SIGTERM is 15 and SIG_IGN is pointer value 1 on supported Unix targets.
    unsafe {
        signal(15, 1);
    }
}

fn main() {
    let mut arguments = std::env::args().skip(1);
    let mode = arguments.next().unwrap();
    match mode.as_str() {
        "echo" => {
            let stdin = std::io::stdin();
            let mut reader = BufReader::new(stdin);
            let mut stdout = std::io::stdout();
            while let Some(body) = read_message(&mut reader) {
                stdout.write_all(&frame(&body)).unwrap();
                stdout.flush().unwrap();
            }
        }
        "fragmented" => {
            let stdin = std::io::stdin();
            let mut reader = BufReader::new(stdin);
            let body = read_message(&mut reader).unwrap();
            let framed = frame(&body);
            let mut stdout = std::io::stdout();
            for chunk in framed.chunks(3) {
                stdout.write_all(chunk).unwrap();
                stdout.flush().unwrap();
                thread::sleep(Duration::from_millis(1));
            }
            stay_alive();
        }
        "hold" => stay_alive(),
        "exit" => std::process::exit(17),
        "duplicate-length" => {
            print!("Content-Length: 2\r\ncontent-length: 2\r\n\r\n{{}}");
            std::io::stdout().flush().unwrap();
            stay_alive();
        }
        "oversized-header" => {
            let mut stdout = std::io::stdout();
            stdout.write_all(b"X-Test: ").unwrap();
            let mut rest = vec![b'a'; 8 * 1024];
            rest.extend(b"\r\n\r\n");
            stdout.write_all(&rest).unwrap();
            stdout.flush().unwrap();
            stay_alive();
        }
        "oversized-body" => {
            print!("Content-Length: {}\r\n\r\n", 4 * 1024 * 1024 + 1);
            std::io::stdout().flush().unwrap();
            stay_alive();
        }
        "invalid-json" => {
            std::io::stdout()
                .write_all(&frame(b"<html>not json</html>"))
                .unwrap();
            std::io::stdout().flush().unwrap();
            stay_alive();
        }
        #[cfg(unix)]
        "tree-parent" => {
            ignore_sigterm();
            let heartbeat = arguments.next().map(PathBuf::from).unwrap();
            let _child = Command::new(std::env::current_exe().unwrap())
                .arg("tree-child")
                .arg(heartbeat)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            stay_alive();
        }
        #[cfg(unix)]
        "tree-child" => {
            ignore_sigterm();
            let heartbeat = arguments.next().map(PathBuf::from).unwrap();
            loop {
                let tick = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                fs::write(&heartbeat, tick.to_string()).unwrap();
                thread::sleep(Duration::from_millis(25));
            }
        }
        other => panic!("unknown fake server mode: {other}"),
    }
}
