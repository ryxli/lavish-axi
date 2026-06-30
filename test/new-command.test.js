import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

import {
  createNewOutput,
  listKnownTemplates,
  newCommand,
  parseNewArgs,
  resolveTemplatePath,
} from "../src/new-command.js";

// new-command resolves templates from LAVISH_AXI_TEMPLATES_DIR when set; point it
// at dist/templates so these tests validate the real built output.
process.env.LAVISH_AXI_TEMPLATES_DIR = fileURLToPath(new URL("../dist/templates/", import.meta.url));

const surfaceTemplatePath = fileURLToPath(new URL("../dist/templates/surface.html", import.meta.url));
const firstmateTemplatePath = fileURLToPath(new URL("../dist/templates/firstmate.html", import.meta.url));

test("createNewOutput returns file, template, and next_step", () => {
  const output = createNewOutput({ file: ".lavish/surface.html", template: "surface" });
  assert.equal(output.file, ".lavish/surface.html");
  assert.equal(output.template, "surface");
  assert.match(output.next_step, /surface/);
  assert.match(output.next_step, /lavish-axi .lavish\/surface\.html/);
});

test("parseNewArgs extracts template and default output path", () => {
  const result = parseNewArgs(["--template", "surface"]);
  assert.equal(result.template, "surface");
  assert.equal(result.outputPath, null);
});

test("parseNewArgs handles --template=value equals form", () => {
  const result = parseNewArgs(["--template=surface"]);
  assert.equal(result.template, "surface");
  assert.equal(result.outputPath, null);
});

test("parseNewArgs extracts explicit output path", () => {
  const result = parseNewArgs(["--template", "surface", "my-output.html"]);
  assert.equal(result.template, "surface");
  assert.equal(result.outputPath, "my-output.html");
});

test("parseNewArgs throws on unrecognized flags so their values cannot become the output path", () => {
  assert.throws(
    () => parseNewArgs(["--template", "surface", "--port", "4387"]),
    (err) => {
      assert.ok(err instanceof AxiError);
      assert.equal(err.code, "VALIDATION_ERROR");
      assert.match(err.message, /Unknown flag/);
      assert.match(err.message, /--port/);
      return true;
    },
  );
});

test("parseNewArgs picks positional arg before --template flag", () => {
  const result = parseNewArgs(["out.html", "--template", "surface"]);
  assert.equal(result.template, "surface");
  assert.equal(result.outputPath, "out.html");
});

test("resolveTemplatePath resolves to the templates directory", () => {
  const p = resolveTemplatePath("surface");
  assert.ok(p.endsWith(path.join("templates", "surface.html")));
  assert.ok(existsSync(p), "surface.html template file must exist on disk");
});

test("listKnownTemplates includes surface and legacy presets", () => {
  const templates = listKnownTemplates();
  assert.ok(Array.isArray(templates));
  assert.ok(templates.includes("surface"));
  assert.ok(templates.includes("firstmate"));
});

test("newCommand writes the requested legacy template to its default output path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const output = await newCommand(["--template", "firstmate"]);
    const expectedPath = path.join(".lavish", "firstmate.html");
    assert.equal(output.file, expectedPath);
    assert.equal(output.template, "firstmate");
    const written = await readFile(path.join(dir, expectedPath), "utf8");
    assert.match(written, /<!doctype html>/i);
    assert.match(written, /Naval color system/);
    assert.match(written, /window\.lavish/);
    assert.match(written, /--c-ground/);
    assert.match(written, /overflow-x: hidden/);
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand accepts --template=value equals form", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const output = await newCommand(["--template=firstmate"]);
    assert.equal(output.template, "firstmate");
    assert.ok(existsSync(path.join(dir, ".lavish", "firstmate.html")));
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand writes the template to an explicit output path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const outputPath = "custom/output.html";
    const output = await newCommand(["--template", "surface", outputPath]);
    assert.equal(output.file, outputPath);
    const written = await readFile(path.join(dir, outputPath), "utf8");
    assert.match(written, /<!doctype html>/i);
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand creates the .lavish directory if it does not exist", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.ok(!existsSync(path.join(dir, ".lavish")), "pre-condition: no .lavish dir");
    await newCommand([]);
    assert.ok(existsSync(path.join(dir, ".lavish", "surface.html")));
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand refuses to overwrite an existing output file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    await newCommand([]);
    await assert.rejects(
      () => newCommand([]),
      (err) => {
        assert.ok(err instanceof AxiError);
        assert.equal(err.code, "VALIDATION_ERROR");
        assert.match(err.message, /already exists/);
        return true;
      },
    );
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand refuses to overwrite a user-edited output file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    await newCommand([]);
    await writeFile(path.join(dir, ".lavish", "surface.html"), "<html>edited</html>");
    await assert.rejects(
      () => newCommand([]),
      (err) => {
        assert.ok(err instanceof AxiError);
        assert.match(err.message, /already exists/);
        return true;
      },
    );
    const content = await readFile(path.join(dir, ".lavish", "surface.html"), "utf8");
    assert.equal(content, "<html>edited</html>");
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand defaults to the surface template when --template is omitted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const output = await newCommand([]);
    assert.equal(output.template, "surface");
    assert.equal(output.file, path.join(".lavish", "surface.html"));
    const written = await readFile(path.join(dir, ".lavish", "surface.html"), "utf8");
    assert.match(written, /<!doctype html>/i);
    assert.match(written, /terminal-native, review-first/);
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand defaults the template for a positional-only output path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const output = await newCommand(["review.html"]);
    assert.equal(output.template, "surface");
    assert.equal(output.file, "review.html");
    assert.ok(existsSync(path.join(dir, "review.html")));
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand throws VALIDATION_ERROR for unknown template", async () => {
  await assert.rejects(
    () => newCommand(["--template", "unknown-template"]),
    (err) => {
      assert.ok(err instanceof AxiError);
      assert.equal(err.code, "VALIDATION_ERROR");
      assert.match(err.message, /Unknown template/);
      assert.match(err.message, /unknown-template/);
      return true;
    },
  );
});

