import { readFileSync, writeFileSync } from "node:fs";

const [templatePath, outputPath, ...values] = process.argv.slice(2);
const names = ["LABEL", "NODE_BIN", "WORKDIR", "HOME", "STDOUT", "STDERR"];
if (!templatePath || !outputPath || values.length !== names.length) {
  throw new Error("Expected template, output, label, Node, working directory, home, stdout and stderr paths");
}

const replacements = new Map(names.map((name, index) => [name, values[index]]));
const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\r": "&#13;" };
const template = readFileSync(templatePath, "utf8");
// One substitution pass keeps placeholder-like path text literal as well.
const rendered = template.replace(/__(LABEL|NODE_BIN|WORKDIR|HOME|STDOUT|STDERR)__/g, (_, name) =>
  replacements.get(name).replace(/[&<>\r]/g, (character) => entities[character])
);
writeFileSync(outputPath, rendered);
