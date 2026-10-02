import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DmChannel, User } from '@backspace/shared';

let lastCropComplete: ((blob: Blob) => void) | null = null;

// ── Stubs for transitively-imported infra ──────────────────────────────────
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Mock ImageCropModal so tests can deterministically drive the
// `onCropComplete(blob)` path. The real `react-easy-crop` widget doesn't fire
// its `onCropComplete` callback reliably under jsdom (no real layout), so the
// production cropper is replaced with a minimal dialog that exposes a
// "Confirm Crop" button which immediately hands a synthetic Blob back to the
// parent — exercising the same staged-icon state transition as production.
vi.mock('../ui/ImageCropModal', () => ({
  ImageCropModal: ({
    isOpen,
    onCropComplete,
    onClose,
  }: {
    isOpen: boolean;
    imageSrc: string;
    onCropComplete: (blob: Blob) => void;
    onClose: () => void;
    title?: string;
    cropShape?: 'rect' | 'round';
    aspectRatio?: number;
    maxOutputDimension?: number;
  }) => {
    if (!isOpen) return null;
    lastCropComplete = onCropComplete;
    return (
      <div role="dialog" aria-label="cropper-mock">
        <button
          type="button"
          data-testid="cropper-mock-confirm"
          onClick={() =>
            onCropComplete(new Blob(['fake-image-bytes'], { type: 'image/webp' }))
          }
        >
          Confirm Crop
        </button>
        <button type="button" data-testid="cropper-mock-cancel" onClick={onClose}>
          Cancel Crop
        </button>
      </div>
    );
  },
}));

// Mock the api client — assert call counts on uploads + updateMetadata.
const mockUpdateMetadata = vi.fn();
const mockLeave = vi.fn();
const mockKickMember = vi.fn();
const mockTransferOwnership = vi.fn();
// Spread the real module: stores loaded through this tree extend HttpError
// at load time, so a bare object mock breaks the import.
vi.mock('../../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  api: {
    dm: {
      updateMetadata: (...args: unknown[]) => mockUpdateMetadata(...args),
      leave: (...args: unknown[]) => mockLeave(...args),
      kickMember: (...args: unknown[]) => mockKickMember(...args),
      transferOwnership: (...args: unknown[]) => mockTransferOwnership(...args),
    },
    uploads: { url: (f: string) => `/api/uploads/${f}` },
  },
}));

// Mock global fetch — used to detect *any* upload attempt. The test for
// "Cancel discards" asserts that no /api/uploads call ever happens.
const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({
    ok: true,
    json: async () => ({ filename: 'unused.webp' }),
  } as Response);
  // @ts-expect-error overriding jsdom global
  global.fetch = fetchSpy;
});

