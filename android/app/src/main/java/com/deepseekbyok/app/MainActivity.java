package com.deepseekbyok.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.AssetManager;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public final class MainActivity extends Activity {
  private static final int REQ_FILE_CHOOSER = 1001;
  private static final int REQ_CREATE_DOCUMENT = 1002;
  private static final int MAX_EXPORT_SESSIONS = 4;
  private static final long MAX_EXPORT_BYTES = 256L * 1024 * 1024;
  private static final String CANONICAL_ORIGIN =
      "http://127.0.0.1:" + LocalBridgeServer.CANONICAL_WEB_PORT;

  private LocalBridgeServer bridgeServer;
  private int bridgePort;
  private String bridgeToken;
  private WebView webView;
  private ValueCallback<Uri[]> filePathCallback;
  private File pendingExportFile;
  private final Map<String, ExportSession> exportSessions = new ConcurrentHashMap<>();

  private static final class ExportSession {
    final String fileName;
    final String mimeType;
    final File file;
    final FileOutputStream stream;
    long writtenBytes;

    ExportSession(String fileName, String mimeType, File file, FileOutputStream stream) {
      this.fileName = fileName;
      this.mimeType = mimeType;
      this.file = file;
      this.stream = stream;
    }
  }

  private static String generateBridgeToken() {
    byte[] bytes = new byte[32];
    new SecureRandom().nextBytes(bytes);
    StringBuilder hex = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      hex.append(Character.forDigit((b >>> 4) & 0x0f, 16));
      hex.append(Character.forDigit(b & 0x0f, 16));
    }
    return hex.toString();
  }

  private static String sanitizeExportFileName(String raw) {
    if (raw == null || raw.isEmpty()) {
      return "export.dat";
    }
    String clean = raw.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "_").trim();
    return clean.isEmpty() ? "export.dat" : clean;
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    AssetManager assets = getAssets();
    bridgeToken = generateBridgeToken();
    bridgeServer = new LocalBridgeServer(rel -> assets.open("web/" + rel), bridgeToken);
    bridgeServer.setExpectedOriginPort(LocalBridgeServer.CANONICAL_WEB_PORT);
    try {
      bridgePort = bridgeServer.start(LocalBridgeServer.CANONICAL_WEB_PORT);
    } catch (IOException err) {
      Toast.makeText(this, "Local bridge failed: " + err.getMessage(), Toast.LENGTH_LONG).show();
      finish();
      return;
    }

    attachWebView();
  }

  @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
  private void attachWebView() {
    WebView view = new WebView(this);
    this.webView = view;
    setContentView(view);

    if (Build.VERSION.SDK_INT >= 30) {
      view.setOnApplyWindowInsetsListener(
          (v, windowInsets) -> {
            Insets insets =
                windowInsets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            v.setPadding(insets.left, insets.top, insets.right, insets.bottom);
            return WindowInsets.CONSUMED;
          });
    }
    syncThemeChrome(getResources().getConfiguration());

    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(true);
    settings.setMediaPlaybackRequiresUserGesture(false);

    view.addJavascriptInterface(new ExportBridge(), "AndroidExportBridge");

    view.setWebViewClient(
        new WebViewClient() {
          @Override
          public WebResourceResponse shouldInterceptRequest(
              WebView targetView, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme =
                uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            if (!"http".equals(scheme)
                || !"127.0.0.1".equals(host)
                || uri.getPort() != LocalBridgeServer.CANONICAL_WEB_PORT) {
              return null;
            }
            String reqMethod =
                request.getMethod() != null ? request.getMethod().toUpperCase(Locale.ROOT) : "GET";
            String path = uri.getPath() != null ? uri.getPath() : "/";
            if ("/_proxy".equals(path)) {
              return null;
            }
            if (!"GET".equals(reqMethod) && !"HEAD".equals(reqMethod)) {
              return null;
            }
            LocalBridgeServer server = bridgeServer;
            if (server == null) {
              return null;
            }
            return toWebResourceResponse(server.resolveStaticAsset(path), "HEAD".equals(reqMethod));
          }

          @Override
          public boolean shouldOverrideUrlLoading(WebView targetView, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme =
                uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            if ("http".equals(scheme)
                && "127.0.0.1".equals(host)
                && uri.getPort() == LocalBridgeServer.CANONICAL_WEB_PORT) {
              return false;
            }
            if ("https".equals(scheme) || "http".equals(scheme) || "mailto".equals(scheme)) {
              try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
              } catch (Exception ignored) {
              }
            }
            return true;
          }

          @Override
          public void onPageFinished(WebView targetView, String url) {
            super.onPageFinished(targetView, url);
            injectBlobExportHook(targetView);
          }

          @Override
          public void onReceivedError(
              WebView targetView, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) {
              return;
            }
            String html =
                "<!doctype html><html><meta charset='utf-8'><meta name='viewport'"
                    + " content='width=device-width,initial-scale=1'><body"
                    + " style='font-family:sans-serif;padding:32px;text-align:center'><h2>Page"
                    + " load interrupted</h2><p>Local workspace failed to initialize cleanly.</p>"
                    + "<button onclick=\"location.replace('"
                    + CANONICAL_ORIGIN
                    + "/')\" style='padding:10px"
                    + " 18px;font-size:16px'>Reload</button></body></html>";
            targetView.loadDataWithBaseURL(
                CANONICAL_ORIGIN + "/", html, "text/html", "utf-8", null);
          }

          @Override
          public boolean onRenderProcessGone(
              WebView targetView, RenderProcessGoneDetail detail) {
            if (targetView != webView) {
              return false;
            }
            if (targetView.getParent() instanceof ViewGroup) {
              ((ViewGroup) targetView.getParent()).removeView(targetView);
            }
            targetView.destroy();
            webView = null;
            Toast.makeText(
                    MainActivity.this,
                    "Reloading workspace after memory reclaim",
                    Toast.LENGTH_SHORT)
                .show();
            attachWebView();
            return true;
          }
        });

    view.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onShowFileChooser(
              WebView targetView,
              ValueCallback<Uri[]> fileCallback,
              FileChooserParams fileChooserParams) {
            if (filePathCallback != null) {
              filePathCallback.onReceiveValue(null);
            }
            filePathCallback = fileCallback;

            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            if (fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
              intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
              startActivityForResult(Intent.createChooser(intent, "Select File"), REQ_FILE_CHOOSER);
              return true;
            } catch (Exception err) {
              filePathCallback = null;
              return false;
            }
          }
        });

    view.loadUrl(CANONICAL_ORIGIN + "/");
  }

  private static WebResourceResponse toWebResourceResponse(
      LocalBridgeServer.StaticAssetResult asset, boolean headOnly) {
    String baseMime = asset.mimeType;
    String encoding = null;
    int semi = baseMime.indexOf(';');
    if (semi >= 0) {
      String params = baseMime.substring(semi + 1).toLowerCase(Locale.ROOT);
      baseMime = baseMime.substring(0, semi).trim();
      if (params.contains("utf-8")) {
        encoding = "utf-8";
      }
    }
    Map<String, String> headers = new HashMap<>();
    headers.put("X-Content-Type-Options", "nosniff");
    headers.put("X-Frame-Options", "SAMEORIGIN");
    headers.put("Referrer-Policy", "no-referrer");
    if (asset.noCache) {
      headers.put("Cache-Control", "no-cache");
    }
    String reason = asset.status == 200 ? "OK" : asset.status == 403 ? "Forbidden" : "Not Found";
    byte[] payload = headOnly ? new byte[0] : asset.body;
    return new WebResourceResponse(
        baseMime, encoding, asset.status, reason, headers, new ByteArrayInputStream(payload));
  }

  private void syncThemeChrome(Configuration config) {
    boolean nightMode =
        (config.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    if (webView != null) {
      webView.setBackgroundColor(nightMode ? 0xFF151517 : 0xFFFFFFFF);
    }
    if (Build.VERSION.SDK_INT >= 30) {
      WindowInsetsController insetsController = getWindow().getInsetsController();
      if (insetsController != null) {
        int flags = nightMode ? 0 : WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
        insetsController.setSystemBarsAppearance(
            flags, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
      }
    }
  }

  @Override
  public void onConfigurationChanged(Configuration newConfig) {
    super.onConfigurationChanged(newConfig);
    syncThemeChrome(newConfig);
  }

  private void injectBlobExportHook(WebView view) {
    String js =
        "(function(){"
            + "if(window.__dsBlobHooked)return;window.__dsBlobHooked=true;"
            + "const CHUNK=196608;"
            + "const toBase64=(blob)=>new Promise((res,rej)=>{"
            + "const rd=new FileReader();"
            + "rd.onload=()=>{if(typeof rd.result==='string'){const i=rd.result.indexOf(',');res(i>=0?rd.result.slice(i+1):rd.result);}else{rej(new Error('read failed'));}};"
            + "rd.onerror=()=>rej(rd.error||new Error('read error'));"
            + "rd.readAsDataURL(blob);"
            + "});"
            + "const origClick=HTMLAnchorElement.prototype.click;"
            + "HTMLAnchorElement.prototype.click=function(){"
            + "if(this.download&&typeof this.href==='string'&&this.href.startsWith('blob:')&&window.AndroidExportBridge){"
            + "const filename=this.download||'export.dat';"
            + "fetch(this.href).then(r=>r.blob()).then(async (b)=>{"
            + "const mime=b.type||'application/octet-stream';"
            + "const token=window.AndroidExportBridge.beginExport(filename,mime);"
            + "if(!token){window.AndroidExportBridge.notifyExportError('Too many active exports');return;}"
            + "try{"
            + "for(let off=0;off<b.size;off+=CHUNK){"
            + "const b64=await toBase64(b.slice(off,Math.min(b.size,off+CHUNK)));"
            + "if(!window.AndroidExportBridge.appendExportChunk(token,b64))throw new Error('chunk failed or limit reached');"
            + "}"
            + "window.AndroidExportBridge.finishExport(token);"
            + "}catch(e){window.AndroidExportBridge.abortExport(token);"
            + "window.AndroidExportBridge.notifyExportError(String(e&&e.message||e));}"
            + "}).catch((e)=>{window.AndroidExportBridge.notifyExportError(String(e&&e.message||e));});return;}"
            + "return origClick.apply(this,arguments);"
            + "};})();";
    view.evaluateJavascript(js, null);
  }

  @Override
  @SuppressWarnings("deprecation")
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == REQ_FILE_CHOOSER) {
      ValueCallback<Uri[]> callback = filePathCallback;
      filePathCallback = null;
      if (callback == null) {
        return;
      }
      if (resultCode != RESULT_OK || data == null) {
        callback.onReceiveValue(null);
        return;
      }
      List<Uri> uris = new ArrayList<>();
      if (data.getClipData() != null) {
        int count = data.getClipData().getItemCount();
        for (int i = 0; i < count; i++) {
          Uri item = data.getClipData().getItemAt(i).getUri();
          if (item != null) {
            uris.add(item);
          }
        }
      } else if (data.getData() != null) {
        uris.add(data.getData());
      }
      callback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
      return;
    }

    if (requestCode == REQ_CREATE_DOCUMENT) {
      File exportFile = pendingExportFile;
      pendingExportFile = null;
      if (exportFile == null) {
        return;
      }
      if (resultCode == RESULT_OK && data != null && data.getData() != null) {
        Uri dest = data.getData();
        new Thread(
                () -> {
                  try (InputStream is = new FileInputStream(exportFile);
                      OutputStream os = getContentResolver().openOutputStream(dest)) {
                    if (os != null) {
                      byte[] buf = new byte[8192];
                      int n;
                      while ((n = is.read(buf)) != -1) {
                        os.write(buf, 0, n);
                      }
                    }
                    runOnUiThread(
                        () -> Toast.makeText(this, "Export saved", Toast.LENGTH_SHORT).show());
                  } catch (IOException err) {
                    runOnUiThread(
                        () ->
                            Toast.makeText(
                                    this, "Export failed: " + err.getMessage(), Toast.LENGTH_LONG)
                                .show());
                  } finally {
                    //noinspection ResultOfMethodCallIgnored
                    exportFile.delete();
                  }
                })
            .start();
      } else {
        //noinspection ResultOfMethodCallIgnored
        exportFile.delete();
      }
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }

  @Override
  @SuppressWarnings("deprecation")
  public void onBackPressed() {
    if (webView != null && webView.canGoBack()) {
      webView.goBack();
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    for (ExportSession session : exportSessions.values()) {
      try {
        session.stream.close();
      } catch (IOException ignored) {
      }
      //noinspection ResultOfMethodCallIgnored
      session.file.delete();
    }
    exportSessions.clear();
    if (pendingExportFile != null) {
      //noinspection ResultOfMethodCallIgnored
      pendingExportFile.delete();
      pendingExportFile = null;
    }
    if (webView != null) {
      webView.destroy();
      webView = null;
    }
    if (bridgeServer != null) {
      bridgeServer.close();
      bridgeServer = null;
    }
    super.onDestroy();
  }

  private final class ExportBridge {
    @JavascriptInterface
    public String getBridgeToken() {
      return bridgeToken != null ? bridgeToken : "";
    }

    @JavascriptInterface
    public String getProxyUrl() {
      return "http://127.0.0.1:" + bridgePort + "/_proxy";
    }

    @JavascriptInterface
    public void notifyExportError(String message) {
      String clean =
          message != null && !message.trim().isEmpty() ? message.trim() : "Export failed";
      runOnUiThread(
          () ->
              Toast.makeText(MainActivity.this, "Export error: " + clean, Toast.LENGTH_LONG)
                  .show());
    }

    @JavascriptInterface
    public String beginExport(String fileName, String mimeType) {
      if (exportSessions.size() >= MAX_EXPORT_SESSIONS) {
        return "";
      }
      String token = UUID.randomUUID().toString();
      try {
        File tmp = File.createTempFile("ds-export-", ".tmp", getCacheDir());
        FileOutputStream fos = new FileOutputStream(tmp);
        exportSessions.put(
            token, new ExportSession(sanitizeExportFileName(fileName), mimeType, tmp, fos));
        return token;
      } catch (IOException err) {
        return "";
      }
    }

    @JavascriptInterface
    public boolean appendExportChunk(String token, String base64Chunk) {
      ExportSession session = exportSessions.get(token);
      if (session == null || base64Chunk == null) {
        return false;
      }
      try {
        byte[] bytes = Base64.decode(base64Chunk, Base64.DEFAULT);
        if (session.writtenBytes + bytes.length > MAX_EXPORT_BYTES) {
          abortExport(token);
          return false;
        }
        session.stream.write(bytes);
        session.writtenBytes += bytes.length;
        return true;
      } catch (Exception err) {
        return false;
      }
    }

    @JavascriptInterface
    public void abortExport(String token) {
      ExportSession session = exportSessions.remove(token);
      if (session == null) {
        return;
      }
      try {
        session.stream.close();
      } catch (IOException ignored) {
      }
      //noinspection ResultOfMethodCallIgnored
      session.file.delete();
    }

    @JavascriptInterface
    public void finishExport(String token) {
      ExportSession session = exportSessions.remove(token);
      if (session == null) {
        return;
      }
      try {
        session.stream.flush();
        session.stream.close();
      } catch (IOException err) {
        //noinspection ResultOfMethodCallIgnored
        session.file.delete();
        return;
      }
      runOnUiThread(
          () -> {
            if (pendingExportFile != null) {
              //noinspection ResultOfMethodCallIgnored
              pendingExportFile.delete();
            }
            pendingExportFile = session.file;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(
                session.mimeType != null && !session.mimeType.isEmpty()
                    ? session.mimeType
                    : "application/octet-stream");
            intent.putExtra(Intent.EXTRA_TITLE, session.fileName);
            try {
              startActivityForResult(intent, REQ_CREATE_DOCUMENT);
            } catch (Exception err) {
              if (pendingExportFile != null) {
                //noinspection ResultOfMethodCallIgnored
                pendingExportFile.delete();
                pendingExportFile = null;
              }
              Toast.makeText(
                      MainActivity.this,
                      "No file saver available: " + err.getMessage(),
                      Toast.LENGTH_LONG)
                  .show();
            }
          });
    }
  }
}
