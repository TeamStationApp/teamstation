package app.teamstation.cameraman

import app.teamstation.cameraman.harness.ControlChannel
import app.teamstation.cameraman.harness.ControlCommand
import org.junit.Assert.assertEquals
import org.junit.Test

class SendDelayCommandTest {

    @Test
    fun `send delay holds the picture back`() {
        assertEquals(
            ControlCommand.SetSendDelay(milliseconds = 300.0, jitter = 50.0, burst = 0.0),
            ControlChannel.command("tscameraman://test/set-send-delay?ms=300&jitter=50")
        )
    }

    @Test
    fun `audio delay holds only the sound back, and omitted fields are zero`() {
        assertEquals(
            ControlCommand.SetAudioDelay(milliseconds = 1500.0, jitter = 0.0, burst = 0.0),
            ControlChannel.command("tscameraman://test/set-audio-delay?ms=1500")
        )
    }
}
