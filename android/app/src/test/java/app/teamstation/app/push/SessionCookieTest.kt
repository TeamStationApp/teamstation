package app.teamstation.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The session token out of the cookies the app's networking keeps for the API. */
class SessionCookieTest {
  @Test
  fun readsTheSessionAmongOtherCookies() {
    assertEquals("tok_En-1_", SessionCookie.of("theme=dark; ts_session=tok_En-1_; other=1"))
    assertEquals("only", SessionCookie.of("ts_session=only"))
  }

  @Test
  fun takesTheFirstSessionWithAValueAsIosDoes() {
    // Two for the URL (host-only and `Domain=`, or two paths): the first with a value.
    assertEquals("first", SessionCookie.of("ts_session=first; ts_session=second"))
    assertEquals("second", SessionCookie.of("ts_session=; theme=dark; ts_session=second"))
  }

  @Test
  fun decodesWhatTheServerEncoded() {
    assertEquals("a/b=", SessionCookie.of("ts_session=a%2Fb%3D"))
    assertEquals("é and ü", SessionCookie.decoded("%C3%A9 and %c3%bc"))
    // A plus is a plus, as `decodeURIComponent` and `removingPercentEncoding` read it.
    assertEquals("a+b", SessionCookie.of("ts_session=a+b"))
    assertEquals("a+b/", SessionCookie.of("ts_session=a+b%2F"))
    // Not percent-encoding after all: kept as it came.
    assertEquals("100%", SessionCookie.of("ts_session=100%"))
    assertEquals("%zz1", SessionCookie.decoded("%zz1"))
    assertEquals("%4", SessionCookie.decoded("%4"))
    // Escapes that are not UTF-8.
    assertEquals("%C3%28", SessionCookie.decoded("%C3%28"))
  }

  @Test
  fun answersNullWithoutOne() {
    assertNull(SessionCookie.of(null))
    assertNull(SessionCookie.of(""))
    assertNull(SessionCookie.of("theme=dark; ts_sessionx=no; flag"))
    // Cleared at sign-out.
    assertNull(SessionCookie.of("ts_session=; theme=dark"))
  }

  @Test
  fun expiresTheSessionCookieTheApiSetsForTheUrl() {
    val cleared = "ts_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly"
    // Host-only at `Path=/`, as `setSessionCookie` sets it, and the same with `Domain=`.
    assertEquals(
        listOf("$cleared; Secure", "$cleared; Secure; Domain=api.example.test"),
        SessionCookie.expiring("https://api.example.test/api/v1"))
    // A plain-HTTP development server's is not `Secure`.
    assertEquals(
        listOf(cleared, "$cleared; Domain=192.168.1.20"),
        SessionCookie.expiring("http://192.168.1.20:9100/api/v1"))
    // No host, nothing to clear.
    assertEquals(emptyList<String>(), SessionCookie.expiring(""))
    assertEquals(emptyList<String>(), SessionCookie.expiring("not a url"))
    assertEquals(emptyList<String>(), SessionCookie.expiring("teamstation:/chat"))
  }
}
