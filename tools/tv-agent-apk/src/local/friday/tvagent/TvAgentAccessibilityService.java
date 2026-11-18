package local.friday.tvagent;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class TvAgentAccessibilityService extends AccessibilityService {
    private static volatile TvAgentAccessibilityService instance;
    private static volatile String lastPackageName = "";
    private static volatile String lastClassName = "";

    private volatile Map<String, NodeSnapshot> latestNodes = Collections.emptyMap();
    private final Object executorLock = new Object();
    private volatile ExecutorService screenshotExecutor = Executors.newSingleThreadExecutor();
    private final Object screenshotLock = new Object();

    private volatile long lastScreenshotAtMs = 0L;
    private volatile int lastScreenshotMaxWidth = 0;
    private volatile int lastScreenshotQuality = 0;
    private volatile int lastScreenshotWidth = 0;
    private volatile int lastScreenshotHeight = 0;
    private volatile String lastScreenshotBase64 = null;

    public static final class NodeSnapshot {
        public final String id;
        public final String text;
        public final String desc;
        public final String viewId;
        public final String cls;
        public final String pkg;
        public final boolean focused;
        public final boolean selected;
        public final boolean clickable;
        public final boolean editable;
        public final boolean scrollable;
        public final Rect bounds;
        public final int cx;
        public final int cy;
        public final AccessibilityNodeInfo nodeRef;
        public final int priorityScore;

        public NodeSnapshot(
                String id,
                String text,
                String desc,
                String viewId,
                String cls,
                String pkg,
                boolean focused,
                boolean selected,
                boolean clickable,
                boolean editable,
                boolean scrollable,
                Rect bounds,
                AccessibilityNodeInfo nodeRef,
                int priorityScore) {
            this.id = id;
            this.text = text;
            this.desc = desc;
            this.viewId = viewId;
            this.cls = cls;
            this.pkg = pkg;
            this.focused = focused;
            this.selected = selected;
            this.clickable = clickable;
            this.editable = editable;
            this.scrollable = scrollable;
            this.bounds = new Rect(bounds);
            this.cx = (bounds.left + bounds.right) / 2;
            this.cy = (bounds.top + bounds.bottom) / 2;
            this.nodeRef = nodeRef;
            this.priorityScore = priorityScore;
        }

        public JSONObject toJson(String assignedId) throws Exception {
            JSONObject obj = new JSONObject();
            obj.put("id", assignedId);
            obj.put("text", text);
            obj.put("desc", desc);
            obj.put("viewId", viewId);
            obj.put("cls", cls);
            obj.put("pkg", pkg);
            obj.put("focused", focused);
            obj.put("selected", selected);
            obj.put("clickable", clickable);
            obj.put("editable", editable);
            obj.put("scrollable", scrollable);
            JSONArray b = new JSONArray();
            b.put(bounds.left);
            b.put(bounds.top);
            b.put(bounds.right);
            b.put(bounds.bottom);
            obj.put("bounds", b);
            obj.put("cx", cx);
            obj.put("cy", cy);
            return obj;
        }
    }

    public static TvAgentAccessibilityService getInstance() {
        return instance;
    }

    public static String getLastPackageName() {
        return lastPackageName;
    }

    public static String getLastClassName() {
        return lastClassName;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        Log.i(TvAgentSelfHealer.TAG, "TvAgentAccessibilityService onCreate");
        TvAgentHttpServer.ensureStarted(getApplicationContext());
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        Log.i(TvAgentSelfHealer.TAG, "TvAgentAccessibilityService onServiceConnected");
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info != null) {
                info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                        | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                        | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
                setServiceInfo(info);
            }
        } catch (Throwable t) {
            Log.w(TvAgentSelfHealer.TAG, "setServiceInfo warning: " + t.getMessage());
        }
        TvAgentHttpServer.ensureStarted(getApplicationContext());
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        CharSequence pkgCs = event.getPackageName();
        if (pkgCs != null && pkgCs.length() > 0) {
            String pkg = pkgCs.toString();
            if (!"com.android.systemui".equals(pkg) || lastPackageName.isEmpty()) {
                lastPackageName = pkg;
            }
        }
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            CharSequence clsCs = event.getClassName();
            if (clsCs != null && clsCs.length() > 0) {
                lastClassName = clsCs.toString();
            }
        }
    }

    @Override
    public void onInterrupt() {
    }

    private ExecutorService ensureScreenshotExecutor() {
        synchronized (executorLock) {
            if (screenshotExecutor == null || screenshotExecutor.isShutdown() || screenshotExecutor.isTerminated()) {
                screenshotExecutor = Executors.newSingleThreadExecutor();
            }
            return screenshotExecutor;
        }
    }

    private void releaseResources() {
        latestNodes = Collections.emptyMap();
        synchronized (screenshotLock) {
            lastScreenshotBase64 = null;
            lastScreenshotAtMs = 0L;
            lastScreenshotMaxWidth = 0;
            lastScreenshotQuality = 0;
        }
        synchronized (executorLock) {
            if (screenshotExecutor != null && !screenshotExecutor.isShutdown()) {
                screenshotExecutor.shutdownNow();
            }
        }
    }

    @Override
    public boolean onUnbind(Intent intent) {
        if (instance == this) {
            instance = null;
        }
        releaseResources();
        TvAgentSelfHealer.ensureAccessibilityEnabled(getApplicationContext());
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        if (instance == this) {
            instance = null;
        }
        releaseResources();
        super.onDestroy();
    }

    public String[] getCurrentPackageAndClass() {
        String pkg = lastPackageName;
        String cls = lastClassName;
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) {
                if (root.getPackageName() != null && root.getPackageName().length() > 0) {
                    pkg = root.getPackageName().toString();
                    lastPackageName = pkg;
                }
                if (cls.isEmpty() && root.getClassName() != null) {
                    cls = root.getClassName().toString();
                }
            } else {
                List<AccessibilityWindowInfo> windows = getWindows();
                if (windows != null) {
                    for (AccessibilityWindowInfo w : windows) {
                        if (w != null && (w.isActive() || w.isFocused())) {
                            AccessibilityNodeInfo wr = w.getRoot();
                            if (wr != null && wr.getPackageName() != null) {
                                pkg = wr.getPackageName().toString();
                                lastPackageName = pkg;
                                break;
                            }
                        }
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return new String[]{pkg != null ? pkg : "", cls != null ? cls : ""};
    }

    private List<AccessibilityNodeInfo> collectWindowRoots() {
        List<AccessibilityNodeInfo> roots = new ArrayList<>();
        List<String> seenRootKeys = new ArrayList<>();
        try {
            AccessibilityNodeInfo activeRoot = getRootInActiveWindow();
            if (activeRoot != null) {
                Rect r = new Rect();
                activeRoot.getBoundsInScreen(r);
                String key = safeStr(activeRoot.getPackageName()) + "@" + r.toShortString();
                roots.add(activeRoot);
                seenRootKeys.add(key);
            }
        } catch (Throwable ignored) {
        }
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            if (windows != null) {
                for (AccessibilityWindowInfo win : windows) {
                    if (win == null) continue;
                    AccessibilityNodeInfo root = win.getRoot();
                    if (root == null) continue;
                    Rect r = new Rect();
                    root.getBoundsInScreen(r);
                    String key = safeStr(root.getPackageName()) + "@" + r.toShortString();
                    if (!seenRootKeys.contains(key)) {
                        roots.add(root);
                        seenRootKeys.add(key);
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return roots;
    }

    public JSONObject dumpTreeJson(int maxNodes, boolean awake) throws Exception {
        int limit = Math.max(1, Math.min(maxNodes, 250));
        List<AccessibilityNodeInfo> roots = collectWindowRoots();
        String activePkg = getCurrentPackageAndClass()[0];

        List<NodeSnapshot> rawCandidates = new ArrayList<>();
        for (AccessibilityNodeInfo root : roots) {
            traverseNode(root, rawCandidates, 0);
        }

        if (rawCandidates.size() > limit) {
            // Keep highest priority nodes first, then restore visual reading order
            List<NodeSnapshot> byPriority = new ArrayList<>(rawCandidates);
            Collections.sort(byPriority, new Comparator<NodeSnapshot>() {
                @Override
                public int compare(NodeSnapshot a, NodeSnapshot b) {
                    return Integer.compare(b.priorityScore, a.priorityScore);
                }
            });
            final List<NodeSnapshot> selectedSublist = byPriority.subList(0, limit);
            List<NodeSnapshot> ordered = new ArrayList<>();
            for (NodeSnapshot candidate : rawCandidates) {
                if (selectedSublist.contains(candidate)) {
                    ordered.add(candidate);
                }
            }
            rawCandidates = ordered;
        }

        Map<String, NodeSnapshot> nextNodes = new HashMap<>(rawCandidates.size());
        JSONArray nodesArr = new JSONArray();
        for (int i = 0; i < rawCandidates.size(); i++) {
            String nodeId = "n" + i;
            NodeSnapshot snap = rawCandidates.get(i);
            nextNodes.put(nodeId, new NodeSnapshot(
                    nodeId,
                    snap.text,
                    snap.desc,
                    snap.viewId,
                    snap.cls,
                    snap.pkg,
                    snap.focused,
                    snap.selected,
                    snap.clickable,
                    snap.editable,
                    snap.scrollable,
                    snap.bounds,
                    snap.nodeRef,
                    snap.priorityScore));
            nodesArr.put(snap.toJson(nodeId));
        }
        this.latestNodes = Collections.unmodifiableMap(nextNodes);

        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("awake", awake);
        res.put("a11yBound", true);
        res.put("packageName", activePkg);
        res.put("windowCount", roots.size());
        res.put("nodes", nodesArr);
        return res;
    }

    private void traverseNode(
            AccessibilityNodeInfo node,
            List<NodeSnapshot> out,
            int depth) {
        if (node == null || depth > 36 || out.size() >= 600) return;
        if (!node.isVisibleToUser()) return;

        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (bounds.right <= bounds.left
                || bounds.bottom <= bounds.top
                || bounds.right <= 0
                || bounds.bottom <= 0) {
            return;
        }

        String ownText = safeStr(node.getText());
        String ownDesc = safeStr(node.getContentDescription());
        String viewId = safeStr(node.getViewIdResourceName());
        String cls = safeStr(node.getClassName());
        String pkg = safeStr(node.getPackageName());

        boolean focused = node.isFocused() || node.isAccessibilityFocused();
        boolean selected = node.isSelected();
        boolean clickable = node.isClickable() || hasClickAction(node);
        boolean focusable = node.isFocusable();
        boolean editable = node.isEditable();
        boolean scrollable = node.isScrollable();

        // Smart TV card label aggregation:
        // When a clickable or focused/focusable card container has empty text,
        // is not a scrollable list/grid, and has no separate interactive child buttons,
        // aggregate up to 3 short child texts into its text and skip redundant pure-text children.
        boolean absorbedPureTextChildren = false;
        if ((clickable || focused || (focusable && selected) || (focusable && !scrollable))
                && !isMultiItemCollectionView(cls, scrollable)
                && countInteractiveDescendants(node, 0) == 0) {
            if (ownText.isEmpty()) {
                List<String> childTexts = new ArrayList<>();
                collectShortChildTexts(node, 0, childTexts);
                if (!childTexts.isEmpty()) {
                    StringBuilder sb = new StringBuilder();
                    for (int i = 0; i < childTexts.size(); i++) {
                        if (i > 0) sb.append(" · ");
                        sb.append(childTexts.get(i));
                    }
                    ownText = sb.toString();
                    clickable = true;
                    absorbedPureTextChildren = true;
                } else if (!ownDesc.isEmpty()) {
                    ownText = ownDesc;
                    clickable = true;
                    absorbedPureTextChildren = true;
                }
            } else {
                absorbedPureTextChildren = true;
            }
        }

        boolean shouldEmit = focused
                || selected
                || editable
                || clickable
                || scrollable
                || !ownText.isEmpty()
                || !ownDesc.isEmpty()
                || (focusable && !viewId.isEmpty() && !isMultiItemCollectionView(cls, false));

        if (shouldEmit) {
            int priority = 0;
            if (focused) priority += 100;
            if (editable) priority += 90;
            if (selected) priority += 50;
            if (clickable && (!ownText.isEmpty() || !ownDesc.isEmpty())) priority += 70;
            else if (clickable) priority += 30;
            else if (!ownText.isEmpty() || !ownDesc.isEmpty()) priority += 40;
            if (scrollable) priority += 20;

            out.add(new NodeSnapshot(
                    "",
                    ownText,
                    ownDesc,
                    viewId,
                    cls,
                    pkg,
                    focused,
                    selected,
                    clickable,
                    editable,
                    scrollable,
                    bounds,
                    node,
                    priority));
        }

        if (absorbedPureTextChildren) {
            return;
        }

        int childCount = node.getChildCount();
        for (int i = 0; i < childCount; i++) {
            AccessibilityNodeInfo child = null;
            try {
                child = node.getChild(i);
            } catch (Throwable ignored) {
            }
            if (child != null) {
                traverseNode(child, out, depth + 1);
            }
        }
    }

    private static boolean hasClickAction(AccessibilityNodeInfo node) {
        if (node == null) return false;
        List<AccessibilityNodeInfo.AccessibilityAction> actions = node.getActionList();
        if (actions == null) return false;
        for (AccessibilityNodeInfo.AccessibilityAction action : actions) {
            if (action != null && action.getId() == AccessibilityNodeInfo.ACTION_CLICK) {
                return true;
            }
        }
        return false;
    }

    private static boolean isMultiItemCollectionView(String cls, boolean scrollable) {
        if (scrollable) return true;
        if (cls == null || cls.isEmpty()) return false;
        return cls.contains("RecyclerView")
                || cls.contains("GridView")
                || cls.contains("ListView")
                || cls.contains("ScrollView")
                || cls.contains("ViewPager")
                || cls.contains("BrowseFrameLayout");
    }

    private static int countInteractiveDescendants(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 3) return 0;
        int count = 0;
        int childCount = node.getChildCount();
        for (int i = 0; i < childCount; i++) {
            AccessibilityNodeInfo child = null;
            try {
                child = node.getChild(i);
            } catch (Throwable ignored) {
            }
            if (child == null || !child.isVisibleToUser()) continue;
            if (child.isClickable() || child.isEditable() || child.isScrollable() || child.isFocusable()) {
                count++;
                if (count > 0) return count;
            }
            count += countInteractiveDescendants(child, depth + 1);
            if (count > 0) return count;
        }
        return count;
    }

    private static void collectShortChildTexts(
            AccessibilityNodeInfo node,
            int depth,
            List<String> out) {
        if (node == null || depth > 3 || out.size() >= 3) return;
        int childCount = node.getChildCount();
        for (int i = 0; i < childCount && out.size() < 3; i++) {
            AccessibilityNodeInfo child = null;
            try {
                child = node.getChild(i);
            } catch (Throwable ignored) {
            }
            if (child == null || !child.isVisibleToUser()) continue;
            String t = safeStr(child.getText());
            if (t.isEmpty()) {
                t = safeStr(child.getContentDescription());
            }
            if (!t.isEmpty() && t.length() <= 60 && !out.contains(t)) {
                out.add(t);
            }
            if (out.size() < 3) {
                collectShortChildTexts(child, depth + 1, out);
            }
        }
    }

    public JSONObject takeScreenshotJson(int maxWidth, int quality) throws Exception {
        final int targetMaxWidth = Math.max(320, Math.min(maxWidth, 1920));
        final int jpegQuality = Math.max(30, Math.min(quality, 95));

        synchronized (screenshotLock) {
            long now = SystemClock.elapsedRealtime();
            if (lastScreenshotBase64 != null
                    && (now - lastScreenshotAtMs) < 900L
                    && lastScreenshotMaxWidth == targetMaxWidth
                    && lastScreenshotQuality == jpegQuality) {
                JSONObject cached = new JSONObject();
                cached.put("ok", true);
                cached.put("mimeType", "image/jpeg");
                cached.put("width", lastScreenshotWidth);
                cached.put("height", lastScreenshotHeight);
                cached.put("base64", lastScreenshotBase64);
                cached.put("cached", true);
                return cached;
            }

            JSONObject result = captureOnce(targetMaxWidth, jpegQuality);
            if (!result.optBoolean("ok", false)
                    && result.optInt("errorCode", -1) == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) {
                if (lastScreenshotBase64 != null
                        && (SystemClock.elapsedRealtime() - lastScreenshotAtMs) < 5000L
                        && lastScreenshotMaxWidth == targetMaxWidth
                        && lastScreenshotQuality == jpegQuality) {
                    JSONObject fallback = new JSONObject();
                    fallback.put("ok", true);
                    fallback.put("mimeType", "image/jpeg");
                    fallback.put("width", lastScreenshotWidth);
                    fallback.put("height", lastScreenshotHeight);
                    fallback.put("base64", lastScreenshotBase64);
                    fallback.put("cached", true);
                    return fallback;
                }
                SystemClock.sleep(550L);
                result = captureOnce(targetMaxWidth, jpegQuality);
            }
            return result;
        }
    }

    private JSONObject captureOnce(final int targetMaxWidth, final int jpegQuality) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        final JSONObject out = new JSONObject();

        takeScreenshot(Display.DEFAULT_DISPLAY, ensureScreenshotExecutor(), new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult screenshot) {
                HardwareBuffer hwBuf = null;
                Bitmap hwBitmap = null;
                Bitmap swBitmap = null;
                Bitmap scaledBitmap = null;
                try {
                    hwBuf = screenshot.getHardwareBuffer();
                    ColorSpace colorSpace = screenshot.getColorSpace();
                    hwBitmap = Bitmap.wrapHardwareBuffer(hwBuf, colorSpace);
                    if (hwBitmap == null) {
                        out.put("ok", false);
                        out.put("error", "Bitmap.wrapHardwareBuffer returned null");
                        return;
                    }
                    swBitmap = hwBitmap.copy(Bitmap.Config.ARGB_8888, false);
                    if (swBitmap == null) {
                        out.put("ok", false);
                        out.put("error", "Bitmap.copy(ARGB_8888) returned null");
                        return;
                    }
                    int srcW = swBitmap.getWidth();
                    int srcH = swBitmap.getHeight();
                    if (srcW > targetMaxWidth) {
                        int dstW = targetMaxWidth;
                        int dstH = Math.max(1, Math.round((float) srcH * dstW / srcW));
                        scaledBitmap = Bitmap.createScaledBitmap(swBitmap, dstW, dstH, true);
                    } else {
                        scaledBitmap = swBitmap;
                    }

                    ByteArrayOutputStream baos = new ByteArrayOutputStream(32768);
                    scaledBitmap.compress(Bitmap.CompressFormat.JPEG, jpegQuality, baos);
                    String b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);

                    int finalW = scaledBitmap.getWidth();
                    int finalH = scaledBitmap.getHeight();

                    lastScreenshotAtMs = SystemClock.elapsedRealtime();
                    lastScreenshotMaxWidth = targetMaxWidth;
                    lastScreenshotQuality = jpegQuality;
                    lastScreenshotWidth = finalW;
                    lastScreenshotHeight = finalH;
                    lastScreenshotBase64 = b64;

                    out.put("ok", true);
                    out.put("mimeType", "image/jpeg");
                    out.put("width", finalW);
                    out.put("height", finalH);
                    out.put("base64", b64);
                } catch (Throwable t) {
                    try {
                        out.put("ok", false);
                        out.put("error", "Screenshot processing error: " + t.getMessage());
                    } catch (Throwable ignored) {
                    }
                } finally {
                    if (scaledBitmap != null && scaledBitmap != swBitmap) {
                        try { scaledBitmap.recycle(); } catch (Throwable ignored) {}
                    }
                    if (swBitmap != null) {
                        try { swBitmap.recycle(); } catch (Throwable ignored) {}
                    }
                    if (hwBitmap != null) {
                        try { hwBitmap.recycle(); } catch (Throwable ignored) {}
                    }
                    if (hwBuf != null) {
                        try { hwBuf.close(); } catch (Throwable ignored) {}
                    }
                    latch.countDown();
                }
            }

            @Override
            public void onFailure(int errorCode) {
                try {
                    out.put("ok", false);
                    out.put("errorCode", errorCode);
                    out.put("error", "takeScreenshot failed with errorCode=" + errorCode);
                } catch (Throwable ignored) {
                } finally {
                    latch.countDown();
                }
            }
        });

        boolean completed = latch.await(4500L, TimeUnit.MILLISECONDS);
        if (!completed) {
            JSONObject timeoutObj = new JSONObject();
            timeoutObj.put("ok", false);
            timeoutObj.put("error", "takeScreenshot timed out after 4500ms");
            return timeoutObj;
        }
        return out;
    }

    public JSONObject performClickAction(String id, int x, int y, boolean hasCoords) throws Exception {
        JSONObject res = new JSONObject();
        res.put("action", "click");
        if (id != null && !id.isEmpty()) {
            NodeSnapshot snap = latestNodes.get(id);
            if (snap == null) {
                // Refresh tree snapshot once in case /tree wasn't called yet
                dumpTreeJson(100, true);
                snap = latestNodes.get(id);
            }
            if (snap == null) {
                res.put("ok", false);
                res.put("detail", "Node not found: " + id);
                return res;
            }
            AccessibilityNodeInfo target = resolveLiveNode(snap);
            if (target != null && performClickOnNodeOrAncestors(target)) {
                res.put("ok", true);
                res.put("detail", "action_click:" + id);
                return res;
            }
            boolean tapped = dispatchTapGesture(snap.cx, snap.cy, 60L);
            res.put("ok", tapped);
            res.put("detail", (tapped ? "gesture_tap_fallback:" : "click_failed:") + id + "@(" + snap.cx + "," + snap.cy + ")");
            return res;
        }
        if (hasCoords) {
            boolean tapped = dispatchTapGesture(x, y, 60L);
            res.put("ok", tapped);
            res.put("detail", (tapped ? "gesture_tap:" : "gesture_tap_failed:") + x + "," + y);
            return res;
        }
        res.put("ok", false);
        res.put("detail", "click requires id or (x, y)");
        return res;
    }

    public JSONObject performFocusAction(String id) throws Exception {
        JSONObject res = new JSONObject();
        res.put("action", "focus");
        if (id == null || id.isEmpty()) {
            res.put("ok", false);
            res.put("detail", "focus requires id");
            return res;
        }
        NodeSnapshot snap = latestNodes.get(id);
        if (snap == null) {
            dumpTreeJson(100, true);
            snap = latestNodes.get(id);
        }
        if (snap == null) {
            res.put("ok", false);
            res.put("detail", "Node not found: " + id);
            return res;
        }
        AccessibilityNodeInfo target = resolveLiveNode(snap);
        boolean ok = false;
        AccessibilityNodeInfo curr = target;
        for (int level = 0; level <= 2 && curr != null; level++) {
            boolean f1 = curr.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            boolean f2 = curr.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS);
            if (f1 || f2) {
                ok = true;
                break;
            }
            curr = curr.getParent();
        }
        res.put("ok", ok);
        res.put("detail", (ok ? "focused:" : "focus_failed:") + id);
        return res;
    }

    public JSONObject performSetTextAction(String id, String text) throws Exception {
        JSONObject res = new JSONObject();
        res.put("action", "set_text");
        String value = text != null ? text : "";
        AccessibilityNodeInfo target = null;

        if (id != null && !id.isEmpty()) {
            NodeSnapshot snap = latestNodes.get(id);
            if (snap == null) {
                dumpTreeJson(100, true);
                snap = latestNodes.get(id);
            }
            if (snap != null) {
                target = resolveLiveNode(snap);
                if (target != null && !target.isEditable()) {
                    AccessibilityNodeInfo editableChild = findEditableNode(target, 0);
                    if (editableChild != null) {
                        target = editableChild;
                    }
                }
            }
        }

        if (target == null) {
            List<AccessibilityNodeInfo> roots = collectWindowRoots();
            // First look for focused editable node
            for (AccessibilityNodeInfo r : roots) {
                AccessibilityNodeInfo found = findFocusedEditableNode(r, 0);
                if (found != null) {
                    target = found;
                    break;
                }
            }
            // Next look for any editable node
            if (target == null) {
                for (AccessibilityNodeInfo r : roots) {
                    AccessibilityNodeInfo found = findEditableNode(r, 0);
                    if (found != null) {
                        target = found;
                        break;
                    }
                }
            }
        }

        if (target == null) {
            res.put("ok", false);
            res.put("detail", "No editable node found for set_text");
            return res;
        }

        target.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        target.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS);
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        res.put("ok", ok);
        res.put("detail", (ok ? "set_text_ok:" : "set_text_failed:") + (id != null && !id.isEmpty() ? id : "auto"));
        return res;
    }

    public JSONObject performScrollAction(String id, String direction) throws Exception {
        JSONObject res = new JSONObject();
        res.put("action", "scroll");
        String dir = (direction == null || direction.isEmpty()) ? "down" : direction.trim().toLowerCase();
        int actionId = ("up".equals(dir) || "left".equals(dir) || "backward".equals(dir))
                ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;

        AccessibilityNodeInfo scrollableTarget = null;
        if (id != null && !id.isEmpty()) {
            NodeSnapshot snap = latestNodes.get(id);
            if (snap != null) {
                AccessibilityNodeInfo node = resolveLiveNode(snap);
                AccessibilityNodeInfo curr = node;
                for (int i = 0; i <= 5 && curr != null; i++) {
                    if (curr.isScrollable()) {
                        scrollableTarget = curr;
                        break;
                    }
                    curr = curr.getParent();
                }
            }
        }

        if (scrollableTarget == null) {
            List<AccessibilityNodeInfo> roots = collectWindowRoots();
            for (AccessibilityNodeInfo r : roots) {
                scrollableTarget = findScrollableNode(r, 0);
                if (scrollableTarget != null) break;
            }
        }

        boolean ok = false;
        if (scrollableTarget != null) {
            ok = scrollableTarget.performAction(actionId);
        }
        if (!ok) {
            ok = dispatchSwipeGesture(dir);
            res.put("ok", ok);
            res.put("detail", (ok ? "gesture_scroll:" : "scroll_failed:") + dir);
            return res;
        }
        res.put("ok", true);
        res.put("detail", "action_scroll:" + dir);
        return res;
    }

    private boolean performClickOnNodeOrAncestors(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo curr = node;
        for (int level = 0; level <= 3 && curr != null; level++) {
            try {
                if (curr.isFocusable() && !curr.isFocused()) {
                    curr.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                }
                if (curr.isClickable() || hasClickAction(curr) || level == 0) {
                    if (curr.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                        return true;
                    }
                }
                curr = curr.getParent();
            } catch (Throwable ignored) {
                break;
            }
        }
        return false;
    }

    private AccessibilityNodeInfo resolveLiveNode(NodeSnapshot snap) {
        if (snap == null) return null;
        if (snap.nodeRef != null) {
            try {
                if (!snap.nodeRef.refresh()) {
                    return null;
                }
                if (snap.nodeRef.isVisibleToUser()) {
                    return snap.nodeRef;
                }
            } catch (Throwable ignored) {
                return null;
            }
        }
        return null;
    }

    private static AccessibilityNodeInfo findFocusedEditableNode(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 30) return null;
        if (node.isVisibleToUser() && node.isEditable() && (node.isFocused() || node.isAccessibilityFocused())) {
            return node;
        }
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = null;
            try { child = node.getChild(i); } catch (Throwable ignored) {}
            AccessibilityNodeInfo found = findFocusedEditableNode(child, depth + 1);
            if (found != null) return found;
        }
        return null;
    }

    private static AccessibilityNodeInfo findEditableNode(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 30) return null;
        if (node.isVisibleToUser() && node.isEditable()) {
            return node;
        }
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = null;
            try { child = node.getChild(i); } catch (Throwable ignored) {}
            AccessibilityNodeInfo found = findEditableNode(child, depth + 1);
            if (found != null) return found;
        }
        return null;
    }

    private static AccessibilityNodeInfo findScrollableNode(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 30) return null;
        if (node.isVisibleToUser() && node.isScrollable()) {
            return node;
        }
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = null;
            try { child = node.getChild(i); } catch (Throwable ignored) {}
            AccessibilityNodeInfo found = findScrollableNode(child, depth + 1);
            if (found != null) return found;
        }
        return null;
    }

    public boolean dispatchTapGesture(int x, int y, long durationMs) {
        try {
            Path path = new Path();
            path.moveTo(Math.max(1, x), Math.max(1, y));
            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0L, Math.max(40L, durationMs));
            GestureDescription gesture = new GestureDescription.Builder()
                    .addStroke(stroke)
                    .build();
            final CountDownLatch latch = new CountDownLatch(1);
            final AtomicBoolean success = new AtomicBoolean(false);
            boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gestureDescription) {
                    success.set(true);
                    latch.countDown();
                }

                @Override
                public void onCancelled(GestureDescription gestureDescription) {
                    latch.countDown();
                }
            }, null);
            if (!accepted) return false;
            latch.await(1500L, TimeUnit.MILLISECONDS);
            return success.get();
        } catch (Throwable t) {
            Log.w(TvAgentSelfHealer.TAG, "dispatchTapGesture failed: " + t.getMessage());
            return false;
        }
    }

    public boolean dispatchSwipeGesture(String direction) {
        try {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            int w = dm != null && dm.widthPixels > 0 ? dm.widthPixels : 1920;
            int h = dm != null && dm.heightPixels > 0 ? dm.heightPixels : 1080;
            int startX = w / 2;
            int startY = h / 2;
            int endX = startX;
            int endY = startY;
            if ("up".equals(direction) || "backward".equals(direction)) {
                startY = (int) (h * 0.3f);
                endY = (int) (h * 0.75f);
            } else if ("left".equals(direction)) {
                startX = (int) (w * 0.3f);
                endX = (int) (w * 0.75f);
            } else if ("right".equals(direction)) {
                startX = (int) (w * 0.75f);
                endX = (int) (w * 0.25f);
            } else {
                // down / forward
                startY = (int) (h * 0.75f);
                endY = (int) (h * 0.25f);
            }
            Path path = new Path();
            path.moveTo(startX, startY);
            path.lineTo(endX, endY);
            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0L, 220L);
            GestureDescription gesture = new GestureDescription.Builder()
                    .addStroke(stroke)
                    .build();
            final CountDownLatch latch = new CountDownLatch(1);
            final AtomicBoolean success = new AtomicBoolean(false);
            boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gestureDescription) {
                    success.set(true);
                    latch.countDown();
                }

                @Override
                public void onCancelled(GestureDescription gestureDescription) {
                    latch.countDown();
                }
            }, null);
            if (!accepted) return false;
            latch.await(1500L, TimeUnit.MILLISECONDS);
            return success.get();
        } catch (Throwable t) {
            return false;
        }
    }

    private static String safeStr(CharSequence cs) {
        if (cs == null) return "";
        return cs.toString().trim();
    }
}
