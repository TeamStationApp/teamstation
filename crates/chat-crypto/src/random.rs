//! Randomness: every key, nonce, id and link code comes from here.
//!
//! On macOS, Linux, iOS and Android `getrandom` asks the operating system.
//! The browser's module has no operating system: it imports
//! `env.chat_crypto_random(ptr, len)`, which the loader (`wasmCore.ts`) fills
//! from `crypto.getRandomValues` in calls of at most 65,536 bytes, and that is
//! registered here as getrandom's custom source.

use crate::error::{Refusal, Result};

#[cfg(target_arch = "wasm32")]
mod wasm {
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn chat_crypto_random(ptr: *mut u8, len: usize);
    }

    pub fn fill(dest: &mut [u8]) -> Result<(), getrandom::Error> {
        // SAFETY: the loader writes exactly `len` bytes at `ptr`, inside this
        // module's memory, and nothing else.
        unsafe { chat_crypto_random(dest.as_mut_ptr(), dest.len()) };
        Ok(())
    }

    getrandom::register_custom_getrandom!(fill);
}

pub fn fill(dest: &mut [u8]) -> Result<()> {
    getrandom::getrandom(dest).map_err(|_| Refusal::Malformed)
}

pub fn bytes(length: usize) -> Result<Vec<u8>> {
    let mut out = vec![0u8; length];
    fill(&mut out)?;
    Ok(out)
}

pub fn array<const N: usize>() -> Result<[u8; N]> {
    let mut out = [0u8; N];
    fill(&mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_differ() {
        let a: [u8; 32] = array().unwrap();
        let b: [u8; 32] = array().unwrap();
        assert_ne!(a, b);
        assert_eq!(bytes(65536 * 2 + 5).unwrap().len(), 65536 * 2 + 5);
        assert!(bytes(0).unwrap().is_empty());
    }
}
