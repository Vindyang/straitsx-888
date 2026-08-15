// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IMandateRegistry
/// @notice The on-chain record of which mandates exist, what policy body they
///         commit to, and whether the human has revoked them.
///
/// Interface fixed by docs/api-contracts.md §2. Not an HTTP service; consumed
/// exclusively through chain-gateway.
///
/// Non-goals: spend counters, the policy body itself, merchant rules. Those are
/// off-chain. What is on-chain is the minimum a third party needs to verify a
/// settlement was authorised: who owns the mandate, the hash of the policy it
/// was created under, when it expires, and whether it is still live.
///
/// The custom errors below are NOT in §2 — the spec states reverts only as
/// prose. They are additions and change the ABI that Owner B and Owner C
/// consume, so they are announced with the deployed address.
interface IMandateRegistry {
    /// @param mandateId  caller-chosen bytes32 id, unique forever
    /// @param owner      the human; the only address that can revoke
    /// @param policyHash hash of the canonical policy body (packages/contracts/mandate.ts)
    /// @param expiresAt  unix seconds; stored, never enforced here
    event MandateCreated(
        bytes32 indexed mandateId, address indexed owner, bytes32 policyHash, uint64 expiresAt
    );

    event MandateRevoked(bytes32 indexed mandateId, address indexed owner);

    /// @notice Thrown when `mandateId` is already taken. No silent overwrite:
    ///         repointing a live mandate's policyHash would defeat check 2.
    error MandateExists(bytes32 mandateId);

    /// @notice Thrown when `msg.sender` is not the mandate's owner. An unknown
    ///         mandate has owner == address(0), so this also covers unknown ids.
    error NotOwner(bytes32 mandateId, address caller);

    /// @notice Thrown on a second revoke. One event per mandate keeps the log
    ///         honest for the receipt.
    error AlreadyRevoked(bytes32 mandateId);

    /// @notice Register a mandate. Reverts if `mandateId` already exists.
    function createMandate(bytes32 mandateId, bytes32 policyHash, uint64 expiresAt) external;

    /// @notice Revoke a mandate. Owner only, NO timelock.
    /// @dev The absence of a timelock is deliberate and load-bearing: the kill
    ///      switch has to land within one block or it is theatre. Do not add a
    ///      delay, a two-step, or a guardian.
    function revoke(bytes32 mandateId) external;

    /// @notice Read a mandate.
    /// @return owner      address(0) if `mandateId` is unknown — the sentinel
    ///                    chain-gateway maps to 404 MANDATE_NOT_FOUND
    /// @return policyHash the committed policy hash
    /// @return expiresAt  unix seconds, reported verbatim; callers enforce it
    /// @return revoked    true once the owner has revoked
    function get(bytes32 mandateId)
        external
        view
        returns (address owner, bytes32 policyHash, uint64 expiresAt, bool revoked);
}
