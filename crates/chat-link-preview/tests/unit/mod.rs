use super::*;
use ureq::http::Response;

// Each scenario owns the production two-job pool for its duration.
static WORKERS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn response(
    status: u16,
    mime: &str,
    bytes: Vec<u8>,
    length: Option<usize>,
) -> Response<ureq::Body> {
    let mut headers = Response::builder()
        .status(status)
        .header("content-type", mime);
    if let Some(n) = length {
        headers = headers.header("content-length", n);
    }
    headers.body(ureq::Body::builder().data(bytes)).unwrap()
}

fn consume(response: Response<ureq::Body>, kind: Kind) -> Option<Vec<u8>> {
    read_response(
        response,
        kind,
        kind.limit()?,
        &AtomicBool::new(false),
        Instant::now() + DEADLINE,
    )
}

#[test]
fn reads_variable_length_pages_and_exact_length_blobs() {
    let page = vec![b'a'; HTML_LIMIT];
    assert_eq!(
        consume(
            response(200, "Text/HTML; charset=utf-8", page.clone(), None),
            Kind::Page
        ),
        Some(page)
    );
    let data = vec![0, 1, 2];
    assert_eq!(
        consume(response(200, "", data.clone(), Some(3)), Kind::Blob(3)),
        Some(data)
    );
    assert!(consume(response(200, "", vec![1], None), Kind::Blob(2)).is_none());
    assert!(Kind::Blob(0).limit().is_none());
    assert!(Kind::Blob(128 * 1024 + 1).limit().is_none());
}

#[test]
fn refuses_unsuitable_responses_before_display() {
    assert!(consume(response(302, "text/html", vec![], None), Kind::Page).is_none());
    assert!(consume(response(200, "text/plain", vec![], None), Kind::Page).is_none());
    assert!(consume(response(200, "text/html", vec![], None), Kind::Image).is_none());
    assert!(consume(
        response(200, "text/html", vec![], Some(HTML_LIMIT + 1)),
        Kind::Page
    )
    .is_none());
    assert!(consume(
        response(200, "text/html", vec![0; HTML_LIMIT + 1], None),
        Kind::Page
    )
    .is_none());
    assert!(consume(response(200, "image/jpeg", vec![1], None), Kind::Image).is_none());
    for (stop, until) in [(true, Instant::now() + DEADLINE), (false, Instant::now())] {
        assert!(read_response(
            response(200, "text/html", vec![1], None),
            Kind::Page,
            HTML_LIMIT,
            &AtomicBool::new(stop),
            until
        )
        .is_none());
    }
}

#[test]
fn decodes_declared_page_encoding_within_the_output_limit() {
    let mime = "text/html; charset=\"windows-1252\"";
    assert_eq!(
        consume(response(200, mime, b"Caf\xe9".to_vec(), None), Kind::Page),
        Some("Café".as_bytes().to_vec())
    );
    assert!(consume(
        response(200, mime, vec![0xe9; HTML_LIMIT], None),
        Kind::Page
    )
    .is_none());
}

#[test]
fn cancellation_interrupts_an_active_header_or_body_read() {
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };
    let _workers = WORKERS.lock().unwrap();
    for send_headers in [false, true] {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = format!("http://{}/fixture", server.local_addr().unwrap());
        let (held, reached) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let fixture = thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut line = String::new();
            let mut reader = BufReader::new(&stream);
            while reader.read_line(&mut line).unwrap() > 0 && line != "\r\n" {
                line.clear();
            }
            if send_headers {
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 32\r\n\r\n<").unwrap();
            }
            held.send(()).unwrap();
            let _ = released.recv_timeout(DEADLINE);
        });
        let job = Arc::new(PreviewJob::default());
        let active = job.clone();
        let (finished, result) = mpsc::channel();
        let worker = thread::spawn(move || {
            let client: ureq::Agent = Config::builder()
                .proxy(None)
                .timeout_global(Some(DEADLINE))
                .build()
                .into();
            assert!(active.attach(&client));
            let page = client.get(address).call().ok().and_then(|response| {
                read_response(
                    response,
                    Kind::Page,
                    HTML_LIMIT,
                    &active.stopped,
                    Instant::now() + DEADLINE,
                )
            });
            finished.send(page).unwrap();
        });
        reached.recv_timeout(DEADLINE).unwrap();
        job.cancel();
        assert!(result
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_none());
        release.send(()).unwrap();
        worker.join().unwrap();
        fixture.join().unwrap();
    }
}

#[test]
fn only_public_resolution_results_reach_the_connector() {
    use ureq::unversioned::transport::{ConnectionDetails, Connector};
    #[derive(Debug)]
    struct Record(Arc<Mutex<Vec<SocketAddr>>>);
    impl Connector for Record {
        type Out = ();
        fn connect(
            &self,
            details: &ConnectionDetails,
            _: Option<()>,
        ) -> Result<Option<()>, ureq::Error> {
            self.0.lock().unwrap().extend(details.addrs.iter().copied());
            Err(ureq::Error::HostNotFound)
        }
    }
    let _workers = WORKERS.lock().unwrap();
    fn fixture(host: &str) -> std::io::Result<std::vec::IntoIter<SocketAddr>> {
        let v4 = "93.184.216.34:80".parse().unwrap();
        let v6 = "[2606:4700:4700::1111]:80".parse().unwrap();
        let addresses = match host {
            "mixed.example.org:80" => {
                let mut result = vec![v4; 16];
                result.push("192.168.0.4:80".parse().unwrap());
                result
            }
            "public.example.org:80" => vec![v4, v6],
            "empty.example.org:80" => vec![],
            _ => return Err(std::io::ErrorKind::NotFound.into()),
        };
        Ok(addresses.into_iter())
    }
    for name in ["mixed", "empty", "missing", "public"] {
        let connected = Arc::new(Mutex::new(vec![]));
        let agent = ureq::Agent::with_parts(
            Config::builder().proxy(None).build(),
            Record(connected.clone()),
            PublicResolver {
                lookup: fixture,
                stop: Arc::new(AtomicBool::new(false)),
                until: Instant::now() + DEADLINE,
            },
        );
        assert!(agent
            .get(format!("http://{name}.example.org/page"))
            .call()
            .is_err());
        let observed = connected.lock().unwrap();
        if name == "public" {
            assert_eq!(
                observed.as_slice(),
                &[
                    "93.184.216.34:80".parse::<SocketAddr>().unwrap(),
                    "[2606:4700:4700::1111]:80".parse().unwrap()
                ]
            );
        } else {
            assert!(observed.is_empty());
        }
    }
}

