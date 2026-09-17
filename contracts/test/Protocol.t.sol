// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OptionsEngine} from "../src/OptionsEngine.sol";
import {DemoOracle} from "../src/Oracle.sol";
import {DemoUSDC, WrappedMON} from "../src/TestAssets.sol";
import {DemoOrderBook, StrategyRouter, KuruExactAdapter} from "../src/Venues.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev A contract-wallet interface double, not a production account implementation.
contract ClaimSignerDouble {
    bytes32 public digest;

    function setDigest(bytes32 value) external {
        digest = value;
    }

    function isValidSignature(bytes32 value, bytes calldata signature) external view returns (bytes4) {
        return value == digest && keccak256(signature) == keccak256(hex"1234") ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

abstract contract ProtocolFixture is Test {
    DemoUSDC usd;
    WrappedMON mon;
    DemoOracle oracle;
    OptionsEngine engine;
    StrategyRouter router;
    bytes32 asset = keccak256("MON/USD");
    address maker = address(0x111);
    address trader = address(0x222);
    uint64 expiry;

    function setUp() public {
        vm.warp(100000);
        usd = new DemoUSDC();
        mon = new WrappedMON();
        oracle = new DemoOracle();
        oracle.publish(asset, 1e8);
        engine = new OptionsEngine(address(usd), address(oracle), 300);
        engine.approveUnderlying(address(mon), true);
        router = new StrategyRouter(address(engine));
        expiry = uint64(block.timestamp + 100);
        usd.mint(maker, 1e30);
        usd.mint(trader, 1e30);
        vm.deal(maker, 1e30);
        vm.startPrank(maker);
        mon.deposit{value: 1e28}();
        mon.approve(address(engine), type(uint256).max);
        usd.approve(address(engine), type(uint256).max);
        vm.stopPrank();
        vm.prank(trader);
        usd.approve(address(router), type(uint256).max);
    }

    function series(OptionsEngine.Kind kind, uint256 strike, uint256 upper) internal returns (uint256) {
        return engine.createSeries(address(mon), asset, expiry, kind, strike, upper, 1e35, "TEST");
    }

    function write(uint256 id, uint256 quantity) internal {
        vm.prank(maker);
        engine.write(id, quantity, maker);
    }

    function settle(uint256 price) internal {
        vm.warp(expiry);
        oracle.publish(asset, price);
        oracle.finalize(asset, expiry, new bytes[](0));
    }
}

contract ProtocolTest is ProtocolFixture {
    function testCallLifecycleWriterFirst() public {
        uint256 id = series(OptionsEngine.Kind.Call, 1e8, 0);
        write(id, 100e18);
        address token = engine.getSeries(id).token;
        vm.prank(maker);
        IERC20(token).transfer(trader, 100e18);
        settle(2e8);
        vm.prank(maker);
        engine.settleWriter(id, maker);
        vm.prank(trader);
        engine.redeemLong(id, 100e18, trader);
        assertEq(mon.balanceOf(trader), 50e18);
        assertEq(engine.getSeries(id).escrow, 0);
        assertEq(IERC20(token).totalSupply(), 0);
    }

    function testPutLifecycleHolderFirst() public {
        uint256 id = series(OptionsEngine.Kind.Put, 1e8, 0);
        write(id, 100e18);
        address token = engine.getSeries(id).token;
        assertEq(engine.getSeries(id).escrow, 100e6);
        vm.prank(maker);
        IERC20(token).transfer(trader, 100e18);
        settle(50e6);
        uint256 before = usd.balanceOf(trader);
        vm.prank(trader);
        engine.redeemLong(id, 100e18, trader);
        assertEq(usd.balanceOf(trader) - before, 50e6);
        vm.prank(maker);
        engine.settleWriter(id, maker);
        assertEq(engine.getSeries(id).escrow, 0);
    }

    function testPauseDoesNotBlockCloseOrClaims() public {
        uint256 id = series(OptionsEngine.Kind.Put, 1e8, 0);
        write(id, 10e18);
        engine.pauseIssuance(true);
        vm.prank(maker);
        vm.expectRevert("Issuance unavailable");
        engine.write(id, 1e18, maker);
        vm.prank(maker);
        engine.closeWrite(id, 5e18);
        settle(2e8);
        vm.startPrank(maker);
        engine.redeemLong(id, 5e18, maker);
        engine.settleWriter(id, maker);
        vm.stopPrank();
        assertEq(engine.getSeries(id).escrow, 0);
    }

    function testStalePriceRejectsWriteButAllowsBurn() public {
        uint256 id = series(OptionsEngine.Kind.Call, 1e8, 0);
        write(id, 1e18);
        vm.warp(block.timestamp + 50);
        vm.prank(maker);
        engine.closeWrite(id, 1e18);
        // Separate distant expiry to exercise actual staleness before expiry.
        expiry += 1000;
        uint256 next = series(OptionsEngine.Kind.Call, 1e8, 0);
        vm.warp(block.timestamp + 301);
        vm.prank(maker);
        vm.expectRevert("Issuance unavailable");
        engine.write(next, 1e18, maker);
    }

    function testSettlementCannotChooseLaterPrice() public {
        vm.warp(expiry);
        oracle.publish(asset, 110e6);
        vm.warp(expiry + 1);
        oracle.publish(asset, 120e6);
        assertEq(oracle.finalize(asset, expiry, new bytes[](0)), 110e6);
        assertEq(oracle.finalize(asset, expiry, new bytes[](0)), 110e6);
    }

    function testSeriesIsolationAndDuplicateTerms() public {
        uint256 a = series(OptionsEngine.Kind.Put, 1e8, 0);
        uint256 b = series(OptionsEngine.Kind.Put, 2e8, 0);
        write(a, 10e18);
        write(b, 10e18);
        vm.expectRevert("Duplicate series");
        series(OptionsEngine.Kind.Put, 1e8, 0);
        settle(50e6);
        vm.startPrank(maker);
        engine.redeemLong(a, 10e18, maker);
        engine.settleWriter(a, maker);
        vm.stopPrank();
        assertEq(engine.getSeries(b).escrow, 20e6);
    }

    function testFuzzSplitClaimsRemainSolvent(
        uint96 rawQ,
        uint64 rawStrike,
        uint64 rawPrice,
        uint8 rawKind,
        uint16 split
    ) public {
        uint256 q = bound(rawQ, 2, 1e24);
        uint256 k = bound(rawStrike, 1, 1e12);
        uint256 p = bound(rawPrice, 1, 1e12);
        OptionsEngine.Kind kind = OptionsEngine.Kind(rawKind % 4);
        uint256 id = series(kind, k, rawKind % 4 >= 2 ? k + 1e8 : 0);
        write(id, q);
        address token = engine.getSeries(id).token;
        uint256 first = bound(split, 1, q - 1);
        vm.prank(maker);
        IERC20(token).transfer(trader, q);
        settle(p);
        uint256 funding = engine.getSeries(id).escrow;
        uint256 a = engine.previewPayout(id, first, p);
        uint256 b = engine.previewPayout(id, q - first, p);
        assertLe(a + b, funding);
        vm.prank(maker);
        engine.settleWriter(id, maker);
        vm.startPrank(trader);
        engine.redeemLong(id, first, trader);
        engine.redeemLong(id, q - first, trader);
        vm.stopPrank();
        engine.sweepDust(id);
        assertEq(engine.getSeries(id).escrow, 0);
    }

    function testPartialBurnRecomputesRoundedFunding() public {
        uint256 id = series(OptionsEngine.Kind.Put, 123456789, 0);
        write(id, 1234567890123456789);
        vm.prank(maker);
        engine.closeWrite(id, 1234567890123456000);
        assertEq(engine.getSeries(id).escrow, engine.requiredCollateral(id, 789));
    }

    function testDelegatedClaimCannotRedirectChangeQuantityOrReplay() public {
        uint256 holderKey = 1234;
        address holder = vm.addr(holderKey);
        uint256 id = series(OptionsEngine.Kind.Put, 1e8, 0);
        write(id, 1e18);
        address token = engine.getSeries(id).token;
        vm.prank(maker);
        IERC20(token).transfer(holder, 1e18);
        settle(50e6);
        uint256 deadline = expiry + 100;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Strata"),
                keccak256("1"),
                block.chainid,
                address(engine)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domain,
                keccak256(
                    abi.encode(
                        keccak256(
                            "Claim(uint256 seriesId,address holder,uint256 quantity,uint256 nonce,uint256 deadline)"
                        ),
                        id,
                        holder,
                        1e18,
                        0,
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(holderKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        // A valid EIP-7702 delegation does not make the EOA key signature invalid.
        vm.etch(holder, abi.encodePacked(hex"ef0100", address(0x1234)));
        vm.expectRevert("Invalid authorization");
        engine.redeemWithSignature(id, holder, 2e18, deadline, signature);
        assertEq(engine.nonces(holder), 0);
        uint256 before = usd.balanceOf(trader);
        vm.prank(trader);
        engine.redeemWithSignature(id, holder, 1e18, deadline, signature);
        assertEq(usd.balanceOf(holder), 500000);
        assertEq(usd.balanceOf(trader), before);
        vm.expectRevert("Invalid authorization");
        engine.redeemWithSignature(id, holder, 1e18, deadline, signature);
        assertEq(engine.nonces(holder), 1);
    }

    function testRevocationPreservesCollateralAndOrdinaryClaim() public {
        uint256 holderKey = 1234;
        address holder = vm.addr(holderKey);
        uint256 id = series(OptionsEngine.Kind.Put, 1e8, 0);
        write(id, 1e18);
        address token = engine.getSeries(id).token;
        vm.prank(maker);
        IERC20(token).transfer(holder, 1e18);
        settle(50e6);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Strata"),
                keccak256("1"),
                block.chainid,
                address(engine)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domain,
                keccak256(
                    abi.encode(
                        keccak256(
                            "Claim(uint256 seriesId,address holder,uint256 quantity,uint256 nonce,uint256 deadline)"
                        ),
                        id,
                        holder,
                        1e18,
                        0,
                        expiry + 100
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(holderKey, digest);
        uint256 escrow = engine.getSeries(id).escrow;
        vm.prank(holder);
        engine.invalidateAuthorizations();
        assertEq(engine.nonces(holder), 1);
        assertEq(engine.getSeries(id).escrow, escrow);
        assertEq(IERC20(token).balanceOf(holder), 1e18);
        vm.expectRevert("Invalid authorization");
        engine.redeemWithSignature(id, holder, 1e18, expiry + 100, abi.encodePacked(r, s, v));
        vm.prank(holder);
        engine.redeemLong(id, 1e18, holder);
        assertEq(usd.balanceOf(holder), 500000);
        vm.prank(maker);
        engine.settleWriter(id, maker);
        assertEq(engine.getSeries(id).escrow, 0);
    }

    function claimDigest(uint256 id, address holder, uint256 quantity, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Strata"),
                keccak256("1"),
                block.chainid,
                address(engine)
            )
        );
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domain,
                keccak256(
                    abi.encode(
                        keccak256(
                            "Claim(uint256 seriesId,address holder,uint256 quantity,uint256 nonce,uint256 deadline)"
                        ),
                        id,
                        holder,
                        quantity,
                        nonce,
                        deadline
                    )
                )
            )
        );
    }

    function testContractWalletClaimUsesERC1271Policy() public {
        ClaimSignerDouble holder = new ClaimSignerDouble();
        uint256 id = series(OptionsEngine.Kind.Put, 1e8, 0);
        write(id, 1e18);
        address token = engine.getSeries(id).token;
        vm.prank(maker);
        IERC20(token).transfer(address(holder), 1e18);
        settle(50e6);
        holder.setDigest(claimDigest(id, address(holder), 1e18, 0, expiry + 100));
        vm.expectRevert("Invalid authorization");
        engine.redeemWithSignature(id, address(holder), 1e18, expiry + 100, hex"5678");
        engine.redeemWithSignature(id, address(holder), 1e18, expiry + 100, hex"1234");
        assertEq(usd.balanceOf(address(holder)), 500000);
    }

    function testCompactEOASignatureClaim() public {
        uint256 key = 1234;
        address holder = vm.addr(key);
        uint256 id = series(OptionsEngine.Kind.Put, 1e8, 0);
        write(id, 1e18);
        address token = engine.getSeries(id).token;
        vm.prank(maker);
        IERC20(token).transfer(holder, 1e18);
        settle(50e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, claimDigest(id, holder, 1e18, 0, expiry + 100));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        engine.redeemWithSignature(id, holder, 1e18, expiry + 100, abi.encodePacked(r, vs));
        assertEq(usd.balanceOf(holder), 500000);
    }

    function testFuzzMultipleWritersAndCombinedClaimStaySolvent(
        uint96 rawA,
        uint96 rawB,
        uint64 rawStrike,
        uint64 rawPrice,
        uint8 rawKind,
        bool holderFirst
    ) public {
        uint256 a = bound(rawA, 1, 1e24);
        uint256 b = bound(rawB, 1, 1e24);
        uint256 strike = bound(rawStrike, 1, 1e12);
        uint256 price = bound(rawPrice, 1, 1e12);
        uint256 id = series(OptionsEngine.Kind(rawKind % 4), strike, rawKind % 4 >= 2 ? strike + 1e8 : 0);
        address second = address(0x333);
        usd.mint(second, 1e30);
        vm.deal(second, 1e30);
        vm.startPrank(second);
        mon.deposit{value: 1e28}();
        mon.approve(address(engine), type(uint256).max);
        usd.approve(address(engine), type(uint256).max);
        engine.write(id, b, trader);
        vm.stopPrank();
        vm.prank(maker);
        engine.write(id, a, trader);
        settle(price);
        uint256 funding = engine.getSeries(id).escrow;
        uint256 payout = engine.previewPayout(id, a + b, price);
        assertLe(payout, funding);
        if (holderFirst) {
            vm.prank(trader);
            engine.redeemLong(id, a + b, trader);
        }
        vm.prank(second);
        engine.settleWriter(id, second);
        vm.prank(maker);
        engine.settleWriter(id, maker);
        if (!holderFirst) {
            vm.prank(trader);
            engine.redeemLong(id, a + b, trader);
        }
        engine.sweepDust(id);
        assertEq(engine.getSeries(id).escrow, 0);
        assertEq(IERC20(engine.getSeries(id).token).totalSupply(), 0);
    }

    function book(uint256 id) internal returns (DemoOrderBook b) {
        b = new DemoOrderBook(engine.getSeries(id).token, address(usd), expiry);
        router.register(id, address(b));
        vm.startPrank(maker);
        IERC20(b.base()).approve(address(b), type(uint256).max);
        usd.approve(address(b), type(uint256).max);
        vm.stopPrank();
    }

    function testAtomicStrategyRollsBackFirstLegIfSecondFails() public {
        uint256 a = series(OptionsEngine.Kind.Call, 1e8, 0);
        uint256 b = series(OptionsEngine.Kind.Put, 1e8, 0);
        write(a, 100e18);
        write(b, 100e18);
        DemoOrderBook ba = book(a);
        book(b);
        vm.prank(maker);
        ba.place(false, 100000, 100e18);
        StrategyRouter.Leg[] memory legs = new StrategyRouter.Leg[](2);
        legs[0] = StrategyRouter.Leg(a, true, 10e18, 1e6);
        legs[1] = StrategyRouter.Leg(b, true, 10e18, 1e6);
        vm.prank(trader);
        vm.expectRevert("Insufficient liquidity");
        router.execute(legs, 2e6, 2e6, 0, expiry);
        assertEq(IERC20(ba.base()).balanceOf(trader), 0);
        (,,, uint256 remaining,,) = ba.orders(1);
        assertEq(remaining, 100e18);
    }

    function testStaleRouterTradeCannotMoveFundsAndMakerCanRecoverQuote() public {
        expiry += 1000;
        uint256 id = series(OptionsEngine.Kind.Call, 1e8, 0);
        write(id, 10e18);
        DemoOrderBook b = book(id);
        vm.prank(maker);
        uint256 order = b.place(false, 100000, 10e18);
        uint256 beforeUsd = usd.balanceOf(trader);
        vm.warp(block.timestamp + 301);
        StrategyRouter.Leg[] memory legs = new StrategyRouter.Leg[](1);
        legs[0] = StrategyRouter.Leg(id, true, 1e18, 100000);
        vm.prank(trader);
        vm.expectRevert("Market unavailable");
        router.execute(legs, 100000, 100000, 0, expiry);
        assertEq(usd.balanceOf(trader), beforeUsd);
        assertEq(IERC20(b.base()).balanceOf(trader), 0);
        (,,, uint256 remaining,,) = b.orders(order);
        assertEq(remaining, 10e18);
        vm.startPrank(maker);
        b.cancel(order);
        engine.closeWrite(id, 10e18);
        vm.stopPrank();
        assertEq(engine.getSeries(id).escrow, 0);
        assertEq(IERC20(b.base()).totalSupply(), 0);
    }

    function testTradeBuySellCancelAndWithdrawal() public {
        uint256 id = series(OptionsEngine.Kind.Call, 1e8, 0);
        write(id, 100e18);
        DemoOrderBook b = book(id);
        vm.startPrank(maker);
        b.place(false, 110000, 100e18);
        uint256 bid = b.place(true, 90000, 100e18);
        vm.stopPrank();
        StrategyRouter.Leg[] memory legs = new StrategyRouter.Leg[](1);
        legs[0] = StrategyRouter.Leg(id, true, 10e18, 1100000);
        vm.prank(trader);
        router.execute(legs, 1100000, 1100000, 0, expiry);
        assertEq(IERC20(b.base()).balanceOf(trader), 10e18);
        address claim = b.base();
        vm.prank(trader);
        IERC20(claim).approve(address(router), 10e18);
        legs[0] = StrategyRouter.Leg(id, false, 10e18, 900000);
        vm.prank(trader);
        router.execute(legs, 0, 0, 900000, expiry);
        assertEq(IERC20(b.base()).balanceOf(trader), 0);
        vm.prank(maker);
        b.cancel(bid);
        (,,, uint256 remaining,,) = b.orders(bid);
        assertEq(remaining, 0);
        assertEq(usd.balanceOf(address(router)), 0);
    }

    function testUnresolvedUnwindSignaturesAndReplay() public {
        uint256 wKey = 123;
        uint256 hKey = 456;
        address w = vm.addr(wKey);
        address h = vm.addr(hKey);
        vm.etch(w, abi.encodePacked(hex"ef0100", address(0x1234)));
        vm.etch(h, abi.encodePacked(hex"ef0100", address(0x1234)));
        usd.mint(w, 100e6);
        uint256 id = series(OptionsEngine.Kind.Put, 1e8, 0);
        vm.startPrank(w);
        usd.approve(address(engine), type(uint256).max);
        engine.write(id, 10e18, h);
        vm.stopPrank();
        vm.warp(expiry);
        OptionsEngine.Unwind memory u = OptionsEngine.Unwind(id, w, h, 10e18, 3e6, 0, 0, expiry + 100);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Strata"),
                keccak256("1"),
                block.chainid,
                address(engine)
            )
        );
        bytes32 typehash = keccak256(
            "Unwind(uint256 seriesId,address writer,address holder,uint256 quantity,uint256 payment,uint256 writerNonce,uint256 holderNonce,uint256 deadline)"
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", domain, keccak256(abi.encode(typehash, id, w, h, 10e18, 3e6, 0, 0, expiry + 100))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wKey, digest);
        bytes memory ws = abi.encodePacked(r, s, v);
        (v, r, s) = vm.sign(hKey, digest);
        bytes memory hs = abi.encodePacked(r, s, v);
        engine.unwindUnresolved(u, ws, hs);
        assertEq(usd.balanceOf(h), 3e6);
        assertEq(engine.getSeries(id).escrow, 0);
        vm.expectRevert("Invalid nonce");
        engine.unwindUnresolved(u, ws, hs);
    }
}

interface IKuruFactory {
    function deployProxy(
        uint8 kind,
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tick,
        uint96 min,
        uint96 max,
        uint256 takerFee,
        uint256 makerFee,
        uint96 spread
    ) external returns (address);
}

interface IKuruOrders {
    function addSellOrder(uint32 price, uint96 size, bool postOnly) external;
    function addBuyOrder(uint32 price, uint96 size, bool postOnly) external;
    function batchCancelOrders(uint40[] calldata ids) external;
    function batchCancelOrdersNoRevert(uint40[] calldata ids) external;
}

interface IKuruDeposit {
    function deposit(address owner, address token, uint256 amount) external payable;
    function getBalance(address owner, address token) external view returns (uint256);
}

contract KuruForkTest is ProtocolFixture {
    function testKuruDeployedForkExactBuySellAndPartialRollback() public {
        vm.skip(!vm.envOr("RUN_KURU_FORK", false), "Run with RUN_KURU_FORK=true and a Monad testnet fork");
        address factory = 0x7EFbE105Ca7415dE98F96622173458ac1c054630;
        address margin = 0xd029C2D98ff85D8F64799017fE00a59B1159CE02;
        uint256 id = series(OptionsEngine.Kind.Call, 1e8, 0);
        write(id, 100e18);
        address token = engine.getSeries(id).token;
        address market =
            IKuruFactory(factory).deployProxy(0, token, address(usd), 1000, 1000000, 1, 1, 1000000000, 0, 0, 100);
        KuruExactAdapter adapter = new KuruExactAdapter(market, margin, expiry);
        router.register(id, address(adapter));
        vm.startPrank(maker);
        IERC20(token).approve(margin, 100e18);
        usd.approve(margin, 100e6);
        IKuruDeposit(margin).deposit(maker, token, 100e18);
        IKuruDeposit(margin).deposit(maker, address(usd), 100e6);
        IKuruOrders(market).addSellOrder(110000, 5000, true);
        IKuruOrders(market).addSellOrder(120000, 95000, true);
        IKuruOrders(market).addBuyOrder(90000, 100000, true);
        vm.stopPrank();
        vm.startPrank(maker);
        // A third party can deposit into adapter custody; this must not cause a permanent DoS.
        usd.approve(margin, 1);
        IKuruDeposit(margin).deposit(address(adapter), address(usd), 1);
        vm.stopPrank();
        StrategyRouter.Leg[] memory legs = new StrategyRouter.Leg[](1);
        legs[0] = StrategyRouter.Leg(id, true, 10e18, 1150000);
        uint256 before = usd.balanceOf(trader);
        // Five contracts at 0.11 and five at 0.12: aggregate cap must admit both levels.
        vm.prank(trader);
        router.execute(legs, 1150000, 1150000, 0, expiry);
        assertEq(IERC20(token).balanceOf(trader), 10e18);
        assertEq(before - usd.balanceOf(trader), 1150000);
        assertEq(usd.balanceOf(address(adapter)), 0);
        assertEq(IERC20(token).balanceOf(address(adapter)), 0);
        assertEq(usd.balanceOf(address(this)), 1);
        // The first ask was fully filled. The admitted cancellation path must tolerate that race.
        uint40[] memory staleIds = new uint40[](1);
        staleIds[0] = 1;
        vm.prank(maker);
        vm.expectRevert();
        IKuruOrders(market).batchCancelOrders(staleIds);
        uint256 makerQuoteBefore = IKuruDeposit(margin).getBalance(maker, address(usd));
        vm.prank(maker);
        IKuruOrders(market).batchCancelOrdersNoRevert(staleIds);
        assertEq(IKuruDeposit(margin).getBalance(maker, address(usd)), makerQuoteBefore);
        assertEq(IERC20(token).balanceOf(trader), 10e18);
        vm.prank(trader);
        IERC20(token).approve(address(router), 10e18);
        legs[0] = StrategyRouter.Leg(id, false, 10e18, 900000);
        vm.prank(trader);
        router.execute(legs, 0, 0, 900000, expiry);
        before = usd.balanceOf(trader);
        legs[0] = StrategyRouter.Leg(id, true, 200e18, 24e6);
        vm.prank(trader);
        vm.expectRevert();
        router.execute(legs, 24e6, 24e6, 0, expiry);
        assertEq(usd.balanceOf(trader), before);
        assertEq(IERC20(token).balanceOf(trader), 0);
    }
}
