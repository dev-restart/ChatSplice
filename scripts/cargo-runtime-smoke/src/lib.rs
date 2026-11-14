//! A small macOS diagnostic for the public, managed Cargo execution path.
//! Run from this directory with `cargo test --offline --locked -- --nocapture`.
//! Uses only loopback addresses and the local resolver socket; no external DNS.

#[cfg(all(test, not(target_os = "macos")))]
#[test]
fn this_diagnostic_requires_macos() {
    panic!("This diagnostic checks the macOS managed Cargo runtime; run it on the Mac host.");
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::env;
    use std::ffi::CString;
    use std::fs::{self, File};
    use std::io::{self, Read, Write};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::path::{Component, Path, PathBuf};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    type Probe<T> = Result<T, String>;

    // Darwin definitions, not Linux values. No creation flags or mode argument.
    // https://github.com/apple/darwin-xnu/blob/main/bsd/sys/fcntl.h
    const O_RDONLY: c_int = 0x0000;
    const O_NONBLOCK: c_int = 0x0000_0004;
    const O_NOFOLLOW: c_int = 0x0000_0100;
    const O_DIRECTORY: c_int = 0x0010_0000;
    const O_CLOEXEC: c_int = 0x0100_0000;

    extern "C" {
        fn openat(dirfd: c_int, path: *const c_char, oflag: c_int, ...) -> c_int;
    }

    fn io_error(error: io::Error) -> String {
        let message: String = error
            .to_string()
            .chars()
            .filter(|c| !c.is_control())
            .take(240)
            .collect();
        format!(
            "kind={:?} errno={:?} message={message}",
            error.kind(),
            error.raw_os_error()
        )
    }

    fn report<T: std::fmt::Debug>(label: &str, result: &Probe<T>) {
        eprintln!("[cargo-runtime-smoke] {label}: {result:?}");
    }

    fn bounded<T, F>(label: &str, operation: F) -> Probe<T>
    where
        T: Send + 'static,
        F: FnOnce() -> Probe<T> + Send + 'static,
    {
        let (tx, rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name(label.into())
            .spawn(move || {
                let _ = tx.send(operation());
            })
            .map_err(io_error)?;
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(result) => {
                worker
                    .join()
                    .map_err(|_| "probe worker panicked".to_owned())?;
                result
            }
            // Rust std has no cancellation API for getaddrinfo or Unix connect.
            // At most one worker per probe can remain until this test process exits.
            Err(mpsc::RecvTimeoutError::Timeout) => Err("timeout after 3s".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("probe worker disconnected".into()),
        }
    }

    fn path_node() -> Probe<PathBuf> {
        let value = env::var_os("PATH").ok_or("PATH is unset")?;
        for (index, directory) in env::split_paths(&value).take(128).enumerate() {
            // Managed Cargo supplies absolute PATH entries. Do not search cwd.
            if !directory.is_absolute() {
                continue;
            }
            let candidate = directory.join("node");
            match fs::metadata(&candidate) {
                Ok(metadata)
                    if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 =>
                {
                    eprintln!("[cargo-runtime-smoke] node selected from PATH entry {index}");
                    return fs::canonicalize(candidate).map_err(|error| {
                        format!(
                            "node canonicalize at PATH entry {index}: {}",
                            io_error(error)
                        )
                    });
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    eprintln!(
                        "[cargo-runtime-smoke] node metadata at PATH entry {index}: {}",
                        io_error(error)
                    );
                }
            }
        }
        Err("no executable node found in the first 128 absolute PATH entries".into())
    }

    fn descriptor_read(path: &Path) -> Probe<usize> {
        if !path.is_absolute() {
            return Err("canonical Node path is not absolute".into());
        }
        let mut components = Vec::new();
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => components.push(name),
                _ => return Err("canonical Node path has a non-normal component".into()),
            }
        }
        if components.is_empty() {
            return Err("Node path has no file component".into());
        }
        let mut directory =
            File::open("/").map_err(|error| format!("component=\"/\": {}", io_error(error)))?;
        for (index, component) in components.iter().enumerate() {
            let final_component = index + 1 == components.len();
            let label: String = component.to_string_lossy().chars().take(96).collect();
            let name =
                CString::new(component.as_bytes()).map_err(|_| "path component contains NUL")?;
            let flags = O_RDONLY
                | O_CLOEXEC
                | O_NOFOLLOW
                | if final_component {
                    O_NONBLOCK
                } else {
                    O_DIRECTORY
                };
            // SAFETY: the directory fd and NUL-terminated name remain alive.
            // O_CREAT is absent, so openat has no fourth mode argument.
            let fd = unsafe { openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return Err(format!(
                    "stage=openat component={label:?} index={index}: {}",
                    io_error(io::Error::last_os_error())
                ));
            }
            // SAFETY: openat returned a new owned fd; File closes it on every exit.
            let mut opened = unsafe { File::from_raw_fd(fd) };
            if final_component {
                let metadata = opened.metadata().map_err(io_error)?;
                if !metadata.is_file() {
                    return Err("opened Node target is not a regular file".into());
                }
                opened.read_exact(&mut [0u8; 1]).map_err(|error| {
                    format!("stage=read component={label:?}: {}", io_error(error))
                })?;
                return Ok(components.len());
            }
            directory = opened;
        }
        Err("Node descriptor walk did not reach a file".into())
    }

    fn readable(path: &Path) -> Probe<()> {
        let mut file = File::open(path).map_err(io_error)?;
        file.read(&mut [0u8; 1]).map_err(io_error)?;
        Ok(()) // Never print system file contents.
    }

    fn resolver_observations() {
        report(
            "resolver hosts read (observation)",
            &readable(Path::new("/private/etc/hosts")),
        );
        match fs::canonicalize("/etc/resolv.conf") {
            Ok(path) => {
                let known_system_path = ["/private/etc", "/private/var/run", "/etc", "/var/run"]
                    .iter()
                    .any(|prefix| path.starts_with(prefix));
                if known_system_path {
                    eprintln!(
                        "[cargo-runtime-smoke] resolv.conf canonical target: {}",
                        path.display()
                    );
                    report(
                        "resolver canonical resolv.conf read (observation)",
                        &readable(&path),
                    );
                } else {
                    eprintln!("[cargo-runtime-smoke] resolv.conf target outside expected system paths; read skipped");
                }
            }
            Err(error) => eprintln!(
                "[cargo-runtime-smoke] resolv.conf canonicalize: {}",
                io_error(error)
            ),
        }
        let socket = Path::new("/var/run/mDNSResponder");
        match fs::canonicalize(socket) {
            Ok(path) => eprintln!(
                "[cargo-runtime-smoke] mDNSResponder canonical target: {}",
                path.display()
            ),
            Err(error) => eprintln!(
                "[cargo-runtime-smoke] mDNSResponder canonicalize: {}",
                io_error(error)
            ),
        }
        let connection = bounded("resolver-socket", || {
            UnixStream::connect("/var/run/mDNSResponder")
                .map(drop)
                .map_err(io_error)
        });
        report(
            "resolver Unix socket connect, no bytes sent (observation)",
            &connection,
        );
    }

    fn serve_once(listener: TcpListener, expected_host: String) -> Probe<()> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, peer)) if peer.ip().is_loopback() => break stream,
                Ok(_) => return Err("unexpected non-loopback HTTP peer".into()),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err("HTTP accept timeout after 2s".into());
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(format!("HTTP accept: {}", io_error(error))),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .map_err(io_error)?;
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .map_err(io_error)?;
        let mut request = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while request.len() < 2048 && Instant::now() < deadline {
            let mut chunk = [0u8; 256];
            let count = stream.read(&mut chunk).map_err(io_error)?;
            if count == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..count]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let request = std::str::from_utf8(&request).map_err(|_| "HTTP request was not UTF-8")?;
        let mut lines = request.lines();
        let path_seen = lines.next() == Some("GET /allowed HTTP/1.1");
        let host_seen =
            lines.any(|line| line.strip_prefix("Host: ") == Some(expected_host.as_str()));
        stream
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .map_err(io_error)?;
        if path_seen && host_seen && request.ends_with("\r\n\r\n") {
            Ok(())
        } else {
            Err(format!(
                "HTTP observation mismatch: path_seen={path_seen} host_seen={host_seen}"
            ))
        }
    }

    fn http_round_trip(ip: IpAddr) -> Probe<()> {
        if !ip.is_loopback() {
            return Err("refusing a non-loopback HTTP address".into());
        }
        let listener = TcpListener::bind(SocketAddr::new(ip, 0))
            .map_err(|error| format!("listener bind: {}", io_error(error)))?;
        listener.set_nonblocking(true).map_err(io_error)?;
        let address = listener.local_addr().map_err(io_error)?;
        let host = format!("localhost:{}", address.port());
        let server_host = host.clone();
        let server = thread::Builder::new()
            .name("loopback-http".into())
            .spawn(move || serve_once(listener, server_host))
            .map_err(io_error)?;
        let client = (|| -> Probe<()> {
            let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
                .map_err(|error| format!("client connect: {}", io_error(error)))?;
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .map_err(io_error)?;
            stream
                .set_write_timeout(Some(Duration::from_secs(1)))
                .map_err(io_error)?;
            write!(
                stream,
                "GET /allowed HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
            )
            .map_err(io_error)?;
            let mut status = [0u8; 12];
            stream.read_exact(&mut status).map_err(io_error)?;
            if &status == b"HTTP/1.1 204" {
                Ok(())
            } else {
                Err("unexpected HTTP response status".into())
            }
        })();
        // Join even when the client fails. The owned listener/streams close by RAII.
        let observed = server.join().map_err(|_| "HTTP server worker panicked")?;
        match (client, observed) {
            (Ok(()), Ok(())) => Ok(()),
            (client, server) => Err(format!("client={client:?}; server={server:?}")),
        }
    }

    #[test]
    fn node_runtime_descriptor_walk_and_read() {
        let result = path_node().and_then(|path| descriptor_read(&path));
        report(
            "Node root dirfd/openat walk and one-byte read; value is component count",
            &result,
        );
        assert!(
            result.is_ok(),
            "required Node descriptor read failed: {result:?}"
        );
    }

    #[test]
    fn numeric_ipv4_and_ipv6_loopback_http() {
        let ipv4 = http_round_trip(IpAddr::V4(Ipv4Addr::LOCALHOST));
        let ipv6 = http_round_trip(IpAddr::V6(Ipv6Addr::LOCALHOST));
        report("numeric IPv4 HTTP GET /allowed and Host observation", &ipv4);
        report("numeric IPv6 HTTP GET /allowed and Host observation", &ipv6);
        assert!(
            ipv4.is_ok() && ipv6.is_ok(),
            "numeric loopback failure: IPv4={ipv4:?}; IPv6={ipv6:?}"
        );
    }

    #[test]
    fn localhost_resolution_and_http_with_resolver_evidence() {
        // Collect resource evidence before asserting anything about name resolution.
        // Missing resources are observations; actual localhost behavior is required.
        resolver_observations();
        let resolved = bounded("localhost-resolve", || {
            ("localhost", 0)
                .to_socket_addrs()
                .map(|addresses| addresses.take(16).collect::<Vec<_>>())
                .map_err(io_error)
        });
        report("localhost ToSocketAddrs", &resolved);
        let result = resolved.and_then(|addresses| {
            if addresses.is_empty() || addresses.iter().any(|address| !address.ip().is_loopback()) {
                return Err("localhost did not resolve exclusively to nonempty loopback addresses; no connections attempted".into());
            }
            // Use a resolved address, retaining localhost in Host. Prefer IPv4 only
            // for repeatability; numeric IPv6 is checked independently above.
            let address = addresses.iter().find(|address| address.is_ipv4()).unwrap_or(&addresses[0]);
            http_round_trip(address.ip())
        });
        report(
            "resolved localhost HTTP GET /allowed and Host observation",
            &result,
        );
        assert!(
            result.is_ok(),
            "required localhost behavior failed: {result:?}"
        );
    }
}
