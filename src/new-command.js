import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AxiError } from "axi-sdk-js";

const KNOWN_TEMPLATES = ["firstmate"];

export function createNewOutput({ file, template }) {
  return {
    file,
    template,
    next_step: `Template "${template}" written to ${file}. Run \`lavish-axi ${file}\` to open it in Lavish Editor, then fill in the content placeholders.`,
  };
}

export function resolveNewOutputPath(args, template) {
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--template") {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return path.join(".lavish", `${template}.html`);
}

export function resolveTemplatePath(template) {
  const url = new URL(`./templates/${template}.html`, import.meta.url);
  return fileURLToPath(url);
}

export function listKnownTemplates() {
  return KNOWN_TEMPLATES.filter((t) => {
    try {
      return existsSync(resolveTemplatePath(t));
    } catch {
      return false;
    }
  });
}

export async function newCommand(args) {
  const templateIndex = args.indexOf("--template");
  const template = templateIndex !== -1 ? args[templateIndex + 1] : null;

  const available = listKnownTemplates();

  if (!template) {
    throw new AxiError("--template is required", "VALIDATION_ERROR", [
      `Run \`lavish-axi new --template <name> [output-path]\``,
      `Available templates: ${available.join(", ")}`,
    ]);
  }

  if (!available.includes(template)) {
    throw new AxiError(`Unknown template: ${template}`, "VALIDATION_ERROR", [
      `Available templates: ${available.join(", ")}`,
    ]);
  }

  const outputPath = resolveNewOutputPath(args, template);
  const outputDir = path.dirname(path.resolve(outputPath));
  await mkdir(outputDir, { recursive: true });

  const templateContent = readFileSync(resolveTemplatePath(template), "utf8");
  await writeFile(outputPath, templateContent, "utf8");

  return createNewOutput({ file: outputPath, template });
}
