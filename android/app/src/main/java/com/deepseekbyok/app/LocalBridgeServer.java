package com.deepseekbyok.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class LocalBridgeServer implements Closeable {
  public interface AssetOpener {
    InputStream open(String relativePath) throws IOException;
  }

  private static final int DEFAULT_START_PORT = 18787;
  private static final int MAX_HEADER_BYTES = 64 * 1024;
  private static final int MAX_BODY_BYTES = 25 * 1024 * 1024;
  private static final int CONNECT_TIMEOUT_MS = 30_000;
  private static final int READ_TIMEOUT_MS = 180_000;

  private static final Set<String> ALLOWED_METHODS =
      new HashSet<>(Arrays.asList("GET", "POST", "DELETE", "HEAD"));
  private static final Set<String> FORWARDED_REQ_HEADERS =
      new HashSet<>(
          Arrays.asList(
              "authorization",
              "x-api-key",
              "anthropic-beta",
              "anthropic-version",
              "content-type",
              "accept"));

  private static final Map<String, String> MIME_TYPES = new HashMap<>();

  static {
    MIME_TYPES.put(".html", "text/html; charset=utf-8");
    MIME_TYPES.put(".js", "application/javascript; charset=utf-8");
    MIME_TYPES.put(".css", "text/css; charset=utf-8");
    MIME_TYPES.put(".json", "application/json; charset=utf-8");
    MIME_TYPES.put(".webmanifest", "application/manifest+json; charset=utf-8");
    MIME_TYPES.put(".svg", "image/svg+xml");
    MIME_TYPES.put(".png", "image/png");
    MIME_TYPES.put(".ico", "image/x-icon");
    MIME_TYPES.put(".webp", "image/webp");
    MIME_TYPES.put(".woff2", "font/woff2");
    MIME_TYPES.put(".woff", "font/woff");
    MIME_TYPES.put(".ttf", "font/ttf");
    MIME_TYPES.put(".txt", "text/plain; charset=utf-8");
  }

  private final AssetOpener assetOpener;
  private final ExecutorService executor = Executors.newCachedThreadPool();
  private volatile ServerSocket serverSocket;
  private volatile boolean running;
  private volatile int boundPort;

  public LocalBridgeServer(AssetOpener assetOpener) {
    this.assetOpener = assetOpener;
  }

  public int start() throws IOException {
    return start(DEFAULT_START_PORT);
  }

  public synchronized int start(int preferredPort) throws IOException {
    if (running && serverSocket != null) {
      return boundPort;
    }
    InetAddress loopback = InetAddress.getByName("127.0.0.1");
    IOException lastError = null;
    ServerSocket sock = null;
    if (preferredPort == 0) {
      sock = new ServerSocket();
      sock.setReuseAddress(true);
      sock.bind(new InetSocketAddress(loopback, 0));
    } else {
      for (int p = preferredPort; p <= preferredPort + 10; p++) {
        try {
          ServerSocket candidate = new ServerSocket();
          candidate.setReuseAddress(true);
          candidate.bind(new InetSocketAddress(loopback, p));
          sock = candidate;
          break;
        } catch (IOException err) {
          lastError = err;
        }
      }
    }
    if (sock == null) {
      throw lastError != null ? lastError : new IOException("Failed to bind loopback socket");
    }
    final ServerSocket acceptedSocket = sock;
    this.serverSocket = acceptedSocket;
    this.boundPort = acceptedSocket.getLocalPort();
    this.running = true;

    Thread acceptThread =
        new Thread(
            () -> {
              while (running) {
                try {
                  Socket client = acceptedSocket.accept();
                  executor.submit(() -> handleConnection(client));
                } catch (IOException ignored) {
                  if (!running) {
                    break;
                  }
                }
              }
            },
            "LocalBridgeAccept");
    acceptThread.setDaemon(true);
    acceptThread.start();
    return this.boundPort;
  }

  public int getPort() {
    return boundPort;
  }

  @Override
  public synchronized void close() {
    running = false;
    ServerSocket sock = this.serverSocket;
    this.serverSocket = null;
    if (sock != null) {
      try {
        sock.close();
      } catch (IOException ignored) {
      }
    }
    executor.shutdownNow();
  }

  private void handleConnection(Socket client) {
    try (Socket s = client) {
      s.setSoTimeout(CONNECT_TIMEOUT_MS);
      BufferedInputStream in = new BufferedInputStream(s.getInputStream());
      OutputStream out = s.getOutputStream();

      String headerBlock = readHeaderBlock(in);
      if (headerBlock == null) {
        return;
      }

      String[] lines = headerBlock.split("\r\n");
      if (lines.length == 0) {
        sendText(out, 400, "Bad Request");
        return;
      }
      String[] reqLine = lines[0].split(" ", 3);
      if (reqLine.length < 2) {
        sendText(out, 400, "Bad Request");
        return;
      }
      String method = reqLine[0].toUpperCase(Locale.ROOT);
      String rawTarget = reqLine[1];

      Map<String, String> headers = new HashMap<>();
      for (int i = 1; i < lines.length; i++) {
        int colon = lines[i].indexOf(':');
        if (colon > 0) {
          String k = lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT);
          String v = lines[i].substring(colon + 1).trim();
          headers.put(k, v);
        }
      }

      int qIdx = rawTarget.indexOf('?');
      String pathOnly = qIdx >= 0 ? rawTarget.substring(0, qIdx) : rawTarget;
      String rawQuery = qIdx >= 0 ? rawTarget.substring(qIdx + 1) : "";

      if ("/_proxy".equals(pathOnly)) {
        s.setSoTimeout(READ_TIMEOUT_MS);
        handleProxy(method, rawQuery, headers, in, out);
      } else {
        serveStatic(method, pathOnly, out);
      }
    } catch (PayloadTooLargeException err) {
      try {
        sendText(client.getOutputStream(), 413, err.getMessage());
      } catch (IOException ignored) {
      }
    } catch (Exception ignored) {
    }
  }

  private void handleProxy(
      String method,
      String rawQuery,
      Map<String, String> headers,
      InputStream in,
      OutputStream out)
      throws IOException {
    if (!ALLOWED_METHODS.contains(method)) {
      sendText(out, 405, "Method Not Allowed");
      return;
    }

    String originErr = checkProxyOrigin(headers, boundPort);
    if (originErr != null) {
      sendText(out, 403, originErr);
      return;
    }

    String targetParam = getQueryParam(rawQuery, "url");
    if (targetParam == null || targetParam.isEmpty()) {
      sendText(out, 400, "Missing ?url= parameter");
      return;
    }

    URI targetUri;
    try {
      targetUri = new URI(targetParam);
    } catch (Exception err) {
      sendText(out, 400, "Invalid target URL");
      return;
    }

    String targetErr = checkProxyTargetAllowed(targetUri, boundPort);
    if (targetErr != null) {
      sendText(out, 403, targetErr);
      return;
    }

    byte[] requestBody = null;
    if (!"GET".equals(method) && !"HEAD".equals(method) && !"DELETE".equals(method)) {
      requestBody = readRequestBody(headers, in);
    }

    HttpURLConnection conn = null;
    try {
      URL url = targetUri.toURL();
      conn = (HttpURLConnection) url.openConnection();
      conn.setInstanceFollowRedirects(false);
      conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
      conn.setReadTimeout(READ_TIMEOUT_MS);
      conn.setRequestMethod(method);
      conn.setRequestProperty("Accept-Encoding", "identity");

      for (String headerName : FORWARDED_REQ_HEADERS) {
        String val = headers.get(headerName);
        if (val != null && !val.isEmpty()) {
          conn.setRequestProperty(headerName, val);
        }
      }

      if (requestBody != null) {
        conn.setDoOutput(true);
        conn.setFixedLengthStreamingMode(requestBody.length);
        try (OutputStream reqOut = conn.getOutputStream()) {
          reqOut.write(requestBody);
        }
      }

      int status = conn.getResponseCode();
      if (status >= 300 && status < 400) {
        sendText(out, 502, "Upstream redirects are blocked by proxy policy");
        return;
      }

      String contentType = conn.getContentType();
      StringBuilder respHead = new StringBuilder();
      respHead
          .append("HTTP/1.1 ")
          .append(status)
          .append(" ")
          .append(reasonPhrase(status))
          .append("\r\n");
      respHead.append("Cache-Control: no-store\r\n");
      respHead.append("X-Content-Type-Options: nosniff\r\n");
      if (contentType != null && !contentType.isEmpty()) {
        respHead.append("Content-Type: ").append(sanitizeHeaderValue(contentType)).append("\r\n");
      }
      if ("HEAD".equals(method)) {
        respHead.append("Content-Length: 0\r\nConnection: close\r\n\r\n");
        out.write(respHead.toString().getBytes(StandardCharsets.US_ASCII));
        out.flush();
        return;
      }

      respHead.append("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
      out.write(respHead.toString().getBytes(StandardCharsets.US_ASCII));
      out.flush();

      InputStream upstreamStream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
      if (upstreamStream != null) {
        byte[] buf = new byte[4096];
        int n;
        while ((n = upstreamStream.read(buf)) != -1) {
          if (n > 0) {
            out.write((Integer.toHexString(n) + "\r\n").getBytes(StandardCharsets.US_ASCII));
            out.write(buf, 0, n);
            out.write("\r\n".getBytes(StandardCharsets.US_ASCII));
            out.flush();
          }
        }
        upstreamStream.close();
      }
      out.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
      out.flush();
    } catch (Exception err) {
      String msg = err.getMessage() != null ? err.getMessage() : err.getClass().getSimpleName();
      sendText(out, 502, msg);
    } finally {
      if (conn != null) {
        conn.disconnect();
      }
    }
  }

  private void serveStatic(String method, String pathOnly, OutputStream out) throws IOException {
    if (!"GET".equals(method) && !"HEAD".equals(method)) {
      sendText(out, 405, "Method Not Allowed");
      return;
    }
    String clean = decodePath(pathOnly);
    if (clean == null || clean.contains("..") || clean.contains("\\")) {
      sendText(out, 403, "Forbidden");
      return;
    }
    while (clean.startsWith("/")) {
      clean = clean.substring(1);
    }
    if (clean.isEmpty()) {
      clean = "index.html";
    }

    byte[] content = tryOpenAsset(clean);
    String servedPath = clean;
    if (content == null) {
      content = tryOpenAsset("index.html");
      servedPath = "index.html";
    }
    if (content == null) {
      sendText(out, 404, "Web bundle not synced. Run pnpm android:sync first.");
      return;
    }

    String ext = "";
    int dot = servedPath.lastIndexOf('.');
    if (dot >= 0) {
      ext = servedPath.substring(dot).toLowerCase(Locale.ROOT);
    }
    String mime = MIME_TYPES.getOrDefault(ext, "application/octet-stream");
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 200 OK\r\n");
    head.append("Content-Type: ").append(mime).append("\r\n");
    head.append("Content-Length: ").append(content.length).append("\r\n");
    head.append("X-Content-Type-Options: nosniff\r\n");
    head.append("X-Frame-Options: SAMEORIGIN\r\n");
    head.append("Referrer-Policy: no-referrer\r\n");
    if ("index.html".equals(servedPath) || "sw.js".equals(servedPath)) {
      head.append("Cache-Control: no-cache\r\n");
    }
    head.append("Connection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    if (!"HEAD".equals(method)) {
      out.write(content);
    }
    out.flush();
  }

  private byte[] tryOpenAsset(String relativePath) {
    try (InputStream is = assetOpener.open(relativePath)) {
      if (is == null) {
        return null;
      }
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      byte[] chunk = new byte[8192];
      int n;
      while ((n = is.read(chunk)) != -1) {
        buf.write(chunk, 0, n);
      }
      return buf.toByteArray();
    } catch (IOException err) {
      return null;
    }
  }

  public static String checkProxyOrigin(Map<String, String> headers, int expectedPort) {
    String hostHeader = headers.getOrDefault("host", "").trim().toLowerCase(Locale.ROOT);
    String origin = headers.getOrDefault("origin", "").trim();
    String secFetchSite =
        headers.getOrDefault("sec-fetch-site", "").trim().toLowerCase(Locale.ROOT);

    if (!origin.isEmpty()) {
      if ("null".equalsIgnoreCase(origin)) {
        return "Null Origin blocked by proxy CSRF policy";
      }
      try {
        URI uri = new URI(origin);
        String originHost = formatAuthorityHost(uri);
        if (!isMatchingLocalHost(originHost, hostHeader, expectedPort)) {
          return "Cross-origin proxy request blocked";
        }
      } catch (Exception err) {
        return "Invalid Origin header";
      }
    }

    if (!secFetchSite.isEmpty()
        && !"same-origin".equals(secFetchSite)
        && !"none".equals(secFetchSite)) {
      return "Cross-site fetch blocked by proxy CSRF policy";
    }

    if (origin.isEmpty()) {
      String referer = headers.getOrDefault("referer", "").trim();
      if (!referer.isEmpty()) {
        try {
          URI refUri = new URI(referer);
          if (!isMatchingLocalHost(formatAuthorityHost(refUri), hostHeader, expectedPort)) {
            return "Cross-origin Referer blocked by proxy CSRF policy";
          }
        } catch (Exception err) {
          return "Invalid Referer header";
        }
      }
    }
    return null;
  }

  private static boolean isMatchingLocalHost(String headerAuthority, String hostHeader, int port) {
    if (!hostHeader.isEmpty()) {
      return headerAuthority.equalsIgnoreCase(hostHeader);
    }
    return ("127.0.0.1:" + port).equals(headerAuthority)
        || ("localhost:" + port).equals(headerAuthority);
  }

  private static String formatAuthorityHost(URI uri) {
    String h = uri.getHost();
    if (h == null) {
      return "";
    }
    int p = uri.getPort();
    if (p == -1) {
      p = "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }
    return h.toLowerCase(Locale.ROOT) + ":" + p;
  }

  public static String checkProxyTargetAllowed(URI targetUri, int bridgePort) {
    String scheme = targetUri.getScheme() != null ? targetUri.getScheme().toLowerCase(Locale.ROOT) : "";
    if (!"https".equals(scheme) && !"http".equals(scheme)) {
      return "Unsupported target protocol";
    }
    if (targetUri.getRawUserInfo() != null) {
      return "Credentials in target URL are not allowed";
    }
    String rawHost = targetUri.getHost();
    if (rawHost == null || rawHost.isEmpty()) {
      return "Invalid target hostname";
    }
    String host = rawHost.replaceAll("^\\[|\\]$", "").toLowerCase(Locale.ROOT);
    int targetPort = targetUri.getPort();
    if (targetPort == -1) {
      targetPort = "https".equals(scheme) ? 443 : 80;
    }

    boolean isLocalName =
        "localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host);
    if (isLocalName) {
      if (bridgePort > 0 && targetPort == bridgePort) {
        return "Self-proxy recursion blocked";
      }
      return null;
    }

    if (!"https".equals(scheme)) {
      return "Remote proxy targets must use HTTPS";
    }

    try {
      InetAddress[] resolved = InetAddress.getAllByName(host);
      if (resolved.length == 0) {
        return "Target DNS lookup failed";
      }
      for (InetAddress addr : resolved) {
        if (isPrivateOrMetadataAddress(addr)) {
          return "Target resolves to private or metadata IP";
        }
      }
    } catch (Exception err) {
      return "Target DNS lookup failed";
    }
    return null;
  }

  public static boolean isPrivateOrMetadataAddress(InetAddress addr) {
    if (addr.isAnyLocalAddress()
        || addr.isLoopbackAddress()
        || addr.isLinkLocalAddress()
        || addr.isSiteLocalAddress()
        || addr.isMulticastAddress()) {
      return true;
    }
    if (addr instanceof Inet4Address) {
      byte[] b = addr.getAddress();
      int a = b[0] & 0xff;
      int s = b[1] & 0xff;
      int t = b[2] & 0xff;
      return a == 0
          || a == 10
          || a == 127
          || (a == 100 && s >= 64 && s <= 127)
          || (a == 169 && s == 254)
          || (a == 172 && s >= 16 && s <= 31)
          || (a == 192 && s == 0 && (t == 0 || t == 2))
          || (a == 192 && s == 168)
          || (a == 198 && (s == 18 || s == 19))
          || (a == 198 && s == 51 && t == 100)
          || (a == 203 && s == 0 && t == 113)
          || a >= 224;
    }
    if (addr instanceof Inet6Address) {
      byte[] b = addr.getAddress();
      int first = b[0] & 0xff;
      if ((first & 0xfe) == 0xfc) {
        return true; // fc00::/7 ULA
      }
      if (first == 0xfe && (b[1] & 0xc0) == 0x80) {
        return true; // fe80::/10 link-local
      }
      if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == (byte) 0xb8) {
        return true; // 2001:db8::/32 documentation
      }
    }
    return false;
  }

  private static String readHeaderBlock(InputStream in) throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    int state = 0;
    int b;
    while ((b = in.read()) != -1) {
      buf.write(b);
      if (buf.size() > MAX_HEADER_BYTES) {
        throw new IOException("Header too large");
      }
      if (state == 0 && b == '\r') {
        state = 1;
      } else if (state == 1 && b == '\n') {
        state = 2;
      } else if (state == 2 && b == '\r') {
        state = 3;
      } else if (state == 3 && b == '\n') {
        byte[] raw = buf.toByteArray();
        return new String(raw, 0, raw.length - 4, StandardCharsets.ISO_8859_1);
      } else {
        state = b == '\r' ? 1 : 0;
      }
    }
    return buf.size() == 0 ? null : buf.toString(StandardCharsets.ISO_8859_1.name());
  }

  private static byte[] readRequestBody(Map<String, String> headers, InputStream in)
      throws IOException {
    String te = headers.get("transfer-encoding");
    if (te != null && te.toLowerCase(Locale.ROOT).contains("chunked")) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      while (true) {
        String line = readAsciiLine(in);
        if (line == null) {
          break;
        }
        int semi = line.indexOf(';');
        String hex = (semi >= 0 ? line.substring(0, semi) : line).trim();
        int size = hex.isEmpty() ? 0 : Integer.parseInt(hex, 16);
        if (size == 0) {
          readAsciiLine(in);
          break;
        }
        if (out.size() + size > MAX_BODY_BYTES) {
          throw new PayloadTooLargeException();
        }
        byte[] chunk = readExact(in, size);
        out.write(chunk);
        readAsciiLine(in);
      }
      return out.toByteArray();
    }

    String clHeader = headers.get("content-length");
    if (clHeader == null) {
      return new byte[0];
    }
    int len = Integer.parseInt(clHeader.trim());
    if (len < 0 || len > MAX_BODY_BYTES) {
      throw new PayloadTooLargeException();
    }
    return readExact(in, len);
  }

  private static String readAsciiLine(InputStream in) throws IOException {
    ByteArrayOutputStream line = new ByteArrayOutputStream();
    int b;
    while ((b = in.read()) != -1) {
      if (b == '\n') {
        byte[] arr = line.toByteArray();
        int end = arr.length > 0 && arr[arr.length - 1] == '\r' ? arr.length - 1 : arr.length;
        return new String(arr, 0, end, StandardCharsets.US_ASCII);
      }
      line.write(b);
    }
    return line.size() == 0 ? null : line.toString(StandardCharsets.US_ASCII.name());
  }

  private static byte[] readExact(InputStream in, int length) throws IOException {
    byte[] out = new byte[length];
    int offset = 0;
    while (offset < length) {
      int n = in.read(out, offset, length - offset);
      if (n < 0) {
        throw new IOException("Unexpected EOF while reading request body");
      }
      offset += n;
    }
    return out;
  }

  private static String getQueryParam(String query, String name) {
    if (query == null || query.isEmpty()) {
      return null;
    }
    for (String pair : query.split("&")) {
      int eq = pair.indexOf('=');
      if (eq > 0 && name.equals(pair.substring(0, eq))) {
        return URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
      }
    }
    return null;
  }

  private static String decodePath(String path) {
    try {
      return URLDecoder.decode(path, StandardCharsets.UTF_8);
    } catch (IllegalArgumentException err) {
      return null;
    }
  }

  private static String sanitizeHeaderValue(String val) {
    return val.replace("\r", "").replace("\n", "");
  }

  private static void sendText(OutputStream out, int status, String bodyText) throws IOException {
    byte[] body = bodyText.getBytes(StandardCharsets.UTF_8);
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 ")
        .append(status)
        .append(" ")
        .append(reasonPhrase(status))
        .append("\r\n");
    head.append("Content-Type: text/plain; charset=utf-8\r\n");
    head.append("Content-Length: ").append(body.length).append("\r\n");
    head.append("X-Content-Type-Options: nosniff\r\n");
    head.append("Connection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    out.write(body);
    out.flush();
  }

  private static String reasonPhrase(int status) {
    switch (status) {
      case 200:
        return "OK";
      case 400:
        return "Bad Request";
      case 403:
        return "Forbidden";
      case 404:
        return "Not Found";
      case 405:
        return "Method Not Allowed";
      case 413:
        return "Payload Too Large";
      case 502:
        return "Bad Gateway";
      default:
        return "Status";
    }
  }

  private static final class PayloadTooLargeException extends IOException {
    PayloadTooLargeException() {
      super("Request body too large");
    }
  }
}
