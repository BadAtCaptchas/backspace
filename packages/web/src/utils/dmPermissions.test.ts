import { describe, expect, it } from 'vitest';
import type { DmChannel, User } from '@backspace/shared';
import { wireDm } from '../test/dmWireShape';
import { canAddDmMembers, isDmOwner } from './dmPermissions';

const self: User = { id: 'self', username: 'alice', homeUserId: null, homeInstance: null } as User;
const ownerAlias: User = {
  ...self, id: 'self-on-peer', homeUserId: self.id, homeInstance: window.location.host,
};
const group = (overrides: Partial<DmChannel> = {}) => wireDm({
  id: 'group', createdAt: 0, ownerId: self.id, members: [self], ...overrides,
});

describe('group DM membership permissions', () => {
  it('allows a local owner and rejects another member', () => {
    expect(isDmOwner(group(), self, '')).toBe(true);
    expect(canAddDmMembers(group({ ownerId: 'other', members: [{ ...self, id: 'other' }] }), self, '')).toBe(false);
  });

  it('recognizes the owner by their home identity on a remote copy', () => {
    const dm = group({ ownerId: ownerAlias.id, members: [ownerAlias] });
    expect(canAddDmMembers(dm, self, 'https://peer.example')).toBe(true);
  });

  it('handles signing in through a replicated account', () => {
    const dm = group({ ownerId: 'self-on-third', members: [{ ...ownerAlias, id: 'self-on-third' }] });
    expect(canAddDmMembers(dm, ownerAlias, 'https://third.example')).toBe(true);
  });

  it('uses the owner home fields when the owner row is unavailable', () => {
    expect(isDmOwner(group({
      ownerId: ownerAlias.id, members: [],
      ownerHomeUserId: self.id, ownerHomeInstance: `http://${window.location.host}`,
    }), self, 'https://peer.example')).toBe(true);
  });

  it('does not confuse matching IDs or usernames from different instances', () => {
    expect(isDmOwner(group(), self, 'https://peer.example')).toBe(false);
    expect(isDmOwner(group({
      ownerId: ownerAlias.id,
      members: [{ ...ownerAlias, homeInstance: 'someone-else.example' }],
    }), self, 'https://peer.example')).toBe(false);
  });

  it('follows the current owner row after a legacy ownership event leaves old home fields', () => {
    expect(isDmOwner(group({
      ownerId: 'new-owner', members: [{ ...self, id: 'new-owner' }],
      ownerHomeUserId: self.id, ownerHomeInstance: window.location.host,
    }), self, '')).toBe(false);
  });

  it('preserves 1:1 conversion, but requires a channel and a signed-in user', () => {
    expect(canAddDmMembers(wireDm({ id: 'pair', createdAt: 0, members: [self] }), self, '')).toBe(true);
    expect(isDmOwner(wireDm({ id: 'pair', createdAt: 0, members: [self] }), self, '')).toBe(false);
    expect(canAddDmMembers(undefined, self, '')).toBe(false);
    expect(canAddDmMembers(group(), null, '')).toBe(false);
  });
});


describe('member invitations', () => {
  const other = { ...self, id: 'other' };
  const joined = (membersCanInvite: boolean) => group({ ownerId: other.id, members: [self, other], membersCanInvite });

  it('lets existing members invite when enabled, and blocks them when disabled', () => {
    expect(canAddDmMembers(joined(true), self, '')).toBe(true);
    expect(canAddDmMembers(joined(false), self, '')).toBe(false);
    expect(canAddDmMembers(group({ membersCanInvite: false }), self, '')).toBe(true);
  });

  it('defaults legacy missing flags to enabled', () => {
    const legacy: Partial<DmChannel> = joined(true);
    delete legacy.membersCanInvite;
    expect(canAddDmMembers(legacy as DmChannel, self, '')).toBe(true);
  });

  it('requires membership even with enabled invites or matching owner metadata', () => {
    expect(canAddDmMembers(group({ members: [], membersCanInvite: true }), self, '')).toBe(false);
    expect(canAddDmMembers(group({ ownerId: 'other', members: [other] }), self, '')).toBe(false);
    expect(canAddDmMembers(wireDm({ id: 'pair', createdAt: 0, members: [other] }), self, '')).toBe(false);
  });

  it('recognizes a member alias on a remote instance without trusting equal local IDs', () => {
    expect(canAddDmMembers(group({ ownerId: other.id, members: [ownerAlias, other] }), self, 'https://peer.example')).toBe(true);
    expect(canAddDmMembers(joined(true), self, 'https://peer.example')).toBe(false);
    expect(canAddDmMembers(group({ ownerId: other.id, members: [{ ...ownerAlias, homeInstance: 'unrelated.example' }, other] }), self, 'https://peer.example')).toBe(false);
  });
});
