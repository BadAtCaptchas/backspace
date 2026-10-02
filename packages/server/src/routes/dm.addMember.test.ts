import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
let federationEnabled = false;

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
    isFederationRelayEnabled: () => federationEnabled,
    appendMutationLog: vi.fn(),
    queueOutboxEvent: vi.fn(),
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

function seedGroupDm(id: string, membersCanInvite = true): void {
  testDb.insert(schema.dmChannels).values({
    id,
    ownerId: 'owner-A',
    membersCanInvite,
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
    federationEnabled = false;
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    sqlite.close();
    vi.restoreAllMocks();
  });

  it('rejects non-owner members before they can add friends to a private group DM', async () => {
    seedGroupDm('dm-private', false);
    currentUserId = 'member-B';

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-private/members',
      payload: { userId: 'target-C' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('dm_owner_only');

    const membership = testDb.select().from(schema.dmMembers).where(and(
      eq(schema.dmMembers.dmChannelId, 'dm-private'),
      eq(schema.dmMembers.userId, 'target-C'),
    )).get();
    expect(membership).toBeUndefined();
  });

  it.each([true, false])('rejects outsiders regardless of membersCanInvite=%s', async (enabled) => {
    seedGroupDm('outsider', enabled);
    currentUserId = 'target-C';
    const res = await app.inject({ method: 'POST', url: '/api/dm/outsider/members', payload: { userId: 'target-C' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_dm_member');
  });

  it('allows a member to invite a friend by default and serializes the permission', async () => {
    seedGroupDm('open-group');
    currentUserId = 'member-B';
    const res = await app.inject({ method: 'POST', url: '/api/dm/open-group/members', payload: { userId: 'target-C' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().membersCanInvite).toBe(true);
    expect(res.json().members.map((member: { id: string }) => member.id)).toContain('target-C');
  });

  it('ignores an invitation request trying to override the stored permission', async () => {
    seedGroupDm('closed-group', false);
    currentUserId = 'member-B';
    const res = await app.inject({ method: 'POST', url: '/api/dm/closed-group/members', payload: { userId: 'target-C', membersCanInvite: true } });
    expect(res.statusCode).toBe(403);
    expect(testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'closed-group')).get()?.membersCanInvite).toBe(false);
  });

  it('still checks friendship when member invites are enabled', async () => {
    seedGroupDm('no-friend');
    testDb.delete(schema.friends).run();
    currentUserId = 'member-B';
    const res = await app.inject({ method: 'POST', url: '/api/dm/no-friend/members', payload: { userId: 'target-C' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_a_friend');
  });

  it('lets the owner invite while member invites are disabled', async () => {
    seedGroupDm('owner-only', false);
    const res = await app.inject({ method: 'POST', url: '/api/dm/owner-only/members', payload: { userId: 'target-C' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().membersCanInvite).toBe(false);
  });

  it.each(['permission', 'membership'])('rechecks %s after remote target resolution', async (change) => {
    seedGroupDm('awaiting-resolution');
    currentUserId = 'member-B';
    const identity = await import('../utils/federationClientIdentity.js');
    const target = testDb.select().from(schema.users).where(eq(schema.users.id, 'target-C')).get()!;
    let resolveTarget!: (value: typeof target) => void;
    const waiting = new Promise<typeof target>((resolve) => { resolveTarget = resolve; });
    const resolver = vi.spyOn(identity, 'resolveRemoteIdentityForClient').mockReturnValueOnce(waiting);
    const pending = app.inject({ method: 'POST', url: '/api/dm/awaiting-resolution/members', payload: { homeUserId: 'target-C', homeInstance: 'https://remote.test' } }).then(result => result);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
    if (change === 'permission') {
      testDb.update(schema.dmChannels).set({ membersCanInvite: false }).where(eq(schema.dmChannels.id, 'awaiting-resolution')).run();
    } else {
      testDb.delete(schema.dmMembers).where(and(eq(schema.dmMembers.dmChannelId, 'awaiting-resolution'), eq(schema.dmMembers.userId, 'member-B'))).run();
    }
    resolveTarget(target);
    const response = await pending;
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe(change === 'permission' ? 'dm_owner_only' : 'not_dm_member');
    expect(testDb.select().from(schema.dmMembers).where(and(eq(schema.dmMembers.dmChannelId, 'awaiting-resolution'), eq(schema.dmMembers.userId, target.id))).get()).toBeUndefined();
  });

  it('rejects a duplicate member even when members may invite', async () => {
    seedGroupDm('duplicate');
    testDb.insert(schema.dmMembers).values({ dmChannelId: 'duplicate', userId: 'target-C' }).run();
    currentUserId = 'member-B';
    const res = await app.inject({ method: 'POST', url: '/api/dm/duplicate/members', payload: { userId: 'target-C' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('already_member');
  });

  it('enforces the capacity limit for enabled member invitations', async () => {
    seedGroupDm('full');
    for (let i = 0; i < 8; i++) {
      seedUser(`extra-${i}`, `extra-${i}`);
      testDb.insert(schema.dmMembers).values({ dmChannelId: 'full', userId: `extra-${i}` }).run();
    }
    currentUserId = 'member-B';
    const res = await app.inject({ method: 'POST', url: '/api/dm/full/members', payload: { userId: 'target-C' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('group_dm_too_many_members');
  });

  it('relays the actual owner when a member adds from a legacy copy without owner home fields', async () => {
    seedGroupDm('legacy-owner');
    federationEnabled = true;
    currentUserId = 'member-B';
    testDb.update(schema.dmChannels).set({ federatedId: 'group-legacy', ownerHomeUserId: null, ownerHomeInstance: null }).where(eq(schema.dmChannels.id, 'legacy-owner')).run();
    testDb.update(schema.users).set({ homeInstance: 'https://remote.test' }).where(eq(schema.users.id, 'target-C')).run();
    const res = await app.inject({ method: 'POST', url: '/api/dm/legacy-owner/members', payload: { userId: 'target-C' } });
    expect(res.statusCode).toBe(200);
    const { queueOutboxEvent } = await import('../utils/federationOutbox.js');
    const memberAdd = vi.mocked(queueOutboxEvent).mock.calls.find(call => call[2] === 'member_add');
    expect(memberAdd).toBeDefined();
    const payload = JSON.parse(memberAdd![3]!);
    expect(payload.group.owner).toEqual({ homeUserId: 'owner-A', homeInstance: 'https://local.test' });
    expect(payload.group.membersCanInvite).toBe(true);
    expect(payload.membership.addedBy.homeUserId).toBe('member-B');
  });

  it('uses the current owner after ownership changes', async () => {
    seedGroupDm('dm-transferred', false);
    testDb.update(schema.dmChannels).set({ ownerId: 'member-B' })
      .where(eq(schema.dmChannels.id, 'dm-transferred')).run();

    const oldOwner = await app.inject({ method: 'POST', url: '/api/dm/dm-transferred/members', payload: { userId: 'target-C' } });
    expect(oldOwner.statusCode).toBe(403);
    expect(oldOwner.json().code).toBe('dm_owner_only');
    currentUserId = 'member-B';
    const newOwner = await app.inject({ method: 'POST', url: '/api/dm/dm-transferred/members', payload: { userId: 'target-C' } });
    expect(newOwner.statusCode).toBe(200);
  });

  it('does not add a third person to a 1-on-1 DM', async () => {
    testDb.insert(schema.dmChannels).values({ id: 'dm-pair', createdAt: Date.now() }).run();
    for (const userId of ['owner-A', 'member-B']) {
      testDb.insert(schema.dmMembers).values({ dmChannelId: 'dm-pair', userId }).run();
    }
    const res = await app.inject({ method: 'POST', url: '/api/dm/dm-pair/members', payload: { userId: 'target-C' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('dm_not_group');
    expect(testDb.select().from(schema.dmMembers).where(eq(schema.dmMembers.dmChannelId, 'dm-pair')).all()).toHaveLength(2);
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
