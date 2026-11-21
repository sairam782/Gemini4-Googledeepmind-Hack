package expo.modules.callscreener

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.ContactsContract
import android.telecom.Call
import android.telecom.CallScreeningService
import android.telecom.Connection
import android.util.Log

/**
 * Decides, per incoming call, whether it rings normally or goes to the Uno ReVoice agent.
 *
 *  - Caller is in contacts           -> allow, phone rings normally.
 *  - Caller is unknown / withheld    -> disallow + reject + skip notification. The carrier treats the
 *                                       call as declined and conditional forwarding sends it to Twilio.
 *  - Android 11+: number verification failed (spoofed) -> send to the agent even if it matches a contact.
 *
 * Android only invokes this service while Uno ReVoice holds ROLE_CALL_SCREENING
 * (see CallScreenerModule.requestScreeningRole).
 */
class UnoCallScreeningService : CallScreeningService() {

  override fun onScreenCall(callDetails: Call.Details) {
    // Never interfere with outgoing calls.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
      callDetails.callDirection != Call.Details.DIRECTION_INCOMING
    ) {
      respondToCall(callDetails, allow())
      return
    }

    val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!prefs.getBoolean(KEY_ENABLED, true)) {
      respondToCall(callDetails, allow())
      return
    }

    val number = callDetails.handle?.schemeSpecificPart?.takeIf { it.isNotBlank() }
    val hasContactsPermission =
      checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

    val verificationFailed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
      callDetails.callerNumberVerificationStatus == Connection.VERIFICATION_STATUS_FAILED

    val decision = when {
      // Without contacts access we can't tell family from strangers: fail open so nobody is lost.
      !hasContactsPermission -> Decision.ALLOW_NO_PERMISSION
      verificationFailed -> Decision.AGENT_SPOOFED
      number == null -> Decision.AGENT_WITHHELD
      isContact(number) -> Decision.ALLOW_CONTACT
      else -> Decision.AGENT_UNKNOWN
    }

    respondToCall(callDetails, if (decision.toAgent) sendToAgent() else allow())

    Log.i(TAG, "Screened ${number ?: "withheld"} -> $decision")
    prefs.edit()
      .putString(KEY_LAST_NUMBER, number ?: "")
      .putString(KEY_LAST_DECISION, decision.name)
      .putLong(KEY_LAST_AT, System.currentTimeMillis())
      .apply()
  }

  private fun allow(): CallResponse =
    CallResponse.Builder()
      .setDisallowCall(false)
      .build()

  private fun sendToAgent(): CallResponse =
    CallResponse.Builder()
      .setDisallowCall(true)
      .setRejectCall(true)
      .setSkipNotification(true)
      // Keep it in the call log so the user can see what was screened.
      .setSkipCallLog(false)
      .build()

  private fun isContact(number: String): Boolean {
    val uri = Uri.withAppendedPath(
      ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
      Uri.encode(number)
    )
    return try {
      contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup._ID), null, null, null)
        ?.use { it.count > 0 } ?: false
    } catch (e: Exception) {
      Log.w(TAG, "Contact lookup failed", e)
      // Fail open: a lookup error should never silently divert a family member.
      true
    }
  }

  enum class Decision(val toAgent: Boolean) {
    ALLOW_CONTACT(false),
    ALLOW_NO_PERMISSION(false),
    AGENT_UNKNOWN(true),
    AGENT_WITHHELD(true),
    AGENT_SPOOFED(true),
  }

  companion object {
    const val TAG = "UnoCallScreening"
    const val PREFS = "uno_revoice_call_screener"
    const val KEY_ENABLED = "enabled"
    const val KEY_LAST_NUMBER = "last_number"
    const val KEY_LAST_DECISION = "last_decision"
    const val KEY_LAST_AT = "last_at"
  }
}
