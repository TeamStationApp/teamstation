package app.teamstation.cameraman.sentry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as the TeamStation app's `src/common/sentry/sentry.test.ts`. */
class SentryRulesTest {
    @Test
    fun `filters secrets out of text`() {
        val cases = listOf(
            "https://app.example.test/signin/abc123" to "https://app.example.test/signin/[Filtered]",
            "/i/INVITE42?ref=x" to "/i/[Filtered]",
            "https://app.example.test/c/invite/INVITE42" to "https://app.example.test/c/invite/[Filtered]",
            "GET /api/v1/oauth/approvals/h4ndleAbc_-123" to "GET /api/v1/oauth/approvals/[Filtered]",
            "teamstation:///oauth/native-approval/h4ndleAbc_-123" to "teamstation:///oauth/native-approval/[Filtered]",
            "undefined is not a function (evaluating 'a?.b()')" to "undefined is not a function (evaluating 'a?.b()')",
            "Unexpected token '?'" to "Unexpected token '?'",
            "POST /api/v1/join/INVITE42/redeem" to "POST /api/v1/join/[Filtered]/redeem",
            "/media/1700000000/sig_abc/videos/9/hls/x.m3u8" to "/media/[Filtered]/videos/9/hls/x.m3u8",
            "rtmps://live.example.test:1936/live/streamkey123" to "rtmps://live.example.test:1936/live/[Filtered]",
            "rtmp://live.example.test/streamkey123" to "rtmp://live.example.test/[Filtered]",
            "/api/v1/teams?token" to "/api/v1/teams",
            "/api/v1/teams?token=abc&x=1" to "/api/v1/teams",
            "sign-in code for ruth@example.test: 123456" to "sign-in code for [email]: 123456",
            "Why did it fail?" to "Why did it fail?",
        )
        for ((input, output) in cases) assertEquals(input, output, SentryRules.scrubText(input))
    }

    @Test
    fun `filters secret-named fields at any depth, and keeps status codes`() {
        @Suppress("UNCHECKED_CAST")
        val out = SentryRules.scrubMap(
            mapOf(
                "a" to mapOf("clientHash" to "h", "nested" to listOf(mapOf("token" to "t"))),
                "streamKey" to "k",
                "sessionId" to "s",
                "status_code" to 400,
                "http.response.status_code" to 500,
                "errorCode" to "E_FAIL",
                "csrfToken" to "x",
                "count" to 3,
                "link" to "/signin/abc",
            )
        )
        val inner = out["a"] as Map<String, Any?>
        assertEquals(SentryRules.FILTERED, inner["clientHash"])
        assertEquals(SentryRules.FILTERED, ((inner["nested"] as List<*>)[0] as Map<*, *>)["token"])
        assertEquals(SentryRules.FILTERED, out["streamKey"])
        assertEquals(SentryRules.FILTERED, out["sessionId"])
        assertEquals(400, out["status_code"])
        assertEquals(500, out["http.response.status_code"])
        assertEquals("E_FAIL", out["errorCode"])
        assertEquals(SentryRules.FILTERED, out["csrfToken"])
        assertEquals(3, out["count"])
        assertEquals("/signin/[Filtered]", out["link"])
        assertTrue(SentryRules.isSecret("authorization"))
        assertFalse(SentryRules.isSecret("statusCode"))
    }

    @Test
    fun `stops at a depth limit`() {
        var deep: Any = mapOf("leaf" to 1)
        repeat(12) { deep = mapOf("next" to deep) }
        assertTrue(SentryRules.scrubValue(deep).toString().contains(SentryRules.FILTERED))
        assertNull(SentryRules.scrubValue(null))
    }

    @Test
    fun `drops every secret-named header`() {
        assertEquals(
            mapOf("User-Agent" to "ua", "Referer" to "/i/[Filtered]"),
            SentryRules.scrubHeaders(
                mapOf(
                    "Authorization" to "Bearer t",
                    "Cookie" to "c",
                    "X-OAuth-CSRF" to "x",
                    "X-Api-Key" to "k",
                    "User-Agent" to "ua",
                    "Referer" to "/i/abc",
                )
            ),
        )
    }

    @Test
    fun `names the release and environment`() {
        assertEquals("app.teamstation.cameraman@1.0+42" to "42", SentryRules.release("app.teamstation.cameraman", "1.0", "42"))
        assertEquals("app.teamstation.cameraman@1.0" to null, SentryRules.release("app.teamstation.cameraman", "1.0", ""))
        val cases = listOf(
            "app.teamstation.app" to "production",
            "" to "production",
            null to "production",
            "develop6.example.test" to "develop6",
            "localhost:9100" to "development",
            "192.168.1.20" to "development",
            "[::1]" to "development",
            "host.local" to "development",
        )
        for ((host, environment) in cases) assertEquals(host.toString(), environment, SentryRules.environment(host))
    }

    @Test
    fun `reads the test trigger`() {
        assertEquals("error", SentryRules.test("error"))
        assertEquals("crash", SentryRules.test("crash"))
        assertNull(SentryRules.test("other"))
        assertNull(SentryRules.test(null))
    }
}
