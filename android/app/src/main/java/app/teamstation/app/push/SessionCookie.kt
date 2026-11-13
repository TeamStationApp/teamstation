package app.teamstation.app.push

import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * The API's session cookie (`ts_session`, the session's own token) in the jar
 * React Native's networking keeps (`CookieManager`), which sends it on every
 * request. Read by the same rule as iOS (`TSPushCenter.sessionToken`): the
 * first `ts_session` with a value (`getCookie` gives only those unexpired),
 * percent-decoded as `decodeURIComponent` does, `+` left alone.
 */
object SessionCookie {
  const val NAME = "ts_session"

  /** The token in [cookies], `CookieManager.getCookie`'s header for a URL, or null for none. */
  fun of(cookies: String?): String? {
    if (cookies == null) return null
    for (part in cookies.split(';')) {
      val at = part.indexOf('=')
      if (at < 0 || part.substring(0, at).trim() != NAME) continue
      val value = part.substring(at + 1).trim()
      if (value.isNotEmpty()) return decoded(value)
    }
    return null
  }

  /**
   * [value] with its `%XX` escapes decoded as UTF-8, or as it came when it
   * is not percent-encoding after all.
   */
  fun decoded(value: String): String {
    if ('%' !in value) return value
    val bytes = ByteArrayOutputStream()
    var at = 0
    while (at < value.length) {
      if (value[at] != '%') {
        val next = value.indexOf('%', at).let { if (it < 0) value.length else it }
        bytes.write(value.substring(at, next).toByteArray(Charsets.UTF_8))
        at = next
        continue
      }
      val high = value.getOrNull(at + 1)?.digitToIntOrNull(16)
      val low = value.getOrNull(at + 2)?.digitToIntOrNull(16)
      if (high == null || low == null) return value
      bytes.write(high * 16 + low)
      at += 3
    }
    return try {
      Charsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes.toByteArray()))
          .toString()
    } catch (_: CharacterCodingException) {
      value
    }
  }

  /**
   * The `Set-Cookie` values that take the session cookie for [url] out of
   * the jar: the one the API sets (host-only, `Path=/`), and one set with
   * `Domain=` for the same host. Empty for a URL with no host.
   */
  fun expiring(url: String): List<String> {
    val address = runCatching { URI(url) }.getOrNull() ?: return emptyList()
    val host = address.host?.takeIf { it.isNotEmpty() } ?: return emptyList()
    val secure = if (address.scheme.equals("https", ignoreCase = true)) "; Secure" else ""
    val cleared =
        "$NAME=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly$secure"
    return listOf(cleared, "$cleared; Domain=$host")
  }
}
