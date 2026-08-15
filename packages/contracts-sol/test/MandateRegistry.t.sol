// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {IMandateRegistry} from "../src/IMandateRegistry.sol";

/// @notice A3 — the registry test suite.
///
/// The five cases from the task board, plus the event and no-silent-overwrite
/// assertions A2 calls for. Written before the contract.
contract MandateRegistryTest is Test {
    MandateRegistry internal registry;

    address internal human = makeAddr("human");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant MANDATE_ID = bytes32(uint256(0x7f3a));
    bytes32 internal constant POLICY_HASH = bytes32(uint256(0xab12));
    uint64 internal constant EXPIRES_AT = 1786000000;

    function setUp() public {
        registry = new MandateRegistry();
    }

    function _create() internal {
        vm.prank(human);
        registry.createMandate(MANDATE_ID, POLICY_HASH, EXPIRES_AT);
    }

    // -----------------------------------------------------------------------
    // createMandate
    // -----------------------------------------------------------------------

    function test_createMandate_storesAndReadsBack() public {
        _create();

        (address owner, bytes32 policyHash, uint64 expiresAt, bool revoked) =
            registry.get(MANDATE_ID);

        assertEq(owner, human, "owner is the creator");
        assertEq(policyHash, POLICY_HASH, "policyHash round-trips");
        assertEq(expiresAt, EXPIRES_AT, "expiresAt round-trips");
        assertFalse(revoked, "a fresh mandate is not revoked");
    }

    function test_createMandate_emitsMandateCreated() public {
        vm.expectEmit(true, true, true, true);
        emit IMandateRegistry.MandateCreated(MANDATE_ID, human, POLICY_HASH, EXPIRES_AT);

        vm.prank(human);
        registry.createMandate(MANDATE_ID, POLICY_HASH, EXPIRES_AT);
    }

    /// A2: "Revert on createMandate for an existing id — no silent overwrite."
    /// A silent overwrite would let anyone repoint a live mandate's policyHash,
    /// which is check 2's entire basis.
    function test_createMandate_duplicateId_reverts() public {
        _create();

        vm.prank(human);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateRegistry.MandateExists.selector, MANDATE_ID)
        );
        registry.createMandate(MANDATE_ID, POLICY_HASH, EXPIRES_AT);
    }

    /// Even a different caller with different data cannot take over the id.
    function test_createMandate_duplicateId_byStranger_reverts() public {
        _create();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateRegistry.MandateExists.selector, MANDATE_ID)
        );
        registry.createMandate(MANDATE_ID, bytes32(uint256(0xdead)), EXPIRES_AT);

        (address owner, bytes32 policyHash,,) = registry.get(MANDATE_ID);
        assertEq(owner, human, "owner unchanged");
        assertEq(policyHash, POLICY_HASH, "policyHash unchanged");
    }

    // -----------------------------------------------------------------------
    // revoke — owner only, NO timelock (instant revoke is demo Run 3)
    // -----------------------------------------------------------------------

    function test_revoke_byOwner_setsRevokedTrue() public {
        _create();

        vm.prank(human);
        registry.revoke(MANDATE_ID);

        (,,, bool revoked) = registry.get(MANDATE_ID);
        assertTrue(revoked, "a revoked mandate reads revoked == true");
    }

    /// Run 3 depends on a revoke landing within one block. No timelock, no
    /// delay, no two-step. Same transaction, same block, immediately visible.
    function test_revoke_isImmediate_sameBlock() public {
        _create();
        uint256 blockAtCreate = block.number;

        vm.prank(human);
        registry.revoke(MANDATE_ID);

        assertEq(block.number, blockAtCreate, "no block advanced");
        (,,, bool revoked) = registry.get(MANDATE_ID);
        assertTrue(revoked, "revoked in the same block it was requested");
    }

    function test_revoke_emitsMandateRevoked() public {
        _create();

        vm.expectEmit(true, true, true, true);
        emit IMandateRegistry.MandateRevoked(MANDATE_ID, human);

        vm.prank(human);
        registry.revoke(MANDATE_ID);
    }

    function test_revoke_byNonOwner_reverts() public {
        _create();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateRegistry.NotOwner.selector, MANDATE_ID, stranger)
        );
        registry.revoke(MANDATE_ID);

        (,,, bool revoked) = registry.get(MANDATE_ID);
        assertFalse(revoked, "a failed revoke changes nothing");
    }

    /// An unknown mandate has owner == address(0), so any caller is a non-owner.
    function test_revoke_unknownId_reverts() public {
        bytes32 unknownId = bytes32(uint256(0xffff));

        vm.prank(human);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateRegistry.NotOwner.selector, unknownId, human)
        );
        registry.revoke(unknownId);
    }

    /// One MandateRevoked event per mandate keeps the event log honest — the
    /// receipt story reads the log, and a duplicate would misdate the revocation.
    function test_revoke_twice_reverts() public {
        _create();

        vm.startPrank(human);
        registry.revoke(MANDATE_ID);

        vm.expectRevert(
            abi.encodeWithSelector(IMandateRegistry.AlreadyRevoked.selector, MANDATE_ID)
        );
        registry.revoke(MANDATE_ID);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // get — the unknown-id sentinel chain-gateway maps to 404
    // -----------------------------------------------------------------------

    function test_get_unknownId_returnsZeroOwner() public view {
        (address owner, bytes32 policyHash, uint64 expiresAt, bool revoked) =
            registry.get(bytes32(uint256(0xdeadbeef)));

        assertEq(owner, address(0), "owner == address(0) is the unknown-id sentinel");
        assertEq(policyHash, bytes32(0));
        assertEq(expiresAt, 0);
        assertFalse(revoked);
    }

    // -----------------------------------------------------------------------
    // expiry is stored, NOT enforced on-chain — callers enforce it
    // -----------------------------------------------------------------------

    /// A3: "expired mandate: expiresAt respected by callers". The contract is a
    /// registry, not a clock. It stores the timestamp faithfully and keeps
    /// answering reads after it passes; policy-service's check 1 compares
    /// `now < expiresAt`. Enforcing here would silently change `get`'s meaning.
    function test_get_afterExpiry_stillReadableAndUnrevoked() public {
        _create();

        vm.warp(uint256(EXPIRES_AT) + 1 days);

        (address owner,, uint64 expiresAt, bool revoked) = registry.get(MANDATE_ID);
        assertEq(owner, human, "an expired mandate is still readable");
        assertEq(expiresAt, EXPIRES_AT, "expiresAt is reported verbatim");
        assertFalse(revoked, "expiry is not revocation: different states");
        assertLt(expiresAt, block.timestamp, "and it really is in the past");
    }

    /// Creating an already-expired mandate is permitted: the contract does not
    /// enforce expiry in either direction. Adding an unspecified validation
    /// here would be a rule nobody agreed to.
    function test_createMandate_pastExpiry_isAllowed() public {
        vm.warp(uint64(EXPIRES_AT) + 1 days);

        vm.prank(human);
        registry.createMandate(MANDATE_ID, POLICY_HASH, EXPIRES_AT);

        (address owner,,,) = registry.get(MANDATE_ID);
        assertEq(owner, human);
    }

    /// Revoking an expired mandate must still work — the kill switch cannot
    /// depend on the clock.
    function test_revoke_afterExpiry_stillWorks() public {
        _create();
        vm.warp(uint256(EXPIRES_AT) + 1 days);

        vm.prank(human);
        registry.revoke(MANDATE_ID);

        (,,, bool revoked) = registry.get(MANDATE_ID);
        assertTrue(revoked);
    }

    // -----------------------------------------------------------------------
    // isolation between mandates
    // -----------------------------------------------------------------------

    function test_revoke_doesNotAffectOtherMandates() public {
        bytes32 otherId = bytes32(uint256(0x1234));
        _create();
        vm.prank(human);
        registry.createMandate(otherId, POLICY_HASH, EXPIRES_AT);

        vm.prank(human);
        registry.revoke(MANDATE_ID);

        (,,, bool revokedOther) = registry.get(otherId);
        assertFalse(revokedOther, "revoking one mandate leaves the others live");
    }

    function testFuzz_createAndGet_roundTrips(
        bytes32 mandateId,
        bytes32 policyHash,
        uint64 expiresAt,
        address creator
    ) public {
        vm.assume(creator != address(0));

        vm.prank(creator);
        registry.createMandate(mandateId, policyHash, expiresAt);

        (address owner, bytes32 gotHash, uint64 gotExpiry, bool revoked) =
            registry.get(mandateId);

        assertEq(owner, creator);
        assertEq(gotHash, policyHash);
        assertEq(gotExpiry, expiresAt);
        assertFalse(revoked);
    }
}
