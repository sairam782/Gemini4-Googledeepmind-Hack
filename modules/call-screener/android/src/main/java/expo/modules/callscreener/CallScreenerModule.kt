package expo.modules.callscreener

import android.app.Activity
import android.app.role.RoleManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val REQUEST_SCREENING_ROLE = 7301

class CallScreenerModule : Module() {
  private var pendingRolePromise: Promise? = null

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "React context is not available", null)

  private fun roleManager(): RoleManager? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) context.getSystemService(RoleManager::class.java) else null

  override fun definition() = ModuleDefinition {
    Name("CallScreener")

    /** True when Android supports the call-screening role on this device (Android 10+). */
    Function("isSupported") {
      roleManager()?.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) == true
    }

    /** True when Uno ReVoice is the active call-screening app. */
    Function("isScreeningRoleHeld") {
      roleManager()?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true
    }

    /**
     * Asks the user to make Uno ReVoice the call-screening app.
     * Resolves true if the role is (now) held, false if the user declined or the device can't do it.
     */
    AsyncFunction("requestScreeningRole") { promise: Promise ->
      val rm = roleManager()
      if (rm == null || !rm.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING)) {
        promise.resolve(false)
        return@AsyncFunction
      }
      if (rm.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) {
        promise.resolve(true)
        return@AsyncFunction
      }
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject(CodedException("ERR_NO_ACTIVITY", "No foreground activity to show the role dialog", null))
        return@AsyncFunction
      }
      pendingRolePromise?.resolve(false)
      pendingRolePromise = promise
      activity.startActivityForResult(
        rm.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING),
        REQUEST_SCREENING_ROLE
      )
    }.runOnQueue(Queues.MAIN)

    /** Pause/resume screening without giving up the role. */
    Function("setScreeningEnabled") { enabled: Boolean ->
      prefs().edit().putBoolean(UnoCallScreeningService.KEY_ENABLED, enabled).apply()
    }

    Function("isScreeningEnabled") {
      prefs().getBoolean(UnoCallScreeningService.KEY_ENABLED, true)
    }

    /** The most recent screening decision, for checking on a real phone that forwarding works. */
    Function("getLastDecision") {
      val p = prefs()
      val at = p.getLong(UnoCallScreeningService.KEY_LAST_AT, 0L)
      if (at == 0L) {
        null
      } else {
        mapOf(
          "number" to p.getString(UnoCallScreeningService.KEY_LAST_NUMBER, ""),
          "decision" to p.getString(UnoCallScreeningService.KEY_LAST_DECISION, ""),
          "at" to at.toDouble()
        )
      }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_SCREENING_ROLE) return@OnActivityResult
      val held = roleManager()?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true
      pendingRolePromise?.resolve(held || payload.resultCode == Activity.RESULT_OK)
      pendingRolePromise = null
    }
  }

  private fun prefs() =
    context.getSharedPreferences(UnoCallScreeningService.PREFS, Context.MODE_PRIVATE)
}
