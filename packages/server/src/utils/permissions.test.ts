import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { computeCategoryPermissions, computePermissions, hasPermission, PermissionBits, permissionsToString } from './permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string, isAdmin = 0): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: 'x',
    isAdmin,
    createdAt: Date.now(),
  }).run();
}

function seedSpace(spaceId: string): void {
  seedUser('owner');
  testDb.insert(schema.spaces).values({
    id: spaceId,
    name: 'Test Space',
    ownerId: 'owner',
    createdAt: Date.now(),
  }).run();
  testDb.insert(schema.roles).values({
    id: spaceId,
    spaceId,
    name: '@everyone',
    color: '#b9bbbe',
    position: 0,
    permissions: permissionsToString(
      PermissionBits.VIEW_CHANNEL |
      PermissionBits.SEND_MESSAGES |
      PermissionBits.READ_MESSAGE_HISTORY,
    ),
    createdAt: Date.now(),
  }).run();
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('space permission membership guard', () => {
  it('does not apply @everyone permissions to non-members', () => {
    const spaceId = 'sp-perms-1';
    seedSpace(spaceId);
    seedUser('attacker');

    expect(computePermissions('attacker', spaceId)).toBe(0n);
    expect(hasPermission('attacker', spaceId, PermissionBits.VIEW_CHANNEL)).toBe(false);
    expect(computeCategoryPermissions('attacker', spaceId, 'cat-missing')).toBe(0n);
  });

  it('preserves @everyone permissions for members', () => {
    const spaceId = 'sp-perms-2';
    seedSpace(spaceId);
    seedUser('member');
    testDb.insert(schema.spaceMembers).values({
      spaceId,
      userId: 'member',
      joinedAt: Date.now(),
    }).run();

    expect(hasPermission('member', spaceId, PermissionBits.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission('member', spaceId, PermissionBits.SEND_MESSAGES)).toBe(true);
  });
});
