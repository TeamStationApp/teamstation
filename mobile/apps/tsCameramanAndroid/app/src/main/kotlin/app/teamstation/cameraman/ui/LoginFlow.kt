package app.teamstation.cameraman.ui

import app.teamstation.cameraman.core.BroadcastPolicy

/**
 * The sign-in modal and the logout row.
 *
 * One field and one pill. They start as the address and "Email sign-in code",
 * and become the code and "Sign in" after the server accepts the address.
 * The sixth digit submits. Logout arms a slide; only the slide signs out.
 */
data class LoginFlow(
    val step: Step = Step.Email,
    val email: String = "",
    val code: String = "",
    val notice: String? = null,
    val logoutArmed: Boolean = false,
    val swallowNextDisarm: Boolean = false
) {
    enum class Step { Email, Code }

    val buttonLabel: String
        get() = if (step == Step.Email) SEND_LABEL else SIGN_IN_LABEL

    val fieldIsCode: Boolean
        get() = step == Step.Code

    fun cancel(): LoginFlow = copy(step = Step.Email, code = "", notice = null)

    fun codeSent(): LoginFlow = copy(step = Step.Code, code = "", notice = CHECK_EMAIL)

    fun codeRejected(): LoginFlow =
        copy(step = Step.Code, code = "", notice = BAD_CODE)

    /** At most six digits. The pair's second value is true when this edit reaches six. */
    fun replaceCode(raw: String): Pair<LoginFlow, Boolean> {
        val digits = raw.filter { it.isDigit() }.take(CODE_LENGTH)
        val submit = digits.length == CODE_LENGTH && digits != code
        return copy(code = digits) to submit
    }

    fun armLogout(): LoginFlow = copy(logoutArmed = true, swallowNextDisarm = true)

    fun tapElsewhere(): LoginFlow {
        if (swallowNextDisarm) return copy(swallowNextDisarm = false)
        return copy(logoutArmed = false)
    }

    /** True when an armed slide has crossed the same fraction as slide to stop. */
    fun slide(progress: Double): Pair<LoginFlow, Boolean> {
        if (!logoutArmed || !BroadcastPolicy.slideCommits(progress)) return this to false
        return copy(logoutArmed = false, swallowNextDisarm = false) to true
    }

    companion object {
        const val CHECK_EMAIL = "Check your email"
        const val BAD_CODE = "That code is wrong or has expired"
        const val SEND_LABEL = "Email sign-in code"
        const val SIGN_IN_LABEL = "Sign in"
        const val CODE_LENGTH = 6

        fun showsDevelopmentHost(host: String): Boolean {
            val trimmed = host.trim()
            return trimmed.isNotEmpty() &&
                trimmed != "app.teamstation.app" &&
                trimmed != "https://app.teamstation.app"
        }

        fun loggedInLine(email: String): String = "$email currently logged in"
    }
}
