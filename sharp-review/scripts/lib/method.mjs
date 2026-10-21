// method.mjs — read the review METHOD (sharp-review/method/) as data.
//
// The method directory is the single source of profiles, prompt templates, the finding schema,
// reviewer-status rules and the merge/id spec. This loader only reads and checks it; every
// executor (this Node one, the headless Python one) interprets the same files.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const METHOD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'method');
export const SUPPORTED_SCHEMA_VERSION = 2;

const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));

// method.json principles.fills: the finding schema names the field; principles.json alone lists the ids.
function withPrincipleIds(schema, field, principles) {
  const rule = schema.properties[field];
  if (!rule) throw new Error(`finding schema has no ${field} property for principles.json to fill`);
  const ids = principles.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new Error(`principles.json repeats an id: ${ids}`);
  return { ...schema, properties: { ...schema.properties, [field]: { ...rule, items: { ...rule.items, enum: ids } } } };
}

export function loadMethod(dir = METHOD_DIR) {
  const method = readJSON(join(dir, 'method.json'));
  if (method.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`sharp-review method at ${dir} declares schema_version ${method.schema_version}; this executor reads ${SUPPORTED_SCHEMA_VERSION}`);
  }
  const profiles = {};
  for (const p of readJSON(join(dir, method.files.profiles)).profiles) profiles[p.key] = p;
  const principles = readJSON(join(dir, method.files.principles)).principles;
  return {
    ...method,
    dir,
    profiles,
    principleList: principles,
    findingSchema: withPrincipleIds(readJSON(join(dir, method.files.finding_schema)), method.principles.finding_field, principles),
    readTemplate: (rel) => readFileSync(join(dir, rel), 'utf8'),
  };
}
