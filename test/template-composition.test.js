import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_TEMPLATE,
  TEMPLATE_CONTRACTS,
  TEMPLATE_METADATA,
  contractsForEnvironment,
} from "../src/templates/contracts.js";
import { listKnownTemplates } from "../src/new-command.js";

const distTemplates = new URL("../dist/templates/", import.meta.url);
process.env.LAVISH_AXI_TEMPLATES_DIR = fileURLToPath(distTemplates);
const sectionsDir = new URL("../src/templates/sections/", import.meta.url);

for (const [concept, sections] of Object.entries(TEMPLATE_CONTRACTS)) {
  test(`${concept} composes its exact contract order`, async () => {
    const manifest = JSON.parse(
      await readFile(new URL(`../src/templates/concepts/${concept}.json`, import.meta.url), "utf8"),
    );
    assert.deepEqual(manifest.sections, sections);
    assert.deepEqual({ title: manifest.title, treatment: manifest.treatment }, TEMPLATE_METADATA[concept]);
    const html = await readFile(new URL(`${concept}.html`, distTemplates), "utf8");
    assert.equal((html.match(/<!-- ==SECTION:[^=]+==/g) || []).length, sections.length);
    let cursor = 0;
    for (const section of sections) {
      const marker = `==SECTION:${section}==`;
      const index = html.indexOf(marker, cursor);
      assert.ok(index >= 0, `${concept}: ${section} is present in order`);
      cursor = index + marker.length;
    }
    assert.match(html, new RegExp(`<body[^>]*data-treatment="${manifest.treatment}"`));
  });
}

test("the default and available templates are fixed contracts", () => {
  assert.equal(DEFAULT_TEMPLATE, "decision");
  assert.deepEqual(listKnownTemplates(), Object.keys(contractsForEnvironment(false)).sort());
  assert.equal(existsSync(fileURLToPath(new URL("../dist/templates/surface.html", import.meta.url))), false);
  assert.equal(existsSync(fileURLToPath(new URL("../dist/templates/firstmate.html", import.meta.url))), false);
});

test("base and every section partial have exact structural markers", async () => {
  const base = await readFile(new URL("../src/templates/base.html", import.meta.url), "utf8");
  assert.equal((base.match(/<!-- ==LAVISH:SECTIONS== -->/g) || []).length, 1);
  const files = (await readdir(sectionsDir)).filter((file) => file.endsWith(".html"));
  for (const file of files) {
    const name = file.slice(0, -5);
    const html = await readFile(new URL(file, sectionsDir), "utf8");
    assert.equal((html.match(new RegExp(`<!-- ==SECTION:${name}==`, "g")) || []).length, 1);
    assert.equal((html.match(new RegExp(`<!-- ==/SECTION:${name}== -->`, "g")) || []).length, 1);
  }
});