// Mock transferStore — Save path goes through startUpload → waitForTransferAttachment.
// We expose a controllable mock so tests assert call counts.
const mockStartUpload = vi.fn();
vi.mock('../../stores/transferStore', () => ({
  useTransferStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({}),
    {
      getState: () => ({
        startUpload: (...args: unknown[]) => mockStartUpload(...args),
        transfers: new Map(),
      }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

// Mock waitForTransferAttachment to resolve with a deterministic filename.
const mockWaitForTransfer = vi.fn();
vi.mock('../../utils/waitForTransfer', () => ({
  waitForTransferAttachment: (...args: unknown[]) => mockWaitForTransfer(...args),
}));

// Mock cropImage so ImageCropModal's apply step doesn't try to read a real image.
vi.mock('../../utils/cropImage', () => ({
  cropImage: vi.fn().mockResolvedValue(new Blob(['cropped'], { type: 'image/webp' })),
}));

import { GroupDmSettings } from './GroupDmSettings';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';

// ── Fixtures ───────────────────────────────────────────────────────────────
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-self',
    username: 'me',
    displayName: 'Me',
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 0,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
    ...overrides,
  };
}

function makeGroupDm(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    id: 'dm-1',
    federatedId: null,
    ownerId: 'user-self', // viewer is owner by default
    ownerHomeUserId: null,
    ownerHomeInstance: null,
    createdAt: 0,
    members: [
      makeUser({ id: 'user-self', username: 'me', displayName: 'Me' }),
      makeUser({ id: 'user-2', username: 'alice', displayName: 'Alice' }),
      makeUser({ id: 'user-3', username: 'bob', displayName: 'Bob' }),
    ],
    lastMessage: null,
    name: 'My Group',
    icon: null,
    metadataUpdatedAt: 0,
    membersCanInvite: true,
    ...overrides,
  };
}

function setStoreState(opts: { dmChannel: DmChannel; authUser: User | null }) {
  useUIStore.setState({
    activeModal: 'groupDmSettings',
    modalData: { dmChannelId: opts.dmChannel.id },
    isMobile: false,
  });
  useSpaceStore.setState({
    dmChannels: [opts.dmChannel],
  } as Partial<ReturnType<typeof useSpaceStore.getState>>);
  useAuthStore.setState({ user: opts.authUser } as Partial<ReturnType<typeof useAuthStore.getState>>);
  useSocialStore.setState({ friends: [] } as Partial<ReturnType<typeof useSocialStore.getState>>);
}

beforeEach(() => {
  useSpaceStore.setState({ channelOriginMap: new Map() });
  useAuthStore.setState({ token: 'session-token' });
  mockUpdateMetadata.mockReset();
  mockLeave.mockReset();
  mockKickMember.mockReset();
  mockTransferOwnership.mockReset();
  mockStartUpload.mockReset();
  mockWaitForTransfer.mockReset();
  mockUpdateMetadata.mockResolvedValue({});
  mockLeave.mockResolvedValue({ success: true });
  mockStartUpload.mockResolvedValue('transfer-1');
  mockWaitForTransfer.mockResolvedValue({ attachmentId: 'a-1', filename: 'icon-123.webp' });

  useUIStore.setState({
    activeModal: null,
    modalData: {},
    isMobile: false,
    toasts: [],
  });
});

function renderModal() {
  return render(<GroupDmSettings />);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GroupDmSettings — non-owner', () => {
  it('disables the name input, hides Save, and disables icon clicks', () => {
    const dm = makeGroupDm({ ownerId: 'user-2' }); // viewer is NOT owner
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderModal();

    const input = screen.getByLabelText('Group name') as HTMLInputElement;
    expect(input.disabled).toBe(true);

    // Save button is not rendered for non-owners; only "Close".
    expect(screen.queryByTestId).toBeDefined(); // sanity
    expect(document.querySelector('[data-group-dm-save]')).toBeNull();
    expect(document.querySelector('[data-group-dm-close]')).not.toBeNull();

    // Hero is a disabled button.
    const hero = document.querySelector('[data-group-dm-icon-hero]') as HTMLButtonElement;
    expect(hero.disabled).toBe(true);

    // Leave button is still enabled.
    const leaveBtn = document.querySelector('[data-group-dm-leave]') as HTMLButtonElement;
    expect(leaveBtn).not.toBeNull();
    expect(leaveBtn.disabled).toBe(false);
  });
});

describe('GroupDmSettings — owner overview', () => {
  it('enables the name input, name change marks dirty, Save calls updateMetadata', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ name: 'Old Name' });
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderModal();

    const input = screen.getByLabelText('Group name') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('Old Name');

    // Save is rendered but disabled when not dirty.
    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    await user.clear(input);
    await user.type(input, 'New Name');

    expect(saveBtn.disabled).toBe(false);
    await user.click(saveBtn);

    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    expect(mockUpdateMetadata).toHaveBeenCalledWith('dm-1', { name: 'New Name' });
    // Upload helpers should NOT fire — name-only edit.
    expect(mockStartUpload).not.toHaveBeenCalled();
  });

  it('no-op save: Save button stays disabled when nothing has changed', () => {
    const dm = makeGroupDm({ name: 'Stable' });
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();
    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });
});

