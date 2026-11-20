package app.teamstation.app.chat

import android.view.InputDevice
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import com.facebook.react.R
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import com.facebook.react.views.textinput.ReactEditText

private class ChatKeyPress(surface: Int, tag: Int, val key: String) :
  Event<ChatKeyPress>(surface, tag) {
  override fun getEventName() = "topKeyPress"
  override fun canCoalesce() = false
  override fun getEventData(): WritableMap = Arguments.createMap().apply { putString("key", key) }
}

/** Claims the matching key-up even if cancelling the edit changes the field's native ID. */
internal class ChatHardwareKeys(
  private val send: (ReactEditText, String) -> Boolean = { field, key ->
    val context = UIManagerHelper.getReactContext(field)
    val dispatcher = UIManagerHelper.getEventDispatcher(context)
    if (dispatcher == null) false else {
      dispatcher.dispatchEvent(ChatKeyPress(UIManagerHelper.getSurfaceId(field), field.id, key))
      true
    }
  }
) {
  private val pressed = mutableSetOf<Pair<Int, Int>>()

  fun dispatch(focused: View?, event: KeyEvent): Boolean {
    if (event.keyCode != KeyEvent.KEYCODE_DPAD_UP && event.keyCode != KeyEvent.KEYCODE_ESCAPE) return false
    val press = event.deviceId to event.keyCode
    if (event.action == KeyEvent.ACTION_UP) return pressed.remove(press)
    if (event.action != KeyEvent.ACTION_DOWN) return false
    if (event.repeatCount != 0) return press in pressed
    pressed.remove(press)
    val field = focused as? ReactEditText ?: return false
    if (!field.isEnabled || !field.hasFocus() || field.keyListener == null ||
      !event.isFromSource(InputDevice.SOURCE_KEYBOARD) ||
      event.flags and KeyEvent.FLAG_SOFT_KEYBOARD != 0 || !event.hasNoModifiers() ||
      field.text?.let { BaseInputConnection.getComposingSpanStart(it) >= 0 } == true) return false
    val key = when (field.getTag(R.id.view_tag_native_id)) {
      "chatComposerEditLatest" -> if (event.keyCode == KeyEvent.KEYCODE_DPAD_UP && field.text.isNullOrEmpty()) "ArrowUp" else null
      "chatComposerCancelEdit" -> if (event.keyCode == KeyEvent.KEYCODE_ESCAPE) "Escape" else null
      else -> null
    } ?: return false
    if (!send(field, key)) return false
    pressed.add(press)
    return true
  }
}
