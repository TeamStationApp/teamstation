package co.gamestation.cameraman.gl

import android.opengl.GLES11Ext
import android.opengl.GLES20
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/**
 * Draws the camera's external texture over a whole destination surface.
 *
 * Two matrices, and keeping them apart is the point. `texMatrix` is whatever `SurfaceTexture` says
 * is needed to sample its buffer correctly — crop, vertical flip, driver-specific layout — and is
 * never ours to reason about. `mvpMatrix` is ours: the 0°/180° capture rotation and the aspect-fill
 * scale.
 */
internal class TextureProgram {
    private val program: Int
    private val positionHandle: Int
    private val textureCoordinateHandle: Int
    private val mvpMatrixHandle: Int
    private val textureMatrixHandle: Int
    private val textureHandle: Int

    private val vertices: FloatBuffer = floats(
        floatArrayOf(
            -1f, -1f,
            1f, -1f,
            -1f, 1f,
            1f, 1f
        )
    )

    private val textureCoordinates: FloatBuffer = floats(
        floatArrayOf(
            0f, 0f,
            1f, 0f,
            0f, 1f,
            1f, 1f
        )
    )

    init {
        val vertex = compile(GLES20.GL_VERTEX_SHADER, vertexShader)
        val fragment = compile(GLES20.GL_FRAGMENT_SHADER, fragmentShader)
        program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, vertex)
        GLES20.glAttachShader(program, fragment)
        GLES20.glLinkProgram(program)
        val linked = IntArray(1)
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0)
        check(linked[0] == GLES20.GL_TRUE) {
            "link failed: " + GLES20.glGetProgramInfoLog(program)
        }
        GLES20.glDeleteShader(vertex)
        GLES20.glDeleteShader(fragment)

        positionHandle = GLES20.glGetAttribLocation(program, "aPosition")
        textureCoordinateHandle = GLES20.glGetAttribLocation(program, "aTextureCoord")
        mvpMatrixHandle = GLES20.glGetUniformLocation(program, "uMVPMatrix")
        textureMatrixHandle = GLES20.glGetUniformLocation(program, "uTexMatrix")
        textureHandle = GLES20.glGetUniformLocation(program, "sTexture")
    }

    /** An external-OES texture, which is the only kind `SurfaceTexture` will attach to. */
    fun createExternalTexture(): Int {
        val ids = IntArray(1)
        GLES20.glGenTextures(1, ids, 0)
        val texture = ids[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR
        )
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR
        )
        // Clamped rather than repeated: an aspect-fill scale samples slightly outside the texture at
        // the edges, and repeating would wrap the far side of the picture into that sliver.
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE
        )
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE
        )
        return texture
    }

    fun draw(textureId: Int, textureMatrix: FloatArray, mvpMatrix: FloatArray) {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)

        GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
        GLES20.glUniform1i(textureHandle, 0)

        GLES20.glUniformMatrix4fv(mvpMatrixHandle, 1, false, mvpMatrix, 0)
        GLES20.glUniformMatrix4fv(textureMatrixHandle, 1, false, textureMatrix, 0)

        GLES20.glEnableVertexAttribArray(positionHandle)
        GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 0, vertices)
        GLES20.glEnableVertexAttribArray(textureCoordinateHandle)
        GLES20.glVertexAttribPointer(
            textureCoordinateHandle, 2, GLES20.GL_FLOAT, false, 0, textureCoordinates
        )

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)

        GLES20.glDisableVertexAttribArray(positionHandle)
        GLES20.glDisableVertexAttribArray(textureCoordinateHandle)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 0)
        GLES20.glUseProgram(0)
    }

    fun release() {
        GLES20.glDeleteProgram(program)
    }

    private fun compile(type: Int, source: String): Int {
        val shader = GLES20.glCreateShader(type)
        GLES20.glShaderSource(shader, source)
        GLES20.glCompileShader(shader)
        val compiled = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0)
        check(compiled[0] == GLES20.GL_TRUE) {
            "shader compile failed: " + GLES20.glGetShaderInfoLog(shader)
        }
        return shader
    }

    private fun floats(values: FloatArray): FloatBuffer =
        ByteBuffer.allocateDirect(values.size * 4)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer()
            .apply {
                put(values)
                position(0)
            }

    private companion object {
        const val vertexShader = """
            uniform mat4 uMVPMatrix;
            uniform mat4 uTexMatrix;
            attribute vec4 aPosition;
            attribute vec4 aTextureCoord;
            varying vec2 vTextureCoord;
            void main() {
                gl_Position = uMVPMatrix * aPosition;
                vTextureCoord = (uTexMatrix * aTextureCoord).xy;
            }
        """

        const val fragmentShader = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            varying vec2 vTextureCoord;
            uniform samplerExternalOES sTexture;
            void main() {
                gl_FragColor = texture2D(sTexture, vTextureCoord);
            }
        """
    }
}
