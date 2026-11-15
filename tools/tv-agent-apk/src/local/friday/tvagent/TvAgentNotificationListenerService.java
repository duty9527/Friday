package local.friday.tvagent;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.ContentObserver;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

public final class TvAgentNotificationListenerService extends NotificationListenerService {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private BroadcastReceiver dynamicReceiver;
    private ContentObserver settingsObserver;

    private final Runnable ensureReadyTask = new Runnable() {
        @Override
        public void run() {
            TvAgentSelfHealer.ensureAllReady(TvAgentNotificationListenerService.this);
        }
    };

    private final Runnable watchdogTask = new Runnable() {
        @Override
        public void run() {
            TvAgentSelfHealer.ensureAllReady(TvAgentNotificationListenerService.this);
            handler.postDelayed(this, 15_000L);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TvAgentSelfHealer.TAG, "TvAgentNotificationListenerService onCreate");
        TvAgentSelfHealer.ensureAllReady(this);

        dynamicReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                TvAgentSelfHealer.ensureAllReady(TvAgentNotificationListenerService.this);
                scheduleDelayedCheck(350L);
                scheduleDelayedCheck(1200L);
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        filter.addAction(TvAgentBootReceiver.ACTION_STR_BOOT);
        filter.addAction(TvAgentBootReceiver.ACTION_ENSURE_READY);
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(dynamicReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(dynamicReceiver, filter);
            }
        } catch (Throwable t) {
            Log.w(TvAgentSelfHealer.TAG, "registerReceiver failed: " + t.getMessage());
        }

        settingsObserver = new ContentObserver(handler) {
            @Override
            public void onChange(boolean selfChange, Uri uri) {
                scheduleDelayedCheck(200L);
            }
        };
        try {
            getContentResolver().registerContentObserver(
                    Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES),
                    false, settingsObserver);
            getContentResolver().registerContentObserver(
                    Settings.Secure.getUriFor(Settings.Secure.ACCESSIBILITY_ENABLED),
                    false, settingsObserver);
        } catch (Throwable t) {
            Log.w(TvAgentSelfHealer.TAG, "registerContentObserver failed: " + t.getMessage());
        }

        handler.postDelayed(watchdogTask, 15_000L);
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        Log.i(TvAgentSelfHealer.TAG, "TvAgentNotificationListenerService onListenerConnected");
        TvAgentSelfHealer.ensureAllReady(this);
        scheduleDelayedCheck(500L);
    }

    @Override
    public void onListenerDisconnected() {
        super.onListenerDisconnected();
        try {
            requestRebind(new ComponentName(this, TvAgentNotificationListenerService.class));
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        // Notification contents intentionally ignored
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // Notification contents intentionally ignored
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (dynamicReceiver != null) {
            try {
                unregisterReceiver(dynamicReceiver);
            } catch (Throwable ignored) {
            }
        }
        if (settingsObserver != null) {
            try {
                getContentResolver().unregisterContentObserver(settingsObserver);
            } catch (Throwable ignored) {
            }
        }
        super.onDestroy();
    }

    private void scheduleDelayedCheck(long delayMs) {
        handler.removeCallbacks(ensureReadyTask);
        handler.postDelayed(ensureReadyTask, delayMs);
    }
}