describe('GroupDmSettings — icon staging', () => {
  // Helper: drive a crop blob into the staged-icon state by exercising the
  // production pipeline end-to-end:
  //   1. Fire a change event on the hidden file input (simulates file picker).
  //   2. Wait for the (mocked) ImageCropModal dialog to appear once
  //      FileReader.onload resolves and `cropSrc` becomes non-null.
  //   3. Click "Confirm Crop" on the mock — this fires the real
  //      `onCropComplete(blob)` callback synchronously, which causes
  //      GroupDmSettings to transition iconState → 'staged'.
  //   4. Wait for the cropper dialog to disappear (parent setCropSrc(null)).
  // After this helper resolves, the component is in the staged-icon state
  // and Save will exercise the upload + PATCH path.
  async function stageIcon(user: ReturnType<typeof userEvent.setup>) {
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    const file = new File(['raw'], 'pick.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });
    // Cropper opens once FileReader.onload resolves cropSrc.
    const confirmBtn = await screen.findByTestId('cropper-mock-confirm');
    await user.click(confirmBtn);
    // After confirm, the parent clears cropSrc → cropper unmounts.
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'cropper-mock' })).toBeNull(),
    );
  }

  it('Cancel discards a staged icon — no upload fires', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm();
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();

    // Stage an icon via the file picker → cropper round-trip. The mock
    // guarantees onCropComplete fires synchronously on click — if this throws
    // it's a real test failure (no graceful fallback).
    await stageIcon(user);

    // Sanity: staging marks the form dirty → Save becomes enabled.
    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));

    const cancelBtn = document.querySelector('[data-group-dm-cancel]') as HTMLButtonElement;
    await user.click(cancelBtn);

    // Cancel must close the modal and NOT fire any upload or PATCH.
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(mockStartUpload).not.toHaveBeenCalled();
    expect(mockUpdateMetadata).not.toHaveBeenCalled();
    // Direct /api/uploads POSTs (legacy paths) also must not have happened.
    const uploadCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
      typeof url === 'string' && url.includes('/api/uploads'),
    );
    expect(uploadCalls.length).toBe(0);
  });

  it('Save after staging an icon: upload fires, then PATCH fires with the filename', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm();
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();

    // Stage an icon via the cropper-mock — this hands a real Blob to the
    // component's handleCropComplete, transitioning iconState to 'staged'.
    await stageIcon(user);

    // Save should now trigger startUpload (the staged-icon code path).
    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    await user.click(saveBtn);

    await waitFor(() => expect(mockStartUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    expect(mockUpdateMetadata).toHaveBeenCalledWith('dm-1', { icon: 'icon-123.webp' });
  });

  it('Clearing the icon (X button): PATCH body contains icon: null', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ icon: 'existing.webp' });
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();

    const clearBtn = document.querySelector('[data-group-dm-icon-clear]') as HTMLButtonElement;
    expect(clearBtn).not.toBeNull();
    await user.click(clearBtn);

    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    await user.click(saveBtn);

    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    expect(mockUpdateMetadata).toHaveBeenCalledWith('dm-1', { icon: null });
    // No upload — clear-icon never stages a blob.
    expect(mockStartUpload).not.toHaveBeenCalled();
  });
});

describe('GroupDmSettings — leave', () => {
  it('confirming Leave calls api.dm.leave', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ ownerId: 'user-2' }); // non-owner can still leave
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();

    const leaveBtn = document.querySelector('[data-group-dm-leave]') as HTMLButtonElement;
    await user.click(leaveBtn);

    // The ConfirmDialog mounts in the same tree (no portal-mocking needed).
    const confirmBtn = await screen.findByRole('button', { name: /^leave$/i });
    await user.click(confirmBtn);

    await waitFor(() => expect(mockLeave).toHaveBeenCalledWith('dm-1'));
  });
});


