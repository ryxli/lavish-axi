import { POLL_SEND_AND_END_RULE, POLL_WAKE_PATH_RULES, createHomeOutput } from "./cli.js";
import { PLAYBOOK_ROUTER_HELP } from "./playbooks.js";

// Trigger string agents match against to auto-load the skill.
// Keep activation explicit so ordinary complex responses stay in chat.
export const SKILL_DESCRIPTION =
  "Create a rich, reviewable HTML artifact only when the user explicitly invokes `/lavish`, explicitly asks to use Lavish, " +
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
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [], includeSessions: false, agent: "static" });

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

Install the lavish-axi CLI globally from the standalone ryxli/lavish-axi checkout before using this skill.
Invoke it with \`bunx lavish-axi <html-file>\`.
Run every follow-up command with the \`bunx lavish-axi ...\` prefix.

## Request

$ARGUMENTS

If \`$ARGUMENTS\` is non-empty, the user explicitly invoked \`/lavish\`.
Build an HTML artifact for that request now.
If \`$ARGUMENTS\` is empty but the user explicitly invoked \`/lavish\`, derive the subject from the current conversation.
If this skill loaded organically, continue only when the user's request explicitly asks to use Lavish or asks for an HTML, interactive, annotatable, or browser-based visual artifact.
Otherwise, stop and answer in plain chat.

## When to use

${skillParagraph(home.help[home.help.length - 1])}

## Workflow

1. Run \`bunx lavish-axi new --template <decision|plan|comparison|report> .lavish/<name>.html\`.
   Choose the closest fixed template, edit only the generated content slots, and remove irrelevant sections.
2. Run \`bunx lavish-axi <html-file>\` to open or resume a review session in the browser.
3. Run \`bunx lavish-axi poll <html-file>\` to long-poll for the user's annotations, queued prompts, and browser-proven severe layout failures returned as \`layout_warnings\`.
   On the first poll, prefer \`--agent-reply "<one-line summary of what you built and what to review first>"\` so the conversation panel opens with context.
   The poll stays silent until the user acts or the real browser proves meaningful content is inaccessible or unusable - leave it running, never kill it.
   Cosmetic, intentional, transient, tiny, and uncertain observations remain silent.
${POLL_WAKE_PATH_RULES.map((rule) => `   ${skillCommandText(rule)}`).join("\n")}
4. If poll returns \`layout_warnings\`, follow the returned \`next_step\`: repair and re-check fresh severe failures before involving the human; if every current warning is persistent or low-severity, proceed with a note instead of looping.
5. Apply human feedback, then poll again with \`--agent-reply "<message>"\` to reply in the browser and keep the loop going under the same foreground-or-verified-wake-path rule.
6. Run \`bunx lavish-axi end <html-file>\` when the review is finished.
7. ${POLL_SEND_AND_END_RULE} Deliver any remaining updates directly in this conversation.

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
