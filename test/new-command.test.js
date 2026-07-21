import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

import { DEFAULT_TEMPLATE, contractsForEnvironment } from "../src/templates/contracts.js";
import {
  createNewOutput,
  listKnownTemplates,
  newCommand,
  parseNewArgs,
  resolveTemplatePath,
} from "../src/new-command.js";

process.env.LAVISH_AXI_TEMPLATES_DIR = fileURLToPath(new URL("../dist/templates/", import.meta.url));

const expectedTemplates = Object.keys(contractsForEnvironment(false)).sort();

test("createNewOutput orders editing guidance before the bunx open command", () => {
  const output = createNewOutput({ file: ".lavish/decision.html", template: "decision" });
  assert.equal(output.file, ".lavish/decision.html");
  assert.equal(output.template, "decision");
  assert.match(output.next_step, /decision/);

  const editIndex = output.next_step.indexOf("Edit the content placeholders");
  const removeIndex = output.next_step.indexOf("remove irrelevant sections");
  const openIndex = output.next_step.indexOf("bunx lavish-axi .lavish/decision.html");
  assert.ok(editIndex >= 0, "instructs editing generated placeholders");
  assert.ok(removeIndex > editIndex, "removes irrelevant sections after editing");
  assert.ok(openIndex > removeIndex, "opens with bunx only after content editing");
  assert.doesNotMatch(output.next_step, /`lavish-axi /);
});

test("parseNewArgs supports value and equals forms", () => {
  assert.deepEqual(parseNewArgs(["--template", "decision"]), { template: "decision", outputPath: null });
  assert.deepEqual(parseNewArgs(["--template=report", "out.html"]), { template: "report", outputPath: "out.html" });
  assert.deepEqual(parseNewArgs(["out.html", "--template", "plan"]), { template: "plan", outputPath: "out.html" });
});

test("parseNewArgs rejects unknown flags", () => {
  assert.throws(
    () => parseNewArgs(["--port", "4387"]),
    (error) => error instanceof AxiError && error.code === "VALIDATION_ERROR" && /--port/.test(error.message),
  );
});

test("listKnownTemplates exposes only the fixed default contracts", () => {
  assert.deepEqual(listKnownTemplates(), expectedTemplates);
  assert.equal(DEFAULT_TEMPLATE, "decision");
});

test("resolveTemplatePath resolves a contract template", () => {
  const resolved = resolveTemplatePath("decision");
  assert.ok(resolved.endsWith(path.join("templates", "decision.html")));
  assert.ok(existsSync(resolved));
});

for (const template of expectedTemplates) {
  test(`newCommand writes the ${template} skeleton`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      const output = await newCommand(["--template", template]);
      assert.equal(output.template, template);
      const content = await readFile(path.join(dir, ".lavish", `${template}.html`), "utf8");
      assert.match(content, /<!doctype html>/i);
      assert.match(content, /Canonical Lavish brand foundation/);
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("newCommand defaults to decision", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    const output = await newCommand([]);
    assert.equal(output.template, "decision");
    assert.equal(output.file, path.join(".lavish", "decision.html"));
    assert.ok(existsSync(path.join(dir, ".lavish", "decision.html")));
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand accepts an explicit output path and protects edits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-test-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    await newCommand(["--template=report", "custom/output.html"]);
    const outputFile = path.join(dir, "custom/output.html");
    assert.ok(existsSync(outputFile));
    await writeFile(outputFile, "<html>edited</html>");
    await assert.rejects(
      () => newCommand(["--template", "report", "custom/output.html"]),
      (error) => error instanceof AxiError && /already exists/.test(error.message),
    );
    assert.equal(await readFile(outputFile, "utf8"), "<html>edited</html>");
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("newCommand rejects unconstrained templates", async () => {
  await assert.rejects(
    () => newCommand(["--template", "surface"]),
    (error) => error instanceof AxiError && error.code === "VALIDATION_ERROR" && /Unknown template/.test(error.message),
  );
});
