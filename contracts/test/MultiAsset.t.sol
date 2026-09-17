// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OptionsEngine} from "../src/OptionsEngine.sol";
import {DemoOracle, DemoSessionOracle, IPythCore, OracleRouter, PythSessionCloseOracle} from "../src/Oracle.sol";
import {DemoUSDC, WrappedMON} from "../src/TestAssets.sol";
import {PythInterfaceDouble} from "./PythOracle.t.sol";

contract MultiAssetTest is Test {
    PythInterfaceDouble verifier;
    PythSessionCloseOracle session;
    DemoOracle crypto;
    OracleRouter router;
    OptionsEngine engine;
    DemoUSDC usd;
    WrappedMON mon;
    bytes32 spy = keccak256("Equity.US.SPY/USD");
    bytes32 monAsset = keccak256("Crypto.MON/USD");
    address maker = address(0x111);
    address trader = address(0x222);
    uint64 constant LOOKBACK = 4 days;
    uint64 constant WINDOW = 2 hours;
    uint64 constant EQUITY_LIVE_AGE = 120;
    uint64 close;

    function setUp() public {
        vm.warp(1_000_000);
        vm.deal(address(this), 1 ether);
        verifier = new PythInterfaceDouble();
        session = new PythSessionCloseOracle(address(verifier), LOOKBACK, WINDOW);
        crypto = new DemoOracle();
        crypto.publish(monAsset, 1e8);
        router = new OracleRouter();
        router.bind(spy, address(session), EQUITY_LIVE_AGE);
        router.bind(monAsset, address(crypto), 3600);
        usd = new DemoUSDC();
        mon = new WrappedMON();
        engine = new OptionsEngine(address(usd), address(router), 3600);
        engine.approveUnderlying(address(mon), true);
        close = uint64(block.timestamp + 1 days);
        usd.mint(maker, 1e30);
        vm.prank(maker);
        usd.approve(address(engine), type(uint256).max);
        // SPY trading at $500.00 with a fresh regular-session update.
        verifier.setPrice(IPythCore.Price(50000, 5, -2, block.timestamp));
    }

    function update(int64 price, uint256 published) internal pure returns (bytes[] memory updates) {
        IPythCore.Price memory p = IPythCore.Price(price, 1, -2, published);
        updates = new bytes[](1);
        updates[0] = abi.encode(IPythCore.PriceFeed(keccak256("Equity.US.SPY/USD"), p, p), uint256(0));
    }

    // ---- Router ----

    function testBindingsArePermanentAndOwnerOnly() public {
        vm.expectRevert("Asset already bound");
        router.bind(spy, address(crypto), 60);
        vm.prank(trader);
        vm.expectRevert();
        router.bind(keccak256("Equity.US.QQQ/USD"), address(session), 60);
        vm.expectRevert("Invalid live age");
        router.bind(keccak256("Equity.US.QQQ/USD"), address(session), 0);
        vm.expectRevert("Unknown asset");
        router.livePrice(keccak256("Equity.US.QQQ/USD"));
    }

    function testScheduledAssetClosesForNewExposureWhenSessionEnds() public {
        (uint256 open,) = router.livePrice(spy);
        assertEq(open, 500e8);
        uint256 id = engine.createSeries(address(0), spy, close, OptionsEngine.Kind.Put, 480e8, 0, 1e35, "SPY-P");
        vm.prank(maker);
        engine.write(id, 1e18, maker);
        // No regular-session update for longer than the equity live age: the market is closed.
        vm.warp(block.timestamp + EQUITY_LIVE_AGE + 1);
        (uint256 stale,) = router.livePrice(spy);
        assertEq(stale, 0);
        assertFalse(engine.healthy(id));
        vm.prank(maker);
        vm.expectRevert();
        engine.write(id, 1e18, maker);
        // Exits remain available while closed.
        vm.prank(maker);
        engine.closeWrite(id, 1e18);
        assertEq(engine.getSeries(id).escrow, 0);
        // The 24/7 crypto asset on the same router keeps its own, longer limit.
        (uint256 monPrice,) = router.livePrice(monAsset);
        assertEq(monPrice, 1e8);
    }

    // ---- Engine listing rules ----

    function testCashSettledKindsListWithoutTokenButCallsNeedOne() public {
        engine.createSeries(address(0), spy, close, OptionsEngine.Kind.Put, 480e8, 0, 1e35, "SPY-P");
        engine.createSeries(address(0), spy, close, OptionsEngine.Kind.BullSpread, 500e8, 520e8, 1e35, "SPY-B");
        engine.createSeries(address(0), spy, close, OptionsEngine.Kind.BearSpread, 480e8, 500e8, 1e35, "SPY-R");
        vm.expectRevert("Unapproved underlying");
        engine.createSeries(address(0), spy, close, OptionsEngine.Kind.Call, 500e8, 0, 1e35, "SPY-C");
        engine.createSeries(address(mon), monAsset, close, OptionsEngine.Kind.Call, 1e8, 0, 1e35, "MON-C");
    }

    // ---- Session-close settlement ----

    function testLatestPrintAtOrBeforeCloseSettles() public {
        uint256 id = engine.createSeries(address(0), spy, close, OptionsEngine.Kind.Put, 500e8, 0, 1e35, "SPY-P");
        vm.prank(maker);
        engine.write(id, 10e18, maker);
        address token = engine.getSeries(id).token;
        vm.prank(maker);
        IERC20(token).transfer(trader, 10e18);

        vm.warp(close + 10 minutes);
        // An earlier print is proposed first...
        router.finalize{value: 7}(spy, close, update(49500, close - 30 minutes));
        // ...and the true closing print replaces it.
        router.finalize{value: 7}(spy, close, update(49000, close));
        (uint64 publishedAt,,,, uint256 candidatePrice,) = session.candidate(spy, close);
        assertEq(publishedAt, close);
        assertEq(candidatePrice, 490e8);
        // Claims stay unresolved until the challenge window ends.
        assertEq(router.settlementPrice(spy, close), 0);
        vm.expectRevert("Challenge window open");
        router.finalize(spy, close, new bytes[](0));

        vm.warp(close + WINDOW);
        assertEq(router.finalize(spy, close, new bytes[](0)), 490e8);
        uint256 before = usd.balanceOf(trader);
        vm.prank(trader);
        engine.redeemLong(id, 10e18, trader);
        // 10 puts struck at $500 settled at $490 pay $100.
        assertEq(usd.balanceOf(trader) - before, 100e6);
    }

    function testCandidatesCannotMoveBackwardOrLeaveTheWindow() public {
        vm.warp(close + 1 minutes);
        session.propose{value: 7}(spy, close, update(49000, close - 5 minutes));
        vm.expectRevert("Not a later observation");
        session.propose{value: 7}(spy, close, update(48000, close - 6 minutes));
        vm.expectRevert("Not a later observation");
        session.propose{value: 7}(spy, close, update(48000, close - 5 minutes));
        // After expiry and before expiry - lookback are both out of range.
        vm.expectRevert("Wrong time");
        session.propose{value: 7}(spy, close, update(48000, close + 1));
        vm.expectRevert("Wrong time");
        session.propose{value: 7}(spy, close, update(48000, close - LOOKBACK - 1));
        vm.expectRevert("Exact fee required");
        session.propose{value: 8}(spy, close, update(48000, close - 1 minutes));
        vm.warp(close + WINDOW);
        vm.expectRevert("Challenge window closed");
        session.propose{value: 7}(spy, close, update(48000, close));
        assertEq(session.finalize(spy, close, new bytes[](0)), 490e8);
        vm.expectRevert("Already finalized");
        session.propose{value: 7}(spy, close, update(48000, close));
    }

    function testNoProposalBeforeExpiryAndNoCandidateKeepsClaimsUnresolved() public {
        vm.expectRevert("Not expired");
        session.propose{value: 7}(spy, close, update(49000, block.timestamp));
        vm.warp(close + WINDOW);
        vm.expectRevert("No candidate");
        session.finalize(spy, close, new bytes[](0));
        // Unresolved series keep the bilateral unwind route; nothing is fabricated.
        assertEq(session.settlementPrice(spy, close), 0);
    }

    function testInvalidConfiguration() public {
        vm.expectRevert("Invalid lookback");
        new PythSessionCloseOracle(address(verifier), 10 minutes, WINDOW);
        vm.expectRevert("Invalid challenge window");
        new PythSessionCloseOracle(address(verifier), LOOKBACK, 1 minutes);
        vm.expectRevert("Invalid verifier");
        new PythSessionCloseOracle(address(0x1234), LOOKBACK, WINDOW);
    }
}

