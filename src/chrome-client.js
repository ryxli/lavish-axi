/* global EventSource, document, location, window */

const sessionDataElement = document.getElementById("lavish-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const annotationPills = /** @type {HTMLDivElement} */ (document.getElementById("annotationPills"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const annotationButton = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const endButton = /** @type {HTMLButtonElement} */ (document.getElementById("end"));
const filePathInput = /** @type {HTMLInputElement} */ (document.getElementById("filePath"));
const copyPathButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyPath"));
const shareButton = /** @type {HTMLButtonElement} */ (document.getElementById("share"));
const shareDialog = /** @type {HTMLDivElement} */ (document.getElementById("shareDialog"));
const shareForm = /** @type {HTMLFormElement} */ (document.getElementById("shareForm"));
const shareCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareClose"));
const shareCancelButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareCancel"));
const sharePublishButton = /** @type {HTMLButtonElement} */ (document.getElementById("sharePublish"));
const shareTitleInput = /** @type {HTMLInputElement} */ (document.getElementById("shareTitle"));
const sharePasswordInput = /** @type {HTMLInputElement} */ (document.getElementById("sharePassword"));
const shareExpiresInInput = /** @type {HTMLInputElement} */ (document.getElementById("shareExpiresIn"));
const shareParentSlugInput = /** @type {HTMLInputElement} */ (document.getElementById("shareParentSlug"));
const shareSandboxModeInput = /** @type {HTMLSelectElement} */ (document.getElementById("shareSandboxMode"));
const shareStatus = /** @type {HTMLDivElement} */ (document.getElementById("shareStatus"));
const shareResult = /** @type {HTMLDivElement} */ (document.getElementById("shareResult"));
const shareUrlInput = /** @type {HTMLInputElement} */ (document.getElementById("shareUrl"));
const shareOwnerKeyInput = /** @type {HTMLInputElement} */ (document.getElementById("shareOwnerKey"));
const copyShareUrlButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyShareUrl"));
const copyOwnerKeyButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyOwnerKey"));

const queued = [];
let annotation = true;
let agentPolling = false;
let pendingSnapshot = "";
let workingBubble = null;

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

function render() {
  annotationPills.innerHTML = queued
    .map(
      (prompt, index) =>
        '<div class="pill-wrap"><div class="pill"><span class="pill-preview">' +
        escapeHtml(prompt.prompt) +
        '</span><button class="pill-close" type="button" aria-label="Remove queued prompt" data-index="' +
        index +
        '">×</button></div><div class="pill-tooltip">' +
        (prompt.selector
          ? '<div class="tooltip-label">Target</div><div class="pill-tooltip-target">' +
            escapeHtml(prompt.selector) +
            "</div>"
          : "") +
        '<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">' +
        escapeHtml(prompt.prompt) +
        "</div></div></div>",
    )
    .join("");

  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
}

function addChat(role, text) {
  if (!text) return;

  const el = document.createElement("div");
  el.className = "bubble " + role;
  el.innerHTML = "<small>" + (role === "agent" ? "Agent" : "You") + "</small><div>" + escapeHtml(text) + "</div>";
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function syncChat(chat) {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }

  for (const item of chat) addChat(item.role, item.text);
  if (workingBubble) chatLog.appendChild(workingBubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setAgentPolling(active) {
  agentPolling = !!active;
  sendButton.disabled = !agentPolling;

  if (agentPolling) {
    if (workingBubble) workingBubble.remove();
    workingBubble = null;
    return;
  }

  if (!workingBubble) {
    workingBubble = document.createElement("div");
    workingBubble.className = "bubble agent agent-working";
    workingBubble.innerHTML = '<span class="spinner"></span><span>Working...</span>';
    chatLog.appendChild(workingBubble);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  queued.splice(index, 1);
  render();
}

function postToFrame(message) {
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

function sendQueued() {
  if (!agentPolling) return;

  const text = chatInput.value.trim();
  if (text) {
    queued.push({ uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" });
    addChat("user", text);
    chatInput.value = "";
    render();
  }
  if (!queued.length) return;

  postToFrame({ type: "lavish:requestSnapshot" });
}

async function submitQueued() {
  const prompts = queued.splice(0, queued.length);
  render();
  setAgentPolling(false);
  await fetch("/api/" + key + "/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts, domSnapshot: pendingSnapshot }),
  });
}

async function endSession() {
  await fetch("/api/" + key + "/end", { method: "POST" });
  document.body.innerHTML =
    '<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Editor</span></div></div><main class="ended-view"><section class="ended-card"><div class="ended-title">Session ended.</div><p class="ended-copy">Return to your agent to continue.</p></section></main>';
}

async function copyFilePath() {
  try {
    await navigator.clipboard.writeText(filePathInput.value);
  } catch {
    filePathInput.select();
    document.execCommand("copy");
  }

  copyPathButton.textContent = "Copied";
  setTimeout(() => {
    copyPathButton.textContent = "Copy Path";
  }, 1200);
}

function openShareDialog() {
  shareDialog.hidden = false;
  shareStatus.textContent = "";
  shareStatus.classList.remove("error");
  shareTitleInput.focus();
}

function closeShareDialog() {
  shareDialog.hidden = true;
}

async function copyText(value, button, label) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = label;
  }, 1200);
}

async function publishShare(event) {
  event.preventDefault();
  sharePublishButton.disabled = true;
  shareStatus.classList.remove("error");
  shareStatus.textContent = "Publishing with HtmlShip...";
  shareResult.hidden = true;

  try {
    const response = await fetch("/api/" + key + "/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: shareTitleInput.value.trim(),
        password: sharePasswordInput.value,
        expires_in: shareExpiresInInput.value,
        parent_slug: shareParentSlugInput.value.trim(),
        sandbox_mode: shareSandboxModeInput.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "HtmlShip publish failed");
    }

    shareUrlInput.value = data.url || "";
    shareOwnerKeyInput.value = data.owner_key || "";
    shareStatus.textContent = data.expires_at
      ? "Published. This page expires at " + data.expires_at + "."
      : "Published. Keep the owner key private.";
    shareResult.hidden = false;
    shareUrlInput.focus();
    shareUrlInput.select();
  } catch (error) {
    shareStatus.classList.add("error");
    shareStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sharePublishButton.disabled = false;
  }
}

async function reloadAfterServerRestart() {
  let sawOutage = false;
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (sawOutage && res.ok) {
        location.reload();
        return;
      }
    } catch {
      sawOutage = true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  location.reload();
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  if (msg.type === "lavish:queuePrompt") {
    queued.push(msg.prompt);
    render();
  }
  if (msg.type === "lavish:snapshot") {
    pendingSnapshot = msg.snapshot || "";
    submitQueued();
  }
  if (msg.type === "lavish:sendQueuedPrompts") sendQueued();
  if (msg.type === "lavish:endSession") endSession();
});

annotationButton.onclick = () => {
  annotation = !annotation;
  annotationButton.textContent = "Annotation: " + (annotation ? "On" : "Off");
  annotationButton.classList.toggle("annotation-on", annotation);
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
};

sendButton.onclick = sendQueued;
copyPathButton.onclick = copyFilePath;
shareButton.onclick = openShareDialog;
shareCloseButton.onclick = closeShareDialog;
shareCancelButton.onclick = closeShareDialog;
shareForm.addEventListener("submit", publishShare);
shareDialog.addEventListener("click", (event) => {
  if (event.target === shareDialog) closeShareDialog();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !shareDialog.hidden) closeShareDialog();
});
copyShareUrlButton.onclick = () => copyText(shareUrlInput.value, copyShareUrlButton, "Copy URL");
copyOwnerKeyButton.onclick = () => copyText(shareOwnerKeyInput.value, copyOwnerKeyButton, "Copy Key");
endButton.onclick = endSession;
frame.addEventListener("load", () => postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation }));

const events = new EventSource("/events/" + key);
events.addEventListener("reload", () => {
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  // eslint-disable-next-line no-self-assign
  frame.src = frame.src;
});
events.addEventListener("chrome-reload", () => reloadAfterServerRestart());
events.addEventListener("agent-reply", (event) => addChat("agent", JSON.parse(event.data).text));
events.addEventListener("chat-sync", (event) => syncChat(JSON.parse(event.data).chat || []));
events.addEventListener("agent-working", (event) => setAgentPolling(!JSON.parse(event.data).working));

render();
initialChat.forEach((item) => addChat(item.role, item.text));
setAgentPolling(false);
