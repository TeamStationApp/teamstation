package app.teamstation.app.stream

import android.content.pm.ServiceInfo
import app.teamstation.app.stream.PhoneStreamService.Action
import app.teamstation.app.stream.PhoneStreamService.Book
import app.teamstation.app.stream.PhoneStreamService.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** When the foreground service is started, retyped and stopped, and what it shows. */
class PhoneStreamServiceTest {
    private val camera = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    private val dataSync = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC

    @Test
    fun workThatEndsBeforeTheServiceStartsIsStoppedByTheServiceAfterItsStartForeground() {
        val book = Book()
        // An upload starts and its export fails at once: the start is still on its way.
        assertEquals(Action.START, book.changed { it.copy(uploading = "Home Plate") }.second)
        assertEquals(Action.NONE, book.changed { it.copy(uploading = null) }.second)
        // The service still names the work it was started for, then stops itself.
        val shown = book.shown(State(uploading = "Home Plate"))
        assertEquals(State(uploading = "Home Plate"), shown)
        assertEquals(dataSync, book.types(shown))
        assertTrue(book.afterStart(started = true))
        // With nothing running, the next end of work has nothing to stop.
        assertEquals(Action.NONE, book.changed { it }.second)
    }

    @Test
    fun aServiceInTheForegroundIsStoppedOnceTheWorkEnds() {
        val book = Book()
        book.changed { it.copy(recording = "Home Plate") }
        assertEquals(State(recording = "Home Plate"), book.shown(State(recording = "Home Plate")))
        assertFalse(book.afterStart(started = true))
        // Retyped for an upload alongside, then both end.
        assertEquals(Action.START, book.changed { it.copy(uploading = "First Base") }.second)
        assertEquals(camera or dataSync, book.types(book.shown(null)))
        assertFalse(book.afterStart(started = true))
        assertEquals(Action.START, book.changed { it.copy(recording = null) }.second)
        assertFalse(book.afterStart(started = true))
        assertEquals(Action.STOP, book.changed { it.copy(uploading = null) }.second)
        book.destroyed()
        assertEquals(Action.NONE, book.changed { it }.second)
    }

    @Test
    fun aFailedRetypeKeepsTheForegroundAndAFailedFirstStartStops() {
        val book = Book()
        book.changed { it.copy(recording = "Home Plate") }
        // The first startForeground is refused: there is no foreground to keep.
        assertTrue(book.afterStart(started = false))
        book.changed { it.copy(recording = "Home Plate") }
        assertFalse(book.afterStart(started = true))
        // A retype is refused: the service keeps protecting the recording as it was.
        book.changed { it.copy(uploading = "First Base") }
        assertFalse(book.afterStart(started = false))
        assertEquals(State("Home Plate", "First Base"), book.state)
    }

    @Test
    fun aRefusedStartIsNotWaitedFor() {
        val book = Book()
        book.changed { it.copy(uploading = "Home Plate") }
        book.startFailed()
        book.startFailed()
        assertEquals(Action.NONE, book.changed { it.copy(uploading = null) }.second)
    }

    @Test
    fun aNewerStartOnItsWayKeepsTheServiceAlive() {
        val book = Book()
        book.changed { it.copy(recording = "Home Plate") }
        book.changed { it.copy(recording = null) }
        book.changed { it.copy(recording = "First Base") }
        // The first start finds the work ended and started again: a start is still on its way.
        assertFalse(book.afterStart(started = true))
        assertFalse(book.afterStart(started = true))
        assertEquals(State(recording = "First Base"), book.shown(null))
    }

    @Test
    fun aStartWithNothingToNameShowsTheAppAndAsksForDataSync() {
        val book = Book()
        val shown = book.shown(null)
        assertEquals(State(), shown)
        assertEquals("TeamStation", PhoneStreamService.title(shown))
        assertEquals(dataSync, book.types(shown))
    }

    @Test
    fun theDataSyncTimeoutDropsToTheRecordingOrStops() {
        val book = Book()
        book.changed { it.copy(recording = "Home Plate", uploading = "First Base") }
        assertFalse(book.afterStart(started = true))
        val remaining = book.dataSyncTimedOut()
        assertEquals(State("Home Plate", "First Base"), remaining)
        assertEquals(camera, book.types(remaining!!))
        // A new upload, after this one finishes, tries dataSync again.
        book.changed { it.copy(uploading = null) }
        book.changed { it.copy(uploading = "Third Base") }
        assertEquals(camera or dataSync, book.types(book.shown(null)))
        // Uploading alone, the timeout leaves nothing to keep the service.
        val uploadOnly = Book()
        uploadOnly.changed { it.copy(uploading = "Home Plate") }
        assertNull(uploadOnly.dataSyncTimedOut())
    }
}