contract DemoSessionOracleTest is Test {
    DemoSessionOracle oracle;
    bytes32 spy = keccak256("Equity.US.SPY/USD");
    uint64 close;

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new DemoSessionOracle(4 days, 60);
        close = uint64(block.timestamp + 1 hours);
    }

    function testSettlesOnLatestObservationAtOrBeforeCloseAfterWindow() public {
        oracle.publish(spy, 500e8);
        vm.warp(close);
        oracle.publish(spy, 490e8);
        // The next session's price must never become the settlement.
        vm.warp(close + 30);
        oracle.publish(spy, 470e8);
        vm.expectRevert("Challenge window open");
        oracle.finalize(spy, close, new bytes[](0));
        vm.warp(close + 60);
        assertEq(oracle.finalize(spy, close, new bytes[](0)), 490e8);
        assertEq(oracle.settlementPrice(spy, close), 490e8);
    }

    function testStaleOrMissingObservationsCannotSettle() public {
        vm.warp(close + 60);
        vm.expectRevert("No observation before expiry");
        oracle.finalize(spy, close, new bytes[](0));
        oracle.publish(spy, 480e8); // after expiry only
        vm.expectRevert("No observation before expiry");
        oracle.finalize(spy, close, new bytes[](0));
        vm.prank(address(0xbad));
        vm.expectRevert();
        oracle.publish(spy, 1e8);
    }
}
