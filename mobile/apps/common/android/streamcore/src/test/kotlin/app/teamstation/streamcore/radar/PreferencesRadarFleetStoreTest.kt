package app.teamstation.streamcore.radar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PreferencesRadarFleetStoreTest {
    private val context = RuntimeEnvironment.getApplication()

    @Test
    fun `the serials and the switch persist under the host's keys, and none reads as empty`() {
        val store = PreferencesRadarFleetStore(context, "test.radar", "serials", "on", enabledByDefault = false)
        assertEquals(emptyList<String>(), store.readSerials())
        assertFalse(store.readEnabled())

        store.writeSerials(listOf("ADFA0000001", "ADFA0000002"))
        store.writeEnabled(true)
        val reopened = PreferencesRadarFleetStore(context, "test.radar", "serials", "on", enabledByDefault = false)
        assertEquals(listOf("ADFA0000001", "ADFA0000002"), reopened.readSerials())
        assertTrue(reopened.readEnabled())
        assertEquals(
            "ADFA0000001,ADFA0000002",
            context.getSharedPreferences("test.radar", 0).getString("serials", null)
        )

        reopened.writeSerials(emptyList())
        assertFalse(context.getSharedPreferences("test.radar", 0).contains("serials"))
    }

    @Test
    fun `Cameraman's store reads the single serial an earlier build wrote, and is on by default`() {
        context.getSharedPreferences(PreferencesRadarFleetStore.CAMERAMAN_FILE, 0)
            .edit().putString("serial", "ADFA0000001").commit()
        val store = PreferencesRadarFleetStore.cameraman(context)
        assertEquals(listOf("ADFA0000001"), store.readSerials())
        assertTrue(store.readEnabled())
    }

    @Test
    fun `stored serials keep TAG One names once each`() {
        assertEquals(emptyList<String>(), PreferencesRadarFleetStore.serialsFrom(null))
        assertEquals(
            listOf("ADFA0000001", "ADFA0000002"),
            PreferencesRadarFleetStore.serialsFrom(" ADFA0000001,nope,adfa0000001,ADFA0000002")
        )
    }

    @Test
    fun `radar permissions follow the running release`() {
        assertEquals(RadarPermissions.required(34), RadarPermissions.required())
    }
}
