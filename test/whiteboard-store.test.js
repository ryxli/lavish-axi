import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_WHITEBOARD_OPERATION_BYTES,
  MAX_WHITEBOARD_OPERATIONS,
  WhiteboardOperationError,
  WhiteboardRevisionConflictError,
  applyWhiteboardOperations,
  decodePngDataUrl,
  isValidDiagramIndex,
  isValidWhiteboardKey,
  loadWhiteboard,
  loadWhiteboardRevisions,
  WHITEBOARD_HISTORY_LIMIT,
  saveWhiteboard,
  whiteboardFeedbackPaths,
  writeWhiteboardFeedbackFiles,
} from "../src/whiteboard-store.js";
const KEY = "0123456789abcdef";
// A 1x1 transparent PNG.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-whiteboard-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveWhiteboard/loadWhiteboard strips persisted theme and canvas background", async () => {
  await withTempDir(async (dir) => {
    const scene = {
      elements: [{ id: "A", type: "rectangle" }],
      appState: { theme: "dark", viewBackgroundColor: "#121212", scrollX: 12 },
      files: {},
    };
    const baseline = { elements: [{ id: "A", type: "rectangle" }] };
    await saveWhiteboard(dir, KEY, 0, { sourceHash: "hash-1", textMetricsVersion: 1, scene, baseline });
    const loaded = await loadWhiteboard(dir, KEY, 0);
    assert.equal(loaded.source_hash, "hash-1");
    assert.equal(loaded.text_metrics_version, 1);
    assert.deepEqual(loaded.scene, {
      ...scene,
      appState: { scrollX: 12 },
    });
    assert.deepEqual(loaded.baseline, baseline);
    assert.ok(loaded.updated_at);
  });
});

test("loadWhiteboard returns null when nothing was saved", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await loadWhiteboard(dir, KEY, 3), null);
  });
});

test("legacy records without revisions remain readable at revision zero", async () => {
  await withTempDir(async (dir) => {
    const recordDir = path.join(dir, "whiteboards", KEY);
    await mkdir(recordDir, { recursive: true });
    await writeFile(
      path.join(recordDir, "4.json"),
      `${JSON.stringify({ source_hash: "legacy", scene: { elements: [{ id: "A" }] }, baseline: null })}\n`,
    );
    assert.deepEqual(await loadWhiteboard(dir, KEY, 4), {
      source_hash: "legacy",
      text_metrics_version: 0,
      updated_at: "",
      scene: { elements: [{ id: "A" }] },
      baseline: null,
    });
    assert.deepEqual(await loadWhiteboardRevisions(dir, KEY, 4, { afterRevision: 0 }), { revision: 0, revisions: [] });
  });
});

test("saveWhiteboard overwrites prior state for the same diagram", async () => {
  await withTempDir(async (dir) => {
    await saveWhiteboard(dir, KEY, 1, { sourceHash: "h1", scene: { elements: [] }, baseline: null });
    await saveWhiteboard(dir, KEY, 1, { sourceHash: "h2", scene: { elements: [{ id: "B" }] }, baseline: null });
    const loaded = await loadWhiteboard(dir, KEY, 1);
    assert.equal(loaded.source_hash, "h2");
    assert.equal((await loadWhiteboardRevisions(dir, KEY, 1, { afterRevision: 0 })).revision, 2);
    assert.equal(loaded.scene.elements.length, 1);
  });
});

test("applyWhiteboardOperations applies ordered append, replace, and delete", async () => {
  await withTempDir(async (dir) => {
    await saveWhiteboard(dir, KEY, 2, {
      sourceHash: "h",
      scene: { elements: [{ id: "A", text: "old" }] },
    });
    const result = await applyWhiteboardOperations(dir, KEY, 2, {
      baseRevision: 1,
      operations: [
        { op: "append", value: { id: "B", text: "new" }, ignored: true },
        { op: "replace", id: "A", value: { id: "A", text: "updated" }, ignored: true },
        { op: "delete", id: "B", extra: "ignored" },
      ],
    });
    assert.equal(result.revision, 2);
    assert.deepEqual(result.scene.elements, [{ id: "A", text: "updated" }]);
    assert.deepEqual(result.revisions[1].operations, [
      { op: "append", value: { id: "B", text: "new" } },
      { op: "replace", id: "A", value: { id: "A", text: "updated" } },
      { op: "delete", id: "B" },
    ]);
  });
});

