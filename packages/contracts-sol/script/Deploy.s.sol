// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";

/// @notice A4/A5 — deploy MandateRegistry to Fuji (43113) and mainnet (43114).
///
/// The deployer is NOT the signer. This contract holds no funds and the KMS key
/// never touches it: `createMandate` and `revoke` are called by the human's own
/// wallet from the dashboard, via the unsigned tx that chain-gateway builds.
/// Deploy from any funded EOA.
///
/// Usage — import a key into an encrypted keystore ONCE, never into an env file:
///
///   cast wallet import registry-deployer --interactive
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url https://api.avax-test.network/ext/bc/C/rpc \
///     --account registry-deployer \
///     --broadcast
///
/// Then publish the address:  pnpm tsx scripts/sync-registry.ts 43113
contract Deploy is Script {
    function run() external returns (MandateRegistry registry) {
        vm.startBroadcast();
        registry = new MandateRegistry();
        vm.stopBroadcast();

        console.log("MandateRegistry deployed");
        console.log("  chainId:", block.chainid);
        console.log("  address:", address(registry));
        console.log("  block:  ", block.number);
    }
}
