---
name: lavish
description: Create a rich, reviewable HTML artifact only when the user explicitly invokes `/lavish`, names Lavish, or asks for an HTML, interactive, annotatable, or browser-based visual artifact. Otherwise answer in plain chat.
argument-hint: <what the artifact should show>
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [html, review, artifacts, visualization]
    category: productivity
---

# Lavish Editor

Lavish Editor turns explicitly requested rich HTML artifacts into collaborative human review surfaces.
Use it only when the user invokes `/lavish`, names Lavish, or asks for an HTML, interactive, annotatable, or browser-based visual artifact.
Otherwise answer in plain chat.
Generate the requested artifact, then run `bunx lavish-axi <html-file>` so the user can visually review it, annotate elements or selected text, queue prompts, and send feedback back through `bunx lavish-axi poll`.

You do not need lavish-axi installed globally.
Invoke it with `bunx lavish-axi <html-file>`.
Run every follow-up command with the `bunx lavish-axi ...` prefix.

## Request

$ARGUMENTS

If the user explicitly invoked `/lavish`, build an HTML artifact for `$ARGUMENTS` now.
If `$ARGUMENTS` is empty, derive the subject from the current conversation.
If this skill loaded organically, continue only when the user's request explicitly names Lavish or asks for an HTML, interactive, annotatable, or browser-based visual artifact.
Otherwise, stop and answer in plain chat.

## When to use

Use Lavish only when the user explicitly invokes `/lavish`, names Lavish, or asks for an HTML, interactive, annotatable, or browser-based visual artifact.
A plan, comparison, table, diagram, report, code diff, PR review, or generally complex answer is not a trigger by itself.
Otherwise answer in plain chat.

## Workflow

1. Run `bunx lavish-axi new --template <decision|plan|comparison|report> .lavish/<name>.html`.
   Choose the closest fixed template, edit only the generated content slots, and remove irrelevant sections.
2. Run `bunx lavish-axi <html-file>` to open or resume a review session in the browser.
3. Run `bunx lavish-axi poll <html-file>` to long-poll for the user's annotations, queued prompts, and browser-reported `layout_warnings`.
   On the first poll, prefer `--agent-reply "<one-line summary of what you built and what to review first>"` so the conversation panel opens with context.
   The poll stays silent until the user acts or the real browser reports fresh layout warnings - leave it running, never kill it.
   If your harness limits how long a foreground command may run, run the poll as a background task.
   If it gets killed or times out anyway, just re-run it - queued feedback is never lost.
4. If poll returns `layout_warnings`, follow the returned `next_step`.
   Fix and re-check fresh error-severity findings, but proceed with a note instead of looping when every current warning is persistent or low-severity.
5. Apply human feedback, then poll again with `--agent-reply "<message>"` to reply in the browser and keep the loop going.
6. Run `bunx lavish-axi end <html-file>` when the review is finished.
7. If the user ends the session from the browser instead, `bunx lavish-axi <html-file>` refuses to reopen it and says so.
   Only pass `--reopen` when the user asks for further review or something genuinely important needs their visual attention.
   Otherwise deliver remaining updates directly in this conversation.

## Visual guidance

- Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance
- Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose
- Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view
- Prevent horizontal overflow at every nesting level: nested grid/flex children also need minmax(0, 1fr) tracks and min-width: 0, especially when badges, labels, or status text use wide pixel or monospace fonts; wrap, truncate, or contain long unbreakable text deliberately
- When the artifact would describe existing or current UI or state, show it instead: capture screenshots of the real pages (run the app read-only if needed) and embed them, rather than explaining the current look in prose; reserve prose for what cannot be shown such as rationale, trade-offs, and open questions

## Playbooks

Run `bunx lavish-axi playbook <id>` for focused, detailed guidance on any of these.
One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
For flows, architecture, state, or sequence diagrams, do not hand-build boxes-and-arrows from div/flexbox.
Open the diagram playbook and use the theme-aware Mermaid snippet from `bunx lavish-axi design` unless SVG is needed for richly annotated nodes.

