import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("check script runs all verification commands", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const checkCommands = packageJson.scripts.check.split(" && ");

  assert.deepEqual(checkCommands, [
    "bun run build",
    "bun run lint",
    "bun run format:check",
    "bun run typecheck",
    "bun run test",
    "bun scripts/build-skill.js --check",
  ]);
});

test("generated skill stays in sync with the no-args home output", async () => {
  const { createSkillMarkdown } = await import("../src/skill.js");
  const committed = await readFile(new URL("../skills/lavish/SKILL.md", import.meta.url), "utf8");

  assert.equal(committed, createSkillMarkdown(), "run `bun run build:skill` and commit the result");
});

test("package manifest includes the installable skill", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.files.includes("skills/lavish"));
});

test("Bun install policy enforces a one-week release age and trusts esbuild only", async () => {
  const [bunfig, packageJson] = await Promise.all([
    readFile(new URL("../bunfig.toml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(
    bunfig,
    /^\[install\]\nminimumReleaseAge = 604800\nminimumReleaseAgeExcludes = \["axi-sdk-js", "lavish-axi"\]\n$/,
  );
  assert.deepEqual(packageJson.trustedDependencies, ["esbuild"]);
  await assert.rejects(access(new URL("../pnpm-workspace.yaml", import.meta.url)));
});

test("lavish-design agent skill is marked internal for skills CLI discovery", async () => {
  const skillMd = await readFile(new URL("../.agents/skills/lavish-design/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---\n", 4));

  assert.match(frontmatter, /^name: lavish-design$/m);
  assert.match(frontmatter, /^metadata:\n {2}internal: true$/m);
});

test("public lavish skill is not marked internal", async () => {
  const skillMd = await readFile(new URL("../skills/lavish/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---\n", 4));

  assert.doesNotMatch(frontmatter, /^metadata:\n {2}internal: true$/m);
});

test("artifact build copies local design assets", async () => {
  const buildScript = await readFile(new URL("../scripts/build.js", import.meta.url), "utf8");

  assert.match(buildScript, /daisyui\.css/);
  assert.match(buildScript, /daisyui-themes\.css/);
  assert.match(buildScript, /tailwindcss-browser\.js/);
});

test("package metadata matches the standalone GitHub repository", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.repository.url, "git+https://github.com/ryxli/lavish-axi.git");
  assert.equal(packageJson.bugs.url, "https://github.com/ryxli/lavish-axi/issues");
  assert.equal(packageJson.homepage, "https://github.com/ryxli/lavish-axi#readme");
  assert.equal(packageJson.publishConfig, undefined);
});
