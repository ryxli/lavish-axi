import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { sanitizeWhiteboardScene } from "./whiteboard-core.js";

// Sidecar persistence for whiteboard scenes, kept out of `state.json` on
// purpose: `SessionStore` rewrites the whole state file on every operation, so
// multi-hundred-KB Excalidraw scenes autosaving every second would turn each
// unrelated store write into a large rewrite. Scenes live as one JSON file per
// (session key, diagram index) under `<state-dir>/whiteboards/`, next to the
// published `.excalidraw`/`.png` feedback files the agent reads.

const KEY_RE = /^[0-9a-f]{16}$/;
export const MAX_WHITEBOARD_OPERATIONS = 100;
export const MAX_WHITEBOARD_OPERATION_BYTES = 256 * 1024;
export const WHITEBOARD_HISTORY_LIMIT = 100;

export class WhiteboardOperationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WhiteboardOperationError";
    this.code = "INVALID_WHITEBOARD_OPERATIONS";
    this.status = 400;
    Object.assign(this, details);
  }
}

export class WhiteboardRevisionConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(`whiteboard revision conflict: expected ${expectedRevision}, current ${actualRevision}`);
    this.name = "WhiteboardRevisionConflictError";
    this.code = "WHITEBOARD_REVISION_CONFLICT";
    this.status = 409;
    this.expected_revision = expectedRevision;
    this.actual_revision = actualRevision;
  }
}

export class WhiteboardNotFoundError extends Error {
  constructor() {
    super("whiteboard not found");
    this.name = "WhiteboardNotFoundError";
    this.code = "WHITEBOARD_NOT_FOUND";
    this.status = 404;
  }
}
const writeTails = new Map();
let temporaryFileId = 0;

export function isValidWhiteboardKey(key) {
  return KEY_RE.test(String(key || ""));
}

export function isValidDiagramIndex(index) {
  const number = Number(index);
  return Number.isInteger(number) && number >= 0 && number <= 999;
}

function assertValidRef(key, index) {
  if (!isValidWhiteboardKey(key)) throw new Error(`invalid whiteboard session key: ${key}`);
  if (!isValidDiagramIndex(index)) throw new Error(`invalid whiteboard diagram index: ${index}`);
}

export function whiteboardDir(stateDir, key) {
  return path.join(stateDir, "whiteboards", String(key));
}

function workingFile(stateDir, key, index) {
  return path.join(whiteboardDir(stateDir, key), `${Number(index)}.json`);
}

function writeQueueKey(stateDir, key, index) {
  return `${path.resolve(stateDir)}\u0000${key}\u0000${Number(index)}`;
}

function queueWhiteboardWrite(stateDir, key, index, operation) {
  const queueKey = writeQueueKey(stateDir, key, index);
  const prior = writeTails.get(queueKey) || Promise.resolve();
  const result = prior.catch(() => {}).then(operation);
  const tail = result.catch(() => {});
  writeTails.set(queueKey, tail);
  tail.finally(() => {
    if (writeTails.get(queueKey) === tail) writeTails.delete(queueKey);
  });
  return result;
}

async function writeFileAtomically(file, content) {
  const temporary = `${file}.${process.pid}.${++temporaryFileId}.tmp`;
  try {
    const temporaryHandle = await open(temporary, "w");
    try {
      await temporaryHandle.writeFile(content);
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await rename(temporary, file);
    const directoryHandle = await open(path.dirname(file), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
function cloneJsonValue(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new WhiteboardOperationError("operation value must be JSON-serializable");
  }
  if (encoded === undefined) throw new WhiteboardOperationError("operation value must be JSON-serializable");
  try {
    return JSON.parse(encoded);
  } catch {
    throw new WhiteboardOperationError("operation value must be JSON-serializable");
  }
}

function normalizeOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new WhiteboardOperationError("operation must be an object");
  }
  const op = operation.op;
  if (op === "append") {
    const value = operation.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WhiteboardOperationError("append value must be an element object");
    }
    const normalizedValue = cloneJsonValue(value);
    if (!normalizedValue || typeof normalizedValue !== "object" || Array.isArray(normalizedValue)) {
      throw new WhiteboardOperationError("append value must be an element object");
    }
    if (typeof normalizedValue.id !== "string" || normalizedValue.id.trim() === "") {
      throw new WhiteboardOperationError("append value.id must be a nonempty string");
    }
    return { op, value: normalizedValue };
  }
  if (op === "replace") {
    if (typeof operation.id !== "string" || operation.id.trim() === "") {
      throw new WhiteboardOperationError("replace id must be a nonempty string");
    }
    const value = operation.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WhiteboardOperationError("replace value must be an element object");
    }
    const normalizedValue = cloneJsonValue(value);
    if (!normalizedValue || typeof normalizedValue !== "object" || Array.isArray(normalizedValue)) {
      throw new WhiteboardOperationError("replace value must be an element object");
    }
    if (normalizedValue.id !== operation.id) {
      throw new WhiteboardOperationError("replace id must match value.id");
    }
    return { op, id: operation.id, value: normalizedValue };
  }
  if (op === "delete") {
    if (typeof operation.id !== "string" || operation.id.trim() === "") {
      throw new WhiteboardOperationError("delete id must be a nonempty string");
    }
    return { op, id: operation.id };
  }
  throw new WhiteboardOperationError("operation op must be append, replace, or delete");
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const revision = entry.revision;
  if (!Number.isInteger(revision) || revision < 1) return null;
  if (entry.kind !== "full" && entry.kind !== "operations") return null;
  if (!Array.isArray(entry.operations)) return null;
  let operations;
  try {
    operations = Array.from(entry.operations, normalizeOperation);
  } catch {
    return null;
  }
  return {
    revision,
    updated_at: String(entry.updated_at || ""),
    kind: entry.kind,
    operations,
  };
}

