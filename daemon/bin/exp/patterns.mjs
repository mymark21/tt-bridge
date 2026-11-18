// experience/patterns: cross-site playbooks kept under _patterns/.
import path from "node:path";
import fs from "node:fs";
import {
  readEntry,
} from './entry.mjs';

export function loadPatterns(root) {
  const patternsDir = path.join(path.resolve(root), '_patterns');
  if (!fs.existsSync(patternsDir)) return [];
  const entries = [];
  try {
    const list = fs.readdirSync(patternsDir, { withFileTypes: true });
    for (const item of list) {
      if (!item.isDirectory() || item.name.startsWith('_') || item.name.startsWith('.')) continue;
      const file = path.join(patternsDir, item.name, 'entry.md');
      if (fs.existsSync(file)) {
        try {
          const entry = readEntry(file);
          entries.push({
            id: `_patterns/${item.name}`,
            slug: entry.slug || item.name,
            kind: entry.kind || 'pattern',
            description: entry.description || '',
            triggers: Array.isArray(entry.triggers) ? entry.triggers : [],
            lastVerified: entry.last_verified || null,
          });
        } catch {}
      }
    }
  } catch {}
  return entries;
}
