import type { DmChannel, User } from '@backspace/shared';
import { canonicalUserKey, deliveringHost } from './identity';

type Viewer = Pick<User, 'id' | 'homeUserId' | 'homeInstance'>;

/** Compare the owner's home identity, not unrelated instance-local row IDs. */
export function isDmOwner(
  dm: DmChannel | null | undefined,
  viewer: Viewer | null,
  origin: string,
): boolean {
  if (!dm?.ownerId || !viewer) return false;
  const owner = dm.members.find((member) => member.id === dm.ownerId);
  // Prefer the current roster. Older ownership events can update ownerId
  // without refreshing ownerHomeUserId / ownerHomeInstance.
  const ownerIdentity = owner
    ? { ...owner, homeInstance: owner.homeInstance || deliveringHost(origin) }
    : {
        id: dm.ownerId,
        homeUserId: dm.ownerHomeUserId,
        homeInstance: dm.ownerHomeInstance || deliveringHost(origin),
      };
  return canonicalUserKey(ownerIdentity) === canonicalUserKey({
    ...viewer,
    homeInstance: viewer.homeInstance || deliveringHost(''),
  });
}

/** Either participant may create a new group from a 1:1 conversation. */
export function canAddDmMembers(
  dm: DmChannel | null | undefined,
  viewer: Viewer | null,
  origin: string,
): boolean {
  return !!dm && !!viewer && (!dm.ownerId || isDmOwner(dm, viewer, origin));
}
