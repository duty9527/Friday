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

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context appCtx = context.getApplicationContext() != null
                ? context.getApplicationContext()
                : context;
        String action = intent != null ? intent.getAction() : "";
        Log.i(TvAgentSelfHealer.TAG, "TvAgentBootReceiver onReceive: " + action);

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