test("write inputs are snapshotted before queued storage", async () => {
  await withTempDir(async (dir) => {
    const scene = { elements: [{ id: "A" }] };
    const saved = saveWhiteboard(dir, KEY, 5, { sourceHash: "before", scene, baseline: { elements: scene.elements } });
    scene.elements[0].id = "mutated";
    await saved;
    const operations = [{ op: "append", value: { id: "B" } }];
    const applied = applyWhiteboardOperations(dir, KEY, 5, { baseRevision: 1, operations });
    operations[0].value.id = "mutated";
    await applied;
    assert.deepEqual((await loadWhiteboard(dir, KEY, 5)).scene.elements, [{ id: "A" }, { id: "B" }]);
  });
});

test("whiteboard revisions remain ordered and durable across reload", async () => {
  await withTempDir(async (dir) => {
    await saveWhiteboard(dir, KEY, 3, { sourceHash: "one", scene: { elements: [] } });
    await applyWhiteboardOperations(dir, KEY, 3, {
      baseRevision: 1,
      operations: [{ op: "append", value: { id: "A" } }],
    });
    await saveWhiteboard(dir, KEY, 3, { sourceHash: "three", scene: { elements: [{ id: "C" }] } });
    const history = await loadWhiteboardRevisions(dir, KEY, 3, { afterRevision: 0 });
    assert.equal(history.revision, 3);
    assert.deepEqual(
      history.revisions.map(({ revision, kind }) => ({ revision, kind })),
      [
        { revision: 1, kind: "full" },
        { revision: 2, kind: "operations" },
        { revision: 3, kind: "full" },
      ],
    );
    const reloaded = await loadWhiteboardRevisions(dir, KEY, 3, { afterRevision: 1 });
    assert.deepEqual(
      reloaded.revisions.map((entry) => entry.revision),
      [2, 3],
    );
    assert.equal((await loadWhiteboardRevisions(dir, KEY, 3, { afterRevision: 0 })).revision, 3);
  });
});

test("revision history is capped while retaining ordered recent revisions", async () => {
  await withTempDir(async (dir) => {
    for (let revision = 1; revision <= WHITEBOARD_HISTORY_LIMIT + 1; revision += 1) {
      await saveWhiteboard(dir, KEY, 7, {
        sourceHash: String(revision),
        scene: { elements: [{ id: String(revision) }] },
      });
    }
    const history = await loadWhiteboardRevisions(dir, KEY, 7, { afterRevision: 0 });
    assert.equal(history.revision, WHITEBOARD_HISTORY_LIMIT + 1);
    assert.equal(history.revisions.length, WHITEBOARD_HISTORY_LIMIT);
    assert.equal(history.revisions[0].revision, 2);
    assert.equal(history.revisions.at(-1).revision, WHITEBOARD_HISTORY_LIMIT + 1);
  });
});

test("operation version conflicts and invalid operations do not persist", async () => {
  await withTempDir(async (dir) => {
    await saveWhiteboard(dir, KEY, 6, { sourceHash: "h", scene: { elements: [{ id: "A" }] } });
    await assert.rejects(
      () => applyWhiteboardOperations(dir, KEY, 6, { baseRevision: 0, operations: [{ op: "delete", id: "A" }] }),
      (error) => error instanceof WhiteboardRevisionConflictError && error.actual_revision === 1,
    );
    const invalidOperations = [
      [{ op: "append", value: { id: "A" } }],
      [{ op: "replace", id: "missing", value: { id: "missing" } }],
      [{ op: "replace", id: "A", value: { id: "B" } }],
      [{ op: "delete", id: "missing" }],
      [{ op: "append", value: { id: "" } }],
      [],
    ];
    for (const operations of invalidOperations) {
      await assert.rejects(
        () => applyWhiteboardOperations(dir, KEY, 6, { baseRevision: 1, operations }),
        (error) => error instanceof WhiteboardOperationError,
      );
    }
    await assert.rejects(
      () =>
        applyWhiteboardOperations(dir, KEY, 6, {
          baseRevision: 1,
          operations: Array.from({ length: MAX_WHITEBOARD_OPERATIONS + 1 }, (_, index) => ({
            op: "append",
            value: { id: `id-${index}` },
          })),
        }),
      WhiteboardOperationError,
    );
    await assert.rejects(
      () =>
        applyWhiteboardOperations(dir, KEY, 6, {
          baseRevision: 1,
          operations: [{ op: "append", value: { id: "large", text: "x".repeat(MAX_WHITEBOARD_OPERATION_BYTES) } }],
        }),
      WhiteboardOperationError,
    );
    await assert.rejects(
      () =>
        applyWhiteboardOperations(dir, KEY, 6, {
          baseRevision: 1,
          operations: [
            { op: "append", value: { id: "B" } },
            { op: "delete", id: "missing" },
          ],
        }),
      WhiteboardOperationError,
    );
    assert.deepEqual((await loadWhiteboard(dir, KEY, 6)).scene.elements, [{ id: "A" }]);
    assert.equal((await loadWhiteboardRevisions(dir, KEY, 6, { afterRevision: 0 })).revision, 1);
  });
});

