import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import * as esbuild from "esbuild";

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
await mkdir("dist/templates", { recursive: true });

// Compose concept templates from a shared base + section partials, so one naval
// design can be mutated into many task concepts. Each concepts/<name>.json lists
// the ordered sections injected at the base's <!-- ==LAVISH:SECTIONS== --> marker.
const templatesDir = new URL("../src/templates/", import.meta.url);
const distTemplatesDir = new URL("../dist/templates/", import.meta.url);
const base = await readFile(new URL("base.html", templatesDir), "utf8");
const sectionPlaceholder = /^[ \t]*<!-- ==LAVISH:SECTIONS== -->[ \t]*$/m;
if (!sectionPlaceholder.test(base)) {
  throw new Error("build: <!-- ==LAVISH:SECTIONS== --> placeholder missing from src/templates/base.html");
}
const conceptFiles = (await readdir(new URL("concepts/", templatesDir))).filter((f) => f.endsWith(".json"));
for (const file of conceptFiles) {
  const concept = file.slice(0, -5);
  const manifest = JSON.parse(await readFile(new URL(`concepts/${file}`, templatesDir), "utf8"));
  const blocks = [];
  for (const name of manifest.sections) {
    blocks.push((await readFile(new URL(`sections/${name}.html`, templatesDir), "utf8")).trimEnd());
  }
  const composed = base
    .replace(sectionPlaceholder, blocks.join("\n\n"))
    .replace("<!-- TITLE: replace me -->", manifest.title ?? "Lavish artifact");
  await writeFile(new URL(`${concept}.html`, distTemplatesDir), composed, "utf8");
}
await mkdir("dist/design", { recursive: true });
await copyFile("node_modules/daisyui/daisyui.css", "dist/design/daisyui.css");
await copyFile("node_modules/daisyui/themes.css", "dist/design/daisyui-themes.css");
await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");
