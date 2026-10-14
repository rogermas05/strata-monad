// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OptionsEngine} from "../src/OptionsEngine.sol";
import {DemoOracle} from "../src/Oracle.sol";
import {DemoUSDC, WrappedMON} from "../src/TestAssets.sol";
import {StrategyRouter} from "../src/Venues.sol";
import {HouseVault} from "../src/HouseVault.sol";

/// @dev Margin-account double: per-owner custody balances, no fees.
contract MockKuruMargin {
    mapping(address => mapping(address => uint256)) public balances;

    function deposit(address user, address token, uint256 amount) external payable {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        balances[user][token] += amount;
    }

    function withdraw(uint256 amount, address token) external {
        balances[msg.sender][token] -= amount;
        IERC20(token).transfer(msg.sender, amount);
    }

    function getBalance(address user, address token) external view returns (uint256) {
        return balances[user][token];
    }

    /// @dev Simulates a taker lifting a maker's ask: claims leave, USDC arrives.
    function fill(address maker, address taker, address claim, uint256 quantity, address quote, uint256 cost)
        external
    {
        balances[maker][claim] -= quantity;
        IERC20(quote).transferFrom(taker, address(this), cost);
        balances[maker][quote] += cost;
        IERC20(claim).transfer(taker, quantity);
    }
}

contract MockKuruBook {
    uint256 public updates;
    uint256 public cancels;
    address public base;

    constructor(address base_) {
        base = base_;
    }

    function batchUpdate(
        uint32[] calldata,
        uint96[] calldata,
        uint32[] calldata,
        uint96[] calldata,
        uint40[] calldata,
        bool postOnly
    ) external {
        require(postOnly, "Post-only required");
        updates++;
    }

    function batchCancelOrdersNoRevert(uint40[] calldata) external {
        cancels++;
    }
}

contract MockVenue {
    address public book;
    address public base;
    address public quote;

    constructor(address book_, address base_, address quote_) {
        book = book_;
        base = base_;
        quote = quote_;
    }
}

