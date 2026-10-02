package app.teamstation.cameraman.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag

/**
 * The rectangle the broadcast occupies on this screen.
 *
 * The preview is drawn letterboxed into the same aspect, and the bars outside this box stay empty.
 * Chrome is placed in [content] so it sits on the picture rather than in those bars.
 */
@Composable
fun CameraFrame(
    aspectRatio: Float,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit
) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Box(
            modifier = Modifier
                .aspectRatio(aspectRatio, matchHeightConstraintsFirst = true)
                .testTag("camera-frame"),
            content = content
        )
    }
}
