import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeMermaidNodeTarget } from "./mermaid-node.js";
import { EXCALIDRAW_SCENE_TARGET_TYPE, normalizeExcalidrawSceneTarget } from "./whiteboard-core.js";

const DELIVERY_LEASE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 2;

export class SessionStore {
  constructor(file) {
    this.file = file;
    this.locks = new Map();
  }

  async withSessionLock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  async listSessions() {
    const state = await this.readState();
    return Object.values(state.sessions).sort((a, b) => a.file.localeCompare(b.file));
  }

  async findByFile(file) {
    const absolute = await canonicalFile(file);
    const state = await this.readState();
    return state.sessions[sessionKey(absolute)] || null;
  }

  async findByKey(key) {
    const state = await this.readState();
    return state.sessions[key] || null;
  }

  async upsertSession(file, url) {
    const absolute = await canonicalFile(file);
    const key = sessionKey(absolute);
    return this.withSessionLock(key, async () => {
      const state = await this.readState();
      const existing = state.sessions[key] || {};
      const existingPrompts = existing.prompts || [];
      const existingStatus = existing.status === "ended" ? "open" : existing.status || "open";
      const session = {
        key,
        file: absolute,
        url,
        status: existingStatus === "feedback" && existingPrompts.length === 0 ? "open" : existingStatus,
        pending_prompts: existing.pending_prompts || 0,
        prompts: existingPrompts,
        layout_warnings: existing.layout_warnings || [],
        delivered_layout_warning_keys: existing.delivered_layout_warning_keys || [],
        dom_snapshot: existing.dom_snapshot || "",
        chat: existing.chat || [],
        feedback_delivery: existing.feedback_delivery || null,
        ended_by: existing.ended_by,
        updated_at: new Date().toISOString(),
      };
      state.sessions[key] = session;
      await this.writeState(state);
      return session;
    });
  }

  async queuePrompts(key, payload) {
    return this.withSessionLock(key, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      if (session.status === "ended") return { ...session, rejected: "ended" };
      const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
      const shouldEndSession = Boolean(payload.endSession || payload.end_session);
      const normalizedPrompts = prompts.map(normalizePrompt);
      const merged = [...(session.prompts || [])];
      for (const prompt of normalizedPrompts) {
        const queueKey = prompt.queue_key;
        const index = queueKey ? merged.findIndex((item) => item.queue_key === queueKey) : -1;
        if (index >= 0) merged[index] = prompt;
        else merged.push(prompt);
      }
      const changed =
        JSON.stringify(merged) !== JSON.stringify(session.prompts || []) ||
        String(payload.domSnapshot || payload.dom_snapshot || "") !== String(session.dom_snapshot || "");
      const userMessages = normalizedPrompts
        .filter((prompt) => prompt.tag === "message" && prompt.prompt)
        .map((prompt) => ({ role: "user", text: prompt.prompt, at: new Date().toISOString() }));
      session.prompts = merged;
      session.chat = [...(session.chat || []), ...userMessages];
      session.pending_prompts = merged.length;
      session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
      if (shouldEndSession) {
        session.status = "ended";
        session.ended_by = "user";
      } else {
        session.status = "feedback";
      }
      if (changed || shouldEndSession) {
        session.feedback_delivery = createDeliveryEnvelope(session, Date.now());
      }
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async recordLayoutWarnings(key, payload) {
    return this.withSessionLock(key, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      const deliveredWarningKeys = session.delivered_layout_warning_keys || [];
      const deliveredKeys = new Set(deliveredWarningKeys);
      const layoutWarnings = normalizeLayoutWarnings(
        payload.layout_warnings || payload.layoutWarnings || [],
        deliveredKeys,
      );
      const activeWarningKeys = new Set(layoutWarnings.map(layoutWarningKey));
      const nextDeliveredWarningKeys = deliveredWarningKeys
        .filter((keyValue) => activeWarningKeys.has(keyValue))
        .slice(-200);
      const deliveredKeysChanged =
        nextDeliveredWarningKeys.length !== deliveredWarningKeys.length ||
        nextDeliveredWarningKeys.some((keyValue, index) => keyValue !== deliveredWarningKeys[index]);
      const previousSignature = JSON.stringify(session.layout_warnings || []);
      const nextSignature = JSON.stringify(layoutWarnings);
      const warningsChanged = previousSignature !== nextSignature;
      if (!warningsChanged && !deliveredKeysChanged) {
        return { session, changed: false, hasWarnings: layoutWarnings.length > 0 };
      }
      session.layout_warnings = layoutWarnings;
      session.delivered_layout_warning_keys = nextDeliveredWarningKeys;
      if (layoutWarnings.length > 0 && session.status !== "ended") session.status = "feedback";
      else if ((session.prompts || []).length === 0 && session.status !== "ended") session.status = "open";
      if (warningsChanged && layoutWarnings.length > 0)
        session.feedback_delivery = createDeliveryEnvelope(session, Date.now());
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, changed: warningsChanged, hasWarnings: layoutWarnings.length > 0 };
    });
  }

