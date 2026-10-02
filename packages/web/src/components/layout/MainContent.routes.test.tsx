import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via the voice components and stores.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

vi.mock('../chat/MessageList', () => ({ MessageList: () => null }));
vi.mock('../chat/MessageInput', () => ({ MessageInput: () => null }));
vi.mock('./TransferIndicator', () => ({ TransferIndicator: () => null }));

// The pages themselves have their own tests; here only which one renders matters.
vi.mock('../chat/ExplorePage', () => ({ ExplorePage: () => <div data-testid="page">explore</div> }));
vi.mock('../chat/FriendsPage', () => ({ FriendsPage: () => <div data-testid="page">friends</div> }));
vi.mock('../projectHub/ProjectHubPage', () => ({ ProjectHubPage: () => <div data-testid="page">backspace</div> }));

import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { MainContent } from './MainContent';
import { useAuthStore } from '../../stores/authStore';
import { wireDm } from '../../test/dmWireShape';
import type { User } from '@backspace/shared';

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <MainContent />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useChatStore.setState({ currentChannelId: null });
  useSpaceStore.setState({ currentSpaceId: null, channels: [], dmChannels: [] });
  useUIStore.setState({ showDms: false });
});

describe('MainContent home pages', () => {
  it('renders the Backspace page on /backspace', () => {
    renderAt('/backspace');
    expect(screen.getByTestId('page')).toHaveTextContent('backspace');
  });

  it('still renders Explore on /explore', () => {
    renderAt('/explore');
    expect(screen.getByTestId('page')).toHaveTextContent('explore');
  });

  it('renders Friends on the DM home', () => {
    useUIStore.setState({ showDms: true });
    renderAt('/channels/@me');
    expect(screen.getByTestId('page')).toHaveTextContent('friends');
  });

  it('renders the Backspace page on /backspace before the previous space is cleared', () => {
    // The route effect that clears the space runs after the first render.
    useSpaceStore.setState({ currentSpaceId: 'space-1' });
    renderAt('/backspace');
    expect(screen.getByTestId('page')).toHaveTextContent('backspace');
  });
});


describe('MainContent add-friends permissions', () => {
  const viewer = {
    id: 'viewer', username: 'viewer', displayName: null, avatar: null, banner: null,
    accentColor: null, avatarColor: null, bio: null, status: 'online', customStatus: null,
    isAdmin: false, createdAt: 0, homeInstance: null, homeUserId: null, replicatedInstances: [],
  } satisfies User;
  const other = { ...viewer, id: 'other', username: 'other' };

  beforeEach(() => {
    useAuthStore.setState({ user: viewer });
    useChatStore.setState({ currentChannelId: 'dm' });
    useSpaceStore.setState({ channelOriginMap: new Map() });
    useUIStore.setState({ showDms: true });
  });

  it('keeps the add-friends entry point for either participant in a 1:1 DM', () => {
    useSpaceStore.setState({ dmChannels: [wireDm({ id: 'dm', createdAt: 0, members: [other, viewer] })] });
    renderAt('/channels/@me/dm');
    expect(screen.getByTitle('Add Friends to DM')).toBeInTheDocument();
  });

  it('hides the entry point from other group members when invitations are disabled', () => {
    useSpaceStore.setState({ dmChannels: [wireDm({ id: 'dm', createdAt: 0, ownerId: other.id, membersCanInvite: false, members: [other, viewer] })] });
    renderAt('/channels/@me/dm');
    expect(screen.queryByTitle('Add Friends to DM')).not.toBeInTheDocument();
  });

  it('shows the local owner the entry point', () => {
    useSpaceStore.setState({ dmChannels: [wireDm({ id: 'dm', createdAt: 0, ownerId: viewer.id, members: [viewer, other] })] });
    renderAt('/channels/@me/dm');
    expect(screen.getByTitle('Add Friends to DM')).toBeInTheDocument();
  });

  it('follows a federated owner and an ownership transfer reactively', () => {
    const alias = { ...viewer, id: 'viewer-on-peer', homeUserId: viewer.id, homeInstance: window.location.host };
    const dm = wireDm({ id: 'dm', createdAt: 0, ownerId: alias.id, membersCanInvite: false, members: [alias, other] });
    useSpaceStore.setState({ dmChannels: [dm], channelOriginMap: new Map([['dm', 'https://peer.example']]) });
    renderAt('/channels/@me/dm');
    expect(screen.getByTitle('Add Friends to DM')).toBeInTheDocument();
    act(() => useSpaceStore.setState({ dmChannels: [{ ...dm, ownerId: other.id }] }));
    expect(screen.queryByTitle('Add Friends to DM')).not.toBeInTheDocument();
  });

  it('shows members the default-on entry point and follows permission changes', () => {
    const dm = wireDm({ id: 'dm', createdAt: 0, ownerId: other.id, members: [other, viewer] });
    useSpaceStore.setState({ dmChannels: [dm] });
    renderAt('/channels/@me/dm');
    expect(screen.getByTitle('Add Friends to DM')).toBeInTheDocument();
    act(() => useSpaceStore.setState({ dmChannels: [{ ...dm, membersCanInvite: false }] }));
    expect(screen.queryByTitle('Add Friends to DM')).not.toBeInTheDocument();
    act(() => useSpaceStore.setState({ dmChannels: [{ ...dm, membersCanInvite: true }] }));
    expect(screen.getByTitle('Add Friends to DM')).toBeInTheDocument();
  });

  it('hides the entry point from a non-member even when invitations are enabled', () => {
    useSpaceStore.setState({ dmChannels: [wireDm({ id: 'dm', createdAt: 0, ownerId: other.id, members: [other] })] });
    renderAt('/channels/@me/dm');
    expect(screen.queryByTitle('Add Friends to DM')).not.toBeInTheDocument();
  });

});
