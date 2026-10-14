import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('each migration creates every named table constraint once', () => {
  const root = new URL('../prisma/migrations/', import.meta.url);
  for (const name of readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    const sql = readFileSync(new URL(`${name}/migration.sql`, root), 'utf8');
    const seen = new Set();
    for (const [, table, constraint] of sql.matchAll(/ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/g)) {
      const key = `${table}.${constraint}`;
      assert.ok(!seen.has(key), `${name} repeats ${key}`);
      seen.add(key);
    }
  }
});
