import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

import * as esbuild from "esbuild";

import { TEMPLATE_CONTRACTS, WHITEBOARD_TEMPLATE_CONTRACTS, TEMPLATE_METADATA } from "../src/templates/contracts.js";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["bin/lavish-axi.js"],
  outfile: "dist/cli.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.LAVISH_AXI_BUILD_UMAMI_HOST": JSON.stringify(process.env.LAVISH_AXI_UMAMI_HOST || ""),
    "process.env.LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(process.env.LAVISH_AXI_UMAMI_WEBSITE_ID || ""),
    "process.env.LAVISH_AXI_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});

await chmod("dist/cli.mjs", 0o755);
await copyFile("src/chrome-client.js", "dist/chrome-client.js");
await copyFile("src/chrome.css", "dist/chrome.css");
await mkdir("dist/design", { recursive: true });
await copyFile("node_modules/daisyui/daisyui.css", "dist/design/daisyui.css");
await copyFile("node_modules/daisyui/themes.css", "dist/design/daisyui-themes.css");
await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");

// Whiteboard frame: a self-contained browser bundle (Excalidraw + the Mermaid
// converter + its exactly-pinned mermaid + React) served from
// /whiteboard-assets/ by an embedded frame for every rendered Mermaid diagram
// in a `.mermaid` container.
// Everything is vendored so the eagerly loaded whiteboards work fully offline.
await mkdir("dist/whiteboard", { recursive: true });
await esbuild.build({
  entryPoints: { whiteboard: "src/whiteboard-frame.js" },
  outdir: "dist/whiteboard",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  conditions: ["production"],
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.IS_PREACT": '"false"',
  },
});

// Excalidraw lazily fetches canvas fonts from `EXCALIDRAW_ASSET_PATH/fonts/`.
// Vendor every family except Xiaolai (12 MB of CJK glyphs; those fall back to
// Excalidraw's CDN fallback or the system font when missing locally).
const fontFamilies = ["Assistant", "Cascadia", "ComicShanns", "Excalifont", "Liberation", "Lilita", "Nunito", "Virgil"];
await mkdir("dist/whiteboard/fonts", { recursive: true });
for (const family of fontFamilies) {
  await cp(`node_modules/@excalidraw/excalidraw/dist/prod/fonts/${family}`, `dist/whiteboard/fonts/${family}`, {
    recursive: true,
  });
}
const templateSourceDir = new URL("../src/templates/", import.meta.url);
const templateOutputDir = new URL("../dist/templates/", import.meta.url);
const whiteboardEnabled = process.env.LAVISH_AXI_ENABLE_WHITEBOARD_EDITING === "1";
await rm(templateOutputDir, { recursive: true, force: true });
await mkdir(templateOutputDir, { recursive: true });

const sectionPlaceholder = /^[ \t]*<!-- ==LAVISH:SECTIONS== -->[ \t]*$/gm;
const baseTemplate = await readFile(new URL("base.html", templateSourceDir), "utf8");
const baseMatches = baseTemplate.match(sectionPlaceholder) || [];
if (baseMatches.length !== 1) {
  throw new Error("build: src/templates/base.html must contain exactly one <!-- ==LAVISH:SECTIONS== --> marker");
}

const contracts = whiteboardEnabled ? { ...TEMPLATE_CONTRACTS, ...WHITEBOARD_TEMPLATE_CONTRACTS } : TEMPLATE_CONTRACTS;
const conceptFiles = (await readdir(new URL("concepts/", templateSourceDir))).filter((file) => file.endsWith(".json"));
const conceptNames = new Set(conceptFiles.map((file) => file.slice(0, -5)));
for (const name of Object.keys(contracts)) {
  if (!conceptNames.has(name)) throw new Error(`build: missing concept manifest for ${name}`);
}
for (const file of conceptFiles) {
  const concept = file.slice(0, -5);
  if (!Object.hasOwn(contracts, concept)) continue;
  const manifest = JSON.parse(await readFile(new URL(`concepts/${file}`, templateSourceDir), "utf8"));
  const expectedSections = contracts[concept];
  if (JSON.stringify(manifest.sections) !== JSON.stringify(expectedSections)) {
    throw new Error(`build: ${concept} sections must exactly match ${JSON.stringify(expectedSections)}`);
  }
  const metadata = TEMPLATE_METADATA[concept];
  if (!metadata || manifest.title !== metadata.title || manifest.treatment !== metadata.treatment) {
    throw new Error(`build: ${concept} title/treatment metadata is invalid`);
  }
  const blocks = [];
  for (const section of expectedSections) {
    const sectionContent = await readFile(new URL(`sections/${section}.html`, templateSourceDir), "utf8");
    const sectionPattern = new RegExp(`<!-- ==SECTION:${section}==[\\s\\S]*<!-- ==/SECTION:${section}== -->`);
    if (!sectionPattern.test(sectionContent)) {
      throw new Error(`build: section ${section} has invalid delimiters`);
    }
    blocks.push(sectionContent.trimEnd());
  }
  const composed = baseTemplate
    .replace(sectionPlaceholder, blocks.join("\n\n"))
    .replace("<!-- TITLE: replace me -->", manifest.title)
    .replaceAll("__LAVISH_TEMPLATE__", concept)
    .replaceAll("__LAVISH_TREATMENT__", manifest.treatment);
  await writeFile(new URL(`${concept}.html`, templateOutputDir), composed, "utf8");
}
