package local.friday.tvagent;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.net.Uri;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import org.json.JSONException;

public final class TvAgentHttpServer {
    public static final int PORT = 8989;
    public static final String VERSION = "1.0.0";
    private static final int MAX_HEADER_LINE_BYTES = 8192;
    private static final int MAX_HEADER_COUNT = 64;
    private static final int MAX_BODY_BYTES = 262_144;
    private static final char[] HEX_DIGITS = "0123456789abcdef".toCharArray();

    private static final Object LOCK = new Object();
    private static final Object TOKEN_LOCK = new Object();
    private static volatile ServerSocket serverSocket;
    private static volatile Context appContext;
    private static final ExecutorService WORKER_POOL = new ThreadPoolExecutor(
            2,
            16,
            60L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<Runnable>(32),
            new ThreadPoolExecutor.AbortPolicy()
    );

    private static final class HeaderTooLargeException extends IOException {
        HeaderTooLargeException(String message) {
            super(message);
        }
    }

    private TvAgentHttpServer() {
    }

    public static void ensureStarted(Context context) {
        if (context != null && appContext == null) {
            appContext = context.getApplicationContext() != null
                    ? context.getApplicationContext()
                    : context;
        }
        ensureTokenInitialized(appContext != null ? appContext : context);
        synchronized (LOCK) {
            if (serverSocket != null && !serverSocket.isClosed() && serverSocket.isBound()) {
                return;
            }
            try {
                ServerSocket ss = new ServerSocket();
                ss.setReuseAddress(true);
                ss.bind(new InetSocketAddress("0.0.0.0", PORT), 32);
                serverSocket = ss;
                Log.i(TvAgentSelfHealer.TAG, "TvAgentHttpServer listening on 0.0.0.0:" + PORT);
                Thread acceptThread = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        acceptLoop(ss);
                    }
                }, "friday-tv-http-accept");
                acceptThread.setDaemon(true);
                acceptThread.start();
            } catch (Throwable t) {
                Log.w(TvAgentSelfHealer.TAG, "TvAgentHttpServer bind failed: " + t.getMessage());
            }
        }
    }

    private static void acceptLoop(ServerSocket ss) {
        while (!ss.isClosed()) {
            try {
                final Socket client = ss.accept();
                try {
                    WORKER_POOL.execute(new Runnable() {
                        @Override
                        public void run() {
                            handleClient(client);
                        }
                    });
                } catch (RejectedExecutionException rex) {
                    try {
                        sendJson(client, 503, new JSONObject().put("ok", false).put("error", "Server busy"));
                    } catch (Throwable ignored) {
                    } finally {
                        try {
                            client.close();
                        } catch (Throwable ignored) {
                        }
                    }
                }
            } catch (Throwable t) {
                if (ss.isClosed()) break;
            }
        }
    }

    private static void handleClient(Socket client) {
        try {
            client.setSoTimeout(8000);
            InetAddress remoteAddr = client.getInetAddress();
            if (!isAllowedClientAddress(remoteAddr)) {
                sendJson(client, 403, new JSONObject()
                        .put("ok", false)
                        .put("error", "Forbidden client address"));
                return;
            }

            BufferedInputStream in = new BufferedInputStream(client.getInputStream());
            String requestLine = readLine(in, MAX_HEADER_LINE_BYTES);
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                sendJson(client, 400, new JSONObject().put("ok", false).put("error", "Bad request line"));
                return;
            }
            String method = parts[0].toUpperCase(Locale.ROOT);
            String rawTarget = parts[1];

            Map<String, String> headers = new HashMap<>();
            int headerCount = 0;
            int contentLength = 0;
            boolean hasContentLength = false;
            while (true) {
                String line = readLine(in, MAX_HEADER_LINE_BYTES);
                if (line == null || line.isEmpty()) break;
                headerCount++;
                if (headerCount > MAX_HEADER_COUNT) {
                    sendJson(client, 431, new JSONObject().put("ok", false).put("error", "Too many headers"));
                    return;
                }
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String k = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                    String v = line.substring(colon + 1).trim();
                    headers.put(k, v);
                    if ("content-length".equals(k)) {
                        hasContentLength = true;
                        try {
                            contentLength = Integer.parseInt(v);
                        } catch (NumberFormatException nfe) {
                            sendJson(client, 400, new JSONObject().put("ok", false).put("error", "Invalid Content-Length"));
                            return;
                        }
                        if (contentLength < 0) {
                            sendJson(client, 400, new JSONObject().put("ok", false).put("error", "Negative Content-Length"));
                            return;
                        }
                    }
                }
            }

            // Anti-DNS-Rebinding & anti-CSRF checks: block browser Origin and non-IP/localhost Host.
            if (headers.containsKey("origin")) {
                sendJson(client, 403, new JSONObject().put("ok", false).put("error", "Browser Origin not permitted"));
                return;
            }
            if (!isValidHostHeader(headers.get("host"))) {
                sendJson(client, 403, new JSONObject().put("ok", false).put("error", "Invalid Host header"));
                return;
            }

            if ("OPTIONS".equals(method)) {
                sendOptions204(client);
                return;
            }

            String configuredToken = ensureTokenInitialized(appContext);
            String reqToken = headers.get("x-tv-token");
            if (configuredToken == null || configuredToken.isEmpty() || reqToken == null
                    || !MessageDigest.isEqual(
                            configuredToken.getBytes(StandardCharsets.UTF_8),
                            reqToken.getBytes(StandardCharsets.UTF_8))) {
                sendJson(client, 401, new JSONObject().put("ok", false).put("error", "Unauthorized X-TV-Token"));
                return;
            }

            if (hasContentLength && contentLength > MAX_BODY_BYTES) {
                sendJson(client, 413, new JSONObject().put("ok", false).put("error", "Payload too large"));
                return;
            }

            String bodyStr = "";
            if (contentLength > 0) {
                byte[] bodyBytes = readExact(in, contentLength);
                bodyStr = new String(bodyBytes, StandardCharsets.UTF_8);
            }

            Uri parsedUri = Uri.parse("http://localhost" + (rawTarget.startsWith("/") ? rawTarget : "/" + rawTarget));
            String path = parsedUri.getPath() != null ? parsedUri.getPath() : "/";

            if ("GET".equals(method) && "/status".equals(path)) {
                sendJson(client, 200, handleStatus());
                return;
            }
            if ("GET".equals(method) && "/tree".equals(path)) {
                int maxNodes = parseIntParam(parsedUri, "maxNodes", 80);
                sendJson(client, 200, handleTree(maxNodes));
                return;
            }
            if ("GET".equals(method) && "/screenshot".equals(path)) {
                int maxWidth = parseIntParam(parsedUri, "maxWidth", 960);
                int quality = parseIntParam(parsedUri, "quality", 70);
                String savePath = parsedUri.getQueryParameter("savePath");
                sendJson(client, 200, handleScreenshot(maxWidth, quality, savePath));
                return;
            }
            if ("POST".equals(method) && "/act".equals(path)) {
                JSONObject reqJson = bodyStr.trim().isEmpty() ? new JSONObject() : new JSONObject(bodyStr);
                sendJson(client, 200, handleAct(reqJson));
                return;
            }

            sendJson(client, 404, new JSONObject()
                    .put("ok", false)
                    .put("error", "Not found: " + method + " " + path));
        } catch (HeaderTooLargeException htle) {
            try {
                sendJson(client, 431, new JSONObject()
                        .put("ok", false)
                        .put("error", String.valueOf(htle.getMessage())));
            } catch (Throwable ignored) {
            }
        } catch (EOFException | JSONException badReq) {
            try {
                sendJson(client, 400, new JSONObject()
                        .put("ok", false)
                        .put("error", String.valueOf(badReq.getMessage())));
            } catch (Throwable ignored) {
            }
        } catch (SecurityException se) {
            try {
                sendJson(client, 403, new JSONObject()
                        .put("ok", false)
                        .put("error", String.valueOf(se.getMessage())));
            } catch (Throwable ignored) {
            }
        } catch (Throwable t) {
            try {
                sendJson(client, 500, new JSONObject()
                        .put("ok", false)
                        .put("error", String.valueOf(t.getMessage())));
            } catch (Throwable ignored) {
            }
        } finally {
            try {
                client.close();
            } catch (Throwable ignored) {
            }
        }
    }

    private static JSONObject handleStatus() throws Exception {
        Context ctx = appContext;
        TvAgentSelfHealer.ensureAccessibilityEnabled(ctx);
        TvAgentAccessibilityService svc = waitForServiceIfHealing(ctx, 250L);

        boolean awake = isScreenAwake(ctx);
        boolean a11yBound = (svc != null);
        boolean guardedLauncherEnabled = TvAgentSelfHealer.isGuardedLauncherEnabled(ctx);

        String pkg = "";
        String cls = "";
        if (svc != null) {
            String[] pc = svc.getCurrentPackageAndClass();
            pkg = pc[0];
            cls = pc[1];
        } else {
            pkg = TvAgentAccessibilityService.getLastPackageName();
            cls = TvAgentAccessibilityService.getLastClassName();
        }

        int volume = 0;
        int maxVolume = 100;
        if (ctx != null) {
            try {
                AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    volume = am.getStreamVolume(AudioManager.STREAM_MUSIC);
                    maxVolume = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                }
            } catch (Throwable ignored) {
            }
        }

        JSONArray apps = TvAgentSelfHealer.getLaunchableApps(ctx);

        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("version", VERSION);
        res.put("awake", awake);
        res.put("a11yBound", a11yBound);
        res.put("guardedLauncherEnabled", guardedLauncherEnabled);
        res.put("packageName", pkg != null ? pkg : "");
        res.put("className", cls != null ? cls : "");
        res.put("volume", volume);
        res.put("maxVolume", maxVolume);
        res.put("apps", apps);
        return res;
    }

    private static JSONObject handleTree(int maxNodes) throws Exception {
        Context ctx = appContext;
        TvAgentSelfHealer.ensureAccessibilityEnabled(ctx);
        TvAgentAccessibilityService svc = waitForServiceIfHealing(ctx, 900L);
        boolean awake = isScreenAwake(ctx);
        if (svc == null) {
            JSONObject err = new JSONObject();
            err.put("ok", false);
            err.put("awake", awake);
            err.put("a11yBound", false);
            err.put("packageName", TvAgentAccessibilityService.getLastPackageName());
            err.put("windowCount", 0);
            err.put("nodes", new JSONArray());
            err.put("error", "AccessibilityService is not bound");
            return err;
        }
        return svc.dumpTreeJson(maxNodes, awake);
    }

    private static JSONObject handleScreenshot(int maxWidth, int quality, String savePath) throws Exception {
        Context ctx = appContext;
        TvAgentSelfHealer.ensureAccessibilityEnabled(ctx);
        TvAgentAccessibilityService svc = waitForServiceIfHealing(ctx, 900L);
        if (svc == null) {
            JSONObject err = new JSONObject();
            err.put("ok", false);
            err.put("error", "AccessibilityService is not bound");
            return err;
        }
        Context storageCtx = ctx != null ? ctx : svc;
        File validatedOut = null;
        if (savePath != null && !savePath.trim().isEmpty()) {
            validatedOut = resolveSafeAppStoragePath(storageCtx, savePath.trim());
            if (validatedOut == null) {
                throw new SecurityException("savePath must stay within app filesDir or cacheDir");
            }
        }
        JSONObject result = svc.takeScreenshotJson(maxWidth, quality);
        if (validatedOut != null && result.optBoolean("ok", true) && result.has("base64")) {
            byte[] jpeg = Base64.decode(result.getString("base64"), Base64.DEFAULT);
            File parent = validatedOut.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            try (FileOutputStream fos = new FileOutputStream(validatedOut)) {
                fos.write(jpeg);
            }
            result.put("savedTo", validatedOut.getCanonicalPath());
        }
        return result;
    }

    private static File resolveSafeAppStoragePath(Context ctx, String rawSavePath) throws IOException {
        if (ctx == null || rawSavePath == null || rawSavePath.isEmpty()) return null;
        File filesDir = ctx.getFilesDir();
        File cacheDir = ctx.getCacheDir();
        File requested = new File(rawSavePath);
        if (!requested.isAbsolute()) {
            requested = new File(new File(filesDir, "screenshots"), rawSavePath);
        }
        String canonicalTarget = requested.getCanonicalPath();
        if (filesDir != null) {
            String filesPrefix = filesDir.getCanonicalPath() + File.separator;
            if (canonicalTarget.startsWith(filesPrefix)) return new File(canonicalTarget);
        }
        if (cacheDir != null) {
            String cachePrefix = cacheDir.getCanonicalPath() + File.separator;
            if (canonicalTarget.startsWith(cachePrefix)) return new File(canonicalTarget);
        }
        return null;
    }

    private static JSONObject handleAct(JSONObject body) throws Exception {
        Context ctx = appContext;
        TvAgentSelfHealer.ensureAccessibilityEnabled(ctx);
        String action = body.optString("action", "").trim().toLowerCase(Locale.ROOT);
        JSONObject res = new JSONObject();
        res.put("action", action);

        if ("wake".equals(action)) {
            boolean ok = TvAgentSelfHealer.wakeScreen(ctx);
            res.put("ok", ok);
            res.put("detail", ok ? "wake_lock_acquired" : "wake_failed");
            return res;
        }

        if ("launch_app".equals(action)) {
            String pkg = body.optString("package", body.optString("pkg", "")).trim();
            boolean ok = TvAgentSelfHealer.launchApp(ctx, pkg);
            res.put("ok", ok);
            res.put("detail", (ok ? "launched:" : "launch_failed:") + pkg);
            return res;
        }

        if ("open_uri".equals(action)) {
            String uri = body.optString("uri", body.optString("url", "")).trim();
            String pkg = body.optString("package", body.optString("pkg", "")).trim();
            boolean ok = TvAgentSelfHealer.openUri(ctx, uri, pkg);
            res.put("ok", ok);
            res.put("detail", (ok ? "opened:" : "open_uri_failed:") + uri);
            return res;
        }

        TvAgentAccessibilityService svc = waitForServiceIfHealing(ctx, 800L);

        if ("global".equals(action)) {
            String name = body.optString("name", body.optString("key", "")).trim().toLowerCase(Locale.ROOT);
            int globalId = mapGlobalAction(name);
            boolean ok = false;
            if (svc != null && globalId != -1) {
                ok = svc.performGlobalAction(globalId);
            }
            if (!ok && "home".equals(name)) {
                ok = TvAgentSelfHealer.launchHomeFallback(ctx);
                res.put("ok", ok);
                res.put("detail", ok ? "home_intent_fallback" : "home_failed");
                return res;
            }
            res.put("ok", ok);
            res.put("detail", (ok ? "global:" : "global_failed:") + name);
            return res;
        }

        if (svc == null) {
            res.put("ok", false);
            res.put("detail", "AccessibilityService is not bound");
            return res;
        }

        if ("click".equals(action)) {
            String id = body.optString("id", body.optString("nodeId", "")).trim();
            boolean hasCoords = body.has("x") && body.has("y");
            int x = body.optInt("x", 0);
            int y = body.optInt("y", 0);
            return svc.performClickAction(id, x, y, hasCoords);
        }

        if ("focus".equals(action)) {
            String id = body.optString("id", body.optString("nodeId", "")).trim();
            return svc.performFocusAction(id);
        }

        if ("set_text".equals(action)) {
            String id = body.optString("id", body.optString("nodeId", "")).trim();
            String text = body.optString("text", body.optString("value", ""));
            return svc.performSetTextAction(id, text);
        }

        if ("scroll".equals(action)) {
            String id = body.optString("id", body.optString("nodeId", "")).trim();
            String direction = body.optString("direction", body.optString("dir", "down")).trim();
            return svc.performScrollAction(id, direction);
        }

        res.put("ok", false);
        res.put("detail", "Unsupported action: " + action);
        return res;
    }

    private static int mapGlobalAction(String name) {
        if ("back".equals(name)) return AccessibilityService.GLOBAL_ACTION_BACK;
        if ("home".equals(name)) return AccessibilityService.GLOBAL_ACTION_HOME;
        if ("recents".equals(name) || "recent".equals(name)) return AccessibilityService.GLOBAL_ACTION_RECENTS;
        if ("notifications".equals(name)) return AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS;
        if ("quick_settings".equals(name)) return AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS;
        if ("dpad_up".equals(name) || "up".equals(name)) return 16; // AccessibilityService.GLOBAL_ACTION_DPAD_UP (API 33+)
        if ("dpad_down".equals(name) || "down".equals(name)) return 17; // AccessibilityService.GLOBAL_ACTION_DPAD_DOWN (API 33+)
        if ("dpad_left".equals(name) || "left".equals(name)) return 18; // AccessibilityService.GLOBAL_ACTION_DPAD_LEFT (API 33+)
        if ("dpad_right".equals(name) || "right".equals(name)) return 19; // AccessibilityService.GLOBAL_ACTION_DPAD_RIGHT (API 33+)
        if ("dpad_center".equals(name) || "center".equals(name) || "enter".equals(name) || "ok".equals(name)) return 20; // AccessibilityService.GLOBAL_ACTION_DPAD_CENTER (API 33+)
        return -1;
    }

    private static TvAgentAccessibilityService waitForServiceIfHealing(Context ctx, long maxWaitMs) {
        TvAgentAccessibilityService svc = TvAgentAccessibilityService.getInstance();
        if (svc != null) return svc;
        long deadline = SystemClock.elapsedRealtime() + maxWaitMs;
        while (SystemClock.elapsedRealtime() < deadline) {
            SystemClock.sleep(60L);
            svc = TvAgentAccessibilityService.getInstance();
            if (svc != null) return svc;
        }
        return TvAgentAccessibilityService.getInstance();
    }

    private static boolean isScreenAwake(Context ctx) {
        if (ctx == null) return true;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm == null || pm.isInteractive();
        } catch (Throwable ignored) {
            return true;
        }
    }

    private static boolean isAllowedClientAddress(InetAddress addr) {
        if (addr == null) return false;
        if (addr.isLoopbackAddress() || addr.isSiteLocalAddress() || addr.isLinkLocalAddress()) {
            return true;
        }
        String host = addr.getHostAddress();
        if (host == null) return false;
        if (host.startsWith("::ffff:")) {
            host = host.substring(7);
        }
        if (host.startsWith("127.") || host.startsWith("192.168.") || host.startsWith("10.")
                || "::1".equals(host) || host.startsWith("fd") || host.startsWith("fc") || host.startsWith("fe80:")) {
            return true;
        }
        if (host.startsWith("172.")) {
            String[] octets = host.split("\\.");
            if (octets.length >= 2) {
                try {
                    int second = Integer.parseInt(octets[1]);
                    return second >= 16 && second <= 31;
                } catch (NumberFormatException ignored) {
                }
            }
        }
        return false;
    }

    public static String ensureTokenInitialized(Context ctx) {
        if (ctx == null) return "";
        synchronized (TOKEN_LOCK) {
            try {
                Context storage = ctx.createDeviceProtectedStorageContext();
                SharedPreferences prefs = storage.getSharedPreferences("tv_agent_prefs", Context.MODE_PRIVATE);
                String existing = prefs.getString("x_tv_token", "");
                if (existing != null && existing.trim().length() >= 16) {
                    return existing.trim();
                }
                byte[] randomBytes = new byte[32];
                new SecureRandom().nextBytes(randomBytes);
                char[] hex = new char[64];
                for (int i = 0; i < 32; i++) {
                    int v = randomBytes[i] & 0xFF;
                    hex[i * 2] = HEX_DIGITS[v >>> 4];
                    hex[i * 2 + 1] = HEX_DIGITS[v & 0x0F];
                }
                String generated = new String(hex);
                prefs.edit().putString("x_tv_token", generated).commit();
                return generated;
            } catch (Throwable ignored) {
                return "";
            }
        }
    }

    public static String syncTokenIfValid(Context ctx, String token) {
        if (ctx == null) return "";
        if (token == null) return ensureTokenInitialized(ctx);
        String trimmed = token.trim().toLowerCase(Locale.ROOT);
        if (!trimmed.matches("^[0-9a-f]{32,128}$")) {
            return ensureTokenInitialized(ctx);
        }
        synchronized (TOKEN_LOCK) {
            try {
                Context storage = ctx.createDeviceProtectedStorageContext();
                SharedPreferences prefs = storage.getSharedPreferences("tv_agent_prefs", Context.MODE_PRIVATE);
                prefs.edit().putString("x_tv_token", trimmed).commit();
                return trimmed;
            } catch (Throwable ignored) {
                return "";
            }
        }
    }

    private static boolean isValidHostHeader(String rawHost) {
        if (rawHost == null) return false;
        String h = rawHost.trim().toLowerCase(Locale.ROOT);
        if (h.isEmpty() || h.length() > 128) return false;
        String hostname;
        if (h.startsWith("[")) {
            int closeIdx = h.indexOf(']');
            if (closeIdx <= 1) return false;
            hostname = h.substring(1, closeIdx);
            if (closeIdx + 1 < h.length()) {
                String portPart = h.substring(closeIdx + 1);
                if (!portPart.matches("^:\\d{1,5}$")) return false;
            }
            return hostname.matches("^[0-9a-f:]+$");
        }
        int colonIdx = h.indexOf(':');
        if (colonIdx >= 0) {
            String portPart = h.substring(colonIdx + 1);
            if (!portPart.matches("^\\d{1,5}$")) return false;
            hostname = h.substring(0, colonIdx);
        } else {
            hostname = h;
        }
        if ("localhost".equals(hostname)) return true;
        if (!hostname.matches("^\\d{1,3}(?:\\.\\d{1,3}){3}$")) return false;
        String[] octets = hostname.split("\\.");
        if (octets.length != 4) return false;
        for (String oct : octets) {
            try {
                int v = Integer.parseInt(oct);
                if (v < 0 || v > 255) return false;
            } catch (NumberFormatException nfe) {
                return false;
            }
        }
        return true;
    }

    private static int parseIntParam(Uri uri, String key, int defaultValue) {
        if (uri == null) return defaultValue;
        try {
            String v = uri.getQueryParameter(key);
            if (v != null && !v.trim().isEmpty()) {
                return Integer.parseInt(v.trim());
            }
        } catch (Throwable ignored) {
        }
        return defaultValue;
    }

    private static String readLine(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(128);
        int b;
        boolean sawByte = false;
        while ((b = in.read()) != -1) {
            sawByte = true;
            if (b == '\n') break;
            if (b != '\r') {
                baos.write(b);
            }
            if (baos.size() > maxBytes) {
                throw new HeaderTooLargeException("HTTP header line exceeds " + maxBytes + " bytes");
            }
        }
        if (!sawByte && baos.size() == 0) return null;
        return new String(baos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static byte[] readExact(InputStream in, int length) throws IOException {
        byte[] buf = new byte[length];
        int offset = 0;
        while (offset < length) {
            int n = in.read(buf, offset, length - offset);
            if (n == -1) {
                throw new EOFException("Unexpected EOF after " + offset + " of " + length + " bytes");
            }
            offset += n;
        }
        return buf;
    }

    private static void sendOptions204(Socket client) throws IOException {
        OutputStream out = client.getOutputStream();
        String headers = "HTTP/1.1 204 No Content\r\n"
                + "Content-Length: 0\r\n"
                + "Connection: close\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static void sendJson(Socket client, int statusCode, JSONObject json) throws IOException {
        byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
        String statusText = statusCode == 200 ? "OK"
                : statusCode == 400 ? "Bad Request"
                : statusCode == 401 ? "Unauthorized"
                : statusCode == 403 ? "Forbidden"
                : statusCode == 404 ? "Not Found"
                : statusCode == 413 ? "Payload Too Large"
                : statusCode == 431 ? "Request Header Fields Too Large"
                : statusCode == 503 ? "Service Unavailable"
                : "Internal Server Error";
        String headers = "HTTP/1.1 " + statusCode + " " + statusText + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n\r\n";
        OutputStream out = client.getOutputStream();
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }
}
