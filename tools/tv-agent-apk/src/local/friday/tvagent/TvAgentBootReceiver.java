package local.friday.tvagent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

public final class TvAgentBootReceiver extends BroadcastReceiver {
    public static final String ACTION_STR_BOOT = "mitv.action.STR_BOOT_COMPLETED";
    public static final String ACTION_ENSURE_READY = "local.friday.tvagent.ENSURE_READY";
    public static final String ACTION_GET_TOKEN = "local.friday.tvagent.GET_TOKEN";
    public static final String ACTION_SYNC_TOKEN = "local.friday.tvagent.SYNC_TOKEN";

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context appCtx = context.getApplicationContext() != null
                ? context.getApplicationContext()
                : context;
        String action = intent != null ? intent.getAction() : "";
        Log.i(TvAgentSelfHealer.TAG, "TvAgentBootReceiver onReceive: " + action);

        if (ACTION_GET_TOKEN.equals(action)) {
            String token = TvAgentHttpServer.ensureTokenInitialized(appCtx);
            setResult(-1, token, null);
            return;
        }
        if (ACTION_SYNC_TOKEN.equals(action)) {
            String provided = intent != null ? intent.getStringExtra("token") : null;
            String active = TvAgentHttpServer.syncTokenIfValid(appCtx, provided);
            setResult(-1, active, null);
            return;
        }

        TvAgentSelfHealer.ensureAllReady(appCtx);

        Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                TvAgentSelfHealer.ensureAllReady(appCtx);
            }
        }, 400L);
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                TvAgentSelfHealer.ensureAllReady(appCtx);
            }
        }, 1200L);

        if (!ACTION_ENSURE_READY.equals(action)) {
            TvAgentSelfHealer.scheduleEnsureAlarms(appCtx);
        }
    }
}
