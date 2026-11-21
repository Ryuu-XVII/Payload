package app.payload.installer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import org.json.JSONObject

internal object InstallState {
  private const val EXTRA_LEGACY_STATUS = "android.content.pm.extra.LEGACY_STATUS"
  private const val INSTALL_FAILED_UPDATE_INCOMPATIBLE = -7
  private var confirmation: Intent? = null

  private fun storage(context: Context) =
    context.getSharedPreferences("payload_install", Context.MODE_PRIVATE)

  @Synchronized
  fun read(context: Context): JSONObject? =
    storage(context).getString("state", null)?.let(::JSONObject)

  @Synchronized
  fun write(context: Context, state: JSONObject) {
    check(storage(context).edit().putString("state", state.toString()).commit())
  }

  @Synchronized
  fun forget(context: Context, id: Int) {
    if (read(context)?.getInt("sessionId") == id) {
      confirmation = null
      check(storage(context).edit().remove("state").commit())
    }
  }

  @Synchronized
  fun confirmation(): Intent? = confirmation

  @Synchronized
  fun receive(context: Context, intent: Intent) {
    val state = read(context) ?: return
    if (intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) != state.getInt("sessionId")) return
    if (state.getString("stage") == "finished") return
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)

    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      val systemIntent = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
      }
      if (systemIntent != null) {
        confirmation = systemIntent
        write(context, state.put("stage", "confirm"))
        return
      }
    }

    confirmation = null
    val legacy = intent.getIntExtra(EXTRA_LEGACY_STATUS, 0)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
    val result = when {
      status == PackageInstaller.STATUS_SUCCESS -> "success"
      status == PackageInstaller.STATUS_FAILURE_ABORTED -> "cancelled"
      legacy == INSTALL_FAILED_UPDATE_INCOMPATIBLE || (status == PackageInstaller.STATUS_FAILURE_CONFLICT &&
        (message.contains("signature", true) || message.contains("certificate", true))) -> "signing"
      status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ||
        status == PackageInstaller.STATUS_FAILURE_INVALID -> "incompatible"
      status == PackageInstaller.STATUS_FAILURE_STORAGE -> "storage"
      status == PackageInstaller.STATUS_FAILURE_BLOCKED -> "blocked"
      else -> "failed"
    }
    write(context, state.put("stage", "finished").put("result", result))
  }
}

class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    InstallState.receive(context, intent)
  }
}
