import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/session-store.js";

async function createStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<h1>Hello</h1>");
  const store = new SessionStore(path.join(dir, "state.json"));
  const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
  return { dir, store, session };
}

async function closeStore(dir) {
  await rm(dir, { recursive: true, force: true });
}

test("queue keys replace structured answers and lease without destructive reads", async () => {
  const { dir, store, session } = await createStore();
  try {
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ prompt: "Use blue", tag: "decision", queue_key: "question:theme" }],
    });
    await store.queuePrompts(session.key, {
      prompts: [{ prompt: "Use brass", tag: "decision", queue_key: "question:theme" }],
    });
    const first = await store.leaseFeedback(session.key, 1_000);
    assert.equal(first.status, "feedback");
    assert.equal(first.attempt, 1);
    assert.equal(first.prompts.length, 1);
    assert.equal(first.prompts[0].prompt, "Use brass");
    assert.equal(first.prompts[0].queue_key, undefined);
    const second = await store.leaseFeedback(session.key, 1_001);
    assert.deepEqual(second, { status: "waiting" });
  } finally {
    await closeStore(dir);
  }
});

test("ack is idempotent and clears the delivered payload", async () => {
  const { dir, store, session } = await createStore();
  try {
    await store.queuePrompts(session.key, { prompts: [{ prompt: "Fix it", tag: "message" }] });
    const delivery = await store.leaseFeedback(session.key, 10_000);
    const ack = await store.ackFeedback(session.key, delivery.delivery_id, 10_001);
    assert.equal(ack.status, "acked");
    assert.equal((await store.ackFeedback(session.key, delivery.delivery_id, 10_002)).idempotent, true);
    assert.equal((await store.leaseFeedback(session.key, 10_003)).status, "waiting");
    const persisted = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(persisted.sessions[session.key].feedback_delivery.state, "acked");
    assert.deepEqual(persisted.sessions[session.key].prompts, []);
  } finally {
    await closeStore(dir);
  }
});

test("one lease expiry retries once, then exhausts without redelivery", async () => {
  const { dir, store, session } = await createStore();
  try {
    await store.queuePrompts(session.key, { prompts: [{ prompt: "Do not lose this", tag: "message" }] });
    const first = await store.leaseFeedback(session.key, 100_000);
    const waiting = await store.leaseFeedback(session.key, 159_999);
    assert.equal(waiting.status, "waiting");
    const retry = await store.leaseFeedback(session.key, 160_000);
    assert.equal(retry.delivery_id, first.delivery_id);
    assert.equal(retry.attempt, 2);
    const exhausted = await store.leaseFeedback(session.key, 220_000);
    assert.equal(exhausted.status, "delivery_exhausted");
    assert.equal((await store.leaseFeedback(session.key, 999_999)).status, "delivery_exhausted");
    const recovered = await store.retryFeedback(session.key, first.delivery_id, 1_000_000);
    assert.equal(recovered.status, "pending");
    assert.equal((await store.leaseFeedback(session.key, 1_000_001)).attempt, 1);
  } finally {
    await closeStore(dir);
  }
});

test("new feedback creates a new generation after exhaustion", async () => {
  const { dir, store, session } = await createStore();
  try {
    await store.queuePrompts(session.key, { prompts: [{ prompt: "Initial", tag: "message" }] });
    const first = await store.leaseFeedback(session.key, 1);
    await store.leaseFeedback(session.key, 60_001);
    await store.leaseFeedback(session.key, 120_001);
    const exhausted = await store.leaseFeedback(session.key, 180_001);
    assert.equal(exhausted.status, "delivery_exhausted");
    await store.queuePrompts(session.key, { prompts: [{ prompt: "Replacement", tag: "message", queue_key: "new" }] });
    const next = await store.leaseFeedback(session.key, 180_002);
    assert.equal(next.status, "feedback");
    assert.notEqual(next.delivery_id, first.delivery_id);
    assert.equal(next.prompts.at(-1).prompt, "Replacement");
  } finally {
    await closeStore(dir);
  }
});

test("ended sessions retain the final envelope until ACK", async () => {
  const { dir, store, session } = await createStore();
  try {
    await store.queuePrompts(session.key, { prompts: [{ prompt: "Final note", tag: "message" }], endSession: true });
    const delivery = await store.leaseFeedback(session.key, 5);
    assert.equal(delivery.session_ended, true);
    assert.equal(delivery.ended_by, "user");
    await store.ackFeedback(session.key, delivery.delivery_id, 6);
    assert.equal((await store.leaseFeedback(session.key, 7)).status, "ended");
  } finally {
    await closeStore(dir);
  }
});

test("layout warnings become a durable delivery and repeat findings become persistent", async () => {
  const { dir, store, session } = await createStore();
  try {
    const warning = {
      selector: "html",
      kind: "page-horizontal-overflow",
      overflowPx: 24,
      viewportWidth: 720,
      severity: "error",
    };
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    const first = await store.leaseFeedback(session.key, 1);
    assert.equal(first.layout_warnings[0].persistent, false);
    await store.ackFeedback(session.key, first.delivery_id, 2);
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    const repeat = await store.leaseFeedback(session.key, 3);
    assert.equal(repeat.layout_warnings[0].persistent, true);
  } finally {
    await closeStore(dir);
  }
});

