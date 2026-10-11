package app.teamstation.cameraman.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** What a sign-in link did, over the camera screen: signed in, or whose link it was. Nothing when empty. */
@Composable
internal fun SignInLinkToast(message: String, modifier: Modifier = Modifier) {
    if (message.isEmpty()) return
    Surface(
        // Below the camera screen's top bar, so the name, settings and thermal state stay readable.
        modifier = modifier
            .padding(top = 72.dp, start = 24.dp, end = 24.dp)
            .widthIn(max = 520.dp)
            .testTag("sign-in-link-message"),
        shape = RoundedCornerShape(12.dp),
        color = Color.Black.copy(alpha = 0.75f),
        contentColor = Color.White,
        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.25f))
    ) {
        Text(
            message,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center
        )
    }
}
