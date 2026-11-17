package com.deepseekbyok.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

public final class LocalBridgeServer implements Closeable {
  public interface AssetOpener {
    InputStream open(String relativePath) throws IOException;
  }

  public static final class StaticAssetResult {
    public final int status;
    public final String mimeType;
    public final byte[] body;
    public final boolean noCache;

    StaticAssetResult(int status, String mimeType, byte[] body, boolean noCache) {
      this.status = status;
      this.mimeType = mimeType;
      this.body = body;
      this.noCache = noCache;
    }
  }

  private static final class PinnedTarget {
    final String scheme;
    final String host;
    final int port;
    final String pathAndQuery;
    final InetAddress pinnedAddress;

    PinnedTarget(
        String scheme, String host, int port, String pathAndQuery, InetAddress pinnedAddress) {
      this.scheme = scheme;
      this.host = host;
      this.port = port;
      this.pathAndQuery = pathAndQuery;
      this.pinnedAddress = pinnedAddress;
    }
  }

  public static final int CANONICAL_WEB_PORT = 18787;
  private static final int MAX_HEADER_BYTES = 64 * 1024;
  private static final int MAX_BODY_BYTES = 25 * 1024 * 1024;
  private static final int CONNECT_TIMEOUT_MS = 30_000;
  private static final int READ_TIMEOUT_MS = 180_000;
  private static final int MAX_WORKERS = 32;

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
  private final String bridgeToken;
  private final ExecutorService executor =
      new ThreadPoolExecutor(
          4,
          MAX_WORKERS,
          60L,
          TimeUnit.SECONDS,
          new SynchronousQueue<>(),
          runnable -> {
            Thread t = new Thread(runnable, "LocalBridgeWorker");
            t.setDaemon(true);
            return t;
          });
  private volatile ServerSocket serverSocket;
  private volatile boolean running;
  private volatile int boundPort;
  private volatile int expectedOriginPort;

  public LocalBridgeServer(AssetOpener assetOpener) {
    this(assetOpener, null);
  }

  public LocalBridgeServer(AssetOpener assetOpener, String bridgeToken) {
    this.assetOpener = assetOpener;
    this.bridgeToken = bridgeToken == null || bridgeToken.isEmpty() ? null : bridgeToken;
  }

  public void setExpectedOriginPort(int expectedOriginPort) {
    this.expectedOriginPort = expectedOriginPort;
  }

  public int start() throws IOException {
    return start(CANONICAL_WEB_PORT);
  }

