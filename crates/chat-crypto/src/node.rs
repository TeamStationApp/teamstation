//! The Node-API binding: `call(op, input)` for the server, the scripts and
//! the tests, over the same dispatch as every other platform.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi]
pub fn call(op: u32, input: Buffer) -> Buffer {
    Buffer::from(crate::abi::call_bytes(op, &input))
}
