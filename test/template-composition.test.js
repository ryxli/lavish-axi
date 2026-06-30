import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listKnownTemplates, newCommand } from "../src/new-command.js";

// Resolve templates from the built dist output.
const distTemplates = new URL("../dist/templates/", import.meta.url);
process.env.LAVISH_AXI_TEMPLATES_DIR = fileURLToPath(distTemplates);

const templatesDir = new URL("../src/templates/", import.meta.url);
const conceptsDir = new URL("../src/templates/concepts/", import.meta.url);
const sectionsDir = new URL("../src/templates/sections/", import.meta.url);

async function conceptNames() {
  return (await readdir(conceptsDir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}

test("standalone surface template is copied verbatim into dist/templates", async () => {
  const src = await readFile(new URL("surface.html", templatesDir), "utf8");
  const dist = await readFile(new URL("surface.html", distTemplates), "utf8");
  assert.equal(dist, src);
});

test("every concept composes its manifest sections, in order", async () => {
  const concepts = await conceptNames();
  assert.ok(concepts.length >= 5, "expected the concept preset library");
  for (const concept of concepts) {
    const manifest = JSON.parse(await readFile(new URL(`${concept}.json`, conceptsDir), "utf8"));
    const html = await readFile(new URL(`${concept}.html`, distTemplates), "utf8");
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
  const report = await readFile(new URL("report.html", distTemplates), "utf8");
  assert.doesNotMatch(report, /==SECTION:timeline==/, "report does not include the timeline block");
  for (const cls of [".timeline", ".callout", ".metric-grid", ".form-card", ".actions-row", ".verdict"]) {
    assert.ok(report.includes(cls), `report carries ${cls} CSS for later mutation`);
  }
});

test("newCommand scaffolds legacy concept presets when explicitly requested", async () => {
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

test("listKnownTemplates exposes surface plus the concept presets", async () => {
  const known = listKnownTemplates();
  assert.ok(known.includes("surface"), 'listKnownTemplates includes "surface"');
  for (const concept of await conceptNames()) {
    assert.ok(known.includes(concept), `listKnownTemplates includes "${concept}"`);
  }
});

test("base placeholder remains for concepts while surface is a standalone source template", async () => {
  const base = await readFile(new URL("base.html", templatesDir), "utf8");
  assert.match(base, /<!-- ==LAVISH:SECTIONS== -->/, "base has the sections placeholder");
  assert.ok(existsSync(fileURLToPath(new URL("surface.html", templatesDir))), "surface standalone source exists");
  assert.ok(
    !existsSync(fileURLToPath(new URL("firstmate.html", templatesDir))),
    "legacy concepts remain composed-only source templates",
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