contract HouseVaultTest is Test {
    DemoUSDC usd;
    WrappedMON mon;
    DemoOracle oracle;
    OptionsEngine engine;
    StrategyRouter router;
    MockKuruMargin margin;
    HouseVault vault;
    bytes32 asset = keccak256("SPY/USD");
    address operator = address(0x0b);
    address fees = address(0xfee);
    address alice = address(0xa11ce);
    address bob = address(0xb0b);
    address taker = address(0x7a4e);
    uint64 launch;
    uint64 expiry;

    function setUp() public {
        vm.warp(1_000_000);
        usd = new DemoUSDC();
        mon = new WrappedMON();
        oracle = new DemoOracle();
        oracle.publish(asset, 100e8);
        engine = new OptionsEngine(address(usd), address(oracle), 3600);
        engine.approveUnderlying(address(mon), true);
        router = new StrategyRouter(address(engine));
        margin = new MockKuruMargin();
        launch = uint64(block.timestamp + 1 days);
        expiry = uint64(launch + 7 days);
        vault = new HouseVault(
            address(engine), address(router), address(margin), operator, fees, 1000, 1_000_000e6, launch
        );
        for (uint256 i; i < 3; i++) {
            address account = [alice, bob, taker][i];
            usd.mint(account, 1_000_000e6);
            vm.prank(account);
            usd.approve(address(vault), type(uint256).max);
        }
        vm.prank(taker);
        usd.approve(address(margin), type(uint256).max);
    }

    function list(OptionsEngine.Kind kind, uint256 strike, uint256 upper) internal returns (uint256 id) {
        id = engine.createSeries(address(0), asset, expiry, kind, strike, upper, 1e35, "SPY");
        address token = engine.getSeries(id).token;
        MockKuruBook book = new MockKuruBook(token);
        router.register(id, address(new MockVenue(address(book), token, address(usd))));
    }

    function bookOf(uint256 id) internal view returns (address) {
        return MockVenue(address(router.venues(id))).book();
    }

    function launchWith(uint256[] memory ids) internal {
        vm.warp(launch);
        oracle.publish(asset, 100e8);
        vm.prank(operator);
        vault.roll(ids);
    }

    function one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function none() internal pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    /// @dev Vault writes `quantity` puts, lists them, and a taker buys them all for `premium`.
    function sellPuts(uint256 id, uint256 quantity, uint256 premium) internal {
        address token = engine.getSeries(id).token;
        vm.startPrank(operator);
        vault.write(id, quantity);
        vault.depositToVenue(token, quantity);
        vm.stopPrank();
        margin.fill(address(vault), taker, token, quantity, address(usd), premium);
    }

    function settleAt(uint256 price) internal {
        vm.warp(expiry);
        oracle.publish(asset, price);
        oracle.finalize(asset, expiry, new bytes[](0));
    }

    function testGenesisDepositsCancelAndLaunchAtPar() public {
        vm.prank(alice);
        vault.deposit(1000e6);
        vm.prank(alice);
        vault.cancelDeposit(400e6);
        assertEq(vault.pendingDeposits(), 600e6);
        vm.prank(operator);
        vm.expectRevert("Before launch");
        vault.roll(none());
        launchWith(none());
        assertEq(vault.epoch(), 1);
        assertEq(vault.pricePerShare(0), 1e18);
        assertEq(vault.shareBalance(alice), 600e6);
        vm.prank(alice);
        vault.redeemShares();
        assertEq(vault.balanceOf(alice), 600e6);
        assertEq(vault.epochStartAssets(), 600e6);
    }

    function testPremiumIncomeRaisesSharePriceAndPaysFee() public {
        uint256 id = list(OptionsEngine.Kind.Put, 90e8, 0);
        vm.prank(alice);
        vault.deposit(10_000e6);
        launchWith(one(id));
        sellPuts(id, 100e18, 200e6);
        settleAt(95e8); // out of the money: vault keeps premium and collateral
        vm.prank(operator);
        vault.roll(none());
        // 200 profit, 10% fee -> 180 to depositors.
        assertEq(usd.balanceOf(fees), 20e6);
        assertEq(vault.pricePerShare(1), 1.018e18);
        assertEq(vault.epochStartAssets(), 10_180e6);
        assertEq(IERC20(engine.getSeries(id).token).balanceOf(address(vault)), 0);
    }

    function testInTheMoneyLossLowersSharePriceWithoutFee() public {
        uint256 id = list(OptionsEngine.Kind.Put, 90e8, 0);
        vm.prank(alice);
        vault.deposit(10_000e6);
        launchWith(one(id));
        sellPuts(id, 100e18, 200e6);
        settleAt(80e8); // pays 10 per claim = 1000
        vm.prank(operator);
        vault.roll(none());
        assertEq(usd.balanceOf(fees), 0);
        assertEq(vault.pricePerShare(1), 0.92e18);
        vm.prank(taker);
        engine.redeemLong(id, 100e18, taker);
    }

    function testLateDepositorAndWithdrawalUseRollPrice() public {
        uint256 id = list(OptionsEngine.Kind.Put, 90e8, 0);
        vm.prank(alice);
        vault.deposit(10_000e6);
        launchWith(one(id));
        sellPuts(id, 100e18, 200e6);
        vm.prank(bob);
        vault.deposit(1_018e6);
        vm.prank(alice);
        vault.requestWithdraw(5_000e6);
        vm.prank(alice);
        vm.expectRevert("Withdrawal not ready");
        vault.completeWithdraw();
        settleAt(95e8);
        vm.prank(operator);
        vault.roll(none());
        assertEq(vault.shareBalance(bob), 1_000e6);
        assertEq(vault.withdrawableAssets(alice), 5_090e6);
        uint256 before = usd.balanceOf(alice);
        vm.prank(alice);
        vault.completeWithdraw();
        assertEq(usd.balanceOf(alice) - before, 5_090e6);
        // Remaining: alice 5000 shares + bob 1000 shares at 1.018.
        assertEq(vault.epochStartAssets(), 6_108e6);
        assertEq(usd.balanceOf(address(vault)), 6_108e6);
    }

    function testOperatorCannotSpendReservedDeposits() public {
        uint256 id = list(OptionsEngine.Kind.Put, 90e8, 0);
        vm.prank(alice);
        vault.deposit(100e6);
        launchWith(one(id));
        vm.prank(bob);
        vault.deposit(10_000e6);
        vm.prank(operator);
        vm.expectRevert("Reserved funds");
        vault.write(id, 2e18); // needs 180 USDC, only 100 is managed
    }

    function testOperatorScopeIsLimited() public {
        uint256 call = engine.createSeries(address(mon), asset, expiry, OptionsEngine.Kind.Call, 90e8, 0, 1e35, "C");
        uint256 put = list(OptionsEngine.Kind.Put, 90e8, 0);
        uint256 outside = list(OptionsEngine.Kind.Put, 80e8, 0);
        vm.prank(alice);
        vault.deposit(10_000e6);
        vm.warp(launch);
        vm.prank(operator);
        vm.expectRevert("Ineligible series");
        vault.roll(one(call));
        launchWith(one(put));
        vm.prank(alice);
        vm.expectRevert("Operator only");
        vault.write(put, 1e18);
        vm.prank(operator);
        vm.expectRevert("Series not in epoch");
        vault.write(outside, 1e18);
        address putBook = bookOf(put);
        address outsideBook = bookOf(outside);
        address outsideToken = engine.getSeries(outside).token;
        uint32[] memory p = new uint32[](0);
        uint96[] memory s = new uint96[](0);
        uint40[] memory c = new uint40[](0);
        vm.prank(operator);
        vm.expectRevert("Unadmitted book");
        vault.updateQuotes(outsideBook, p, s, p, s, c);
        vm.prank(operator);
        vault.updateQuotes(putBook, p, s, p, s, c);
        assertEq(MockKuruBook(putBook).updates(), 1);
        vm.warp(expiry - 30);
        vm.prank(operator);
        vm.expectRevert("Quote cutoff");
        vault.updateQuotes(putBook, p, s, p, s, c);
        vm.prank(operator);
        vault.cancelQuotes(putBook, c);
        vm.prank(operator);
        vm.expectRevert("Unadmitted token");
        vault.depositToVenue(outsideToken, 1);
    }

    function testRejectsDeliverableCallsEvenWithVenue() public {
        uint256 call = engine.createSeries(address(mon), asset, expiry, OptionsEngine.Kind.Call, 90e8, 0, 1e35, "C");
        address token = engine.getSeries(call).token;
        router.register(call, address(new MockVenue(address(new MockKuruBook(token)), token, address(usd))));
        vm.warp(launch);
        vm.prank(operator);
        vm.expectRevert("Ineligible series");
        vault.roll(one(call));
    }

    function testSharesAreNonTransferable() public {
        vm.prank(alice);
        vault.deposit(100e6);
        launchWith(none());
        vm.prank(alice);
        vault.redeemShares();
        vm.prank(alice);
        vm.expectRevert("Non-transferable");
        vault.transfer(bob, 1);
    }

    function testRollRequiresSettlementThenTimesOutToIdle() public {
        uint256 id = list(OptionsEngine.Kind.Put, 90e8, 0);
        vm.prank(alice);
        vault.deposit(10_000e6);
        launchWith(one(id));
        sellPuts(id, 10e18, 20e6);
        vm.warp(expiry + 1);
        vm.prank(operator);
        vm.expectRevert("Settlement pending");
        vault.roll(none());
        vm.prank(bob);
        vm.expectRevert("Operator only");
        vault.roll(none());
        vm.warp(launch + 14 days);
        vm.prank(bob);
        vm.expectRevert("Settlement pending");
        vault.roll(none());
        vault.excludeSeries(id);
        vm.prank(bob);
        vault.roll(none());
        assertEq(vault.epoch(), 2);
        // Late settlement is recovered into the then-current share price.
        oracle.publish(asset, 95e8);
        oracle.finalize(asset, expiry, new bytes[](0));
        uint256 idle = vault.idleAssets();
        vault.settleLegacySeries(id);
        assertEq(vault.idleAssets() - idle, 900e6);
    }

    function testDepositCapAndPause() public {
        vault.setParameters(fees, 1000, 500e6, false);
        vm.prank(alice);
        vm.expectRevert("Deposit cap");
        vault.deposit(501e6);
        vault.setParameters(fees, 1000, 500e6, true);
        vm.prank(alice);
        vm.expectRevert("Deposits unavailable");
        vault.deposit(1e6);
    }

    function testFuzzRollConservesCash(uint96 a, uint96 b, uint32 premium, uint32 settle) public {
        uint256 depositA = bound(a, 1_000e6, 400_000e6);
        uint256 depositB = bound(b, 1e6, 400_000e6);
        uint256 price = bound(settle, 50e8, 150e8);
        uint256 id = list(OptionsEngine.Kind.Put, 90e8, 0);
        vm.prank(alice);
        vault.deposit(depositA);
        launchWith(one(id));
        uint256 quantity = (depositA / 90e6) * 1e18;
        if (quantity > 0) sellPuts(id, quantity, bound(premium, 0, 1_000e6));
        vm.prank(bob);
        vault.deposit(depositB);
        vm.prank(alice);
        vault.requestWithdraw(depositA / 2);
        settleAt(price);
        vm.prank(operator);
        vault.roll(none());
        uint256 cash = usd.balanceOf(address(vault));
        assertGe(cash, vault.epochStartAssets() + vault.reservedWithdrawals());
        vm.prank(alice);
        vault.completeWithdraw();
        assertGe(usd.balanceOf(address(vault)), vault.epochStartAssets());
    }
}
