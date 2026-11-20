package app.teamstation.app.chat

import android.view.KeyEvent
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

class ChatComposerKeysPackage : ReactPackage {
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(ChatComposerKeysManager())
}

internal class ChatComposerKeysManager : ReactViewManager() {
  override fun getName(): String = "TSChatComposerKeys"

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup =
    ChatComposerKeysView(context)
}

// A visible IME handles Escape before Activity.dispatchKeyEvent. Give the focused
// chat field its own shortcuts first, keeping unhandled keys on the ordinary path.
internal class ChatComposerKeysView(
  context: ThemedReactContext,
  private val keys: ChatHardwareKeys = ChatHardwareKeys()
) : ReactViewGroup(context) {
  override fun dispatchKeyEventPreIme(event: KeyEvent): Boolean =
    keys.dispatch(findFocus(), event) || super.dispatchKeyEventPreIme(event)
}