- `diagram` - Map relationships, flows, state, and architecture
- `table` - Turn dense records into scan-friendly review surfaces
- `comparison` - Show options, tradeoffs, and current vs target behavior
- `plan` - Explain a product or technical plan before implementation
- `code` - Render source code, code files, patches, PR diffs, and before/after code inside Lavish artifacts
- `input` - Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact
- `slides` - Create a deliberate presentation when slides are requested

## Commands & rules

- Run `bunx lavish-axi <html-file>` to open or resume a Lavish Editor session.
  If the user explicitly ended the session from the browser, this refuses to reopen it and explains why instead of reopening uninvited - pass `--reopen` only when the user asks for further review or something important needs their visual attention
- Unless the user specifies another location, create HTML artifacts in the current working directory under `.lavish/`
- Lavish serves the html file through a local express.js server.
  If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory.
  Never prepend `/` to those asset paths - root paths won't work
- Run `bunx lavish-axi poll <html-file>` to wait for user feedback or browser-reported layout_warnings.
  It long-polls and stays silent until the user sends feedback, ends the session, or the real browser reports fresh layout_warnings, so leave it running - never kill it.
  Fix and re-check fresh error-severity layout_warnings before involving the human; if the poll says every current warning is persistent or low-severity, proceed with a note instead of looping.
  If your harness limits how long a foreground command may run, run the poll as a background task; if it gets killed or times out anyway, just re-run it - queued feedback is never lost.
  When it reports the session ended, stop polling and do not reopen it uninvited - deliver remaining updates in this conversation instead
- Rendered Mermaid diagrams in `.mermaid` containers become embedded, editable Excalidraw whiteboards in the browser (click a diagram to unlock editing; a Fullscreen action opens it over the whole viewport) - flowchart, sequence, class, ER, and state diagrams convert to editable shapes; other types embed as an image to draw on.
  Scenes autosave locally; when a reload detects a changed Mermaid source, the reviewer explicitly chooses to re-convert and discard saved edits or keep editing the saved scene.
  Standalone and exported copies still render plain Mermaid.
  Queue feedback adds a prompt to the Conversation panel; when the user sends it, poll returns a tag "whiteboard" prompt carrying a bounded edit summary plus local scenePath (.excalidraw JSON) and previewPath (PNG) files - read the summary first, open the files only when needed, then apply the edits by updating the Mermaid source in the artifact (never try to write the scene back)
- Run `bunx lavish-axi end <html-file>` to end a session as the agent - ending it this way still allows a plain reopen later.
  When the user ends it from the browser instead, a later `bunx lavish-axi <html-file>` refuses to reopen it without `--reopen`
- Run `bunx lavish-axi export <html-file> [--out <path>]` to write a portable copy of the artifact - one HTML file with its LOCAL assets inlined - so it opens with no Lavish server and no sibling files.
  Remote CDN/font references are left as links, so it needs network to render those.
  Users can also export from the browser chrome's overflow menu
- Run `bunx lavish-axi share <html-file> [--password <pw>] [--token <t>]` to publish the artifact on ht-ml.app (https://ht-ml.app), a third-party hosting service not part of Lavish, and get back a visitable URL.
  Shares are PUBLIC by default, so anyone with the link can open them.
  Pass --password to publish a PRIVATE password-protected page; viewers must supply the password to view.
  Local assets are inlined; remote refs load over the network.
  It returns the url plus a secret update_key for managing the page later.
  Use --token or LAVISH_AXI_HTML_APP_TOKEN only when you have an optional bearer token; it is never required.
  Users can also publish from the browser chrome's overflow menu
- Run `bunx lavish-axi stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected)
- Run `bunx lavish-axi playbook <playbook_id>` for focused artifact guidance.
  One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
- Lavish does not auto-inject any design system - artifacts stay portable so they render identically when opened directly without lavish-axi running.
  Before writing any HTML: Decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look or named design system, use that; (2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system: Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages.
  If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) only when both steps come up empty, use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, available via CDN, and prefer that CDN snippet over hand-writing styles unless explicitly instructed otherwise by the user.
  Run `bunx lavish-axi design` for a content-to-playbook router, a copy-pasteable CDN snippet, a Mermaid CDN snippet/init for diagrams, and the DaisyUI component reference.
  When you deliver the artifact, state which of the three design sources you used and why.
