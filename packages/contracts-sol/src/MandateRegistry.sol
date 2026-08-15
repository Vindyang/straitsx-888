// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMandateRegistry} from "./IMandateRegistry.sol";

/// @title MandateRegistry
/// @notice Deliberately minimal. Every field it stores is one a third party
///         needs to verify that a settlement was authorised; nothing else lives
///         here.
///
/// Two properties are load-bearing and must survive any future edit:
///
///  1. `createMandate` never overwrites. `policyHash` is what check 2 compares
///     a local policy body against, so an id that can be repointed makes the
///     whole check meaningless.
///  2. `revoke` is instant. No timelock, no two-step, no guardian. Demo Run 3
///     is a revocation landing within one block, and a delayed kill switch is
///     not a kill switch.
///
/// Expiry is stored and reported, never enforced. This contract is a registry,
/// not a clock: policy-service's check 1 compares `now < expiresAt` on every
/// decision. Enforcing here would silently change what `get` means to callers
/// that already handle expiry themselves.
contract MandateRegistry is IMandateRegistry {
    struct Mandate {
        address owner; // slot 0: 20 bytes
        uint64 expiresAt; //         + 8 bytes
        bool revoked; //         + 1 byte  = 29, one slot
        bytes32 policyHash; // slot 1
    }

    mapping(bytes32 => Mandate) private _mandates;

    /// @inheritdoc IMandateRegistry
    function createMandate(bytes32 mandateId, bytes32 policyHash, uint64 expiresAt) external {
        Mandate storage m = _mandates[mandateId];
        if (m.owner != address(0)) revert MandateExists(mandateId);

        m.owner = msg.sender;
        m.policyHash = policyHash;
        m.expiresAt = expiresAt;
        // `revoked` stays false; a fresh mandate is live.

        emit MandateCreated(mandateId, msg.sender, policyHash, expiresAt);
    }

    /// @inheritdoc IMandateRegistry
    function revoke(bytes32 mandateId) external {
        Mandate storage m = _mandates[mandateId];

        // An unknown mandate has owner == address(0), which no caller can be,
        // so this single check covers both "not yours" and "does not exist".
        if (m.owner != msg.sender) revert NotOwner(mandateId, msg.sender);
        if (m.revoked) revert AlreadyRevoked(mandateId);

        m.revoked = true;

        emit MandateRevoked(mandateId, msg.sender);
    }

    /// @inheritdoc IMandateRegistry
    function get(bytes32 mandateId)
        external
        view
        returns (address owner, bytes32 policyHash, uint64 expiresAt, bool revoked)
    {
        Mandate storage m = _mandates[mandateId];
        return (m.owner, m.policyHash, m.expiresAt, m.revoked);
    }
}
