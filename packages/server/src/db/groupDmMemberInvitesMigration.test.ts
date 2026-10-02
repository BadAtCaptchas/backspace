import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from './schema.js';

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migration = '0021_group_dm_member_invites.sql';

describe('group DM invitation permission migration', () => {
  it('defaults existing and new groups to enabled and preserves explicit false across reopen', () => {
    const raw = new Database(':memory:');
    try {
      for (const file of fs.readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) {
        if (file === migration) break;
        raw.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
      }
      raw.exec("INSERT INTO dm_channels (id, owner_id, created_at) VALUES ('existing', 'owner', 1)");
      raw.exec(fs.readFileSync(path.join(migrations, migration), 'utf8'));
      const db = drizzle(raw, { schema });
      expect(db.select().from(schema.dmChannels).get()?.membersCanInvite).toBe(true);
      db.insert(schema.dmChannels).values({ id: 'new', ownerId: 'owner', createdAt: 2 }).run();
      expect(db.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'new')).get()?.membersCanInvite).toBe(true);
      db.update(schema.dmChannels).set({ membersCanInvite: false }).where(eq(schema.dmChannels.id, 'existing')).run();
      const reopened = new Database(raw.serialize());
      try {
        expect(drizzle(reopened, { schema }).select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'existing')).get()?.membersCanInvite).toBe(false);
      } finally { reopened.close(); }
    } finally { raw.close(); }
  });
});
