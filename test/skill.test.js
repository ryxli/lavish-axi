import assert from "node:assert/strict";
import test from "node:test";

import { createHomeOutput } from "../src/cli.js";
import { SKILL_DESCRIPTION, createSkillMarkdown } from "../src/skill.js";

function skillCommandText(text) {
  return text.replaceAll("`lavish-axi", "`bunx lavish-axi");
}

test("createSkillMarkdown emits valid frontmatter naming the lavish skill", () => {
  const md = createSkillMarkdown();
  assert.ok(md.startsWith("---\n"), "starts with frontmatter fence");
  const end = md.indexOf("\n---\n", 4);
  assert.ok(end > 0, "frontmatter is closed");
  const frontmatter = md.slice(4, end);
  assert.match(frontmatter, /^name: lavish$/m);
  assert.match(frontmatter, /^description: /m);
  assert.match(frontmatter, /^argument-hint: /m);
  assert.ok(frontmatter.includes(SKILL_DESCRIPTION), "frontmatter carries the skill description");
});

test("createSkillMarkdown emits Hermes Agent metadata in frontmatter", () => {
  const md = createSkillMarkdown();
  const frontmatter = md.slice(4, md.indexOf("\n---\n", 4));

  assert.match(frontmatter, /^author: Kun Chen \(kunchenguid\)$/m);
  assert.match(frontmatter, /^metadata:\n {2}hermes:\n {4}tags: \[[^\]]+\]\n {4}category: \S+$/m);
  assert.doesNotMatch(frontmatter, /^version:/m, "version is omitted to avoid release churn");
});

test("createSkillMarkdown preserves explicit /lavish invocation with optional arguments", () => {
  const md = createSkillMarkdown();
  const body = md.slice(md.indexOf("\n---\n", 4) + 5);

  assert.ok(body.includes("$ARGUMENTS"), "body consumes slash-command arguments");
  assert.match(body, /If `\$ARGUMENTS` is non-empty, the user explicitly invoked `\/lavish`/);
  assert.match(
    body,
    /If `\$ARGUMENTS` is empty but the user explicitly invoked `\/lavish`, derive the subject from the current conversation/,
  );
});

test("createSkillMarkdown limits activation to explicit artifact requests", () => {
  const md = createSkillMarkdown();
  const whenToUse = md.slice(md.indexOf("## When to use"), md.indexOf("## Workflow"));

  assert.match(SKILL_DESCRIPTION, /explicitly invokes `\/lavish`/);
  assert.match(SKILL_DESCRIPTION, /names Lavish/);
  assert.match(SKILL_DESCRIPTION, /HTML, interactive, annotatable, or browser-based visual artifact/);
  assert.doesNotMatch(
    SKILL_DESCRIPTION,
    /\b(?:plan|comparison|table|diagram|report|code diff|PR review|complex answer)\b/i,
  );
  assert.match(
    whenToUse,
    /A plan, comparison, table, diagram, report, code diff, PR review, or generally complex answer is not a trigger by itself/,
  );
  assert.match(whenToUse, /answer in plain chat/);
});

test("createSkillMarkdown stops organic activation without an explicit artifact request", () => {
  const md = createSkillMarkdown();
  const request = md.slice(md.indexOf("## Request"), md.indexOf("## When to use"));

  assert.match(request, /If this skill loaded organically/);
  assert.match(request, /stop and answer in plain chat/);
});

test("createSkillMarkdown mirrors the no-args home output", () => {
  const md = createSkillMarkdown();
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [], includeSessions: false });
  const normalizedMd = md.replace(/\s+/g, " ");

  assert.ok(
    normalizedMd.includes(skillCommandText(home.description).replace(/\s+/g, " ")),
    "includes the product description",
  );

  for (const item of home.visual_guidance) {
    assert.ok(md.includes(item), `includes visual guidance: ${item.slice(0, 32)}...`);
  }

  for (const playbook of home.playbooks) {
    assert.ok(md.includes(playbook.id), `includes playbook id: ${playbook.id}`);
    assert.ok(md.includes(playbook.use_when), `includes playbook use_when: ${playbook.id}`);
  }

  for (const item of home.help) {
    const skillItem = skillCommandText(item).replace(/\s+/g, " ");
    assert.ok(normalizedMd.includes(skillItem), `includes help: ${skillItem.slice(0, 32)}...`);
  }
});

test("createSkillMarkdown starts artifacts from the closest native scaffold", () => {
  const md = createSkillMarkdown();
  const workflow = md.slice(md.indexOf("## Workflow"), md.indexOf("## Visual guidance"));

  assert.match(
    workflow,
    /`bunx lavish-axi new --template <decision\|plan\|comparison\|report> \.lavish\/<name>\.html`/,
  );
  assert.match(workflow, /Choose the closest fixed template/);
  assert.match(workflow, /edit only the generated content slots/i);
  assert.match(workflow, /remove irrelevant sections/i);
});

test("createSkillMarkdown requires opening every matching playbook", () => {
  const md = createSkillMarkdown();
  const playbooksSection = md.slice(md.indexOf("## Playbooks"), md.indexOf("## Commands & rules"));

  assert.ok(playbooksSection.includes("combines several playbooks"), "explains artifacts span playbooks");
  assert.ok(playbooksSection.includes("MUST open each matching playbook"), "requires opening matching playbooks");
  assert.ok(playbooksSection.includes("do not hand-build boxes-and-arrows"), "names the diagram anti-pattern");
});

test("createSkillMarkdown does not leak live session state", () => {
  const md = createSkillMarkdown();
  assert.ok(!md.includes("pending_prompts"), "no session bookkeeping fields");
  assert.ok(!/\/session\/[0-9a-f]{8}/.test(md), "no live session URLs");
});

test("createSkillMarkdown omits setup hooks guidance", () => {
  const md = createSkillMarkdown();
  assert.doesNotMatch(md, /setup hooks/);
});

test("createSkillMarkdown standardizes every command on bunx", () => {
  const md = createSkillMarkdown();

  assert.match(md, /`bunx lavish-axi <html-file>`/);
  assert.match(md, /Run every follow-up command with the `bunx lavish-axi \.\.\.` prefix/);
  assert.doesNotMatch(md, /`npx(?: -y)? lavish-axi/);
  assert.doesNotMatch(md, /`lavish-axi(?: |`)/);
});
