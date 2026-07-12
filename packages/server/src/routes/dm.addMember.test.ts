import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'owner-A';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    getRoom: () => undefined,
    getUserRoom: () => undefined,
    leaveCurrentRoom: vi.fn(() => false),
    destroyRoom: vi.fn(),
    clearVoiceUserStatus: vi.fn(),
  },
}));

vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    isFederationRelayEnabled: () => false,
    queueDmCloseRelay: vi.fn(),
    sendTypingRelay: vi.fn(),
    queueDmRelay: vi.fn(),
    queueGroupMetadataRelay: vi.fn(),
  };
});

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://local.test' };
});

vi.mock('../utils/fileCleanup.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fileCleanup.js')>('../utils/fileCleanup.js');
  return {
    ...actual,
    deleteUploadFile: vi.fn(),
    deleteAttachmentByFilename: vi.fn(),
    deleteAttachmentFiles: vi.fn(),
  };
});

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sqlText.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id,
    username,
    displayName: username,
    passwordHash: 'x',
    homeUserId: id,
    homeInstance: 'https://local.test',
    createdAt: Date.now(),
  }).run();
}

function seedFriendship(a: string, b: string): void {
  testDb.insert(schema.friends).values({
    userId: a,
    friendId: b,
    createdAt: Date.now(),
  }).run();
}

function seedGroupDm(id: string): void {
  testDb.insert(schema.dmChannels).values({
    id,
    ownerId: 'owner-A',
    ownerHomeUserId: 'owner-A',
    ownerHomeInstance: 'https://local.test',
    createdAt: Date.now(),
  }).run();
  for (const userId of ['owner-A', 'member-B']) {
    testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId }).run();
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { dmRoutes } = await import('./dm.js');
  await app.register(dmRoutes);
  await app.ready();
  return app;
}

describe('POST /api/dm/:id/members — group DM authorization', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedUser('owner-A', 'alice');
    seedUser('member-B', 'bob');
    seedUser('target-C', 'carol');
    seedFriendship('owner-A', 'target-C');
    seedFriendship('member-B', 'target-C');
    currentUserId = 'owner-A';
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('rejects non-owner members before they can add friends to a private group DM', async () => {
    seedGroupDm('dm-private');
    currentUserId = 'member-B';

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-private/members',
      payload: { userId: 'target-C' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/owner/i);

    const membership = testDb.select().from(schema.dmMembers).where(and(
      eq(schema.dmMembers.dmChannelId, 'dm-private'),
      eq(schema.dmMembers.userId, 'target-C'),
    )).get();
    expect(membership).toBeUndefined();
  });

  it('allows the group owner to add a friend', async () => {
    seedGroupDm('dm-owned');

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-owned/members',
      payload: { userId: 'target-C' },
    });

    expect(res.statusCode).toBe(200);

    const membership = testDb.select().from(schema.dmMembers).where(and(
      eq(schema.dmMembers.dmChannelId, 'dm-owned'),
      eq(schema.dmMembers.userId, 'target-C'),
    )).get();
    expect(membership).toBeDefined();
  });
});
