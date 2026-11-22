//! Bounded mobile downloads for outgoing previews and encrypted attachment thumbnails.
#[cfg(feature = "mobile-crypto")]
extern crate chat_crypto;

use image::{codecs::jpeg::JpegEncoder, ImageFormat, ImageReader, Limits};
use ip_network::{Ipv4Network, Ipv6Network};
use std::{
    io::{Cursor, Read},
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use ureq::{
    config::Config,
    http::Uri,
    unversioned::{
        resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver},
        transport::{DefaultConnector, NextTimeout},
    },
};

const DEADLINE: Duration = Duration::from_secs(5);
const HTML_LIMIT: usize = 256 * 1024;
const IMAGE_LIMIT: usize = 2 * 1024 * 1024;
const THUMBNAIL_LIMIT: usize = 96 * 1024;
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static RESOLVING: AtomicUsize = AtomicUsize::new(0);

struct WorkPermit(&'static AtomicUsize);
impl WorkPermit {
    fn take(counter: &'static AtomicUsize) -> Option<Self> {
        counter
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 2).then_some(n + 1)
            })
            .ok()
            .map(|_| Self(counter))
    }
}
impl Drop for WorkPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            Ipv4Network::from(ip).is_global()
                && !ip.is_multicast()
                && ip.octets()[..3] != [192, 88, 99]
        }
        IpAddr::V6(ip) => {
            let [first, second, ..] = ip.segments();
            first >> 13 == 1
                && first != 0x2002
                && !(first == 0x2001 && (second < 0x0200 || second == 0x0db8))
                && !(first == 0x3fff && second < 0x1000)
                && Ipv6Network::from(ip).is_unicast_global()
        }
    }
}

/// One native read owns one agent. Shutting it down wakes TLS and socket reads.
#[derive(Default)]
pub struct PreviewJob {
    stopped: Arc<AtomicBool>,
    agent: Mutex<Option<ureq::Agent>>,
}
impl PreviewJob {
    fn attach(&self, agent: &ureq::Agent) -> bool {
        let mut active = self.agent.lock().unwrap();
        if self.stopped.load(Ordering::Acquire) {
            return false;
        }
        *active = Some(agent.clone());
        true
    }
    pub fn cancel(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(agent) = self.agent.lock().unwrap().take() {
            agent.shutdown();
        }
    }
}

fn resolve_endpoint(host: &str) -> std::io::Result<std::vec::IntoIter<SocketAddr>> {
    host.to_socket_addrs()
}