describe('GroupDmSettings — adding group members', () => {
  function openMembers(dm: DmChannel) {
    setStoreState({ dmChannel: dm, authUser: makeUser() });
    useUIStore.setState({ modalData: { dmChannelId: dm.id, initialTab: 'members' } });
    renderModal();
  }

  it('hides the add-member entry point when a non-owner cannot invite', () => {
    openMembers(makeGroupDm({ ownerId: 'user-2', membersCanInvite: false }));
    expect(document.querySelector('[data-group-dm-add-member]')).toBeNull();
    expect(screen.queryByText(/Group is full/i)).not.toBeInTheDocument();
  });

  it('lets the local owner open the add-member modal', async () => {
    openMembers(makeGroupDm());
    const button = document.querySelector('[data-group-dm-add-member]') as HTMLButtonElement;
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(useUIStore.getState().activeModal).toBe('addDmMember');
    expect(useUIStore.getState().modalData.dmChannelId).toBe('dm-1');
  });

  it('recognizes the owner on a remote copy and removes the entry point after transfer', () => {
    const dm = makeGroupDm({
      ownerId: 'self-on-peer',
      membersCanInvite: false,
      members: [
        makeUser({ id: 'self-on-peer', homeUserId: 'user-self', homeInstance: window.location.host }),
        makeUser({ id: 'user-2', username: 'alice' }),
      ],
    });
    useSpaceStore.setState({ channelOriginMap: new Map([[dm.id, 'https://peer.example']]) });
    openMembers(dm);
    expect(document.querySelector('[data-group-dm-add-member]')).toBeEnabled();
    act(() => useSpaceStore.setState({ dmChannels: [{ ...dm, ownerId: 'user-2' }] }));
    expect(document.querySelector('[data-group-dm-add-member]')).toBeNull();
  });

  it('keeps the full-group hint for an owner at capacity', () => {
    openMembers(makeGroupDm({
      members: [makeUser(), ...Array.from({ length: 9 }, (_, index) => makeUser({ id: `member-${index}`, username: `member-${index}` }))],
    }));
    expect(document.querySelector('[data-group-dm-add-member]')).toBeDisabled();
    expect(screen.getByText(/group is full/i)).toBeInTheDocument();
  });
});


