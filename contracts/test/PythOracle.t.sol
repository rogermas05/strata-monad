// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPythCore, PythExpiryOracle} from "../src/Oracle.sol";

// Interface behavior test double. This does not authenticate a real Pyth signature.
contract PythInterfaceDouble is IPythCore {
    Price private latest;

    function setPrice(Price memory p) external {
        latest = p;
    }

    function getPriceUnsafe(bytes32) external view returns (Price memory) {
        return latest;
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 7;
    }

    function parsePriceFeedUpdates(bytes[] calldata updates, bytes32[] calldata ids, uint64 minTime, uint64 maxTime)
        external
        payable
        returns (PriceFeed[] memory result)
    {
        require(msg.value == 7, "Verifier fee");
        (PriceFeed memory f,) = abi.decode(updates[0], (PriceFeed, uint256));
        require(ids.length == 1 && f.id == ids[0], "Wrong feed");
        require(f.price.publishTime >= minTime && f.price.publishTime <= maxTime, "Wrong time");
        result = new PriceFeed[](1);
        result[0] = f;
    }

    function updatePriceFeeds(bytes[] calldata updates) external payable {
        require(msg.value == 7, "Verifier fee");
        (PriceFeed memory f,) = abi.decode(updates[0], (PriceFeed, uint256));
        if (f.price.publishTime > latest.publishTime) latest = f.price;
    }

    function parsePriceFeedUpdatesUnique(bytes[] calldata updates, bytes32[] calldata, uint64 minTime, uint64)
        external
        payable
        returns (PriceFeed[] memory result)
    {
        require(msg.value == 7, "Verifier fee");
        (PriceFeed memory f, uint256 previous) = abi.decode(updates[0], (PriceFeed, uint256));
        require(previous < minTime, "Not unique first update");
        result = new PriceFeed[](1);
        result[0] = f;
    }
}

contract PythOracleTest is Test {
    PythInterfaceDouble verifier;
    PythExpiryOracle oracle;
    bytes32 asset = keccak256("MON");
    uint64 expiry = 1000;

    function setUp() public {
        vm.warp(1100);
        vm.deal(address(this), 1 ether);
        verifier = new PythInterfaceDouble();
        oracle = new PythExpiryOracle(address(verifier));
    }

    function proof(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 published, uint256 previous)
        internal
        pure
        returns (bytes[] memory updates)
    {
        IPythCore.Price memory p = IPythCore.Price(price, conf, expo, published);
        updates = new bytes[](1);
        updates[0] = abi.encode(IPythCore.PriceFeed(id, p, p), previous);
    }

    function testNormalizedLivePriceAndFutureGuard() public {
        verifier.setPrice(IPythCore.Price(1030000, 100, -6, 1099));
        (uint256 p, uint64 published) = oracle.livePrice(asset);
        assertEq(p, 103000000);
        assertEq(published, 1099);
        verifier.setPrice(IPythCore.Price(1030000, 100, -6, 1101));
        vm.expectRevert("Future price");
        oracle.livePrice(asset);
    }

    function testSettlementUsesUniqueVerifierImmutableAndExactFee() public {
        bytes[] memory updates = proof(asset, 110000000, 1000, -8, 1002, 999);
        vm.expectRevert("Exact fee required");
        oracle.finalize{value: 8}(asset, expiry, updates);
        assertEq(oracle.finalize{value: 7}(asset, expiry, updates), 110000000);
        vm.expectRevert("Already finalized");
        oracle.finalize{value: 7}(asset, expiry, proof(asset, 120000000, 0, -8, 1003, 999));
        assertEq(oracle.settlementPrice(asset, expiry), 110000000);
        (uint64 published, int64 rawPrice, uint64 confidence, int32 exponent, bytes32 hash) =
            oracle.evidence(asset, expiry);
        assertEq(published, 1002);
        assertEq(rawPrice, 110000000);
        assertEq(confidence, 1000);
        assertEq(exponent, -8);
        assertEq(hash, keccak256(abi.encode(updates)));
        assertEq(oracle.POLICY_ID(), keccak256("STRATA_PYTH_UNIQUE_FIRST_V1"));
    }

    function testWrongFeedTimeAndLaterObservationRejected() public {
        vm.expectRevert("Wrong feed");
        oracle.finalize{value: 7}(asset, expiry, proof(bytes32(uint256(3)), 110000000, 0, -8, 1001, 999));
        vm.expectRevert("Wrong time");
        oracle.finalize{value: 7}(asset, expiry, proof(asset, 110000000, 0, -8, 999, 998));
        vm.expectRevert("Wrong time");
        oracle.finalize{value: 7}(asset, expiry, proof(asset, 110000000, 0, -8, 1101, 999));
        vm.expectRevert("Not unique first update");
        oracle.finalize{value: 7}(asset, expiry, proof(asset, 110000000, 0, -8, 1002, 1001));
        assertEq(oracle.settlementPrice(asset, expiry), 0);
    }

    function testInvalidPriceConfidenceAndPayloadRejected() public {
        vm.expectRevert("Invalid price");
        oracle.finalize{value: 7}(asset, expiry, proof(asset, -1, 0, -8, 1000, 999));
        vm.expectRevert("Invalid price");
        oracle.finalize{value: 7}(asset, expiry, proof(asset, 100, 0, -19, 1000, 999));
        bytes[] memory oversized = new bytes[](1);
        oversized[0] = new bytes(65537);
        vm.expectRevert("Proof too large");
        oracle.finalize{value: 7}(asset, expiry, oversized);
        vm.expectRevert("Invalid proof request");
        oracle.finalize(asset, expiry, new bytes[](0));
    }

    function testWideConfidenceBlocksNewExposureButCannotSelectLaterSettlement() public {
        verifier.setPrice(IPythCore.Price(100000000, 2000000, -8, 1099));
        vm.expectRevert("Wide confidence");
        oracle.livePrice(asset);
        assertEq(oracle.finalize{value: 7}(asset, expiry, proof(asset, 100000000, 2000000, -8, 1001, 999)), 100000000);
        vm.expectRevert("Already finalized");
        oracle.finalize{value: 7}(asset, expiry, proof(asset, 110000000, 1, -8, 1002, 1001));
    }
}