function normalizeStoredRecord(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const revision = Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
  const revisions = Array.isArray(parsed.revisions)
    ? parsed.revisions.map(normalizeHistoryEntry).filter(Boolean).slice(-WHITEBOARD_HISTORY_LIMIT)
    : [];
  return {
    source_hash: String(parsed.source_hash || ""),
    text_metrics_version: Math.max(0, Math.floor(Number(parsed.text_metrics_version) || 0)),
    updated_at: String(parsed.updated_at || ""),
    scene: parsed.scene ?? null,
    baseline: parsed.baseline ?? null,
    revision,
    revisions,
  };
}

async function readStoredRecord(stateDir, key, index) {
  try {
    const raw = await readFile(workingFile(stateDir, key, index), "utf8");
    return normalizeStoredRecord(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function currentElements(record) {
  if (!record.scene || typeof record.scene !== "object" || Array.isArray(record.scene)) {
    throw new WhiteboardOperationError("saved whiteboard scene must contain elements");
  }
  if (!Array.isArray(record.scene.elements)) {
    throw new WhiteboardOperationError("saved whiteboard scene must contain elements");
  }
  return record.scene.elements;
}

function validateAndApplyOperations(record, operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new WhiteboardOperationError("operations must be a nonempty array");
  }
  if (operations.length > MAX_WHITEBOARD_OPERATIONS) {
    throw new WhiteboardOperationError(`at most ${MAX_WHITEBOARD_OPERATIONS} operations are allowed`);
  }
  const normalized = Array.from(operations, normalizeOperation);
  const operationBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (operationBytes > MAX_WHITEBOARD_OPERATION_BYTES) {
    throw new WhiteboardOperationError(`operations exceed ${MAX_WHITEBOARD_OPERATION_BYTES} bytes`);
  }

  const elements = currentElements(record).map((element) => cloneJsonValue(element));
  const ids = new Set();
  for (const element of elements) {
    if (element && typeof element.id === "string") ids.add(element.id);
  }
  for (const operation of normalized) {
    if (operation.op === "append") {
      if (ids.has(operation.value.id)) {
        throw new WhiteboardOperationError(`append id already exists: ${operation.value.id}`);
      }
      elements.push(operation.value);
      ids.add(operation.value.id);
    } else {
      const elementIndex = elements.findIndex((element) => element?.id === operation.id);
      if (elementIndex < 0) {
        throw new WhiteboardOperationError(`element id does not exist: ${operation.id}`);
      }
      if (operation.op === "replace") elements[elementIndex] = operation.value;
      else elements.splice(elementIndex, 1);
      if (operation.op === "delete") ids.delete(operation.id);
    }
  }
  return { normalized, scene: { ...record.scene, elements } };
}

export function whiteboardFeedbackPaths(stateDir, key, index) {
  assertValidRef(key, index);
  const dir = whiteboardDir(stateDir, key);
  return {
    scenePath: path.join(dir, `${Number(index)}.excalidraw`),
    previewPath: path.join(dir, `${Number(index)}.png`),
  };
}

// Working state: the editable scene, the conversion baseline used for edit
// summaries, and the hash of the Mermaid source the scene was converted from.
export async function saveWhiteboard(
  stateDir,
  key,
  index,
  { sourceHash, textMetricsVersion = 0, scene, baseline = null },
) {
  assertValidRef(key, index);
  const sourceHashSnapshot = String(sourceHash || "");
  const textMetricsVersionSnapshot = Math.max(0, Math.floor(Number(textMetricsVersion) || 0));
  const sceneSnapshot = cloneJsonValue(sanitizeWhiteboardScene(scene));
  const baselineSnapshot = cloneJsonValue(baseline);
  return queueWhiteboardWrite(stateDir, key, index, async () => {
    const prior = await readStoredRecord(stateDir, key, index);
    const revision = (prior?.revision || 0) + 1;
    const updatedAt = new Date().toISOString();
    const entry = { revision, updated_at: updatedAt, kind: "full", operations: [] };
    const record = {
      source_hash: sourceHashSnapshot,
      text_metrics_version: textMetricsVersionSnapshot,
      updated_at: updatedAt,
      scene: sceneSnapshot,
      baseline: baselineSnapshot,
      revision,
      revisions: [...(prior?.revisions || []), entry].slice(-WHITEBOARD_HISTORY_LIMIT),
    };
    await mkdir(whiteboardDir(stateDir, key), { recursive: true });
    await writeFileAtomically(workingFile(stateDir, key, index), `${JSON.stringify(record)}\n`);
    return record;
  });
}

export async function loadWhiteboard(stateDir, key, index) {
  assertValidRef(key, index);
  const record = await readStoredRecord(stateDir, key, index);
  if (!record) return null;
  return {
    source_hash: record.source_hash,
    text_metrics_version: record.text_metrics_version,
    updated_at: record.updated_at,
    scene: record.scene,
    baseline: record.baseline,
  };
}

/**
 * @param {string} stateDir
 * @param {string} key
 * @param {number} index
 * @param {{ baseRevision?: unknown, operations?: unknown }} [input]
 */
export async function applyWhiteboardOperations(stateDir, key, index, { baseRevision, operations } = {}) {
  assertValidRef(key, index);
  if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 0) {
    throw new WhiteboardOperationError("baseRevision must be a nonnegative integer");
  }
  const operationsSnapshot = cloneJsonValue(operations);
  return queueWhiteboardWrite(stateDir, key, index, async () => {
    const prior = await readStoredRecord(stateDir, key, index);
    if (!prior) throw new WhiteboardNotFoundError();
    if (prior.revision !== baseRevision) {
      throw new WhiteboardRevisionConflictError(baseRevision, prior.revision);
    }
    const { normalized, scene } = validateAndApplyOperations(prior, operationsSnapshot);
    const revision = prior.revision + 1;
    const updatedAt = new Date().toISOString();
    const entry = { revision, updated_at: updatedAt, kind: "operations", operations: normalized };
    const record = {
      ...prior,
      updated_at: updatedAt,
      scene: sanitizeWhiteboardScene(scene),
      revision,
      revisions: [...prior.revisions, entry].slice(-WHITEBOARD_HISTORY_LIMIT),
    };
    await mkdir(whiteboardDir(stateDir, key), { recursive: true });
    await writeFileAtomically(workingFile(stateDir, key, index), `${JSON.stringify(record)}\n`);
    return record;
  });
}

/**
 * @param {string} stateDir
 * @param {string} key
 * @param {number} index
 * @param {{ afterRevision?: unknown }} [input]
 */
export async function loadWhiteboardRevisions(stateDir, key, index, { afterRevision } = {}) {
  assertValidRef(key, index);
  if (typeof afterRevision !== "number" || !Number.isInteger(afterRevision) || afterRevision < 0) {
    throw new WhiteboardOperationError("afterRevision must be a nonnegative integer");
  }
  const record = await readStoredRecord(stateDir, key, index);
  if (!record) return { revision: 0, revisions: [] };
  return {
    revision: record.revision,
    revisions: record.revisions.filter((entry) => entry.revision > afterRevision),
  };
}

// Publish the agent-facing feedback files: a standalone `.excalidraw` scene
// JSON and a PNG preview. Called at queue time so the paths embedded in the
// queued prompt always point at the exact reviewed state.
export async function writeWhiteboardFeedbackFiles(stateDir, key, index, { scene, pngDataUrl = "" }) {
  assertValidRef(key, index);
  const { scenePath, previewPath } = whiteboardFeedbackPaths(stateDir, key, index);
  const sanitizedScene = sanitizeWhiteboardScene(scene);
  const sceneJson = {
    type: "excalidraw",
    version: 2,
    source: "lavish-axi",
    elements: Array.isArray(sanitizedScene?.elements) ? sanitizedScene.elements : [],
    appState: sanitizedScene?.appState || {},
    files: sanitizedScene?.files && typeof sanitizedScene.files === "object" ? sanitizedScene.files : {},
  };
  const png = decodePngDataUrl(pngDataUrl);
  return queueWhiteboardWrite(stateDir, key, index, async () => {
    await mkdir(whiteboardDir(stateDir, key), { recursive: true });
    await writeFileAtomically(scenePath, `${JSON.stringify(sceneJson, null, 2)}\n`);
    if (png) {
      await writeFileAtomically(previewPath, png);
      return { scenePath, previewPath };
    }
    return { scenePath, previewPath: "" };
  });
}

export function decodePngDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}
