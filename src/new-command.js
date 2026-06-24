import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AxiError } from "axi-sdk-js";

function templatesDir() {
  return fileURLToPath(new URL("./templates/", import.meta.url));
}

export function listKnownTemplates() {
  try {
    return readdirSync(templatesDir())
      .filter((f) => f.endsWith(".html"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

export function resolveTemplatePath(template) {
  return path.join(templatesDir(), `${template}.html`);
}

// Parses new-command args, handling both "--flag value" and "--flag=value" forms.
// Only "--template" is a recognized flag; unrecognized flags throw so their
// values are never silently captured as the output path.
export function parseNewArgs(args) {
  let template = null;
  let outputPath = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--template" && i + 1 < args.length) {
      template = args[++i];
    } else if (arg.startsWith("--template=")) {
      template = arg.slice("--template=".length) || null;
    } else if (arg.startsWith("--")) {
      throw new AxiError(`Unknown flag: ${arg}`, "VALIDATION_ERROR", ["Run `lavish-axi new --help` for usage"]);
    } else if (outputPath === null) {
      outputPath = arg;
    }
  }
  return { template, outputPath };
}

export function createNewOutput({ file, template }) {
  return {
    file,
    template,
    next_step: `Template "${template}" written to ${file}. Run \`lavish-axi ${file}\` to open it in Lavish Editor, then fill in the content placeholders.`,
  };
}

export async function newCommand(args) {
  const { template, outputPath: explicitOutput } = parseNewArgs(args);
  const available = listKnownTemplates();

  if (!template) {
    throw new AxiError("--template is required", "VALIDATION_ERROR", [
      `Run \`lavish-axi new --template <name> [output-path]\``,
      available.length > 0
        ? `Available templates: ${available.join(", ")}`
        : "No templates found - run `node scripts/build.js` first",
    ]);
  }

  if (!available.includes(template)) {
    throw new AxiError(
      `Unknown template: ${template}`,
      "VALIDATION_ERROR",
      available.length > 0
        ? [`Available templates: ${available.join(", ")}`]
        : [
            "No templates found - this usually means the package was not built correctly",
            "Run `node scripts/build.js` and try again",
          ],
    );
  }

  const outputPath = explicitOutput ?? path.join(".lavish", `${template}.html`);

  try {
    await access(outputPath);
    throw new AxiError(`Output file already exists: ${outputPath}`, "VALIDATION_ERROR", [
      "Delete or rename the existing file first, or pass a different output path",
      `Run \`lavish-axi new --template ${template} <new-path>\` to write to a different location`,
    ]);
  } catch (err) {
    if (err instanceof AxiError) throw err;
    // ENOENT - file does not exist, which is what we want; proceed
  }

  const outputDir = path.dirname(path.resolve(outputPath));
  await mkdir(outputDir, { recursive: true });

  const templateContent = await readFile(resolveTemplatePath(template), "utf8");
  await writeFile(outputPath, templateContent, "utf8");

  return createNewOutput({ file: outputPath, template });
}
