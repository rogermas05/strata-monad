// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DemoUSDC} from "../src/TestAssets.sol";
import {StrataToken, StrataStaking, StrataDistributor} from "../src/Strata.sol";

contract StrataTest is Test {
    DemoUSDC usd;
    StrataToken strata;
    StrataStaking staking;
    StrataDistributor distributor;
    address alice = address(0xa11ce);
    address bob = address(0xb0b);
    address publisher = address(0x9b);

    function setUp() public {
        usd = new DemoUSDC();
        strata = new StrataToken();
        staking = new StrataStaking(address(strata), address(usd), 7 days);
        distributor = new StrataDistributor(address(strata), address(staking), publisher);
        strata.setMinter(address(distributor), true);
        strata.setMinter(address(this), true);
        strata.setTransferAllowed(address(staking), true);
        strata.setTransferAllowed(address(distributor), true);
        strata.mint(alice, 300e18);
        strata.mint(bob, 100e18);
        vm.prank(alice);
        strata.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        strata.approve(address(staking), type(uint256).max);
    }

    function leaf(address account, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
    }

    function pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function proofOf(bytes32 sibling) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = sibling;
    }

    function testTransfersLockedUntilEnabled() public {
        vm.prank(alice);
        vm.expectRevert("Transfers locked");
        strata.transfer(bob, 1);
        strata.enableTransfers();
        vm.prank(alice);
        strata.transfer(bob, 1);
        assertEq(strata.balanceOf(bob), 100e18 + 1);
    }

    function testOnlyMintersMintWithinCap() public {
        vm.prank(alice);
        vm.expectRevert("Minter only");
        strata.mint(alice, 1);
        uint256 cap = strata.MAX_SUPPLY();
        vm.expectRevert("Max supply");
        strata.mint(alice, cap);
    }

    function testFeesSplitProRataAndLateStakersDoNotBackdate() public {
        vm.prank(alice);
        staking.stake(300e18);
        usd.mint(address(staking), 100e6); // 100 USDC of fees before bob stakes
        vm.prank(bob);
        staking.stake(100e18);
        usd.mint(address(staking), 40e6);
        // Rewards round down per account, so dust stays in the pool and it never overpays.
        assertApproxEqAbs(staking.earned(alice), 130e6, 1);
        assertEq(staking.earned(bob), 10e6);
        vm.prank(alice);
        uint256 paidAlice = staking.claim();
        vm.prank(bob);
        uint256 paidBob = staking.claim();
        assertApproxEqAbs(paidAlice + paidBob, 140e6, 1);
        assertLe(paidAlice + paidBob, 140e6);
    }

    function testRewardsWaitForFirstStaker() public {
        usd.mint(address(staking), 50e6);
        staking.sync();
        vm.prank(bob);
        staking.stake(100e18);
        assertEq(staking.earned(bob), 50e6);
    }

    function testUnstakeStopsRewardsAndCoolsDown() public {
        vm.startPrank(alice);
        staking.stake(300e18);
        staking.requestUnstake(100e18);
        vm.expectRevert("Cooling down");
        staking.withdraw();
        vm.stopPrank();
        usd.mint(address(staking), 60e6);
        assertEq(staking.earned(alice), 60e6);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        staking.withdraw();
        assertEq(strata.balanceOf(alice), 100e18);
    }

    function testCumulativeMerkleClaimsAndStakeOption() public {
        bytes32 a1 = leaf(alice, 50e18);
        bytes32 b1 = leaf(bob, 20e18);
        vm.prank(publisher);
        distributor.publish(pair(a1, b1), 1);
        distributor.claim(alice, 50e18, proofOf(b1), false);
        assertEq(strata.balanceOf(alice), 350e18);
        vm.expectRevert("Account only");
        distributor.claim(bob, 20e18, proofOf(a1), true);
        vm.prank(bob);
        distributor.claim(bob, 20e18, proofOf(a1), true);
        assertEq(staking.staked(bob), 20e18);
        vm.expectRevert("Nothing to claim");
        distributor.claim(alice, 50e18, proofOf(b1), false);
        bytes32 a2 = leaf(alice, 80e18);
        vm.prank(publisher);
        vm.expectRevert("Stale epoch");
        distributor.publish(pair(a2, b1), 1);
        vm.prank(publisher);
        distributor.publish(pair(a2, b1), 2);
        distributor.claim(alice, 80e18, proofOf(b1), false);
        assertEq(strata.balanceOf(alice), 380e18);
        vm.expectRevert("Invalid proof");
        distributor.claim(alice, 90e18, proofOf(b1), false);
    }
}
