# Group DM member invitations

Status: fork prototype; pending upstream maintainer design approval.

## Problem and proposed behavior

Hard owner-only invitations change the existing group DM experience. Give each
owner an explicit **Allow members to invite people** setting, enabled by default
for existing and new groups. With it off, only the current owner may invite.
Members still need to be friends with the invited person, and the ten-member
limit remains. Only the owner changes the setting; it survives ownership transfer.
Converting a one-to-one conversation still creates a separate, default-on group.

## Approach

Add one non-null SQLite boolean, `dm_channels.members_can_invite`, with a true
migration/default. Include it in the single `DmChannel` serializer. Extend the
existing owner-only metadata PATCH, `dm_channel_updated` event and owner-authority
`group_metadata_update` relay; use their existing metadata version and make local
versions strictly monotonic. Metadata recovery belongs in existing initial sync.
The existing ownership-transfer event also carries an optional full metadata snapshot, so a transfer arriving before a missed OFF update cannot lose the restriction or its version. There is no new role model, permission bit, event bus or dependency.

Desktop and mobile group settings expose the same toggle and history-sharing
explanation. Non-owners see the value read-only. Add controls require canonical
membership and either ownership or enabled invitations. Stale dialogs and pending
batches stop on loss of permission; saves recheck the modal session and owner after
asynchronous icon uploads. Metadata requests use the owner's instance-local copy
ID as well as its origin.

## Authority and compatibility

Incremental membership relays use their locally stored permission and owner,
never the invitation's claimed setting. Actor identity remains home-user-ID plus
home instance, verified against the signing peer and existing roster. Metadata
relays require the current owner actor and owner instance; delayed work rechecks
that authority before applying.

A new peer has no recorded permission. An owner-initiated bootstrap retains its
existing authenticated owner/homeward authority. A non-owner bootstrap requires
a direct signature from the owner's home instance, enabled invitations, and both
owner and adder in the roster. A remote member cannot authorize bootstrapping a
brand-new third peer with a self-asserted owner setting. That existing general
limitation remains; the previously accepted homeward non-owner edge is now
refused too. The owner can invite instead. A separate owner-authorization
protocol would be needed to support all third-peer member invitations.

Legacy channel/bootstrap omission means enabled. Legacy metadata omission means
preserve the stored setting. Old servers do not enforce the flag; every involved
instance must support it for consistent restrictions. Existing replication is
asynchronous, so each updated receiver enforces the last owner state it received.
This prototype does not claim synchronous distributed revocation. The ten-member cap is also per copy: concurrent additions on different instances near the cap can diverge when each rejects the other's add. Owner-mediated admission or a separate deterministic convergence rule would be needed for a globally serialized cap.

## Alternatives and review questions

- Hard owner-only invitations: removes useful existing behavior and offers no choice
- Trust a member's claimed setting on bootstrap: allows a peer to forge another
  instance's owner permission, so rejected
- New owner-authorized invitation forwarding/proof protocol: supports new third
  peers and could centralize decisions, but introduces a larger protocol and
  availability tradeoff; intentionally deferred for upstream design discussion
- General DM permission bitset/role system: unnecessary for this single setting

Upstream review should agree the default, migration behavior, compatibility
limits and bootstrap boundary before considering this production-ready.

## Verification scope

Migration defaults/persistence; owner and non-owner REST changes; member/nonmember
adds with both values; omitted/malformed values; origin-qualified identities;
authenticated bootstrap and incremental relays; stale and recovered metadata;
ownership changes; desktop/mobile toggle, legacy merge, owner-copy routing and
interrupted/repeated UI flows. Automated results and manual UI evidence limits
are recorded in the pull request without marking upstream approval or CLA consent.
