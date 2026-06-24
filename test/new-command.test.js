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

test("createNewOutput returns file, template, and next_step", () => {
  const output = createNewOutput({ file: ".lavish/firstmate.html", template: "firstmate" });
  assert.equal(output.file, ".lavish/firstmate.html");
  assert.equal(output.template, "firstmate");
  assert.match(output.next_step, /firstmate/);
  assert.match(output.next_step, /lavish-axi .lavish\/firstmate\.html/);
});

test("parseNewArgs extracts template and default output path", () => {
  const result = parseNewArgs(["--template", "firstmate"]);
  assert.equal(result.template, "firstmate");
  assert.equal(result.outputPath, null);
});

test("parseNewArgs handles --template=value equals form", () => {
  const result = parseNewArgs(["--template=firstmate"]);
  assert.equal(result.template, "firstmate");
  assert.equal(result.outputPath, null);
});

test("parseNewArgs extracts explicit output path", () => {
  const result = parseNewArgs(["--template", "firstmate", "my-output.html"]);
  assert.equal(result.template, "firstmate");
  assert.equal(result.outputPath, "my-output.html");
});

test("parseNewArgs throws on unrecognized flags so their values cannot become the output path", () => {
  assert.throws(
    () => parseNewArgs(["--template", "firstmate", "--port", "4387"]),
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
  const result = parseNewArgs(["out.html", "--template", "firstmate"]);
  assert.equal(result.template, "firstmate");
  assert.equal(result.outputPath, "out.html");
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

test("newCommand refuses to overwrite an existing output file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    await newCommand(["--template", "firstmate"]);
    await assert.rejects(
      () => newCommand(["--template", "firstmate"]),
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
    await newCommand(["--template", "firstmate"]);
    // Simulate user editing the file
    await writeFile(path.join(dir, ".lavish", "firstmate.html"), "<html>edited</html>");
    await assert.rejects(
      () => newCommand(["--template", "firstmate"]),
      (err) => {
        assert.ok(err instanceof AxiError);
        assert.match(err.message, /already exists/);
        return true;
      },
    );
    // Confirm user edits are intact
    const content = await readFile(path.join(dir, ".lavish", "firstmate.html"), "utf8");
    assert.equal(content, "<html>edited</html>");
  } finally {
    process.chdir(origCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand defaults to the firstmate template when --template is omitted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const output = await newCommand([]);
    assert.equal(output.template, "firstmate");
    assert.equal(output.file, path.join(".lavish", "firstmate.html"));
    const written = await readFile(path.join(dir, ".lavish", "firstmate.html"), "utf8");
    assert.match(written, /<!doctype html>/i);
    assert.match(written, /Naval color system/);
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
    assert.equal(output.template, "firstmate");
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

test("firstmate template has inline CSS with no external links", async () => {
  const content = await readFile(fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url)), "utf8");
  assert.doesNotMatch(content, /https?:\/\/cdn\./i, "no CDN links");
  assert.doesNotMatch(content, /<link rel="stylesheet"/i, "no external stylesheets");
  assert.doesNotMatch(content, /<script src="https?:/i, "no external scripts");
  assert.match(content, /<style>/, "has inline style block");
});

test("firstmate template has all required components", async () => {
  const content = await readFile(fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url)), "utf8");
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
  const content = await readFile(fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url)), "utf8");
  assert.match(content, /overflow-x: hidden/, "body overflow guard");
  assert.match(content, /overflow-x: auto/, "table overflow guard");
});

test("firstmate template has the cheatsheet comment", async () => {
  const content = await readFile(fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url)), "utf8");
  assert.match(content, /FIRSTMATE NAVAL TEMPLATE/, "cheatsheet header");
  assert.match(content, /COLOR TOKENS/, "color reference");
  assert.match(content, /LAVISH INTERACTION PATTERNS/, "interaction patterns");
  assert.match(content, /queueKey/, "queueKey dedup pattern");
});

test("firstmate template submitDecision only shows confirmation when window.lavish exists", async () => {
  const content = await readFile(fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url)), "utf8");
  // The disable and sent-msg reveal must be inside the if (window.lavish) block,
  // not before it. Check that the disabled assignment follows the lavish check.
  const lavishCheckIndex = content.indexOf("if (window.lavish)");
  const disableIndex = content.indexOf('getElementById("submit-decision").disabled = true');
  assert.ok(lavishCheckIndex !== -1, "has window.lavish guard");
  assert.ok(disableIndex !== -1, "has button disable");
  assert.ok(disableIndex > lavishCheckIndex, "button disable is inside the window.lavish guard");
});

test("firstmate template has no em dashes", async () => {
  const content = await readFile(fileURLToPath(new URL("../src/templates/firstmate.html", import.meta.url)), "utf8");
  assert.doesNotMatch(content, /—/, "no em dashes (\\u2014)");
});