#[derive(Debug)]
struct PublicResolver {
    lookup: fn(&str) -> std::io::Result<std::vec::IntoIter<SocketAddr>>,
    stop: Arc<AtomicBool>,
    until: Instant,
}
impl PublicResolver {
    fn live(&self) -> bool {
        !self.stop.load(Ordering::Acquire) && Instant::now() < self.until
    }
}
impl Resolver for PublicResolver {
    fn resolve(
        &self,
        uri: &Uri,
        _: &Config,
        _: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        if !self.live() {
            return Err(ureq::Error::HostNotFound);
        }
        let authority = uri
            .authority()
            .ok_or(ureq::Error::BadUri("No authority".into()))?;
        let scheme = uri
            .scheme()
            .ok_or(ureq::Error::BadUri("No scheme".into()))?;
        let endpoint =
            DefaultResolver::host_and_port(scheme, authority).ok_or(ureq::Error::HostNotFound)?;
        // OS name resolution can outlive a request. A bounded pool of lookup
        // threads lets the calling worker stop at its deadline or cancellation,
        // and a lookup still holding its thread delays the next until then.
        let permit = loop {
            if let Some(permit) = WorkPermit::take(&RESOLVING) {
                break permit;
            }
            if !self.live() {
                return Err(ureq::Error::HostNotFound);
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let lookup = self.lookup;
        std::thread::Builder::new().spawn(move || {
            let _permit = permit;
            let _ = tx.send(lookup(&endpoint));
        })?;
        let addresses = loop {
            let remaining = self.until.saturating_duration_since(Instant::now());
            if !self.live() {
                return Err(ureq::Error::HostNotFound);
            }
            match rx.recv_timeout(remaining.min(Duration::from_millis(50))) {
                Ok(result) => break result?,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err(ureq::Error::HostNotFound),
            }
        };
        let mut checked = self.empty();
        for addr in addresses {
            if !public(addr.ip()) {
                return Err(ureq::Error::HostNotFound);
            }
            if checked.len() < 16 {
                checked.push(addr)
            }
        }
        if checked.is_empty() || !self.live() {
            return Err(ureq::Error::HostNotFound);
        }
        Ok(checked)
    }
}

#[derive(Clone, Copy)]
pub enum Kind {
    Page,
    Image,
    Blob(usize),
}
impl Kind {
    fn limit(self) -> Option<usize> {
        match self {
            Self::Page => Some(HTML_LIMIT),
            Self::Image => Some(IMAGE_LIMIT),
            Self::Blob(n) if n > 0 && n <= 128 * 1024 => Some(n),
            _ => None,
        }
    }
}

fn thumbnail(bytes: &[u8], mime: &str) -> Option<Vec<u8>> {
    let format = image::guess_format(bytes).ok()?;
    if !matches!(
        (format, mime),
        (ImageFormat::Jpeg, "image/jpeg")
            | (ImageFormat::Png, "image/png")
            | (ImageFormat::WebP, "image/webp")
    ) {
        return None;
    }
    let reader = || ImageReader::with_format(Cursor::new(bytes), format);
    let (w, h) = reader().into_dimensions().ok()?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 12_000_000 {
        return None;
    }
    let mut decoder = reader();
    let mut limits = Limits::default();
    limits.max_image_width = Some(w);
    limits.max_image_height = Some(h);
    limits.max_alloc = Some(96 * 1024 * 1024);
    decoder.limits(limits);
    let scaled = decoder.decode().ok()?.thumbnail(480, 320).to_rgb8();
    let mut jpg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpg, 76)
        .encode_image(&scaled)
        .ok()?;
    (jpg.len() <= THUMBNAIL_LIMIT).then_some(jpg)
}

pub fn read(address: &str, kind: Kind, job: &PreviewJob) -> Option<Vec<u8>> {
    let _permit = WorkPermit::take(&ACTIVE)?;
    let until = Instant::now() + DEADLINE;
    let limit = kind.limit()?;
    let uri: Uri = address.parse().ok()?;
    let host = uri.host()?.trim_end_matches('.').to_ascii_lowercase();
    if address.len() > 8192
        || !matches!(uri.scheme_str(), Some("http" | "https"))
        || uri.authority()?.as_str().contains('@')
        || (!host.contains('.') && !host.contains(':'))
        || [
            "localhost",
            "local",
            "lan",
            "home",
            "internal",
            "test",
            "invalid",
            "example",
            "onion",
            "arpa",
            "localdomain",
        ]
        .contains(&host.rsplit('.').next()?)
    {
        return None;
    }
    let client = ureq::Agent::with_parts(
        Config::builder()
            .proxy(None)
            .max_redirects(0)
            .timeout_global(Some(DEADLINE))
            .build(),
        DefaultConnector::new(),
        PublicResolver {
            lookup: resolve_endpoint,
            stop: job.stopped.clone(),
            until,
        },
    );
    if !job.attach(&client) {
        return None;
    }
    let response = client.get(address).call().ok()?;
    read_response(response, kind, limit, &job.stopped, until)
}

fn read_response(
    mut response: ureq::http::Response<ureq::Body>,
    kind: Kind,
    limit: usize,
    cancel: &AtomicBool,
    until: Instant,
) -> Option<Vec<u8>> {
    if !response.status().is_success() {
        return None;
    }
    let mime = response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase();
    if matches!(kind, Kind::Page) && mime != "text/html"
        || matches!(kind, Kind::Image)
            && !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp")
    {
        return None;
    }
    if !matches!(kind, Kind::Page)
        && response
            .headers()
            .get("content-length")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<usize>().ok())
            .is_some_and(|n| n > limit)
    {
        return None;
    }
    let encoding = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(';')
                .skip(1)
                .filter_map(|part| part.split_once('='))
                .find(|(name, _)| name.trim().eq_ignore_ascii_case("charset"))
        })
        .and_then(|(_, label)| {
            encoding_rs::Encoding::for_label(label.trim().trim_matches('"').as_bytes())
        })
        .unwrap_or(encoding_rs::UTF_8);
    let mut bytes = Vec::new();
    let mut stream = response.body_mut().as_reader();
    let mut block = [0; 8192];
    loop {
        if cancel.load(Ordering::Acquire) || Instant::now() >= until {
            return None;
        }
        // A page needs only its leading metadata. Images and encrypted blobs
        // must fit in their entirety before the decoder sees them.
        let page = matches!(kind, Kind::Page);
        let capacity = if page {
            block.len().min(limit - bytes.len())
        } else {
            block.len()
        };
        if capacity == 0 {
            break;
        }
        let n = stream.read(&mut block[..capacity]).ok()?;
        if n == 0 {
            break;
        }
        if n > limit - bytes.len() {
            return None;
        }
        bytes.extend_from_slice(&block[..n]);
    }
    let result = match kind {
        Kind::Page => {
            let (text, _, _) = encoding.decode(&bytes);
            // A legacy charset or a partial final code point can expand on conversion.
            let mut text = text.into_owned();
            text.truncate(text.floor_char_boundary(limit.min(text.len())));
            text.into_bytes()
        }
        Kind::Image => thumbnail(&bytes, &mime)?,
        Kind::Blob(n) if bytes.len() != n => return None,
        _ => bytes,
    };
    (!cancel.load(Ordering::Acquire) && Instant::now() < until).then_some(result)
}

mod ffi;

#[cfg(test)]
#[path = "../tests/unit/mod.rs"]
mod tests;
