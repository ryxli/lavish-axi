import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import chokidar from "chokidar";
import express from "express";

import { createArtifactSdk } from "./artifact-sdk.js";
import { injectLavishSdk, injectPublicDesignAssets } from "./html-transform.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);
const chromeCssUrl = new URL("./chrome.css", import.meta.url);
const htmlShipDefaultApiUrl = "https://api.htmlship.com";
const htmlShipTimeoutMs = 30000;
const designAssetUrls = {
  "daisyui.css": {
    packaged: new URL("./design/daisyui.css", import.meta.url),
    source: new URL("../node_modules/daisyui/daisyui.css", import.meta.url),
    type: "text/css",
  },
  "daisyui-themes.css": {
    packaged: new URL("./design/daisyui-themes.css", import.meta.url),
    source: new URL("../node_modules/daisyui/themes.css", import.meta.url),
    type: "text/css",
  },
  "tailwindcss-browser.js": {
    packaged: new URL("./design/tailwindcss-browser.js", import.meta.url),
    source: new URL("../node_modules/@tailwindcss/browser/dist/index.global.js", import.meta.url),
    type: "application/javascript",
  },
};

export async function serve({ port, stateFile, version = "" }) {
  const app = express();
  const store = new SessionStore(stateFile);
  const events = new EventEmitter();
  const watchers = new Map();
  const activePolls = new Map();
  const sseClients = new Set();

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "lavish-axi", version });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (req, res) => {
    res.json({ status: "shutting-down" });
    // Defer until after the response flushes so the client gets confirmation.
    setImmediate(shutdown);
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      const url = `http://localhost:${port}/session/${key}`;
      const session = await store.upsertSession(file, url);
      watchSession(session, watchers, events);
      res.json({ key, file, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/poll", async (req, res, next) => {
    try {
      const file = await canonicalFile(String(req.query.file || ""));
      const key = sessionKey(file);
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await store.takeFeedback(key);
      if (immediate.status !== "waiting") {
        res.json(immediate);
        return;
      }
      setPollActive(key, activePolls, events, true);
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(async () => {
              cleanup();
              res.json(await store.takeFeedback(key));
            }, timeoutMs);
      const onFeedback = async (changedKey) => {
        if (changedKey !== key || res.headersSent) {
          return;
        }
        cleanup();
        res.json(await store.takeFeedback(key));
      };
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        setPollActive(key, activePolls, events, false);
      };
      events.on("feedback", onFeedback);
      events.on("ended", onFeedback);
      req.on("close", cleanup);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      const session = await store.queuePrompts(req.params.key, req.body || {});
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("feedback", req.params.key);
      res.json({ status: "queued", pending_prompts: session.pending_prompts });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      await store.endSession(req.params.key);
      events.emit("ended", req.params.key);
      res.json({ status: "ended" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const text = String(req.body?.text || "");
      const session = await store.addAgentReply(req.params.key, text);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("agent-reply", req.params.key, text);
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/share", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const html = await createHtmlShipShareHtml(session.file);
      const page = await publishHtmlShipPage(html, req.body || {});
      res.json(page);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/end", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      await store.endSession(key);
      events.emit("ended", key);
      res.json({ status: "ended" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      watchSession(session, watchers, events);
      res.type("html").send(createChromeHtml(session));
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key", (req, res) => {
    res.redirect(`/artifact/${req.params.key}/index.html`);
  });

  app.get(/^\/artifact\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const html = await readFile(session.file, "utf8");
      res.type("html").send(injectLavishSdk(html, key));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const assetPath = req.params[1];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const root = path.dirname(session.file);
      const file = resolveArtifactAsset(root, assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file);
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", async (req, res, next) => {
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.add(res);
      const session = await store.findByKey(req.params.key);
      const sendReload = (key) => {
        if (key === req.params.key) {
          res.write("event: reload\ndata: {}\n\n");
        }
      };
      const sendAgentReply = (key, text) => {
        if (key === req.params.key) {
          res.write(`event: agent-reply\ndata: ${JSON.stringify({ text })}\n\n`);
        }
      };
      const sendWorking = (key, working) => {
        if (key === req.params.key) {
          res.write(`event: agent-working\ndata: ${JSON.stringify({ working })}\n\n`);
        }
      };
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [] })}\n\n`);
      res.write(`event: agent-working\ndata: ${JSON.stringify({ working: !activePolls.has(req.params.key) })}\n\n`);
      events.on("reload", sendReload);
      events.on("agent-reply", sendAgentReply);
      events.on("agent-working", sendWorking);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("reload", sendReload);
        events.off("agent-reply", sendAgentReply);
        events.off("agent-working", sendWorking);
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome-client.js", async (req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(chromeClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome.css", async (req, res, next) => {
    try {
      res.type("text/css").send(await readFile(chromeCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/design/:asset", async (req, res, next) => {
    try {
      const asset = designAssetUrls[req.params.asset];
      if (!asset) {
        res.status(404).send("Not found");
        return;
      }
      res.type(asset.type).send(await readDesignAsset(asset));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sdk.js", (req, res) => {
    res.type("application/javascript").send(createSdkJs(String(req.query.key || "")));
  });

  app.use((error, req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const httpServer = await new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    // Tell open browser chromes to reload before we drop their SSE connection. The new
    // server adopts the session via state.json once it binds, so the reloaded chrome
    // immediately gets the upgraded HTML/CSS/JS.
    for (const res of sseClients) {
      try {
        res.write("event: chrome-reload\ndata: {}\n\n");
        res.end();
      } catch {
        // best effort
      }
    }
    sseClients.clear();
    for (const w of watchers.values()) {
      w.close().catch(() => {});
    }
    watchers.clear();
    httpServer.close(() => shutdownResolve());
    // Force-close keep-alive sockets so SSE / long-polls don't keep us alive.
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
  }

  return {
    port: httpServer.address().port,
    close: async () => {
      shutdown();
      await done;
    },
    done,
  };
}

async function readDesignAsset(asset) {
  try {
    return await readFile(asset.packaged, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    return readFile(asset.source, "utf8");
  }
}

async function createHtmlShipShareHtml(file) {
  return injectPublicDesignAssets(await readFile(file, "utf8"));
}

export async function publishHtmlShipPage(html, options = {}) {
  const apiUrl = String(process.env.HTMLSHIP_API_URL || htmlShipDefaultApiUrl).replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    "user-agent": "lavish-axi/htmlship-share",
  };
  if (process.env.HTMLSHIP_API_KEY) {
    headers.authorization = `Bearer ${process.env.HTMLSHIP_API_KEY}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), htmlShipTimeoutMs);
  let response;
  try {
    response = await fetch(`${apiUrl}/api/v1/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify(createHtmlShipPayload(html, options)),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("HtmlShip publish timed out", { cause: error });
    }
    throw new Error(`HtmlShip publish failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const data = text ? parseJsonResponse(text) : {};
  if (!response.ok) {
    const detail = data.detail || data.error || text || `HTTP ${response.status}`;
    throw new Error(`HtmlShip publish failed: ${detail}`);
  }

  const url = optionalString(data.url);
  if (!url) {
    throw new Error("HtmlShip publish failed: missing url");
  }

  return {
    url,
    slug: String(data.slug || ""),
    owner_key: String(data.owner_key || ""),
    expires_at: data.expires_at || null,
    created_at: data.created_at || null,
  };
}

export function createHtmlShipPayload(html, options = {}) {
  const body = {
    html: String(html || ""),
    sandbox_mode: optionalString(options.sandbox_mode || options.sandboxMode) || "strict",
  };
  const title = optionalString(options.title);
  const password = optionalString(options.password);
  const parentSlug = optionalString(options.parent_slug || options.parentSlug);
  const expiresIn = normalizeExpiresIn(options.expires_in ?? options.expiresIn);

  if (title) body.title = title;
  if (password) body.password = password;
  if (parentSlug) body.parent_slug = parentSlug;
  if (expiresIn !== null) body.expires_in = expiresIn;

  return body;
}

function optionalString(value) {
  return String(value ?? "").trim();
}

function normalizeExpiresIn(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 10080) {
    throw new Error("expires_in must be an integer from 1 to 10080 minutes");
  }
  return number;
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

export function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return file;
}

function watchSession(session, watchers, events) {
  if (watchers.has(session.key)) {
    return;
  }
  const root = path.dirname(session.file);
  const watcher = chokidar.watch(root, {
    ignored: /(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi)([/\\]|$)/,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  let timer = null;
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(() => events.emit("reload", session.key), 100);
  });
  watchers.set(session.key, watcher);
}

function setPollActive(key, activePolls, events, active) {
  const count = activePolls.get(key) || 0;
  const nextCount = active ? count + 1 : Math.max(0, count - 1);
  if (nextCount === count) return;
  if (nextCount === 0) {
    activePolls.delete(key);
  } else {
    activePolls.set(key, nextCount);
  }
  if (count > 0 === nextCount > 0) return;
  events.emit("agent-working", key, nextCount === 0);
}

export function createChromeHtml(session) {
  const fileInputSize = Math.max(1, session.file.length);
  const defaultShareTitle = path.basename(session.file);
  const sessionJson = jsonScript({ key: session.key, initialChat: session.chat || [] });
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lavish Editor</title>
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="lavish">
<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Editor</span></div><div class="divider" aria-hidden="true"></div><div class="file-wrap" title="${escapeHtml(session.file)}"><input class="file-input" id="filePath" readonly size="${fileInputSize}" value="${escapeHtml(session.file)}"><button class="copy-button" id="copyPath" type="button">Copy Path</button></div><button class="button secondary" id="share" type="button">Share</button><button class="button secondary annotation-on" id="annotation">Annotation: On</button><button class="button danger" id="end">End Session</button></div>
<div class="share-overlay" id="shareDialog" role="dialog" aria-modal="true" aria-labelledby="shareTitleText" hidden><form class="share-card" id="shareForm"><div class="share-head"><div><div class="share-kicker">Powered by htmlship.com</div><h2 id="shareTitleText">Publish a share URL</h2></div><button class="share-close" id="shareClose" type="button" aria-label="Close share dialog">×</button></div><p class="share-copy">This sends the current HTML file to HtmlShip and serves a copy from view.htmlship.com. Password-protect anything that should not be public.</p><p class="share-note">Lavish design assets are rewritten to public CDN links. The annotation SDK is not included. Local sibling assets may not resolve on the shared page.</p><div class="share-grid"><label>Title<input id="shareTitle" name="title" type="text" value="${escapeHtml(defaultShareTitle)}" autocomplete="off"></label><label>Password<input id="sharePassword" name="password" type="password" autocomplete="new-password" placeholder="Optional view password"></label><label>Expires in minutes<input id="shareExpiresIn" name="expires_in" type="number" min="1" max="10080" step="1" placeholder="Optional, max 10080"></label><label>Parent slug<input id="shareParentSlug" name="parent_slug" type="text" autocomplete="off" placeholder="Optional version parent"></label><label>Sandbox mode<select id="shareSandboxMode" name="sandbox_mode"><option value="strict">Strict</option><option value="relaxed" selected>Relaxed</option></select></label></div><div class="share-status" id="shareStatus" role="status"></div><div class="share-result" id="shareResult" hidden><label>Share URL<div class="share-copy-row"><input id="shareUrl" readonly><button class="copy-button" id="copyShareUrl" type="button">Copy URL</button></div></label><label>Owner key<div class="share-copy-row"><input id="shareOwnerKey" readonly><button class="copy-button" id="copyOwnerKey" type="button">Copy Key</button></div></label><p class="share-note">Keep the owner key private. HtmlShip returns it once, and it can update or delete this page.</p></div><div class="share-actions"><button class="button secondary" id="shareCancel" type="button">Cancel</button><button class="button" id="sharePublish" type="submit">Publish Page</button></div></form></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads" src="/artifact/${session.key}/index.html"></iframe></div><aside class="panel"><h2>Conversation</h2><div class="chat" id="chatLog"></div><div class="composer"><div class="annotation-pills" id="annotationPills"></div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="actions"><button class="button" id="send">Send to Agent</button></div></div></aside></div>
<script id="lavish-session" type="application/json">${sessionJson}</script>
<script src="/chrome-client.js"></script>
</body>
</html>`;
}

export function createSdkJs(key) {
  return `(() => {
const key=${JSON.stringify(key)};
void key;
(${createArtifactSdk.toString()})();
})();`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