  public synchronized int start(int preferredPort) throws IOException {
    if (running && serverSocket != null) {
      return boundPort;
    }
    InetAddress loopback = InetAddress.getByName("127.0.0.1");
    IOException lastError = null;
    ServerSocket sock = null;
    if (preferredPort > 0) {
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
    // Fall back to OS-assigned ephemeral loopback port so startup never fails on port conflicts.
    if (sock == null) {
      try {
        ServerSocket candidate = new ServerSocket();
        candidate.setReuseAddress(true);
        candidate.bind(new InetSocketAddress(loopback, 0));
        sock = candidate;
      } catch (IOException err) {
        lastError = err;
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
                  try {
                    executor.execute(() -> handleConnection(client));
                  } catch (RejectedExecutionException saturated) {
                    try {
                      sendText(client.getOutputStream(), 503, "Bridge worker pool saturated", null);
                    } catch (IOException ignored) {
                    } finally {
                      try {
                        client.close();
                      } catch (IOException ignored) {
                      }
                    }
                  }
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

  public StaticAssetResult resolveStaticAsset(String pathOnly) {
    String clean = decodePath(pathOnly);
    if (clean == null || clean.contains("..") || clean.contains("\\")) {
      return new StaticAssetResult(
          403, "text/plain; charset=utf-8", "Forbidden".getBytes(StandardCharsets.UTF_8), true);
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
      return new StaticAssetResult(
          404,
          "text/plain; charset=utf-8",
          "Web bundle not synced. Run pnpm android:sync first.".getBytes(StandardCharsets.UTF_8),
          true);
    }

    String ext = "";
    int dot = servedPath.lastIndexOf('.');
    if (dot >= 0) {
      ext = servedPath.substring(dot).toLowerCase(Locale.ROOT);
    }
    String mime = MIME_TYPES.getOrDefault(ext, "application/octet-stream");
    boolean noCache =
        "index.html".equals(servedPath)
            || "sw.js".equals(servedPath)
            || "manifest.webmanifest".equals(servedPath);
    return new StaticAssetResult(200, mime, content, noCache);
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

      String[] lines = headerBlock.split("\r?\n");
      if (lines.length == 0) {
        sendText(out, 400, "Bad Request", null);
        return;
      }
      String[] reqLine = lines[0].split(" ", 3);
      if (reqLine.length < 2) {
        sendText(out, 400, "Bad Request", null);
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
        sendText(client.getOutputStream(), 413, err.getMessage(), null);
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
    String originErr = checkProxyOrigin(headers, boundPort, expectedOriginPort);
    if (originErr != null) {
      sendText(out, 403, originErr, null);
      return;
    }

    String corsOrigin = resolveCorsOriginForProxy(headers, boundPort, expectedOriginPort);

    if ("OPTIONS".equals(method)) {
      sendOptionsPreflight(out, corsOrigin);
      return;
    }

    if (!ALLOWED_METHODS.contains(method)) {
      sendText(out, 405, "Method Not Allowed", corsOrigin);
      return;
    }

    if (("HEAD".equals(method) || "GET".equals(method))
        && "1".equals(getQueryParam(rawQuery, "probe"))) {
      sendNoContent(out, corsOrigin);
      return;
    }

    String targetParam = getQueryParam(rawQuery, "url");
    if (targetParam == null || targetParam.isEmpty()) {
      sendText(out, 400, "Missing ?url= parameter", corsOrigin);
      return;
    }

    if (bridgeToken != null) {
      String suppliedToken = headers.getOrDefault("x-ds-bridge-token", "");
      if (!MessageDigest.isEqual(
          bridgeToken.getBytes(StandardCharsets.UTF_8),
          suppliedToken.getBytes(StandardCharsets.UTF_8))) {
        sendText(out, 403, "Missing or invalid bridge token", corsOrigin);
        return;
      }
    }

    URI targetUri;
    try {
      targetUri = new URI(targetParam);
    } catch (Exception err) {
      sendText(out, 400, "Invalid target URL", corsOrigin);
      return;
    }

    PinnedTarget pinnedTarget;
    try {
      pinnedTarget = resolvePinnedTarget(targetUri, boundPort, expectedOriginPort);
    } catch (TargetRejectedException err) {
      sendText(out, 403, err.getMessage(), corsOrigin);
      return;
    }

    byte[] requestBody = null;
    if (!"GET".equals(method) && !"HEAD".equals(method) && !"DELETE".equals(method)) {
      requestBody = readRequestBody(headers, in);
    }

    forwardToPinnedUpstream(method, pinnedTarget, headers, requestBody, corsOrigin, out);
  }

  private void forwardToPinnedUpstream(
      String method,
      PinnedTarget target,
      Map<String, String> clientHeaders,
      byte[] requestBody,
      String corsOrigin,
      OutputStream clientOut)
      throws IOException {
    Socket upstreamSock = null;
    try {
      Socket rawSock = new Socket();
      rawSock.connect(
          new InetSocketAddress(target.pinnedAddress, target.port), CONNECT_TIMEOUT_MS);
      rawSock.setSoTimeout(READ_TIMEOUT_MS);

      if ("https".equals(target.scheme)) {
        SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
        SSLSocket sslSock =
            (SSLSocket) factory.createSocket(rawSock, target.host, target.port, true);
        SSLParameters sslParams = sslSock.getSSLParameters();
        sslParams.setEndpointIdentificationAlgorithm("HTTPS");
        sslParams.setServerNames(Collections.singletonList(new SNIHostName(target.host)));
        sslSock.setSSLParameters(sslParams);
        sslSock.startHandshake();
        upstreamSock = sslSock;
      } else {
        upstreamSock = rawSock;
      }

      OutputStream upOut = upstreamSock.getOutputStream();
      StringBuilder reqHead = new StringBuilder();
      reqHead
          .append(method)
          .append(" ")
          .append(target.pathAndQuery)
          .append(" HTTP/1.1\r\n");
      reqHead.append("Host: ").append(formatHostHeader(target)).append("\r\n");
      reqHead.append("Accept-Encoding: identity\r\n");
      reqHead.append("Connection: close\r\n");
      for (String headerName : FORWARDED_REQ_HEADERS) {
        String val = clientHeaders.get(headerName);
        if (val != null && !val.isEmpty()) {
          reqHead
              .append(headerName)
              .append(": ")
              .append(sanitizeHeaderValue(val))
              .append("\r\n");
        }
      }
      if (requestBody != null) {
        reqHead.append("Content-Length: ").append(requestBody.length).append("\r\n");
      }
      reqHead.append("\r\n");
      upOut.write(reqHead.toString().getBytes(StandardCharsets.US_ASCII));
      if (requestBody != null && requestBody.length > 0) {
        upOut.write(requestBody);
      }
      upOut.flush();

      BufferedInputStream upIn = new BufferedInputStream(upstreamSock.getInputStream());
      String upHeaderBlock;
      int status;
      String[] upLines;
      while (true) {
        upHeaderBlock = readHeaderBlock(upIn);
        if (upHeaderBlock == null) {
          sendText(clientOut, 502, "Upstream closed connection before response headers", corsOrigin);
          return;
        }
        upLines = upHeaderBlock.split("\r?\n");
        if (upLines.length == 0) {
          sendText(clientOut, 502, "Malformed upstream status line", corsOrigin);
          return;
        }
        String[] statusParts = upLines[0].split(" ", 3);
        if (statusParts.length < 2) {
          sendText(clientOut, 502, "Malformed upstream status line", corsOrigin);
          return;
        }
        status = Integer.parseInt(statusParts[1]);
        if (status > 100 && status < 200 || status == 100) {
          continue;
        }
        break;
      }

      if (status >= 300 && status < 400) {
        sendText(clientOut, 502, "Upstream redirects are blocked by proxy policy", corsOrigin);
        return;
      }

      String contentType = null;
      String transferEncoding = "";
      long contentLength = -1L;
      for (int i = 1; i < upLines.length; i++) {
        int colon = upLines[i].indexOf(':');
        if (colon <= 0) {
          continue;
        }
        String name = upLines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT);
        String val = upLines[i].substring(colon + 1).trim();
        if ("content-type".equals(name)) {
          contentType = val;
        } else if ("transfer-encoding".equals(name)) {
          transferEncoding = val.toLowerCase(Locale.ROOT);
        } else if ("content-length".equals(name)) {
          try {
            contentLength = Long.parseLong(val);
          } catch (NumberFormatException ignored) {
          }
        }
      }

      StringBuilder respHead = new StringBuilder();
      respHead
          .append("HTTP/1.1 ")
          .append(status)
          .append(" ")
          .append(reasonPhrase(status))
          .append("\r\n");
      respHead.append("Cache-Control: no-store\r\n");
      respHead.append("X-Content-Type-Options: nosniff\r\n");
      appendCorsHeaders(respHead, corsOrigin);
      if (contentType != null && !contentType.isEmpty()) {
        respHead.append("Content-Type: ").append(sanitizeHeaderValue(contentType)).append("\r\n");
      }
      if ("HEAD".equals(method)) {
        respHead.append("Content-Length: 0\r\nConnection: close\r\n\r\n");
        clientOut.write(respHead.toString().getBytes(StandardCharsets.US_ASCII));
        clientOut.flush();
        return;
      }

      respHead.append("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
      clientOut.write(respHead.toString().getBytes(StandardCharsets.US_ASCII));
      clientOut.flush();

      if (transferEncoding.contains("chunked")) {
        streamChunkedBodyToClient(upIn, clientOut);
      } else if (contentLength >= 0) {
        streamFixedLengthToClient(upIn, clientOut, contentLength);
      } else {
        streamUntilEofToClient(upIn, clientOut);
      }
      clientOut.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
      clientOut.flush();
    } catch (Exception err) {
      String msg = err.getMessage() != null ? err.getMessage() : err.getClass().getSimpleName();
      sendText(clientOut, 502, msg, corsOrigin);
    } finally {
      if (upstreamSock != null) {
        try {
          upstreamSock.close();
        } catch (IOException ignored) {
        }
      }
    }
  }

  private static String formatHostHeader(PinnedTarget target) {
    boolean defaultPort =
        ("https".equals(target.scheme) && target.port == 443)
            || ("http".equals(target.scheme) && target.port == 80);
    String formattedHost =
        target.host.contains(":") && !target.host.startsWith("[")
            ? "[" + target.host + "]"
            : target.host;
    return defaultPort ? formattedHost : formattedHost + ":" + target.port;
  }

  private static void streamChunkedBodyToClient(InputStream upIn, OutputStream clientOut)
      throws IOException {
    byte[] buf = new byte[4096];
    while (true) {
      String line = readAsciiLine(upIn);
      if (line == null) {
        break;
      }
      int semi = line.indexOf(';');
      String hex = (semi >= 0 ? line.substring(0, semi) : line).trim();
      if (hex.isEmpty()) {
        continue;
      }
      int chunkSize = Integer.parseInt(hex, 16);
      if (chunkSize == 0) {
        readAsciiLine(upIn);
        break;
      }
      int remaining = chunkSize;
      while (remaining > 0) {
        int n = upIn.read(buf, 0, Math.min(buf.length, remaining));
        if (n < 0) {
          throw new IOException("Unexpected EOF inside upstream chunked body");
        }
        if (n > 0) {
          writeChunk(clientOut, buf, n);
          remaining -= n;
        }
      }
      readAsciiLine(upIn);
    }
  }

  private static void streamFixedLengthToClient(
      InputStream upIn, OutputStream clientOut, long contentLength) throws IOException {
    byte[] buf = new byte[4096];
    long remaining = contentLength;
    while (remaining > 0) {
      int n = upIn.read(buf, 0, (int) Math.min(buf.length, remaining));
      if (n < 0) {
        break;
      }
      if (n > 0) {
        writeChunk(clientOut, buf, n);
        remaining -= n;
      }
    }
  }

  private static void streamUntilEofToClient(InputStream upIn, OutputStream clientOut)
      throws IOException {
    byte[] buf = new byte[4096];
    int n;
    while ((n = upIn.read(buf)) != -1) {
      if (n > 0) {
        writeChunk(clientOut, buf, n);
      }
    }
  }

  private static void writeChunk(OutputStream clientOut, byte[] buf, int len) throws IOException {
    clientOut.write((Integer.toHexString(len) + "\r\n").getBytes(StandardCharsets.US_ASCII));
    clientOut.write(buf, 0, len);
    clientOut.write("\r\n".getBytes(StandardCharsets.US_ASCII));
    clientOut.flush();
  }

  private void serveStatic(String method, String pathOnly, OutputStream out) throws IOException {
    if (!"GET".equals(method) && !"HEAD".equals(method)) {
      sendText(out, 405, "Method Not Allowed", null);
      return;
    }
    StaticAssetResult asset = resolveStaticAsset(pathOnly);
    if (asset.status != 200) {
      sendText(
          out, asset.status, new String(asset.body, StandardCharsets.UTF_8), null);
      return;
    }
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 200 OK\r\n");
    head.append("Content-Type: ").append(asset.mimeType).append("\r\n");
    head.append("Content-Length: ").append(asset.body.length).append("\r\n");
    head.append("X-Content-Type-Options: nosniff\r\n");
    head.append("X-Frame-Options: SAMEORIGIN\r\n");
    head.append("Referrer-Policy: no-referrer\r\n");
    if (asset.noCache) {
      head.append("Cache-Control: no-cache\r\n");
    }
    head.append("Connection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    if (!"HEAD".equals(method)) {
      out.write(asset.body);
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
    return checkProxyOrigin(headers, expectedPort, 0);
  }

  public static String checkProxyOrigin(
      Map<String, String> headers, int boundPort, int extraOriginPort) {
    String hostHeader = headers.getOrDefault("host", "").trim().toLowerCase(Locale.ROOT);
    String origin = headers.getOrDefault("origin", "").trim();
    String secFetchSite =
        headers.getOrDefault("sec-fetch-site", "").trim().toLowerCase(Locale.ROOT);

    if (!hostHeader.isEmpty() && !isLoopbackAuthority(hostHeader, boundPort)) {
      return "Non-loopback Host header blocked by proxy DNS-rebinding policy";
    }

    boolean crossPortCanonicalOrigin = false;
    if (!origin.isEmpty()) {
      if ("null".equalsIgnoreCase(origin)) {
        return "Null Origin blocked by proxy CSRF policy";
      }
      try {
        URI uri = new URI(origin);
        String originHost = formatAuthorityHost(uri);
        if (!isMatchingLocalHost(originHost, hostHeader, boundPort, extraOriginPort)) {
          return "Cross-origin proxy request blocked";
        }
        crossPortCanonicalOrigin =
            extraOriginPort > 0
                && isLoopbackAuthority(originHost, extraOriginPort)
                && !isLoopbackAuthority(originHost, boundPort);
      } catch (Exception err) {
        return "Invalid Origin header";
      }
    }

    if (!secFetchSite.isEmpty() && !"same-origin".equals(secFetchSite) && !"none".equals(secFetchSite)) {
      if (!(crossPortCanonicalOrigin && "same-site".equals(secFetchSite))) {
        return "Cross-site fetch blocked by proxy CSRF policy";
      }
    }

    if (origin.isEmpty()) {
      String referer = headers.getOrDefault("referer", "").trim();
      if (!referer.isEmpty()) {
        try {
          URI refUri = new URI(referer);
          if (!isMatchingLocalHost(
              formatAuthorityHost(refUri), hostHeader, boundPort, extraOriginPort)) {
            return "Cross-origin Referer blocked by proxy CSRF policy";
          }
        } catch (Exception err) {
          return "Invalid Referer header";
        }
      }
    }
    return null;
  }

  private static String resolveCorsOriginForProxy(
      Map<String, String> headers, int boundPort, int extraOriginPort) {
    String origin = headers.getOrDefault("origin", "").trim();
    if (origin.isEmpty() || "null".equalsIgnoreCase(origin)) {
      return null;
    }
    try {
      URI uri = new URI(origin);
      if (!"http".equalsIgnoreCase(uri.getScheme())) {
        return null;
      }
      String originAuthority = formatAuthorityHost(uri);
      if (isLoopbackAuthority(originAuthority, boundPort)
          || (extraOriginPort > 0 && isLoopbackAuthority(originAuthority, extraOriginPort))) {
        return "http://" + originAuthority;
      }
    } catch (Exception ignored) {
    }
    return null;
  }

  private static boolean isLoopbackAuthority(String authority, int port) {
    if (authority == null || authority.isEmpty() || port <= 0) {
      return false;
    }
    return ("127.0.0.1:" + port).equalsIgnoreCase(authority)
        || ("localhost:" + port).equalsIgnoreCase(authority)
        || ("[::1]:" + port).equalsIgnoreCase(authority);
  }

  private static boolean isMatchingLocalHost(
      String headerAuthority, String hostHeader, int boundPort, int extraOriginPort) {
    boolean allowedBound = isLoopbackAuthority(headerAuthority, boundPort);
    boolean allowedExtra =
        extraOriginPort > 0 && isLoopbackAuthority(headerAuthority, extraOriginPort);
    if (!allowedBound && !allowedExtra) {
      return false;
    }
    if (!hostHeader.isEmpty()) {
      if (!isLoopbackAuthority(hostHeader, boundPort)) {
        return false;
      }
      return allowedBound ? headerAuthority.equalsIgnoreCase(hostHeader) : allowedExtra;
    }
    return true;
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
    try {
      resolvePinnedTarget(targetUri, bridgePort, 0);
      return null;
    } catch (TargetRejectedException err) {
      return err.getMessage();
    }
  }

  private static PinnedTarget resolvePinnedTarget(
      URI targetUri, int bridgePort, int canonicalWebPort) throws TargetRejectedException {
    String scheme =
        targetUri.getScheme() != null ? targetUri.getScheme().toLowerCase(Locale.ROOT) : "";
    if (!"https".equals(scheme) && !"http".equals(scheme)) {
      throw new TargetRejectedException("Unsupported target protocol");
    }
    if (targetUri.getRawUserInfo() != null) {
      throw new TargetRejectedException("Credentials in target URL are not allowed");
    }
    String rawHost = targetUri.getHost();
    if (rawHost == null || rawHost.isEmpty()) {
      throw new TargetRejectedException("Invalid target hostname");
    }
    String host = rawHost.replaceAll("^\\[|\\]$", "").toLowerCase(Locale.ROOT);
    int targetPort = targetUri.getPort();
    if (targetPort == -1) {
      targetPort = "https".equals(scheme) ? 443 : 80;
    }

    String rawPath = targetUri.getRawPath();
    String cleanPath = rawPath == null || rawPath.isEmpty() ? "/" : rawPath;
    String rawQuery = targetUri.getRawQuery();
    String pathAndQuery =
        rawQuery != null && !rawQuery.isEmpty() ? cleanPath + "?" + rawQuery : cleanPath;

    boolean isLocalName =
        "localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host);
    if (isLocalName) {
      if ((bridgePort > 0 && targetPort == bridgePort)
          || (canonicalWebPort > 0 && targetPort == canonicalWebPort)) {
        throw new TargetRejectedException("Self-proxy recursion blocked");
      }
      try {
        InetAddress[] resolved = InetAddress.getAllByName(host);
        if (resolved.length == 0) {
          throw new TargetRejectedException("Target DNS lookup failed");
        }
        for (InetAddress addr : resolved) {
          if (!addr.isLoopbackAddress()) {
            throw new TargetRejectedException("Localhost target resolved to non-loopback IP");
          }
        }
        return new PinnedTarget(scheme, host, targetPort, pathAndQuery, resolved[0]);
      } catch (TargetRejectedException err) {
        throw err;
      } catch (Exception err) {
        throw new TargetRejectedException("Target DNS lookup failed");
      }
    }

    if (!"https".equals(scheme)) {
      throw new TargetRejectedException("Remote proxy targets must use HTTPS");
    }

    try {
      InetAddress[] resolved = InetAddress.getAllByName(host);
      if (resolved.length == 0) {
        throw new TargetRejectedException("Target DNS lookup failed");
      }
      for (InetAddress addr : resolved) {
        if (isPrivateOrMetadataAddress(addr)) {
          throw new TargetRejectedException("Target resolves to private or metadata IP");
        }
      }
      return new PinnedTarget(scheme, host, targetPort, pathAndQuery, resolved[0]);
    } catch (TargetRejectedException err) {
      throw err;
    } catch (Exception err) {
      throw new TargetRejectedException("Target DNS lookup failed");
    }
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
      if (first == 0xfe && (b[1] & 0xc0) == 0xc0) {
        return true; // fec0::/10 deprecated site-local
      }
      if (b[0] == 0x00 && b[1] == 0x64 && b[2] == (byte) 0xff && b[3] == (byte) 0x9b) {
        return true; // 64:ff9b::/96 NAT64
      }
      if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == (byte) 0xb8) {
        return true; // 2001:db8::/32 documentation
      }
    }
    return false;
  }

  private static String readHeaderBlock(InputStream in) throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    int crlfState = 0;
    int lfState = 0;
    int b;
    while ((b = in.read()) != -1) {
      buf.write(b);
      if (buf.size() > MAX_HEADER_BYTES) {
        throw new IOException("Header too large");
      }
      if (crlfState == 0 && b == '\r') {
        crlfState = 1;
      } else if (crlfState == 1 && b == '\n') {
        crlfState = 2;
      } else if (crlfState == 2 && b == '\r') {
        crlfState = 3;
      } else if (crlfState == 3 && b == '\n') {
        byte[] raw = buf.toByteArray();
        return new String(raw, 0, raw.length - 4, StandardCharsets.ISO_8859_1);
      } else {
        crlfState = b == '\r' ? 1 : 0;
      }

      if (b == '\n') {
        lfState += 1;
        if (lfState == 2) {
          byte[] raw = buf.toByteArray();
          return new String(raw, 0, raw.length - 2, StandardCharsets.ISO_8859_1);
        }
      } else if (b != '\r') {
        lfState = 0;
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

  private static void appendCorsHeaders(StringBuilder head, String corsOrigin) {
    if (corsOrigin == null || corsOrigin.isEmpty()) {
      return;
    }
    head.append("Access-Control-Allow-Origin: ")
        .append(sanitizeHeaderValue(corsOrigin))
        .append("\r\n");
    head.append("Access-Control-Expose-Headers: Content-Type\r\n");
    head.append("Vary: Origin\r\n");
  }

  private static void sendOptionsPreflight(OutputStream out, String corsOrigin) throws IOException {
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 204 No Content\r\n");
    if (corsOrigin != null && !corsOrigin.isEmpty()) {
      head.append("Access-Control-Allow-Origin: ")
          .append(sanitizeHeaderValue(corsOrigin))
          .append("\r\n");
      head.append("Access-Control-Allow-Methods: GET, POST, DELETE, HEAD, OPTIONS\r\n");
      head.append(
          "Access-Control-Allow-Headers: authorization, x-api-key, anthropic-beta,"
              + " anthropic-version, content-type, accept, x-ds-bridge-token\r\n");
      head.append("Access-Control-Max-Age: 600\r\n");
      head.append("Vary: Origin\r\n");
    }
    head.append("Content-Length: 0\r\nConnection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    out.flush();
  }

  private static void sendNoContent(OutputStream out, String corsOrigin) throws IOException {
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 204 No Content\r\n");
    appendCorsHeaders(head, corsOrigin);
    head.append("Content-Length: 0\r\nConnection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    out.flush();
  }

  private static void sendText(OutputStream out, int status, String bodyText, String corsOrigin)
      throws IOException {
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
    appendCorsHeaders(head, corsOrigin);
    head.append("Connection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    out.write(body);
    out.flush();
  }

  private static String reasonPhrase(int status) {
    switch (status) {
      case 200:
        return "OK";
      case 204:
        return "No Content";
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
      case 503:
        return "Service Unavailable";
      default:
        return "Status";
    }
  }

  private static final class PayloadTooLargeException extends IOException {
    PayloadTooLargeException() {
      super("Request body too large");
    }
  }

  private static final class TargetRejectedException extends Exception {
    TargetRejectedException(String message) {
      super(message);
    }
  }
}
