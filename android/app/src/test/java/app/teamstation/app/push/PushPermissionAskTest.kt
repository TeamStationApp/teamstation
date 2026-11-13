package app.teamstation.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The notification permission ask, answered once whether or not its listener survives. */
class PushPermissionAskTest {
  @Test
  fun theDialogsListenerAnswersWithTheChoiceOnce() {
    val answers = mutableListOf<Boolean?>()
    val later = mutableListOf<Runnable>()
    val ask = PushPermissionAsk({ later.add(it) }) { answers.add(it) }
    ask.onHostPause()
    assertTrue(ask.settle(false))
    // The resume after the dialog finds it answered, and leaves nothing for later.
    ask.onHostResume()
    assertEquals(0, later.size)
    assertFalse(ask.settle(null))
    ask.onHostDestroy()
    assertEquals(listOf<Boolean?>(false), answers)
  }

  @Test
  fun aResumeAfterTheDialogAnswersAnAskWhoseListenerWasLost() {
    val answers = mutableListOf<Boolean?>()
    val later = mutableListOf<Runnable>()
    val ask = PushPermissionAsk({ later.add(it) }) { answers.add(it) }
    // No dialog yet: a resume is not an answer.
    ask.onHostResume()
    assertEquals(0, later.size)
    ask.onHostPause()
    ask.onHostResume()
    assertEquals(1, later.size)
    // A listener the activity kept answers in the same resume, before it.
    later.single().run()
    assertEquals(listOf<Boolean?>(null), answers)
    // A listener that turns up late answers nothing.
    assertFalse(ask.settle(true))
    assertEquals(listOf<Boolean?>(null), answers)
  }

  @Test
  fun aListenerThatAnswersInTheSameResumeComesFirst() {
    val answers = mutableListOf<Boolean?>()
    val later = mutableListOf<Runnable>()
    val ask = PushPermissionAsk({ later.add(it) }) { answers.add(it) }
    ask.onHostPause()
    ask.onHostResume()
    assertTrue(ask.settle(true))
    later.single().run()
    assertEquals(listOf<Boolean?>(true), answers)
  }
}