#[test]
fn scales_each_supported_raster_to_a_jpeg() {
    for (format, mime) in [
        (ImageFormat::Png, "image/png"),
        (ImageFormat::Jpeg, "image/jpeg"),
        (ImageFormat::WebP, "image/webp"),
    ] {
        let input = image::RgbImage::new(800, 400);
        let mut encoded = Cursor::new(Vec::new());
        input.write_to(&mut encoded, format).unwrap();
        let bytes = encoded.into_inner();
        assert!(thumbnail(&bytes, "text/plain").is_none());
        let result = consume(response(200, mime, bytes, None), Kind::Image).unwrap();
        assert!(result.len() <= THUMBNAIL_LIMIT);
        let reader = ImageReader::new(Cursor::new(result))
            .with_guessed_format()
            .unwrap();
        assert_eq!(reader.format(), Some(ImageFormat::Jpeg));
        assert_eq!(reader.into_dimensions().unwrap(), (480, 240));
    }
}

#[test]
fn bounds_concurrent_work_and_releases_every_permit() {
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    let first = WorkPermit::take(&COUNT).unwrap();
    let second = WorkPermit::take(&COUNT).unwrap();
    assert!(WorkPermit::take(&COUNT).is_none());
    drop(first);
    assert!(WorkPermit::take(&COUNT).is_some());
    drop(second);
    assert_eq!(COUNT.load(Ordering::Acquire), 0);
}

#[test]
fn canceled_and_reserved_destinations_are_unavailable() {
    let _workers = WORKERS.lock().unwrap();
    let cancel = PreviewJob::default();
    cancel.cancel();
    for url in [
        "",
        "https://example.test/",
        "https://example.com/",
        "file:///example",
        "http://localhost/",
        "http://user@example.test/",
    ] {
        assert!(read(url, Kind::Page, &cancel).is_none());
    }
    let resolver = PublicResolver {
        lookup: resolve_endpoint,
        stop: Arc::new(AtomicBool::new(false)),
        until: Instant::now() + DEADLINE,
    };
    for address in ["127.0.0.1", "203.0.113.4", "::1", "2001:db8::1", "3fff::1"] {
        assert!(!public(address.parse().unwrap()));
    }
    let uri: Uri = "http://127.0.0.1".parse().unwrap();
    assert!(resolver
        .resolve(&uri, &Config::default(), NextTimeout::default())
        .is_err());
    resolver.stop.store(true, Ordering::Release);
    assert!(resolver
        .resolve(&uri, &Config::default(), NextTimeout::default())
        .is_err());
}

#[test]
fn native_callers_can_cancel_release_and_reject_invalid_input() {
    let _workers = WORKERS.lock().unwrap();
    use super::ffi::*;
    use std::ptr;
    let address = b"https://example.test/";
    unsafe {
        let job = chat_preview_job();
        assert!(!(&*job).stopped.load(Ordering::Acquire));
        chat_preview_cancel(job);
        assert!((&*job).stopped.load(Ordering::Acquire));
        for (kind, size) in [(0, 0), (1, 0), (2, 1), (2, 0), (3, 0)] {
            assert!(chat_preview_read(job, address.as_ptr(), address.len(), kind, size).is_null());
        }
        assert!(chat_preview_read(job, [0xff].as_ptr(), 1, 0, 0).is_null());
        assert!(chat_preview_read(job, ptr::null(), 0, 0, 0).is_null());
        assert!(chat_preview_read(job, address.as_ptr(), 8193, 0, 0).is_null());
        assert!(chat_preview_read(ptr::null(), address.as_ptr(), address.len(), 0, 0).is_null());
        chat_preview_release(job);
        chat_preview_cancel(ptr::null());
        chat_preview_release(ptr::null_mut());
        chat_preview_free(ptr::null_mut());
    }
}

/// The device integration lane supplies a controlled public, HTML page. This
/// also exercises the system resolver and TLS roots used by the shipping core.
#[test]
#[ignore = "requires a public preview QA fixture"]
fn public_page_crosses_the_native_abi() {
    let _workers = WORKERS.lock().unwrap();
    use super::ffi::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::ffi::CStr;
    let address = std::env::var("CHAT_PREVIEW_TEST_PAGE").expect("public fixture URL");
    let marker = std::env::var("CHAT_PREVIEW_TEST_MARKER").expect("fixture title");
    unsafe {
        let job = chat_preview_job();
        let output = chat_preview_read(job, address.as_ptr(), address.len(), 0, 0);
        chat_preview_release(job);
        assert!(!output.is_null(), "No HTML returned for public fixture");
        let html = STANDARD.decode(CStr::from_ptr(output).to_bytes()).unwrap();
        chat_preview_free(output);
        assert!(String::from_utf8_lossy(&html).contains(&marker));
    }
}
