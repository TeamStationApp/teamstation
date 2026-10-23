package app.teamstation.cameraman.sentry

import app.teamstation.observability.NativeSentryPrivacy
import io.sentry.*
import io.sentry.hints.Retryable
import io.sentry.hints.SubmissionResult
import io.sentry.transport.ITransport
import io.sentry.protocol.SentryException
import io.sentry.protocol.SentryStackFrame
import io.sentry.protocol.SentryStackTrace
import io.sentry.transport.RateLimiter
import io.sentry.util.HintUtils
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import org.junit.Assert.*
import org.junit.Test

class NativeTransportTest {
    @Test fun `cached envelopes reconstruct events and discard every attachment before transport`() {
        val serializer = JsonSerializer(SentryOptions())
        val sent = mutableListOf<String>()
        val delegate = object : ITransport {
            override fun send(envelope: SentryEnvelope, hint: Hint) {
                val bytes = ByteArrayOutputStream()
                serializer.serialize(envelope, bytes)
                sent.add(bytes.toString("UTF-8"))
            }
            override fun flush(timeoutMillis: Long) {}
            override fun getRateLimiter(): RateLimiter? = null
            override fun close() {}
            override fun close(restarting: Boolean) {}
        }
        val transport = NativeSentryPrivacy.transport(delegate, serializer)
        val event = SentryEvent().apply {
            setExtra("chat", "private-canary")
            level = SentryLevel.FATAL
            release = "app.teamstation.app@1.0+1"
        }
        val attachment = SentryEnvelopeItem.fromAttachment(serializer, NoOpLogger.getInstance(), Attachment("private-canary".toByteArray(), "chat.txt"), 1000)
        transport.send(SentryEnvelope(event.eventId, null, listOf(SentryEnvelopeItem.fromEvent(serializer, event), attachment)), Hint())
        assertEquals(1, sent.size)
        assertFalse(sent[0].contains("private-canary"))
        assertFalse(sent[0].contains("attachment"))
        assertTrue(sent[0].contains("fatal"))
        for (kind in listOf("TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError")) {
            event.exceptions = listOf(SentryException().apply {
                type = kind; value = "private-canary"
                stacktrace = SentryStackTrace(listOf(SentryStackFrame().apply {
                    filename = "app:///index.android.bundle"; lineno = 1; colno = 12345
                }))
            })
            transport.send(SentryEnvelope(event.eventId, null, listOf(SentryEnvelopeItem.fromEvent(serializer, event), attachment)), Hint())
            val delivered = serializer.deserializeEnvelope(sent.last().byteInputStream())!!.items.first().getEvent(serializer)!!
            assertEquals(kind, delivered.exceptions!!.first().type)
            val frame = delivered.exceptions!!.first().stacktrace!!.frames!!.first()
            assertEquals("index.android.bundle", frame.filename)
            assertEquals(1, frame.lineno)
            assertEquals(12345, frame.colno)
            assertFalse(sent.last().contains("private-canary"))
            assertFalse(sent.last().contains("attachment"))
        }
        for (column in listOf(-1, 100_000_001)) {
            event.exceptions!!.first().stacktrace!!.frames!!.first().colno = column
            assertNull(NativeSentryPrivacy.scrub(event).exceptions!!.first().stacktrace!!.frames!!.first().colno)
        }
        val deliveredCount = sent.size
        val result = object : Retryable, SubmissionResult {
            var retryValue = true
            var success = false
            override fun setRetry(value: Boolean) { retryValue = value }
            override fun isRetry() = retryValue
            override fun setResult(value: Boolean) { success = value }
            override fun isSuccess() = success
        }
        transport.send(SentryEnvelope(event.eventId, null, listOf(attachment)), HintUtils.createWithTypeCheckHint(result))
        assertTrue(result.success)
        assertFalse(result.retryValue)
        assertEquals(deliveredCount, sent.size)
        // A corrupt cached event must never be forwarded as raw bytes.
        val malformed = "{}\n{\"type\":\"event\",\"length\":3}\nbad\n"
        val envelope = serializer.deserializeEnvelope(ByteArrayInputStream(malformed.toByteArray()))!!
        transport.send(envelope, Hint())
        assertEquals(deliveredCount, sent.size)
    }
}
