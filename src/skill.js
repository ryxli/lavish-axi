import { createHomeOutput } from "./cli.js";
import { PLAYBOOK_ROUTER_HELP } from "./playbooks.js";

// Trigger string agents match against to auto-load the skill.
// Keep activation explicit so ordinary complex responses stay in chat.
export const SKILL_DESCRIPTION =
  "Create a rich, reviewable HTML artifact only when the user explicitly invokes `/lavish`, names Lavish, " +
  "or asks for an HTML, interactive, annotatable, or browser-based visual artifact. Otherwise answer in plain chat.";

function skillCommandText(text) {
  return text.replaceAll("`lavish-axi", "`bunx lavish-axi");
}

function sentenceLines(text, continuation = "") {
  return text.replace(/([.!?]) (?=[A-Z])/g, `$1\n${continuation}`);
}

function skillParagraph(text) {
  return sentenceLines(skillCommandText(text));
}

function bullets(items) {
  return items.map((item) => `- ${sentenceLines(skillCommandText(item), "  ")}`).join("\n");
}

function playbookList(playbooks) {
  return playbooks.map((p) => `- \`${p.id}\` - ${p.use_when}`).join("\n");
}

/**
 * Render the installable SKILL.md for the lavish skill. The body mirrors what
 * `lavish-axi` prints with no arguments (minus live session state), while the
 * frontmatter adds discovery metadata for Agent Skills and Hermes Agent.
 *
 * @returns {string} full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown() {
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [], includeSessions: false });

  return `---
name: lavish
description: ${SKILL_DESCRIPTION}
argument-hint: <what the artifact should show>
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [html, review, artifacts, visualization]
    category: productivity
---

# Lavish Editor

${skillParagraph(home.description)}

You do not need lavish-axi installed globally.
Invoke it with \`bunx lavish-axi <html-file>\`.
Run every follow-up command with the \`bunx lavish-axi ...\` prefix.

## Request

$ARGUMENTS

If the user explicitly invoked \`/lavish\`, build an HTML artifact for \`$ARGUMENTS\` now.
If \`$ARGUMENTS\` is empty, derive the subject from the current conversation.
If this skill loaded organically, continue only when the user's request explicitly names Lavish or asks for an HTML, interactive, annotatable, or browser-based visual artifact.
Otherwise, stop and answer in plain chat.

## When to use

${skillParagraph(home.help[home.help.length - 1])}

## Workflow

1. Run \`bunx lavish-axi new --template <decision|plan|comparison|report> .lavish/<name>.html\`.
   Choose the closest fixed template, edit only the generated content slots, and remove irrelevant sections.
2. Run \`bunx lavish-axi <html-file>\` to open or resume a review session in the browser.
3. Run \`bunx lavish-axi poll <html-file>\` to long-poll for the user's annotations, queued prompts, and browser-reported \`layout_warnings\`.
   On the first poll, prefer \`--agent-reply "<one-line summary of what you built and what to review first>"\` so the conversation panel opens with context.
   The poll stays silent until the user acts or the real browser reports fresh layout warnings - leave it running, never kill it.
   If your harness limits how long a foreground command may run, run the poll as a background task.
   If it gets killed or times out anyway, just re-run it - queued feedback is never lost.
4. If poll returns \`layout_warnings\`, follow the returned \`next_step\`.
   Fix and re-check fresh error-severity findings, but proceed with a note instead of looping when every current warning is persistent or low-severity.
5. Apply human feedback, then poll again with \`--agent-reply "<message>"\` to reply in the browser and keep the loop going.
6. Run \`bunx lavish-axi end <html-file>\` when the review is finished.
7. If the user ends the session from the browser instead, \`bunx lavish-axi <html-file>\` refuses to reopen it and says so.
   Only pass \`--reopen\` when the user asks for further review or something genuinely important needs their visual attention.
   Otherwise deliver remaining updates directly in this conversation.

## Visual guidance

${bullets(home.visual_guidance)}

## Playbooks

Run \`bunx lavish-axi playbook <id>\` for focused, detailed guidance on any of these.
${sentenceLines(PLAYBOOK_ROUTER_HELP)}
For flows, architecture, state, or sequence diagrams, do not hand-build boxes-and-arrows from div/flexbox.
Open the diagram playbook and use the theme-aware Mermaid snippet from \`bunx lavish-axi design\` unless SVG is needed for richly annotated nodes.

${playbookList(home.playbooks)}

## Commands & rules

${bullets(home.help.slice(0, -1))}
`;
}
