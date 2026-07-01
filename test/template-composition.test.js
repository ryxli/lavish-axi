import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listKnownTemplates, newCommand } from "../src/new-command.js";

// Resolve templates from the composed dist output (built before `node --test`).
const distTemplates = new URL("../dist/templates/", import.meta.url);
process.env.LAVISH_AXI_TEMPLATES_DIR = fileURLToPath(distTemplates);

const conceptsDir = new URL("../src/templates/concepts/", import.meta.url);
const sectionsDir = new URL("../src/templates/sections/", import.meta.url);

async function conceptNames() {
  return (await readdir(conceptsDir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}

test("every concept composes its manifest sections, in order", async () => {
  const concepts = await conceptNames();
  assert.ok(concepts.length >= 5, "expected the concept preset library");
  for (const concept of concepts) {
    const manifest = JSON.parse(await readFile(new URL(`${concept}.json`, conceptsDir), "utf8"));
    const html = await readFile(new URL(`${concept}.html`, distTemplates), "utf8");
    assert.match(
      html,
      new RegExp(`<body[^>]*data-treatment="${manifest.treatment}"`),
      `${concept}: rendered body carries manifest treatment`,
    );
    let cursor = 0;
    for (const name of manifest.sections) {
      const marker = `==SECTION:${name}==`;
      const idx = html.indexOf(marker, cursor);
      assert.ok(idx !== -1, `${concept}: section "${name}" present and in manifest order`);
      cursor = idx + marker.length;
    }
  }
});

test("composed templates embed every section's CSS so any block can be pasted in later", async () => {
  // report omits timeline/callout/decision-form/actions sections, but a mutating
  // agent must be able to paste any of them in, so their CSS must still ship.
  const report = await readFile(new URL("report.html", distTemplates), "utf8");
  assert.doesNotMatch(report, /==SECTION:timeline==/, "report does not include the timeline block");
  for (const cls of [".timeline", ".callout", ".metric-grid", ".form-card", ".actions-row", ".verdict"]) {
    assert.ok(report.includes(cls), `report carries ${cls} CSS for later mutation`);
  }
});

test("newCommand scaffolds each concept preset", async () => {
  for (const concept of ["firstmate", "plan", "comparison", "report", "decision"]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-concept-"));
    const origCwd = process.cwd();
    try {
      process.chdir(dir);
      const output = await newCommand(["--template", concept]);
      assert.equal(output.template, concept);
      assert.ok(existsSync(path.join(dir, ".lavish", `${concept}.html`)), `${concept} scaffolded`);
    } finally {
      process.chdir(origCwd);
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("listKnownTemplates exposes the concept presets", async () => {
  const known = listKnownTemplates();
  for (const concept of await conceptNames()) {
    assert.ok(known.includes(concept), `listKnownTemplates includes "${concept}"`);
  }
});

test("base.html exposes the sections placeholder and the monolithic template is gone", async () => {
  const base = await readFile(new URL("../src/templates/base.html", import.meta.url), "utf8");
  assert.match(base, /<!-- ==LAVISH:SECTIONS== -->/, "base has the sections placeholder");
  assert.ok(
    !existsSync(fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url))),
    "no monolithic source template remains",
  );
});

test("every section partial is wrapped in matching open/close markers", async () => {
  const files = (await readdir(sectionsDir)).filter((f) => f.endsWith(".html"));
  assert.ok(files.length >= 10, "expected the full section catalog");
  for (const file of files) {
    const name = file.slice(0, -5);
    const html = await readFile(new URL(file, sectionsDir), "utf8");
    assert.match(html, new RegExp(`==SECTION:${name}==`), `${file} has an open marker`);
    assert.match(html, new RegExp(`==/SECTION:${name}==`), `${file} has a close marker`);
  }
});
