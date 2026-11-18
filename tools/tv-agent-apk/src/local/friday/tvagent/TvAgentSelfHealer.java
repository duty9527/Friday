package local.friday.tvagent;

import android.app.ActivityOptions;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class TvAgentSelfHealer {
    public static final String TAG = "FridayTvAgent";
    public static final String PACKAGE_NAME = "local.friday.tvagent";
    public static final String SHORT_SERVICE_NAME =
            "local.friday.tvagent/.TvAgentAccessibilityService";
    public static final String FULL_SERVICE_NAME =
            "local.friday.tvagent/local.friday.tvagent.TvAgentAccessibilityService";
    public static final ComponentName SELF_A11Y_COMPONENT = new ComponentName(
            PACKAGE_NAME, "local.friday.tvagent.TvAgentAccessibilityService");

    private static final String PREFS_NAME = "tv_agent_prefs";
    private static final String PREF_LAUNCHER_PACKAGE = "launcher_package";
    private static final String PREF_LAUNCHER_ACTIVITY = "launcher_activity";
    private static final String PREF_LAUNCHER_A11Y_COMPONENT = "launcher_a11y_component";
    private static final String PREF_EXTRA_PACKAGES = "extra_packages";
    private static final String PREF_EXCLUDED_PACKAGES = "excluded_packages";

    private static volatile long lastAppsCacheTimeMs = 0L;
    private static volatile JSONArray cachedAppsArray = null;

    private TvAgentSelfHealer() {
    }

    private static SharedPreferences getPrefs(Context context) {
        if (context == null) return null;
        Context storage = context;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                Context dp = context.createDeviceProtectedStorageContext();
                if (dp != null) storage = dp;
            } catch (Throwable ignored) {
            }
        }
        return storage.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String getPrefString(Context context, String key) {
        SharedPreferences prefs = getPrefs(context);
        if (prefs == null) return "";
        String val = prefs.getString(key, "");
        return val != null ? val.trim() : "";
    }

    private static Set<String> getPrefPackageSet(Context context, String key) {
        Set<String> set = new HashSet<>();
        String raw = getPrefString(context, key);
        if (raw.isEmpty()) return set;
        for (String token : raw.split("[,;\\s]+")) {
            String trimmed = token.trim();
            if (!trimmed.isEmpty()) set.add(trimmed);
        }
        return set;
    }

    private static String getGuardedLauncherPackage(Context context) {
        return getPrefString(context, PREF_LAUNCHER_PACKAGE);
    }

    private static ComponentName getGuardedLauncherHomeComponent(Context context) {
        String pkg = getPrefString(context, PREF_LAUNCHER_PACKAGE);
        String activity = getPrefString(context, PREF_LAUNCHER_ACTIVITY);
        if (pkg.isEmpty() || activity.isEmpty()) return null;
        return new ComponentName(pkg, activity);
    }

    private static ComponentName getGuardedLauncherA11yComponent(Context context) {
        String raw = getPrefString(context, PREF_LAUNCHER_A11Y_COMPONENT);
        if (raw.isEmpty()) return null;
        return ComponentName.unflattenFromString(raw);
    }

    /**
     * Cooperative accessibility self-healer:
     * Reads enabled_accessibility_services and splits by ':'.
     * ONLY writes Settings.Secure if local.friday.tvagent/.TvAgentAccessibilityService
     * is missing OR accessibility_enabled != 1. Preserves all existing entries.
     */
    public static synchronized boolean ensureAccessibilityEnabled(Context context) {
        if (context == null) return false;
        try {
            ContentResolver cr = context.getContentResolver();
            String current = Settings.Secure.getString(
                    cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            Set<String> entries = new LinkedHashSet<>();
            boolean selfPresent = false;
            if (current != null && !current.trim().isEmpty()) {
                for (String part : current.split(":")) {
                    String token = part.trim();
                    if (token.isEmpty()) continue;
                    entries.add(token);
                    if (isSameComponent(token, SELF_A11Y_COMPONENT)) {
                        selfPresent = true;
                    }
                }
            }
            int enabled = Settings.Secure.getInt(
                    cr, Settings.Secure.ACCESSIBILITY_ENABLED, 0);
            if (selfPresent && enabled == 1) {
                return true;
            }
            boolean ok = true;
            if (!selfPresent) {
                entries.add(SHORT_SERVICE_NAME);
                StringBuilder sb = new StringBuilder();
                for (String entry : entries) {
                    if (sb.length() > 0) sb.append(':');
                    sb.append(entry);
                }
                ok = Settings.Secure.putString(
                        cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, sb.toString());
                Log.i(TAG, "Self-healed enabled_accessibility_services -> " + sb + " (ok=" + ok + ")");
            }
            if (enabled != 1) {
                boolean swOk = Settings.Secure.putInt(
                        cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1);
                ok = ok && swOk;
            }
            return ok;
        } catch (Throwable t) {
            Log.w(TAG, "ensureAccessibilityEnabled failed: " + t.getMessage());
            return false;
        }
    }

    public static boolean isSelfAccessibilityEnabled(Context context) {
        if (context == null) return false;
        try {
            ContentResolver cr = context.getContentResolver();
            if (Settings.Secure.getInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 0) != 1) {
                return false;
            }
            String current = Settings.Secure.getString(
                    cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (current == null) return false;
            for (String part : current.split(":")) {
                if (isSameComponent(part.trim(), SELF_A11Y_COMPONENT)) {
                    return true;
                }
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    public static boolean isGuardedLauncherEnabled(Context context) {
        if (context == null) return false;
        ComponentName guardedComp = getGuardedLauncherA11yComponent(context);
        if (guardedComp == null) return false;
        try {
            ContentResolver cr = context.getContentResolver();
            if (Settings.Secure.getInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 0) != 1) {
                return false;
            }
            String current = Settings.Secure.getString(
                    cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (current == null) return false;
            for (String part : current.split(":")) {
                if (isSameComponent(part.trim(), guardedComp)) {
                    return true;
                }
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    public static boolean isSameComponent(String flattened, ComponentName target) {
        if (flattened == null || flattened.isEmpty() || target == null) return false;
        ComponentName parsed = ComponentName.unflattenFromString(flattened);
        if (parsed != null && parsed.equals(target)) return true;
        return flattened.equalsIgnoreCase(target.flattenToShortString())
                || flattened.equalsIgnoreCase(target.flattenToString());
    }

    public static void ensureAllReady(Context context) {
        if (context == null) return;
        Context appCtx = context.getApplicationContext() != null
                ? context.getApplicationContext()
                : context;
        TvAgentHttpServer.ensureStarted(appCtx);
        ensureAccessibilityEnabled(appCtx);
        try {
            NotificationListenerService.requestRebind(
                    new ComponentName(appCtx, TvAgentNotificationListenerService.class));
        } catch (Throwable ignored) {
        }
    }

    public static void scheduleEnsureAlarms(Context context) {
        if (context == null) return;
        try {
            AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarms == null) return;
            long[] delaysMs = {2500L, 8000L, 25000L};
            for (int i = 0; i < delaysMs.length; i++) {
                Intent intent = new Intent(context, TvAgentBootReceiver.class)
                        .setAction(TvAgentBootReceiver.ACTION_ENSURE_READY);
                PendingIntent pi = PendingIntent.getBroadcast(
                        context, 8900 + i, intent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                alarms.setAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        SystemClock.elapsedRealtime() + delaysMs[i], pi);
            }
        } catch (Throwable ignored) {
        }
    }

    @SuppressWarnings("deprecation")
    public static boolean wakeScreen(Context context) {
        if (context == null) return false;
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return false;
            PowerManager.WakeLock wl = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                            | PowerManager.ACQUIRE_CAUSES_WAKEUP
                            | PowerManager.ON_AFTER_RELEASE,
                    "friday:tvagent:wake");
            wl.setReferenceCounted(false);
            wl.acquire(3000L);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "wakeScreen failed: " + t.getMessage());
            return false;
        }
    }

    public static boolean launchApp(Context context, String packageName) {
        if (context == null || packageName == null || packageName.trim().isEmpty()) {
            return false;
        }
        String pkg = packageName.trim();
        wakeScreen(context);
        try {
            PackageManager pm = context.getPackageManager();
            String guardedPkg = getGuardedLauncherPackage(context);
            ComponentName guardedHome = getGuardedLauncherHomeComponent(context);
            boolean isGuardedHome = !guardedPkg.isEmpty() && guardedPkg.equals(pkg);
            Intent intent = null;
            if (isGuardedHome && guardedHome != null) {
                intent = new Intent(Intent.ACTION_MAIN)
                        .addCategory(Intent.CATEGORY_HOME)
                        .setComponent(guardedHome);
            }
            if (intent == null) {
                intent = pm.getLeanbackLaunchIntentForPackage(pkg);
            }
            if (intent == null) {
                intent = pm.getLaunchIntentForPackage(pkg);
            }
            if (intent == null) {
                Intent query = new Intent(Intent.ACTION_MAIN).setPackage(pkg);
                List<ResolveInfo> resolves = pm.queryIntentActivities(query, 0);
                if (resolves != null && !resolves.isEmpty()) {
                    ActivityInfo ai = resolves.get(0).activityInfo;
                    if (ai != null) {
                        intent = new Intent(Intent.ACTION_MAIN)
                                .setComponent(new ComponentName(ai.packageName, ai.name));
                    }
                }
            }
            if (intent == null) {
                return false;
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            if (isGuardedHome) {
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
            }
            return startActivityReliably(context, intent);
        } catch (Throwable t) {
            Log.w(TAG, "launchApp(" + pkg + ") failed: " + t.getMessage());
            return false;
        }
    }

    public static boolean launchHomeFallback(Context context) {
        String guardedPkg = getGuardedLauncherPackage(context);
        if (!guardedPkg.isEmpty() && launchApp(context, guardedPkg)) {
            return true;
        }
        try {
            Intent home = new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            return startActivityReliably(context, home);
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static boolean openUri(Context context, String uriStr, String packageName) {
        if (context == null || uriStr == null || uriStr.trim().isEmpty()) {
            return false;
        }
        wakeScreen(context);
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(uriStr.trim()));
            if (packageName != null && !packageName.trim().isEmpty()) {
                intent.setPackage(packageName.trim());
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            return startActivityReliably(context, intent);
        } catch (Throwable t) {
            Log.w(TAG, "openUri(" + uriStr + ") failed: " + t.getMessage());
            return false;
        }
    }

    public static boolean startActivityReliably(Context context, Intent intent) {
        TvAgentAccessibilityService svc = TvAgentAccessibilityService.getInstance();
        if (svc != null) {
            try {
                svc.startActivity(intent);
                return true;
            } catch (Throwable ignored) {
            }
        }
        try {
            ActivityOptions options = ActivityOptions.makeBasic();
            if (Build.VERSION.SDK_INT >= 34) {
                options.setPendingIntentCreatorBackgroundActivityStartMode(
                        ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
            }
            PendingIntent pi = PendingIntent.getActivity(
                    context, (int) (SystemClock.uptimeMillis() & 0x7fff), intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE,
                    options.toBundle());
            pi.send();
            return true;
        } catch (Throwable ignored) {
            try {
                context.startActivity(intent);
                return true;
            } catch (Throwable t) {
                Log.w(TAG, "startActivityReliably failed: " + t.getMessage());
                return false;
            }
        }
    }

    public static JSONArray getLaunchableApps(Context context) {
        long now = SystemClock.elapsedRealtime();
        JSONArray cached = cachedAppsArray;
        if (cached != null && (now - lastAppsCacheTimeMs) < 30_000L) {
            return cached;
        }
        JSONArray result = new JSONArray();
        if (context == null) return result;
        try {
            PackageManager pm = context.getPackageManager();
            Map<String, String> appMap = new LinkedHashMap<>();

            Set<String> extraPackages = getPrefPackageSet(context, PREF_EXTRA_PACKAGES);
            Set<String> excludedPackages = getPrefPackageSet(context, PREF_EXCLUDED_PACKAGES);
            String guardedPkg = getGuardedLauncherPackage(context);
            if (!guardedPkg.isEmpty()) {
                extraPackages.add(guardedPkg);
            }

            Intent leanbackIntent = new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER);
            List<ResolveInfo> leanbackList = pm.queryIntentActivities(leanbackIntent, 0);
            if (leanbackList != null) {
                for (ResolveInfo ri : leanbackList) {
                    if (ri.activityInfo == null) continue;
                    String pkg = ri.activityInfo.packageName;
                    if (shouldIncludePackage(pm, pkg, extraPackages, excludedPackages)) {
                        CharSequence labelCs = ri.loadLabel(pm);
                        appMap.put(pkg, labelCs != null ? labelCs.toString().trim() : pkg);
                    }
                }
            }

            Intent launcherIntent = new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> launcherList = pm.queryIntentActivities(launcherIntent, 0);
            if (launcherList != null) {
                for (ResolveInfo ri : launcherList) {
                    if (ri.activityInfo == null) continue;
                    String pkg = ri.activityInfo.packageName;
                    if (!appMap.containsKey(pkg) && shouldIncludePackage(pm, pkg, extraPackages, excludedPackages)) {
                        CharSequence labelCs = ri.loadLabel(pm);
                        appMap.put(pkg, labelCs != null ? labelCs.toString().trim() : pkg);
                    }
                }
            }

            List<ApplicationInfo> installed = pm.getInstalledApplications(0);
            if (installed != null) {
                for (ApplicationInfo ai : installed) {
                    if (ai == null || ai.packageName == null) continue;
                    String pkg = ai.packageName;
                    if (appMap.containsKey(pkg)) continue;
                    boolean isUserApp = (ai.flags & ApplicationInfo.FLAG_SYSTEM) == 0;
                    if (!isUserApp && !extraPackages.contains(pkg)) continue;
                    if (!shouldIncludePackage(pm, pkg, extraPackages, excludedPackages)) continue;
                    if (pm.getLeanbackLaunchIntentForPackage(pkg) != null
                            || pm.getLaunchIntentForPackage(pkg) != null) {
                        CharSequence labelCs = pm.getApplicationLabel(ai);
                        appMap.put(pkg, labelCs != null ? labelCs.toString().trim() : pkg);
                    }
                }
            }

            List<Map.Entry<String, String>> sorted = new ArrayList<>(appMap.entrySet());
            Collections.sort(sorted, new Comparator<Map.Entry<String, String>>() {
                @Override
                public int compare(Map.Entry<String, String> a, Map.Entry<String, String> b) {
                    return a.getKey().compareTo(b.getKey());
                }
            });

            for (Map.Entry<String, String> entry : sorted) {
                JSONObject item = new JSONObject();
                item.put("package", entry.getKey());
                item.put("label", entry.getValue());
                result.put(item);
            }
            cachedAppsArray = result;
            lastAppsCacheTimeMs = now;
        } catch (Throwable t) {
            Log.w(TAG, "getLaunchableApps failed: " + t.getMessage());
        }
        return result;
    }

    private static boolean shouldIncludePackage(
            PackageManager pm,
            String pkg,
            Set<String> extraPackages,
            Set<String> excludedPackages) {
        if (pkg == null || pkg.isEmpty()) return false;
        if (PACKAGE_NAME.equals(pkg) || excludedPackages.contains(pkg)) {
            return false;
        }
        if (extraPackages.contains(pkg)) return true;
        try {
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            if ((ai.flags & ApplicationInfo.FLAG_SYSTEM) == 0) {
                return true;
            }
            // Also include popular preinstalled media/settings TV packages if launchable
            return pkg.contains("tv") || pkg.contains("video") || pkg.contains("settings")
                    || pkg.contains("player") || pkg.contains("media");
        } catch (Throwable ignored) {
            return false;
        }
    }
}