test("surface template has inline CSS with no external links", async () => {
  const content = await readFile(surfaceTemplatePath, "utf8");
  assert.doesNotMatch(content, /https?:\/\/cdn\./i, "no CDN links");
  assert.doesNotMatch(content, /<link rel="stylesheet"/i, "no external stylesheets");
  assert.doesNotMatch(content, /<script src="https?:/i, "no external scripts");
  assert.match(content, /<style>/, "has inline style block");
});

test("surface template has the new review-surface anatomy", async () => {
  const content = await readFile(surfaceTemplatePath, "utf8");
  assert.match(content, /class="prompt-rail"/, "prompt rail");
  assert.match(content, /class="track"/, "evidence track");
  assert.match(content, /class="metrics"/, "micro-metric strip");
  assert.match(content, /class="anatomy"/, "anatomy band");
  assert.match(content, /class="state-rail"/, "live-state rail");
  assert.match(content, /<textarea[^>]*name="note"/, "freeform reply");
  assert.match(content, /<form class="decision-pane"/, "structured decision form");
  assert.match(content, /window\.lavish/, "lavish interaction");
  assert.doesNotMatch(content, /data-lavish-action/, "no custom action-button bias");
});

test("surface template has overflow guards for the page and evidence track", async () => {
  const content = await readFile(surfaceTemplatePath, "utf8");
  assert.match(content, /overflow-x: hidden/, "body overflow guard");
  assert.match(content, /overflow-x: auto/, "track overflow guard");
});

test("surface template carries an inline edit guide", async () => {
  const content = await readFile(surfaceTemplatePath, "utf8");
  assert.match(content, /SURFACE TEMPLATE - QUICK EDIT GUIDE/, "guide header");
  assert.match(content, /DEFAULT SHAPE:/, "shape reference");
  assert.match(content, /SEND PATTERNS:/, "interaction guide");
  assert.match(content, /surface-note/, "queueKey example");
});

test("surface template keeps queueing behind the window.lavish guard", async () => {
  const content = await readFile(surfaceTemplatePath, "utf8");
  const guardIndex = content.indexOf("if (!window.lavish)");
  const queueIndex = content.indexOf("window.lavish.queuePrompt");
  const sendIndex = content.indexOf("window.lavish.sendQueuedPrompts");
  assert.ok(guardIndex !== -1, "has window.lavish guard");
  assert.ok(queueIndex !== -1, "has queuePrompt call");
  assert.ok(sendIndex !== -1, "has sendQueuedPrompts call");
  assert.ok(queueIndex > guardIndex, "queueing happens after the guard");
  assert.ok(sendIndex > queueIndex, "queued prompts are sent after queueing");
});

test("surface template has no em dashes", async () => {
  const content = await readFile(surfaceTemplatePath, "utf8");
  assert.doesNotMatch(content, /—/, "no em dashes (\\u2014)");
});

test("legacy firstmate template still exists as an opt-in path", async () => {
  const content = await readFile(firstmateTemplatePath, "utf8");
  assert.match(content, /FIRSTMATE NAVAL TEMPLATE/, "legacy concept scaffold still built");
});
