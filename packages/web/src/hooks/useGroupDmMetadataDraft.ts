import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DmChannel } from '@backspace/shared';
import { api } from '../api/client';
import { useAuthStore } from '../stores/authStore';
import { getChannelOrigin, useSpaceStore } from '../stores/spaceStore';
import { useTransferStore } from '../stores/transferStore';
import { useUIStore } from '../stores/uiStore';
import { getDmMetadataTarget } from '../utils/crossStoreResolvers';
import { canAddDmMembers, isDmOwner } from '../utils/dmPermissions';
import { waitForTransferAttachment } from '../utils/waitForTransfer';

type IconState =
  | { kind: 'unchanged' }
  | { kind: 'cleared' }
  | { kind: 'staged'; blob: Blob; previewUrl: string };

function mayEdit(channel: DmChannel | null | undefined): boolean {
  const viewer = useAuthStore.getState().user;
  const origin = channel ? getChannelOrigin(channel.id) : '';
  return isDmOwner(channel, viewer, origin) && canAddDmMembers(channel, viewer, origin);
}

function metadataKey(channel: DmChannel | null | undefined): string {
  return JSON.stringify([channel?.name, channel?.icon, channel?.membersCanInvite !== false]);
}

/** Shared drafts and cancellable save sessions for desktop and mobile group settings. */
export function useGroupDmMetadataDraft(
  channel: DmChannel | null,
  active: boolean,
  surface: 'modal' | 'mobile',
  onSaved: () => void,
) {
  const { t } = useTranslation('dm');
  const viewer = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const sessionKey = useUIStore((s) => surface === 'modal' ? s.modalData : s.mobileStack);
  const [name, setName] = useState('');
  const [membersCanInvite, setMembersCanInvite] = useState(true);
  const [iconState, setIconState] = useState<IconState>({ kind: 'unchanged' });
  const [crop, setCrop] = useState<{ src: string; isCurrent: () => boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const generation = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const savingRef = useRef(false);
  const patchingRef = useRef(false);
  const isOwner = mayEdit(channel);
  const channelId = channel?.id;
  const currentName = channel?.name ?? '';
  const currentIcon = channel?.icon;
  const currentMembersCanInvite = channel?.membersCanInvite !== false;

  const invalidate = useCallback(() => {
    generation.current += 1;
    savingRef.current = false;
    patchingRef.current = false;
    setSaving(false);
  }, []);

  const resetDraft = useCallback((nextName: string, nextMembersCanInvite: boolean) => {
    setName(nextName);
    setMembersCanInvite(nextMembersCanInvite);
    setIconState({ kind: 'unchanged' });
    setCrop(null);
    setSaveError('');
  }, []);

  // Subscribe synchronously: losing and regaining ownership, logging out/in,
  // or closing/reopening in one React batch must still cancel the old save.
  useEffect(() => {
    const cancelSession = () => {
      invalidate();
      const latest = useSpaceStore.getState().dmChannels.find((dm) => dm.id === channelId);
      resetDraft(latest?.name ?? '', latest?.membersCanInvite !== false);
    };
    const unsubscribeAuth = useAuthStore.subscribe((next, previous) => {
      if (next.token !== previous.token || next.user?.id !== previous.user?.id
        || next.user?.homeUserId !== previous.user?.homeUserId
        || next.user?.homeInstance !== previous.user?.homeInstance) cancelSession();
    });
    const unsubscribeSpace = useSpaceStore.subscribe((next, previous) => {
      const current = next.dmChannels.find((dm) => dm.id === channelId);
      const before = previous.dmChannels.find((dm) => dm.id === channelId);
      if ((!patchingRef.current && metadataKey(current) !== metadataKey(before))
        || !mayEdit(current) || current?.ownerId !== before?.ownerId
        || next.channelOriginMap.get(channelId ?? '') !== previous.channelOriginMap.get(channelId ?? '')) cancelSession();
    });
    const unsubscribeUi = useUIStore.subscribe((next, previous) => {
      if (surface === 'modal'
        ? next.activeModal !== previous.activeModal || next.modalData !== previous.modalData
        : next.mobileStack !== previous.mobileStack || next.mobileScreen !== previous.mobileScreen) cancelSession();
    });
    return () => {
      generation.current += 1;
      savingRef.current = false;
      unsubscribeAuth();
      unsubscribeSpace();
      unsubscribeUi();
    };
  }, [channelId, surface, invalidate, resetDraft]);

  useEffect(() => {
    invalidate();
  }, [active, channelId, sessionKey, token, viewer?.id, viewer?.homeUserId, viewer?.homeInstance, isOwner, invalidate]);

  // A remote metadata update replaces the draft too. Before PATCH, save checks
  // its original metadata snapshot; its own WS update may arrive before the
  // PATCH response and must not prevent a successful save from dismissing.
  useEffect(() => {
    resetDraft(currentName, currentMembersCanInvite);
  }, [active, channelId, sessionKey, token, viewer?.id, viewer?.homeUserId, viewer?.homeInstance, isOwner, currentName, currentIcon, currentMembersCanInvite, resetDraft]);

  const stagedUrl = iconState.kind === 'staged' ? iconState.previewUrl : null;
  useEffect(() => () => {
    if (stagedUrl) URL.revokeObjectURL(stagedUrl);
  }, [stagedUrl]);

  const captureSession = () => {
    const capturedGeneration = generation.current;
    return () => {
      const ui = useUIStore.getState();
      const topScreen = ui.mobileStack[ui.mobileStack.length - 1];
      const currentSurface = surface === 'modal'
        ? ui.activeModal === 'groupDmSettings' && ui.modalData.dmChannelId === channelId
        : topScreen?.screen === 'group-dm-info' && topScreen.params?.channelId === channelId;
      return currentSurface && activeRef.current && generation.current === capturedGeneration
        && mayEdit(useSpaceStore.getState().dmChannels.find((dm) => dm.id === channelId));
    };
  };

  const discard = () => {
    invalidate();
    resetDraft(currentName, currentMembersCanInvite);
  };

  const readIcon = (file: File) => {
    if (!captureSession()() || savingRef.current) return;
    generation.current += 1;
    const isCurrent = captureSession();
    const reader = new FileReader();
    reader.onload = () => {
      if (isCurrent() && typeof reader.result === 'string') setCrop({ src: reader.result, isCurrent });
    };
    reader.readAsDataURL(file);
  };

  const stageIcon = (blob: Blob) => {
    if (!crop?.isCurrent() || savingRef.current) return;
    setIconState({ kind: 'staged', blob, previewUrl: URL.createObjectURL(blob) });
    setCrop(null);
  };

  const closeCrop = () => {
    invalidate();
    setCrop(null);
  };

  const clearIcon = () => {
    if (captureSession()() && !savingRef.current) setIconState({ kind: 'cleared' });
  };

  const trimmedName = name.trim();
  const nameDirty = trimmedName !== currentName.trim();
  const inviteDirty = membersCanInvite !== currentMembersCanInvite;
  const isDirty = nameDirty || inviteDirty || iconState.kind !== 'unchanged';

  const save = async () => {
    const isCurrent = captureSession();
    if (!channelId || !isCurrent() || !isDirty || savingRef.current) return;
    const originalMetadata = metadataKey(channel);
    const target = getDmMetadataTarget(channelId);
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      if (!target) throw new Error(t('groupSettings.ownerUnavailable'));
      const body: { name?: string | null; icon?: string | null; membersCanInvite?: boolean } = {};
      if (nameDirty) body.name = trimmedName.slice(0, 50);
      if (inviteDirty) body.membersCanInvite = membersCanInvite;
      if (iconState.kind === 'cleared') {
        body.icon = null;
      } else if (iconState.kind === 'staged') {
        const file = new File([iconState.blob], 'dm-icon.webp', { type: iconState.blob.type || 'image/webp' });
        const transferId = await useTransferStore.getState().startUpload(file, { tray: false, origin: target.origin });
        if (!isCurrent()) return;
        const { filename } = await waitForTransferAttachment(transferId);
        if (!isCurrent()) return;
        body.icon = filename;
      }
      const latest = useSpaceStore.getState().dmChannels.find((dm) => dm.id === channelId);
      const latestTarget = getDmMetadataTarget(channelId);
      if (!isCurrent() || metadataKey(latest) !== originalMetadata
        || latestTarget?.origin !== target.origin || latestTarget.channelId !== target.channelId) return;
      patchingRef.current = true;
      await api.dm.updateMetadata(channelId, body);
      if (isCurrent()) {
        discard();
        onSaved();
      }
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : t('groupSettings.saveFailed');
      setSaveError(message);
      useUIStore.getState().addToast(message, 'warning', 4000);
    } finally {
      if (isCurrent()) {
        savingRef.current = false;
        patchingRef.current = false;
        setSaving(false);
      }
    }
  };

  const previewIconUrl = iconState.kind === 'staged'
    ? iconState.previewUrl : iconState.kind === 'cleared' ? null : (currentIcon ?? null);

  return {
    name, setName, trimmedName, membersCanInvite, setMembersCanInvite,
    cropSrc: crop?.src ?? null, closeCrop, saving, saveError, isOwner, isDirty, previewIconUrl,
    readIcon, stageIcon, clearIcon, discard, save,
  };
}
