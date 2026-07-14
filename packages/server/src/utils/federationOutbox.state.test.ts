import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// Mutable reference updated in beforeEach — the factory closes over this.
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

// Mock federation-auth helpers to avoid env-var dependency
vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://local.example',
  buildFederationHeaders: () => ({}),
  generateHmacSecret: () => 'test-secret',
}));

// federationOutbox.ts imports extractDomain from routes/federation.js, which in
// turn imports connectionManager/ws. Stub that route dependency so this unit
// test does not start the server module graph.
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    evictFederatedCallsForHost: vi.fn(),
    federatedCalls: new Map(),
    isUserOnline: vi.fn(),
    lateBindFederatedCall: vi.fn(),
  },
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

function seedSettings(): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    federationRelayEnabled: 1,
    federationRelayTtlDays: 30,
    updatedAt: Date.now(),
  }).run();
}

function seedPeer(id: string, origin: string, status: string): void {
  testDb.insert(schema.federationPeers).values({
    id, origin, hmacSecret: 'secret',
    status, lastSyncedAt: 0, createdAt: Date.now(),
  }).run();
}

function countOutbox(peerId: string): number {
  return testDb.select().from(schema.federationOutbox)
    .where(eq(schema.federationOutbox.peerId, peerId))
    .all().length;
}

// Import once at module level — vi.mock is hoisted and the factory returns the
// live testDb reference, so re-using the cached import is correct.
const { queueOutboxEvent } = await import('./federationOutbox.js');

describe('queueOutboxEvent — non-deliverable statuses', () => {
  beforeEach(() => {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedSettings();
    vi.restoreAllMocks();
  });

  it('does not create a pending peer placeholder for unknown targeted origins', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    queueOutboxEvent('entity-unknown', 'ctx-unknown', 'profile_update', '{}', ['https://attacker.example'], 'profile');

    const peers = testDb.select().from(schema.federationPeers).all();
    const outboxRows = testDb.select().from(schema.federationOutbox).all();

    expect(peers).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
    expect(debugSpy).toHaveBeenCalledWith(
      '[federation] queueOutboxEvent: skipping unknown peer https://attacker.example',
    );
  });

  it.each([
    ['awaiting_approval'],
    ['needs_attention'],
    ['rejected'],
    ['revoked'],
  ])('drops the event and logs a reason for %s peers (no outbox row, no throw)', (status) => {
    seedPeer('peer-drop', 'https://drop.example', status);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    queueOutboxEvent('entity-1', 'ctx-1', 'create', '{}', ['https://drop.example'], 'dm');

    expect(countOutbox('peer-drop')).toBe(0);
    expect(debugSpy).toHaveBeenCalled();
    expect(debugSpy.mock.calls[0]![0] as string).toContain(status);
  });
});