  async leaseFeedback(key, now = Date.now()) {
    return this.withSessionLock(key, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return { status: "missing" };
      let delivery = session.feedback_delivery;
      if (!delivery)
        return session.status === "ended" ? { status: "ended", ended_by: session.ended_by } : { status: "waiting" };
      if (delivery.state === "acked")
        return session.status === "ended" ? { status: "ended", ended_by: session.ended_by } : { status: "waiting" };
      if (delivery.state === "exhausted")
        return { status: "delivery_exhausted", delivery_id: delivery.id, attempts: delivery.attempts };
      if (delivery.state === "leased" && Number(delivery.lease_until || 0) > now) return { status: "waiting" };
      if (
        delivery.state === "leased" &&
        Number(delivery.lease_until || 0) <= now &&
        delivery.attempts >= MAX_DELIVERY_ATTEMPTS
      ) {
        delivery.state = "exhausted";
        delivery.lease_until = null;
        await this.writeState(state);
        return { status: "delivery_exhausted", delivery_id: delivery.id, attempts: delivery.attempts };
      }
      delivery.attempts += 1;
      delivery.state = "leased";
      delivery.lease_until = now + DELIVERY_LEASE_MS;
      delivery.last_delivered_at = new Date(now).toISOString();
      await this.writeState(state);
      return deliveryResult(session, delivery);
    });
  }

  async ackFeedback(key, deliveryId, now = Date.now()) {
    return this.withSessionLock(key, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return { status: "missing" };
      const delivery = session.feedback_delivery;
      if (!delivery || delivery.id !== deliveryId) return { status: "conflict" };
      if (delivery.state === "acked")
        return { status: "acked", idempotent: true, session_ended: session.status === "ended" };
      if (delivery.state !== "leased") return { status: "conflict" };
      delivery.state = "acked";
      delivery.acknowledged_at = new Date(now).toISOString();
      delivery.lease_until = null;
      session.prompts = [];
      session.layout_warnings = [];
      session.pending_prompts = 0;
      session.dom_snapshot = "";
      if (session.status !== "ended") session.status = "open";
      if (delivery.payload.layout_warnings?.length) {
        const deliveredKeys = new Set(session.delivered_layout_warning_keys || []);
        for (const warning of delivery.payload.layout_warnings) deliveredKeys.add(layoutWarningKey(warning));
        session.delivered_layout_warning_keys = [...deliveredKeys].slice(-200);
      }
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { status: "acked", session_ended: session.status === "ended", ended_by: session.ended_by };
    });
  }

  async retryFeedback(key, deliveryId, now = Date.now()) {
    return this.withSessionLock(key, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return { status: "missing" };
      const delivery = session.feedback_delivery;
      if (!delivery || delivery.id !== deliveryId) return { status: "conflict" };
      if (delivery.state !== "exhausted") return { status: "conflict" };
      delivery.state = "pending";
      delivery.attempts = 0;
      delivery.lease_until = null;
      delivery.acknowledged_at = null;
      delivery.last_delivered_at = null;
      session.updated_at = new Date(now).toISOString();
      await this.writeState(state);
      return { status: "pending", delivery_id: delivery.id };
    });
  }

  async endSession(key, endedBy = "agent") {
    return this.withSessionLock(key, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      const existingEndedBy = session.status === "ended" ? session.ended_by : undefined;
      session.status = "ended";
      session.ended_by = endedBy === "user" || existingEndedBy === "user" ? "user" : "agent";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async addAgentReply(key, text) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) return null;
    session.chat = [...(session.chat || []), { role: "agent", text: String(text || ""), at: new Date().toISOString() }];
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return session;
  }

  async readState() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions || {} };
    } catch (error) {
      if (error && error.code === "ENOENT") return { sessions: {} };
      throw error;
    }
  }

  async writeState(state) {
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function createDeliveryEnvelope(session, now) {
  const prior = session.feedback_delivery;
  const prompts = session.prompts || [];
  const warnings = session.layout_warnings || [];
  if (
    prior &&
    JSON.stringify(prior.payload) ===
      JSON.stringify({ prompts, layout_warnings: warnings, dom_snapshot: session.dom_snapshot || "" })
  ) {
    return prior;
  }
  return {
    id: crypto.randomUUID(),
    payload: {
      prompts: structuredClone(prompts),
      layout_warnings: structuredClone(warnings),
      dom_snapshot: session.dom_snapshot || "",
    },
    state: "pending",
    attempts: 0,
    lease_until: null,
    acknowledged_at: null,
    last_delivered_at: null,
    created_at: new Date(now).toISOString(),
  };
}

function deliveryResult(session, delivery) {
  return {
    status: "feedback",
    delivery_id: delivery.id,
    attempt: delivery.attempts,
    dom_snapshot: delivery.payload.dom_snapshot || "",
    prompts: stripQueueKeys(delivery.payload.prompts || []),
    ...(delivery.payload.layout_warnings?.length ? { layout_warnings: delivery.payload.layout_warnings } : {}),
    ...(session.status === "ended" ? { session_ended: true, ended_by: session.ended_by } : {}),
  };
}

function stripQueueKeys(prompts) {
  return prompts.map(({ queue_key: _queueKey, ...prompt }) => prompt);
}

export async function canonicalFile(file) {
  const absolute = path.resolve(file);
  return realpath(absolute);
}

export function sessionKey(file) {
  return crypto.createHash("sha256").update(file).digest("hex").slice(0, 16);
}

function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  const queueKey = String(prompt.queue_key || prompt._lavishQueueKey || "").trim();
  if (queueKey) normalized.queue_key = queueKey;
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  return normalized;
}

function layoutWarningKey(warning) {
  return `${warning.kind}:${warning.selector}`;
}

function normalizeLayoutWarnings(layoutWarnings, deliveredKeys = new Set()) {
  if (!Array.isArray(layoutWarnings)) return [];
  return layoutWarnings
    .filter((warning) => warning && typeof warning === "object" && !Array.isArray(warning))
    .map((warning) => {
      const selector = String(warning.selector || "");
      const kind = String(warning.kind || "layout-warning");
      return {
        selector,
        kind,
        overflowPx: normalizeFiniteNumber(warning.overflowPx),
        viewportWidth: normalizeFiniteNumber(warning.viewportWidth),
        severity: warning.severity === "warning" ? "warning" : "error",
        persistent: deliveredKeys.has(layoutWarningKey({ kind, selector })),
      };
    });
}

function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === "mermaid-node") return normalizeMermaidNodeTarget(target);
  if (target.type === EXCALIDRAW_SCENE_TARGET_TYPE) return normalizeExcalidrawSceneTarget(target);
  return JSON.parse(JSON.stringify(target));
}
