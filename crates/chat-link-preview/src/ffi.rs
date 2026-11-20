//! The worker holds its cancellation handle until the native call has returned.
use super::{read, Kind, PreviewJob};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    ffi::{c_char, CString},
    ptr, slice, str,
};

#[no_mangle]
pub extern "C" fn chat_preview_job() -> *mut PreviewJob {
    Box::into_raw(Box::new(PreviewJob::default()))
}
#[no_mangle]
pub unsafe extern "C" fn chat_preview_cancel(job: *const PreviewJob) {
    if let Some(stop) = job.as_ref() {
        stop.cancel();
    }
}
#[no_mangle]
pub unsafe extern "C" fn chat_preview_release(job: *mut PreviewJob) {
    if !job.is_null() {
        drop(Box::from_raw(job));
    }
}

#[no_mangle]
pub unsafe extern "C" fn chat_preview_read(
    job: *const PreviewJob,
    url: *const u8,
    len: usize,
    kind: i32,
    size: i32,
) -> *mut c_char {
    if job.is_null() || url.is_null() || len > 8192 {
        return ptr::null_mut();
    }
    let Ok(address) = str::from_utf8(slice::from_raw_parts(url, len)) else {
        return ptr::null_mut();
    };
    let kind = match kind {
        0 => Kind::Page,
        1 => Kind::Image,
        2 if size > 0 => Kind::Blob(size as usize),
        _ => return ptr::null_mut(),
    };
    let Some(bytes) = read(address, kind, &*job) else {
        return ptr::null_mut();
    };
    CString::new(STANDARD.encode(bytes))
        .expect("base64 contains no null")
        .into_raw()
}
#[no_mangle]
pub unsafe extern "C" fn chat_preview_free(bytes: *mut c_char) {
    if !bytes.is_null() {
        drop(CString::from_raw(bytes));
    }
}
