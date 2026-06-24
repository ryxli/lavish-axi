import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

import {
  createNewOutput,
  listKnownTemplates,
  newCommand,
  resolveNewOutputPath,
  resolveTemplatePath,
} from "../src/new-command.js";

test("createNewOutput returns file, template, and next_step", () => {
  const output = createNewOutput({ file: ".lavish/firstmate.html", template: "firstmate" });
  assert.equal(output.file, ".lavish/firstmate.html");
  assert.equal(output.template, "firstmate");
  assert.match(output.next_step, /firstmate/);
  assert.match(output.next_step, /lavish-axi .lavish\/firstmate\.html/);
});

test("resolveNewOutputPath defaults to .lavish/<template>.html", () => {
  const result = resolveNewOutputPath(["--template", "firstmate"], "firstmate");
  assert.equal(result, path.join(".lavish", "firstmate.html"));
});

test("resolveNewOutputPath respects explicit output path", () => {
  const result = resolveNewOutputPath(["--template", "firstmate", "my-output.html"], "firstmate");
  assert.equal(result, "my-output.html");
});

test("resolveNewOutputPath ignores flag-like args", () => {
  const result = resolveNewOutputPath(["--template", "firstmate", "--no-open"], "firstmate");
  assert.equal(result, path.join(".lavish", "firstmate.html"));
});

test("resolveNewOutputPath picks positional arg that precedes template flag", () => {
  const result = resolveNewOutputPath(["out.html", "--template", "firstmate"], "firstmate");
  assert.equal(result, "out.html");
});

test("resolveTemplatePath resolves to the templates directory", () => {
  const p = resolveTemplatePath("firstmate");
  assert.ok(p.endsWith(path.join("templates", "firstmate.html")));
  assert.ok(existsSync(p), "firstmate.html template file must exist on disk");
});

test("listKnownTemplates includes firstmate", () => {
  const templates = listKnownTemplates();
  assert.ok(Array.isArray(templates));
  assert.ok(templates.includes("firstmate"));
});

test("newCommand writes the template file to default path", async () => {
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

test("newCommand writes the template to an explicit output path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const outputPath = "custom/output.html";
    const output = await newCommand(["--template", "firstmate", outputPath]);
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
    await newCommand(["--template", "firstmate"]);
    assert.ok(existsSync(path.join(dir, ".lavish", "firstmate.html")));
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand throws VALIDATION_ERROR when --template is missing", async () => {
  await assert.rejects(
    () => newCommand([]),
    (err) => {
      assert.ok(err instanceof AxiError);
      assert.equal(err.code, "VALIDATION_ERROR");
      assert.match(err.message, /--template is required/);
      return true;
    },
  );
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

test("firstmate template has inline CSS with no external links", async () => {
  const templatePath = fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url));
  const content = await readFile(templatePath, "utf8");
  assert.doesNotMatch(content, /https?:\/\/cdn\./i, "no CDN links");
  assert.doesNotMatch(content, /<link rel="stylesheet"/i, "no external stylesheets");
  assert.doesNotMatch(content, /<script src="https?:/i, "no external scripts");
  assert.match(content, /<style>/, "has inline style block");
});

test("firstmate template has all required components", async () => {
  const templatePath = fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url));
  const content = await readFile(templatePath, "utf8");
  assert.match(content, /class="hero"/, "hero block");
  assert.match(content, /class="verdict/, "verdict bar");
  assert.match(content, /class="card"/, "card component");
  assert.match(content, /<table/, "comparison table");
  assert.match(content, /class="form-card"/, "decision form");
  assert.match(content, /class="code-block"/, "code block");
  assert.match(content, /class="btn btn-primary"/, "primary button");
  assert.match(content, /window\.lavish/, "lavish interaction");
  assert.match(content, /data-lavish-action/, "lavish action attribute");
});

test("firstmate template has overflow guards on body", async () => {
  const templatePath = fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url));
  const content = await readFile(templatePath, "utf8");
  assert.match(content, /overflow-x: hidden/, "body overflow guard");
  assert.match(content, /overflow-x: auto/, "table overflow guard");
});

test("firstmate template has the cheatsheet comment", async () => {
  const templatePath = fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url));
  const content = await readFile(templatePath, "utf8");
  assert.match(content, /FIRSTMATE NAVAL TEMPLATE/, "cheatsheet header");
  assert.match(content, /COLOR TOKENS/, "color reference");
  assert.match(content, /LAVISH INTERACTION PATTERNS/, "interaction patterns");
  assert.match(content, /queueKey/, "queueKey dedup pattern");
});
