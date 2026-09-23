/** Writes docs/tools.md from the registered tool definitions. Run with `npm run docs:tools`. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TOOLS } from '../src/tools.js';

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
}

function typeOf(schema: JsonSchema): string {
  if (schema.enum) return schema.enum.map((v) => `\`${String(v)}\``).join(', ');
  if (schema.type === 'array' && schema.items) return `array of ${typeOf(schema.items)}`;
  const base = Array.isArray(schema.type) ? schema.type.join(' or ') : (schema.type ?? 'any');
  if (schema.minimum !== undefined && schema.maximum !== undefined)
    return `${base} (${schema.minimum}-${schema.maximum})`;
  return base;
}

const lines = [
  '# Tools',
  '',
  'Generated from `src/tools.ts` by `npm run docs:tools`. Every `id` accepts a DOI, an IEEE article number, an IEEE Xplore URL (proxied ones too) or an OpenAlex id.',
  '',
];

for (const tool of TOOLS) {
  const schema = z.toJSONSchema(z.object(tool.input), { io: 'input' }) as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  const hints = [
    tool.annotations.readOnlyHint ? 'read-only' : 'writes',
    tool.annotations.openWorldHint ? 'uses the network' : 'local',
  ];
  lines.push(`## ${tool.name}`, '', `**${tool.title}** (${hints.join(', ')})`, '', tool.description, '');
  const properties = Object.entries(schema.properties ?? {});
  if (!properties.length) {
    lines.push('No parameters.', '');
    continue;
  }
  lines.push('| Parameter | Type | Required | Default | Description |', '| --- | --- | --- | --- | --- |');
  for (const [name, property] of properties) {
    const required = schema.required?.includes(name) && property.default === undefined ? 'yes' : 'no';
    const fallback = property.default === undefined ? '' : `\`${JSON.stringify(property.default)}\``;
    const description = (property.description ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    lines.push(`| \`${name}\` | ${typeOf(property)} | ${required} | ${fallback} | ${description} |`);
  }
  lines.push('');
}

writeFileSync(join(import.meta.dirname, '..', 'docs', 'tools.md'), `${lines.join('\n').trimEnd()}\n`);
console.log(`Wrote docs/tools.md (${TOOLS.length} tools)`);