test("concurrent saves preserve the most recent scene", async () => {
  await withTempDir(async (dir) => {
    const slowScene = { elements: [{ id: "old", text: "x".repeat(8 * 1024 * 1024) }] };
    const latestScene = { elements: [{ id: "latest" }] };
    await Promise.all([
      saveWhiteboard(dir, KEY, 5, { sourceHash: "old", scene: slowScene, baseline: null }),
      saveWhiteboard(dir, KEY, 5, { sourceHash: "latest", scene: latestScene, baseline: null }),
    ]);
    const loaded = await loadWhiteboard(dir, KEY, 5);
    assert.equal(loaded.source_hash, "latest");
    assert.deepEqual(loaded.scene, latestScene);
  });
});

test("store rejects invalid keys and indexes (path traversal guard)", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => saveWhiteboard(dir, "../../etc", 0, { sourceHash: "", scene: null }), /invalid/);
    await assert.rejects(() => saveWhiteboard(dir, KEY, "../7", { sourceHash: "", scene: null }), /invalid/);
    await assert.rejects(() => loadWhiteboard(dir, "ZZZZ", 0), /invalid/);
    await assert.rejects(() => writeWhiteboardFeedbackFiles(dir, KEY, -1, { scene: null }), /invalid/);
  });
});

test("isValidWhiteboardKey / isValidDiagramIndex validate shapes", () => {
  assert.equal(isValidWhiteboardKey(KEY), true);
  assert.equal(isValidWhiteboardKey("0123"), false);
  assert.equal(isValidWhiteboardKey("0123456789ABCDEF"), false);
  assert.equal(isValidDiagramIndex(0), true);
  assert.equal(isValidDiagramIndex("12"), true);
  assert.equal(isValidDiagramIndex(1000), false);
  assert.equal(isValidDiagramIndex(-1), false);
  assert.equal(isValidDiagramIndex(1.5), false);
});

test("writeWhiteboardFeedbackFiles writes a standalone .excalidraw and a PNG", async () => {
  await withTempDir(async (dir) => {
    const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(dir, KEY, 2, {
      scene: { elements: [{ id: "A", type: "rectangle" }], appState: { theme: "light" }, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });
    assert.deepEqual({ scenePath, previewPath }, whiteboardFeedbackPaths(dir, KEY, 2));
    const scene = JSON.parse(await readFile(scenePath, "utf8"));
    assert.equal(scene.type, "excalidraw");
    assert.equal(scene.version, 2);
    assert.equal(scene.source, "lavish-axi");
    assert.equal(scene.elements[0].id, "A");
    assert.deepEqual(scene.appState, {});
    const png = await readFile(previewPath);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});

test("writeWhiteboardFeedbackFiles tolerates a missing or invalid preview", async () => {
  await withTempDir(async (dir) => {
    const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(dir, KEY, 4, {
      scene: { elements: [] },
      pngDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    });
    assert.ok(scenePath.endsWith("4.excalidraw"));
    assert.equal(previewPath, "");
  });
});

test("decodePngDataUrl only accepts base64 PNG data URLs", () => {
  assert.ok(decodePngDataUrl(PNG_DATA_URL) instanceof Buffer);
  assert.equal(decodePngDataUrl("data:image/jpeg;base64,abcd"), null);
  assert.equal(decodePngDataUrl("not-a-data-url"), null);
  assert.equal(decodePngDataUrl(null), null);
});
