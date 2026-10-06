/*
 * The chat crypto core's C ABI (crates/chat-crypto/src/abi.rs).
 *
 * chat_crypto_call takes an op from src/common/chatCrypto/ops.json and its
 * arguments, each as a 4-byte big-endian length then the bytes, and hands
 * back `0 ‖ results` (each length-prefixed) or `1 ‖ reason`. The caller frees
 * the result with chat_crypto_free(*out, *out_len). The return value is 0.
 */
#ifndef CHAT_CRYPTO_H
#define CHAT_CRYPTO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int32_t chat_crypto_call(uint32_t op, const uint8_t *input, size_t input_len,
                         uint8_t **out, size_t *out_len);
void chat_crypto_free(uint8_t *pointer, size_t length);
uint8_t *chat_crypto_alloc(size_t length);

#ifdef __cplusplus
}
#endif

#endif