test("new sessions begin with one empty birth revision", async () => {
  const { dir, session } = await createStore();
  try {
    assert.equal(session.revision, 1);
    assert.deepEqual(session.revisions, [
      {
        rev: 1,
        created_at: session.revisions[0].created_at,
        content_hash: "",
        prior_rev: null,
        ideal: "",
        delta: "",
      },
    ]);
    assert.deepEqual(session.changelog, []);
    assert.deepEqual(session.evolution, {
      current_rev: 1,
      initial_rev: 1,
      anchor_ideal: "",
      status: "evolving",
    });
  } finally {
    await closeStore(dir);
  }
});

test("first snapshot fills birth revision, deduplicates hashes, and chains new revisions", async () => {
  const { dir, store, session } = await createStore();
  try {
    const first = await store.snapshotRevision(session.key, {
      content_hash: "hash-a",
      ideal: "quiet",
      delta: "initial render",
    });
    assert.equal(first.rev, 1);
    assert.equal(first.unchanged, false);
    let current = await store.findByKey(session.key);
    assert.equal(current.revisions.length, 1);
    assert.deepEqual(current.revisions[0], {
      rev: 1,
      created_at: current.revisions[0].created_at,
      content_hash: "hash-a",
      prior_rev: null,
      ideal: "quiet",
      delta: "initial render",
    });
    assert.deepEqual(current.changelog, []);

    const duplicate = await store.snapshotRevision(session.key, {
      content_hash: "hash-a",
      ideal: "changed but ignored",
      delta: "ignored",
    });
    assert.deepEqual(duplicate, {
      rev: 1,
      created_at: current.revisions[0].created_at,
      unchanged: true,
    });
    current = await store.findByKey(session.key);
    assert.equal(current.revisions.length, 1);
    assert.equal(current.revisions[0].ideal, "quiet");

    const second = await store.snapshotRevision(session.key, {
      content_hash: "hash-b",
      ideal: "focused",
      delta: "new render",
    });
    assert.equal(second.rev, 2);
    assert.equal(second.unchanged, false);
    current = await store.findByKey(session.key);
    assert.equal(current.revision, 2);
    assert.equal(current.evolution.current_rev, 2);
    assert.deepEqual(current.revisions[1], {
      rev: 2,
      created_at: current.revisions[1].created_at,
      content_hash: "hash-b",
      prior_rev: 1,
      ideal: "focused",
      delta: "new render",
    });
    assert.deepEqual(
      current.changelog.map(({ kind, rev, summary }) => ({ kind, rev, summary })),
      [{ kind: "render", rev: 2, summary: "rev 2" }],
    );
  } finally {
    await closeStore(dir);
  }
});

test("ideal, feedback, changed layout warnings, and agent replies append evolution events", async () => {
  const { dir, store, session } = await createStore();
  try {
    await store.setIdeal(session.key, "Make it calm");
    await store.queuePrompts(session.key, {
      prompts: [{ prompt: "Use less contrast", tag: "message" }],
    });
    const warning = { selector: "html", kind: "overflow", overflowPx: 4, viewportWidth: 720 };
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    await store.addAgentReply(session.key, "Applied the contrast change.");
    const current = await store.findByKey(session.key);
    assert.deepEqual(
      current.changelog.map(({ kind, rev, summary }) => ({ kind, rev, summary })),
      [
        { kind: "ideal_set", rev: 1, summary: "Make it calm" },
        { kind: "feedback", rev: 1, summary: "1 prompt(s)" },
        { kind: "layout_fix", rev: 1, summary: "1 warning(s)" },
        { kind: "agent_reply", rev: 1, summary: "Applied the contrast change." },
      ],
    );
  } finally {
    await closeStore(dir);
  }
});

test("state reads lazily normalize legacy sessions without dropping current fields", async () => {
  const { dir, store, session } = await createStore();
  try {
    const stateFile = path.join(dir, "state.json");
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    const legacySession = persisted.sessions[session.key];
    delete legacySession.revision;
    delete legacySession.revisions;
    delete legacySession.changelog;
    delete legacySession.evolution;
    legacySession.prompts = [{ uid: "p1", prompt: "Keep this", tag: "message" }];
    legacySession.chat = [{ role: "user", text: "Keep chat", at: "2026-01-01T00:00:00.000Z" }];
    legacySession.layout_warnings = [{ selector: "body", kind: "overflow" }];
    legacySession.feedback_delivery = {
      id: "delivery-1",
      state: "pending",
      payload: { prompts: legacySession.prompts, layout_warnings: [], dom_snapshot: "snapshot" },
    };
    await writeFile(stateFile, `${JSON.stringify(persisted)}\n`);

    const loaded = await store.findByKey(session.key);
    assert.deepEqual(loaded.prompts, legacySession.prompts);
    assert.deepEqual(loaded.chat, legacySession.chat);
    assert.deepEqual(loaded.layout_warnings, legacySession.layout_warnings);
    assert.deepEqual(loaded.feedback_delivery, legacySession.feedback_delivery);
    assert.equal(loaded.revision, 1);
    assert.equal(loaded.revisions.length, 1);
    assert.equal(loaded.revisions[0].content_hash, "");
    assert.deepEqual(loaded.evolution, {
      current_rev: 1,
      initial_rev: 1,
      anchor_ideal: "",
      status: "evolving",
    });
  } finally {
    await closeStore(dir);
  }
});
