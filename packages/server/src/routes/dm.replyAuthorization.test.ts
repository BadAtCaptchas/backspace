import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
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
let currentUserId = 'attacker';

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

function seedUser(id: string): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: 'x',
    homeUserId: id,
    homeInstance: 'https://local.test',
    createdAt: Date.now(),
  }).run();
}

function seedDm(id: string, members: string[]): void {
  testDb.insert(schema.dmChannels).values({ id, createdAt: Date.now() }).run();
  for (const userId of members) {
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

describe('DM reply authorization', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedUser('attacker');
    seedUser('friend');
    seedUser('victim-a');
    seedUser('victim-b');
    seedDm('attacker-dm', ['attacker', 'friend']);
    seedDm('private-dm', ['victim-a', 'victim-b']);
    testDb.insert(schema.dmMessages).values({
      id: 'private-message',
      dmChannelId: 'private-dm',
      userId: 'victim-a',
      content: 'TOP SECRET DM CONTENT',
      createdAt: Date.now(),
    }).run();
    currentUserId = 'attacker';
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('rejects replyToId values outside the destination DM channel', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/attacker-dm/messages',
      payload: { content: 'probe', replyToId: 'private-message' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Invalid reply target' });
  });
});
