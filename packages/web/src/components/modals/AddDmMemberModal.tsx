import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, dmCopyOnOrigin, getChannelOrigin } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore, type TaggedFriend } from '../../stores/socialStore';
import { api } from '../../api/client';
import { isSelf, parseFederatedUsername, deliveringHost } from '../../utils/identity';
import { canAddDmMembers, isDmMember } from '../../utils/dmPermissions';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import type { User } from '@backspace/shared';

function AddDmFriendRow({
  friend,
  isInDm,
  isSelected,
  atCapacity,
  isAdding,
  onToggle,
}: {
  friend: TaggedFriend;
  isInDm: boolean;
  isSelected: boolean;
  atCapacity: boolean;
  isAdding: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation(['dm', 'common']);
  const canonical = useCanonicalUserView(friend as unknown as User);
  const { baseName } = parseFederatedUsername(canonical.username);
  const friendDisplayName = canonical.displayName ?? baseName;
  return (
    <button
      onClick={() => onToggle(friend.id)}
      disabled={isInDm || isAdding || atCapacity}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-[4px] transition-colors text-left ${
        isInDm
          ? 'opacity-40 cursor-not-allowed'
          : isSelected
            ? 'bg-accent-mint/[0.08]'
            : 'hover:bg-interactive-hover'
      } ${atCapacity && !isInDm ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <Avatar
        src={canonical.avatar}
        name={friendDisplayName}
        size={30}
        status={canonical.status as any}
        userId={canonical.homeUserId ?? canonical.id}
        avatarColor={canonical.avatarColor}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-txt-primary truncate">
          {friendDisplayName}
        </div>
        <div className="text-[11px] text-txt-tertiary truncate">
          {isInDm ? t('dm:addMember.alreadyInDm') : `@${canonical.username}`}
        </div>
      </div>
      {!isInDm && (
        <div
          className={`w-[18px] h-[18px] rounded flex-shrink-0 flex items-center justify-center ${
            isSelected
              ? 'bg-accent-mint'
              : 'border-2 border-border-hard'
          }`}
        >
          {isSelected && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-surface-base">
              <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
    </button>
  );
}

/** Native friends from remote listings carry their home in the delivery tag. */
function friendIdentity(friend: TaggedFriend) {
  const homeInstance = friend.homeInstance || (friend._instanceOrigin ? deliveringHost(friend._instanceOrigin) : null);
  return {
    id: friend.id,
    homeInstance,
    homeUserId: friend.homeUserId ?? (homeInstance ? friend.id : null),
  };
}

export function AddDmMemberModal() {
  const { t } = useTranslation(['dm', 'common']);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const upsertDmCopy = useSpaceStore((s) => s.upsertDmCopy);
  const friends = useSocialStore((s) => s.friends);
  const navigate = useNavigate();
  const myUser = useAuthStore((s) => s.user);
  const authToken = useAuthStore((s) => s.token);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalSession = useRef(0);

  const isOpen = activeModal === 'addDmMember';
  const dmChannelId = modalData.dmChannelId as string | undefined;
  const dmChannel = dmChannels.find(dm => dm.id === dmChannelId);
  const homeChannel = dmChannelId ? dmCopyOnOrigin(dmChannelId, '') : undefined;
  const canAddMembers = canAddDmMembers(dmChannel, myUser, getChannelOrigin(dmChannelId ?? ''))
    && (!homeChannel || canAddDmMembers(homeChannel, myUser, ''));
  const currentMemberIds = useMemo(
    () => new Set(friends.filter((friend) => isDmMember(dmChannel, friendIdentity(friend), getChannelOrigin(dmChannelId ?? ''))).map((friend) => friend.id)),
    [dmChannel, dmChannelId, friends],
  );
  const memberCount = dmChannel?.members.length ?? 0;
  const maxMembers = 10;
  const remainingSlots = maxMembers - memberCount;

  // Filter friends: client-side search, exclude self
  const filteredFriends = useMemo(() => {
    const q = query.trim().toLowerCase();
    return friends.filter((f) => {
      if (isSelf(f, myUser)) return false;
      if (!q) return true;
      const displayName = (f.displayName ?? '').toLowerCase();
      const username = f.username.toLowerCase();
      return displayName.includes(q) || username.includes(q);
    });
  }, [friends, query, myUser]);

  // Invalidate immediately even if a loss and regain of permission are batched
  // into one React render. An old request must not resume a new modal/session.
  useEffect(() => {
    const invalidate = () => {
      modalSession.current += 1;
      setIsAdding(false);
      setSelected(new Set());
    };
    const unsubscribeUi = useUIStore.subscribe((next, previous) => {
      if (next.activeModal !== previous.activeModal || next.modalData !== previous.modalData) invalidate();
    });
    const unsubscribeAuth = useAuthStore.subscribe((next, previous) => {
      if (next.token !== previous.token || next.user?.id !== previous.user?.id
        || next.user?.homeUserId !== previous.user?.homeUserId
        || next.user?.homeInstance !== previous.user?.homeInstance) invalidate();
    });
    const unsubscribeSpace = useSpaceStore.subscribe(() => {
      if (!dmChannelId) return;
      const current = useSpaceStore.getState().dmChannels.find((dm) => dm.id === dmChannelId);
      const home = dmCopyOnOrigin(dmChannelId, '');
      const viewer = useAuthStore.getState().user;
      if (!canAddDmMembers(current, viewer, getChannelOrigin(dmChannelId))
        || (home && !canAddDmMembers(home, viewer, ''))) invalidate();
    });
    return () => {
      modalSession.current += 1;
      unsubscribeUi();
      unsubscribeAuth?.();
      unsubscribeSpace();
    };
  }, [dmChannelId]);

  // Reset state when modal opens
  useEffect(() => {
    modalSession.current += 1;
    if (isOpen) {
      setQuery('');
      setSelected(new Set());
      setError('');
      setIsAdding(false);
      const timeout = setTimeout(() => inputRef.current?.focus(), 100);
      return () => {
        clearTimeout(timeout);
        modalSession.current += 1;
      };
    }
  }, [isOpen, dmChannelId, modalData, myUser?.id, authToken]);

  // Invite permission can change while this modal is open, including between two
  // requests in a batch. Hide immediately and clear the stale modal state.
  useEffect(() => {
    if (isOpen && !canAddMembers) closeModal();
  }, [isOpen, canAddMembers, closeModal]);

  const toggleFriend = (friendId: string) => {
    if (currentMemberIds.has(friendId)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(friendId)) {
        next.delete(friendId);
      } else {
        // Enforce remaining capacity
        if (next.size >= remainingSlots) return prev;
        next.add(friendId);
      }
      return next;
    });
  };

  const removeFriend = (friendId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(friendId);
      return next;
    });
  };

  const selectedFriends = useMemo(
    () => friends.filter((f) => selected.has(f.id)),
    [friends, selected],
  );

  const handleSubmit = async () => {
    if (!dmChannelId || !dmChannel || isAdding || selectedFriends.length === 0) return;
    const session = modalSession.current;
    const canStillAddMembers = () => {
      const ui = useUIStore.getState();
      const current = useSpaceStore.getState().dmChannels.find((dm) => dm.id === dmChannelId);
      const home = dmCopyOnOrigin(dmChannelId, '');
      const viewer = useAuthStore.getState().user;
      return session === modalSession.current
        && ui.activeModal === 'addDmMember' && ui.modalData === modalData
        && viewer?.id === myUser?.id && viewer?.homeUserId === myUser?.homeUserId
        && viewer?.homeInstance === myUser?.homeInstance && useAuthStore.getState().token === authToken
        && canAddDmMembers(current, viewer, getChannelOrigin(dmChannelId))
        && (!home || canAddDmMembers(home, viewer, ''));
    };
    if (!canStillAddMembers()) return;
    setError('');
    setIsAdding(true);
    // Both requests go to the home instance, which knows the conversation
    // only as its own copy: its id and its members. The row may be pinned to
    // another instance's copy, whose ids mean nothing there.
    const homeCopy = dmCopyOnOrigin(dmChannelId, '');
    try {
      if (!dmChannel.ownerId) {
        // 1-on-1 DM → create a new group DM with all selected + existing other member
        const source = homeCopy ?? dmChannel;
        const sourceOrigin = homeCopy ? '' : getChannelOrigin(dmChannelId);
        const partner = source.members.find((member) => !isDmMember({ ...source, members: [member] }, myUser, sourceOrigin));
        if (!partner) {
          setError(t('dm:addMember.noOtherMember'));
          setIsAdding(false);
          return;
        }
        // Home's own row for the partner when it holds the conversation;
        // otherwise the partner by their home identity, which home resolves.
        const partnerIdentity = homeCopy
          ? { id: partner.id, homeUserId: partner.homeUserId, homeInstance: partner.homeInstance }
          : {
              id: partner.id,
              homeUserId: partner.homeUserId ?? partner.id,
              homeInstance: partner.homeInstance ?? deliveringHost(getChannelOrigin(dmChannelId)),
            };
        const users = [
          partnerIdentity,
          ...selectedFriends.map(friendIdentity),
        ];
        // Home checks the source 1-on-1 by its own id; without a home copy
        // there is none to name.
        const newChannel = await api.dm.createGroup({ users, fromDmChannelId: homeCopy?.id });
        if (canStillAddMembers()) {
          const rowId = upsertDmCopy('', newChannel, 'stated');
          closeModal();
          navigate(`/channels/@me/${rowId}`);
        }
      } else {
        // Existing group DM → add each friend sequentially, on home's copy.
        if (!homeCopy) {
          setError(t('dm:addMember.failed'));
          setIsAdding(false);
          return;
        }
        for (const friend of selectedFriends) {
          if (!canStillAddMembers()) return;
          const identity = friendIdentity(friend);
          await api.dm.addMember(homeCopy.id, {
            userId: identity.homeInstance ? undefined : identity.id,
            homeUserId: identity.homeUserId ?? undefined,
            homeInstance: identity.homeInstance ?? undefined,
          });
        }
        if (canStillAddMembers()) closeModal();
      }
    } catch (err) {
      if (canStillAddMembers()) setError((err as Error).message || t('dm:addMember.failed'));
    } finally {
      if (session === modalSession.current) setIsAdding(false);
    }
  };

  const buttonText = selectedFriends.length === 0
    ? t('dm:addMember.selectFriends')
    : t('dm:addMember.addCount', { count: selectedFriends.length });

  return (
    <Modal isOpen={isOpen && canAddMembers} onClose={closeModal} title={t('dm:addMember.title')} mobileStyle="sheet">
      <div className="space-y-3">
        {/* Header with member count */}
        <div className="flex items-center justify-between">
          <p className="text-[13px] text-txt-tertiary">
            {t('dm:addMember.description')}
          </p>
          <span className="text-[12px] text-txt-tertiary flex-shrink-0 ml-2">
            {t('dm:addMember.capacity', { current: memberCount, max: maxMembers })}
          </span>
        </div>

        {/* Selected chips */}
        {selectedFriends.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            {selectedFriends.map((f) => (
              <span
                key={f.id}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] bg-accent-mint/15 text-accent-mint"
              >
                {f.displayName ?? parseFederatedUsername(f.username).baseName}
                <button
                  onClick={() => removeFriend(f.id)}
                  className="opacity-60 hover:opacity-100 transition-opacity text-[14px] leading-none"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Search input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('dm:addMember.searchPlaceholder')}
          className="input-search w-full py-2 text-[14px]"
          disabled={remainingSlots <= 0}
        />

        {remainingSlots <= 0 && (
          <p className="text-txt-danger text-[13px]">{t('dm:addMember.limitReached', { max: maxMembers })}</p>
        )}

        {error && (
          <p className="text-txt-danger text-[13px]">{error}</p>
        )}

        {/* Friend list */}
        <div className="max-h-[300px] overflow-y-auto space-y-[2px]">
          {filteredFriends.length === 0 && (
            <div className="py-4 text-center text-txt-tertiary text-[14px]">
              {query.trim() ? t('dm:addMember.noMatch') : t('dm:addMember.noFriends')}
            </div>
          )}

          {filteredFriends.map((friend) => {
            const isInDm = currentMemberIds.has(friend.id);
            const isSelected = selected.has(friend.id);
            const atCapacity = !isSelected && selected.size >= remainingSlots;
            return (
              <AddDmFriendRow
                key={friend.id}
                friend={friend}
                isInDm={isInDm}
                isSelected={isSelected}
                atCapacity={atCapacity}
                isAdding={isAdding}
                onToggle={toggleFriend}
              />
            );
          })}
        </div>

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={selectedFriends.length === 0 || isAdding}
          className="w-full py-2 rounded-md text-[13px] font-semibold transition-colors bg-accent-mint text-surface-base hover:bg-accent-mint/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isAdding ? t('dm:addMember.adding') : buttonText}
        </button>
      </div>
    </Modal>
  );
}