describe('GroupDmSettings — member invitation setting', () => {
  it.each([true, false])('owner saves membersCanInvite from %s to its opposite', async (allowed) => {
    const user = userEvent.setup();
    setStoreState({ dmChannel: makeGroupDm({ membersCanInvite: allowed }), authUser: makeUser() });
    renderModal();

    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', String(allowed));
    await user.click(toggle);
    await user.click(document.querySelector('[data-group-dm-save]') as HTMLButtonElement);
    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledWith('dm-1', { membersCanInvite: !allowed }));
    expect(mockStartUpload).not.toHaveBeenCalled();
  });

  it.each([true, false])('non-owner sees a read-only setting when it is %s', (allowed) => {
    setStoreState({ dmChannel: makeGroupDm({ ownerId: 'user-2', membersCanInvite: allowed }), authUser: makeUser() });
    renderModal();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', String(allowed));
  });

  it('defaults missing legacy settings to enabled', () => {
    setStoreState({ dmChannel: makeGroupDm({ membersCanInvite: undefined }), authUser: makeUser() });
    renderModal();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('replaces a local toggle draft when server metadata changes', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ membersCanInvite: true });
    setStoreState({ dmChannel: dm, authUser: makeUser() });
    renderModal();

    await user.click(screen.getByRole('switch'));
    act(() => useSpaceStore.setState({ dmChannels: [{ ...dm, membersCanInvite: false }] }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(document.querySelector('[data-group-dm-save]')).toBeDisabled();
    act(() => useSpaceStore.setState({ dmChannels: [dm] }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(document.querySelector('[data-group-dm-save]')).toBeDisabled();
  });

  it('lets an existing non-owner invite when the setting is enabled', async () => {
    setStoreState({ dmChannel: makeGroupDm({ ownerId: 'user-2' }), authUser: makeUser() });
    useUIStore.setState({ modalData: { dmChannelId: 'dm-1', initialTab: 'members' } });
    renderModal();
    const button = document.querySelector('[data-group-dm-add-member]') as HTMLButtonElement;
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(useUIStore.getState().activeModal).toBe('addDmMember');
  });
});


describe('GroupDmSettings — draft session safety', () => {
  async function stageMetadataIcon(user: ReturnType<typeof userEvent.setup>) {
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['image'], 'icon.png', { type: 'image/png' })] },
    });
    await user.click(await screen.findByTestId('cropper-mock-confirm'));
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  it.each(['owner', 'membership', 'account', 'token', 'metadata', 'close'])('invalidates uploads after transient %s changes', async (change) => {
    const user = userEvent.setup();
    const dm = makeGroupDm();
    const upload = deferred<{ filename: string }>();
    mockWaitForTransfer.mockReturnValueOnce(upload.promise);
    setStoreState({ dmChannel: dm, authUser: makeUser() });
    renderModal();

    await user.click(screen.getByRole('switch'));
    await stageMetadataIcon(user);
    await user.click(document.querySelector('[data-group-dm-save]') as HTMLButtonElement);
    await waitFor(() => expect(mockWaitForTransfer).toHaveBeenCalledTimes(1));
    act(() => {
      if (change === 'owner') {
        useSpaceStore.setState({ dmChannels: [{ ...dm, ownerId: 'user-2' }] });
        useSpaceStore.setState({ dmChannels: [dm] });
      } else if (change === 'membership') {
        useSpaceStore.setState({ dmChannels: [{ ...dm, members: dm.members.filter((m) => m.id !== 'user-self') }] });
        useSpaceStore.setState({ dmChannels: [dm] });
      } else if (change === 'account') {
        useAuthStore.setState({ user: null });
        useAuthStore.setState({ user: makeUser() });
      } else if (change === 'token') {
        useAuthStore.setState({ token: null });
        useAuthStore.setState({ token: 'session-token' });
      } else if (change === 'metadata') {
        useSpaceStore.setState({ dmChannels: [{ ...dm, membersCanInvite: false }] });
        useSpaceStore.setState({ dmChannels: [dm] });
      } else {
        useUIStore.getState().closeModal(); useUIStore.getState().openModal('groupDmSettings', { dmChannelId: 'dm-1' });
      }
    });
    await act(async () => upload.resolve({ filename: 'stale.webp' }));
    expect(mockUpdateMetadata).not.toHaveBeenCalled();
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('checks ownership immediately after startUpload resolves', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm();
    const started = deferred<string>();
    mockStartUpload.mockReturnValueOnce(started.promise);
    setStoreState({ dmChannel: dm, authUser: makeUser() });
    renderModal();

    await stageMetadataIcon(user);
    await user.click(document.querySelector('[data-group-dm-save]') as HTMLButtonElement);
    act(() => useSpaceStore.setState({ dmChannels: [{ ...dm, ownerId: 'user-2' }] }));
    await act(async () => started.resolve('stale-upload'));
    expect(mockWaitForTransfer).not.toHaveBeenCalled();
    expect(mockUpdateMetadata).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('cancel during an upload discards the draft and does not disturb the next edit', async () => {
    const user = userEvent.setup();
    const upload = deferred<{ filename: string }>();
    mockWaitForTransfer.mockReturnValueOnce(upload.promise);
    setStoreState({ dmChannel: makeGroupDm(), authUser: makeUser() });
    renderModal();

    await user.click(screen.getByRole('switch'));
    await stageMetadataIcon(user);
    await user.click(document.querySelector('[data-group-dm-save]') as HTMLButtonElement);
    await waitFor(() => expect(mockWaitForTransfer).toHaveBeenCalledTimes(1));
    await user.click(document.querySelector('[data-group-dm-cancel]') as HTMLButtonElement);
    act(() => useUIStore.getState().openModal('groupDmSettings', { dmChannelId: 'dm-1' }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('switch'));
    await act(async () => upload.resolve({ filename: 'stale.webp' }));
    expect(useUIStore.getState().activeModal).toBe('groupDmSettings');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(document.querySelector('[data-group-dm-save]')).toBeEnabled();
    expect(mockUpdateMetadata).not.toHaveBeenCalled();
    await user.click(document.querySelector('[data-group-dm-save]') as HTMLButtonElement);
    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledExactlyOnceWith('dm-1', { membersCanInvite: false }));
  });

  it.each(['success', 'failure'])('ignores a stale PATCH %s after cancellation and reopening', async (outcome) => {
    const user = userEvent.setup();
    const request = deferred<Record<string, never>>();
    mockUpdateMetadata.mockReturnValueOnce(request.promise);
    setStoreState({ dmChannel: makeGroupDm(), authUser: makeUser() });
    renderModal();

    await user.click(screen.getByRole('switch'));
    await user.click(document.querySelector('[data-group-dm-save]') as HTMLButtonElement);
    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    await user.click(document.querySelector('[data-group-dm-cancel]') as HTMLButtonElement);
    act(() => useUIStore.getState().openModal('groupDmSettings', { dmChannelId: 'dm-1' }));
    await user.click(screen.getByRole('switch'));
    await act(async () => {
      if (outcome === 'success') request.resolve({});
      else request.reject(new Error('old save failed'));
    });
    expect(useUIStore.getState().activeModal).toBe('groupDmSettings');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(document.querySelector('[data-group-dm-save]')).toBeEnabled();
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('resets unsaved permission changes when the account session changes', async () => {
    const user = userEvent.setup();
    setStoreState({ dmChannel: makeGroupDm(), authUser: makeUser() });
    renderModal();

    await user.click(screen.getByRole('switch'));
    act(() => useAuthStore.setState({ token: 'new-session' }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(document.querySelector('[data-group-dm-save]')).toBeDisabled();
  });

  it('uploads the icon to the owner instance before saving its metadata', async () => {
    const user = userEvent.setup();
    const owner = makeUser({ homeInstance: 'owner.example', homeUserId: 'user-self' });
    const dm = makeGroupDm({ members: [owner, makeUser({ id: 'user-2', username: 'alice' })] });
    setStoreState({ dmChannel: dm, authUser: owner });
    useSpaceStore.setState({ channelOriginMap: new Map([['dm-1', 'https://owner.example']]) });
    renderModal();

    await stageMetadataIcon(user);
    await user.click(document.querySelector('[data-group-dm-save]') as HTMLButtonElement);
    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    expect(mockStartUpload).toHaveBeenCalledWith(expect.any(File), { tray: false, origin: 'https://owner.example' });
  });
  it('does not apply an old crop completion to a reopened edit session', async () => {
    const user = userEvent.setup();
    setStoreState({ dmChannel: makeGroupDm(), authUser: makeUser() });
    renderModal();

    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['image'], 'icon.png', { type: 'image/png' })] },
    });
    await screen.findByTestId('cropper-mock-confirm');
    const oldCropComplete = lastCropComplete!;
    // Cancel the crop before leaving the edit session.
    await user.click(screen.getByTestId('cropper-mock-cancel'));
    await user.click(document.querySelector('[data-group-dm-cancel]') as HTMLButtonElement);
    act(() => useUIStore.getState().openModal('groupDmSettings', { dmChannelId: 'dm-1' }));
    act(() => oldCropComplete(new Blob(['stale-image'], { type: 'image/webp' })));
    expect(document.querySelector('[data-group-dm-save]')).toBeDisabled();
    expect(mockStartUpload).not.toHaveBeenCalled();
  });

  it('ignores an upload completion after unmount', async () => {
    const user = userEvent.setup();
    const upload = deferred<{ filename: string }>();
    mockWaitForTransfer.mockReturnValueOnce(upload.promise);
    setStoreState({ dmChannel: makeGroupDm(), authUser: makeUser() });
    const view = renderModal();

    await stageMetadataIcon(user);
    await user.click(document.querySelector('[data-group-dm-save]') as HTMLButtonElement);
    await waitFor(() => expect(mockWaitForTransfer).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => upload.resolve({ filename: 'stale.webp' }));
    expect(mockUpdateMetadata).not.toHaveBeenCalled();
  });

  it('resets the toggle when switching channels', async () => {
    const user = userEvent.setup();
    const first = makeGroupDm();
    const second = makeGroupDm({ id: 'dm-2', membersCanInvite: false });
    setStoreState({ dmChannel: first, authUser: makeUser() });
    useSpaceStore.setState({ dmChannels: [first, second] });
    renderModal();

    await user.click(screen.getByRole('switch'));
    act(() => useUIStore.getState().openModal('groupDmSettings', { dmChannelId: 'dm-2' }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(document.querySelector('[data-group-dm-save]')).toBeDisabled();
  });

  it('still finishes a valid save if its WebSocket update arrives before the PATCH response', async () => {
    const user = userEvent.setup();
    const request = deferred<Record<string, never>>();
    const dm = makeGroupDm();
    mockUpdateMetadata.mockReturnValueOnce(request.promise);
    setStoreState({ dmChannel: dm, authUser: makeUser() });
    renderModal();

    await user.click(screen.getByRole('switch'));
    await user.click(document.querySelector('[data-group-dm-save]') as HTMLButtonElement);
    act(() => useSpaceStore.setState({ dmChannels: [{ ...dm, membersCanInvite: false }] }));
    await act(async () => request.resolve({}));
    expect(useUIStore.getState().activeModal).toBeNull();
  });

});
