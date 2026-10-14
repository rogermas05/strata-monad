// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OptionsEngine} from "./OptionsEngine.sol";
import {StrategyRouter, IKuruMargin} from "./Venues.sol";

interface IKuruVenue {
    function book() external view returns (address);
}

interface IKuruQuotes {
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata orderIdsToCancel,
        bool postOnly
    ) external;
    function batchCancelOrdersNoRevert(uint40[] calldata orderIds) external;
}

/// @notice Pooled, fully funded option writer. Depositors own the house book.
/// @dev Weekly epochs: every series traded in an epoch settles to USDC before the
/// next roll, so the share price is computed from cash only, with no model marks.
/// The operator can write, quote and cancel through admitted Kuru books, but no
/// function transfers vault funds to the operator. Pricing remains a trust assumption.
contract HouseVault is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PPS_UNIT = 1e18;
    uint256 public constant MAX_SERIES = 64;
    uint16 public constant MAX_FEE_BPS = 3000;
    /// @notice New quotes stop this long before a series expires.
    uint64 public constant QUOTE_CUTOFF = 60;
    /// @notice After this long without a roll, anyone may roll into an idle epoch.
    uint64 public constant ROLL_TIMEOUT = 14 days;
    /// @notice A series still unresolved this long after expiry may be excluded from a roll.
    uint64 public constant EXCLUSION_DELAY = 3 days;

    struct DepositReceipt {
        uint256 epoch;
        uint256 amount;
        uint256 unredeemedShares;
    }

    struct Withdrawal {
        uint256 epoch;
        uint256 shares;
    }

    OptionsEngine public immutable engine;
    IERC20 public immutable usdc;
    StrategyRouter public immutable router;
    IKuruMargin public immutable margin;
    uint64 public immutable launchTime;

    address public operator;
    address public feeRecipient;
    uint16 public performanceFeeBps;
    uint256 public depositCap;
    bool public depositsPaused;

    /// @notice 0 is the genesis pre-deposit window; trading epochs start at 1.
    uint256 public epoch;
    uint64 public lastRollTime;
    uint256 public pendingDeposits;
    uint256 public queuedShares;
    uint256 public reservedWithdrawals;
    uint256 public epochStartAssets;

    uint256[] internal currentSeries;
    mapping(uint256 => uint256) public seriesEpoch;
    mapping(uint256 => bool) public excluded;
    mapping(address => uint256) public bookSeries;
    mapping(address => bool) public knownBook;
    mapping(uint256 => uint256) public pricePerShare;
    mapping(address => DepositReceipt) public depositReceipts;
    mapping(address => Withdrawal) public withdrawals;

    event Deposited(address indexed account, uint256 indexed epoch, uint256 amount);
    event DepositCancelled(address indexed account, uint256 indexed epoch, uint256 amount);
    event SharesRedeemed(address indexed account, uint256 shares);
    event WithdrawRequested(address indexed account, uint256 indexed epoch, uint256 shares);
    event Withdrawn(address indexed account, uint256 indexed epoch, uint256 shares, uint256 amount);
    event Rolled(
        uint256 indexed epoch,
        uint256 pricePerShare,
        uint256 assets,
        uint256 fee,
        uint256 mintedShares,
        uint256 burnedShares,
        uint256 depositedAssets,
        uint256 withdrawnAssets
    );
    event EpochSeries(uint256 indexed epoch, uint256[] seriesIds);
    event SeriesExcluded(uint256 indexed seriesId);
    event OperatorChanged(address operator);
    event ParametersChanged(address feeRecipient, uint16 performanceFeeBps, uint256 depositCap, bool depositsPaused);

    modifier onlyOperator() {
        require(msg.sender == operator, "Operator only");
        _;
    }

    constructor(
        address engine_,
        address router_,
        address margin_,
        address operator_,
        address feeRecipient_,
        uint16 feeBps,
        uint256 cap,
        uint64 launch
    ) ERC20("Strata House Share", "sHOUSE") Ownable(msg.sender) {
        require(
            engine_.code.length > 0 && router_.code.length > 0 && margin_.code.length > 0 && operator_ != address(0)
                && feeRecipient_ != address(0) && feeBps <= MAX_FEE_BPS && cap > 0,
            "Invalid config"
        );
        engine = OptionsEngine(engine_);
        router = StrategyRouter(router_);
        require(address(router.engine()) == engine_, "Router engine mismatch");
        usdc = engine.usdc();
        margin = IKuruMargin(margin_);
        operator = operator_;
        feeRecipient = feeRecipient_;
        performanceFeeBps = feeBps;
        depositCap = cap;
        launchTime = launch;
        lastRollTime = uint64(block.timestamp);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ---------------------------------------------------------------- depositors

    function deposit(uint256 amount) external nonReentrant {
        require(!depositsPaused && amount > 0, "Deposits unavailable");
        require(epochStartAssets + pendingDeposits + amount <= depositCap, "Deposit cap");
        DepositReceipt storage r = _convertReceipt(msg.sender);
        r.amount += amount;
        r.epoch = epoch;
        pendingDeposits += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, epoch, amount);
    }

    /// @notice Pending deposits can be cancelled until the next roll prices them.
    function cancelDeposit(uint256 amount) external nonReentrant {
        DepositReceipt storage r = depositReceipts[msg.sender];
        require(amount > 0 && r.epoch == epoch && r.amount >= amount, "Nothing pending");
        r.amount -= amount;
        pendingDeposits -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit DepositCancelled(msg.sender, epoch, amount);
    }

    function redeemShares() public nonReentrant {
        _redeemShares(msg.sender);
    }

    function requestWithdraw(uint256 shares) external nonReentrant {
        require(shares > 0, "Invalid shares");
        _redeemShares(msg.sender);
        Withdrawal storage w = withdrawals[msg.sender];
        if (w.shares > 0 && w.epoch < epoch) _completeWithdraw(msg.sender);
        _transfer(msg.sender, address(this), shares);
        w.shares += shares;
        w.epoch = epoch;
        queuedShares += shares;
        emit WithdrawRequested(msg.sender, epoch, shares);
    }

    function completeWithdraw() external nonReentrant {
        Withdrawal storage w = withdrawals[msg.sender];
        require(w.shares > 0 && w.epoch < epoch, "Withdrawal not ready");
        _completeWithdraw(msg.sender);
    }

    // ---------------------------------------------------------------- views

    function idleAssets() public view returns (uint256) {
        uint256 balance = usdc.balanceOf(address(this));
        uint256 reserved = pendingDeposits + reservedWithdrawals;
        return balance > reserved ? balance - reserved : 0;
    }

    function epochSeries() external view returns (uint256[] memory) {
        return currentSeries;
    }

    /// @notice Shares owned by an account, including those not yet moved to its wallet.
    function shareBalance(address account) external view returns (uint256) {
        DepositReceipt memory r = depositReceipts[account];
        uint256 shares = balanceOf(account) + r.unredeemedShares;
        if (r.amount > 0 && r.epoch < epoch) shares += Math.mulDiv(r.amount, PPS_UNIT, pricePerShare[r.epoch]);
        return shares;
    }

    function withdrawableAssets(address account) external view returns (uint256) {
        Withdrawal memory w = withdrawals[account];
        if (w.shares == 0 || w.epoch >= epoch) return 0;
        return Math.mulDiv(w.shares, pricePerShare[w.epoch], PPS_UNIT);
    }

    // ---------------------------------------------------------------- epochs

    /// @notice Settles the finished epoch to cash, prices shares and admits the next series.
    function roll(uint256[] calldata nextSeries) external nonReentrant {
        bool timedOut = block.timestamp >= lastRollTime + ROLL_TIMEOUT;
        require(
            msg.sender == operator || msg.sender == owner() || (timedOut && nextSeries.length == 0), "Operator only"
        );
        require(nextSeries.length <= MAX_SERIES, "Too many series");
        if (epoch == 0) require(block.timestamp >= launchTime, "Before launch");
        for (uint256 i; i < currentSeries.length; i++) {
            uint256 id = currentSeries[i];
            bookSeries[_book(id)] = 0;
            if (!excluded[id]) _settleSeries(id);
        }
        _withdrawVenueCash();
        _priceEpoch();
        delete currentSeries;
        epoch++;
        lastRollTime = uint64(block.timestamp);
        for (uint256 i; i < nextSeries.length; i++) _admit(nextSeries[i]);
        emit EpochSeries(epoch, nextSeries);
    }

    /// @notice Lets a roll proceed without a series whose settlement never resolved.
    /// Its value is excluded from this roll and recovered later through settleLegacySeries.
    function excludeSeries(uint256 id) external onlyOwner {
        OptionsEngine.Series memory s = engine.getSeries(id);
        require(seriesEpoch[id] == epoch && block.timestamp >= s.expiry + EXCLUSION_DELAY, "Cannot exclude");
        excluded[id] = true;
        emit SeriesExcluded(id);
    }

    /// @notice Settles an earlier epoch's leftover position into the current share price.
    function settleLegacySeries(uint256 id) external nonReentrant {
        require(seriesEpoch[id] != 0 && seriesEpoch[id] < epoch, "Not a legacy series");
        _settleSeries(id);
    }

    // ---------------------------------------------------------------- operator

    function write(uint256 id, uint256 quantity) external onlyOperator nonReentrant {
        _requireTradable(id);
        (uint256 written, uint256 collateral) = engine.writers(id, address(this));
        uint256 needed = engine.requiredCollateral(id, written + quantity) - collateral;
        usdc.forceApprove(address(engine), needed);
        engine.write(id, quantity, address(this));
        usdc.forceApprove(address(engine), 0);
        _checkReserves();
    }

    function closeWrite(uint256 id, uint256 quantity) external onlyOperator nonReentrant {
        engine.closeWrite(id, quantity);
    }

    function depositToVenue(address token, uint256 amount) external onlyOperator nonReentrant {
        require(token == address(usdc) || bookSeries[_bookForToken(token)] != 0, "Unadmitted token");
        IERC20(token).forceApprove(address(margin), amount);
        margin.deposit(address(this), token, amount);
        IERC20(token).forceApprove(address(margin), 0);
        _checkReserves();
    }

    /// @notice Venue withdrawals always return to the vault itself.
    function withdrawFromVenue(address token, uint256 amount) external onlyOperator nonReentrant {
        margin.withdraw(amount, token);
    }

    function updateQuotes(
        address book,
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata cancelIds
    ) external onlyOperator nonReentrant {
        uint256 id = bookSeries[book];
        require(id != 0, "Unadmitted book");
        _requireTradable(id);
        IKuruQuotes(book).batchUpdate(buyPrices, buySizes, sellPrices, sellSizes, cancelIds, true);
    }

    /// @notice Cancellation stays available on every book the vault has used, including expired ones.
    function cancelQuotes(address book, uint40[] calldata ids) external onlyOperator nonReentrant {
        require(knownBook[book], "Unknown book");
        IKuruQuotes(book).batchCancelOrdersNoRevert(ids);
    }

    // ---------------------------------------------------------------- owner

    function setOperator(address next) external onlyOwner {
        require(next != address(0), "Invalid operator");
        operator = next;
        emit OperatorChanged(next);
    }

    function setParameters(address recipient, uint16 feeBps, uint256 cap, bool paused) external onlyOwner {
        require(recipient != address(0) && feeBps <= MAX_FEE_BPS && cap > 0, "Invalid parameters");
        feeRecipient = recipient;
        performanceFeeBps = feeBps;
        depositCap = cap;
        depositsPaused = paused;
        emit ParametersChanged(recipient, feeBps, cap, paused);
    }

    // ---------------------------------------------------------------- internals

    /// @dev Shares only move between accounts and the vault, which keeps point accounting exact.
    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || to == address(0) || from == address(this) || to == address(this), "Non-transferable");
        super._update(from, to, value);
    }

    function _convertReceipt(address account) internal returns (DepositReceipt storage r) {
        r = depositReceipts[account];
        if (r.amount > 0 && r.epoch < epoch) {
            r.unredeemedShares += Math.mulDiv(r.amount, PPS_UNIT, pricePerShare[r.epoch]);
            r.amount = 0;
        }
    }

    function _redeemShares(address account) internal {
        DepositReceipt storage r = _convertReceipt(account);
        uint256 shares = r.unredeemedShares;
        if (shares == 0) return;
        r.unredeemedShares = 0;
        _transfer(address(this), account, shares);
        emit SharesRedeemed(account, shares);
    }

    function _completeWithdraw(address account) internal {
        Withdrawal memory w = withdrawals[account];
        uint256 amount = Math.mulDiv(w.shares, pricePerShare[w.epoch], PPS_UNIT);
        delete withdrawals[account];
        reservedWithdrawals -= amount;
        usdc.safeTransfer(account, amount);
        emit Withdrawn(account, w.epoch, w.shares, amount);
    }

    function _priceEpoch() internal {
        uint256 assets = idleAssets();
        uint256 fee;
        if (epoch > 0 && assets > epochStartAssets) {
            fee = Math.mulDiv(assets - epochStartAssets, performanceFeeBps, 10_000);
            assets -= fee;
        }
        uint256 supply = totalSupply();
        uint256 pps = supply == 0 ? PPS_UNIT : Math.mulDiv(assets, PPS_UNIT, supply);
        // A wiped-out epoch must still price new deposits without dividing by zero.
        if (pps == 0) pps = 1;
        pricePerShare[epoch] = pps;
        uint256 burned = queuedShares;
        uint256 withdrawn = Math.min(Math.mulDiv(burned, pps, PPS_UNIT), assets);
        if (burned > 0) _burn(address(this), burned);
        reservedWithdrawals += withdrawn;
        uint256 deposited = pendingDeposits;
        uint256 minted = Math.mulDiv(deposited, PPS_UNIT, pps);
        if (minted > 0) _mint(address(this), minted);
        pendingDeposits = 0;
        queuedShares = 0;
        epochStartAssets = assets - withdrawn + deposited;
        if (fee > 0) usdc.safeTransfer(feeRecipient, fee);
        emit Rolled(epoch, pps, epochStartAssets, fee, minted, burned, deposited, withdrawn);
    }

    function _settleSeries(uint256 id) internal {
        OptionsEngine.Series memory s = engine.getSeries(id);
        uint256 free = margin.getBalance(address(this), s.token);
        if (free > 0) margin.withdraw(free, s.token);
        uint256 held = IERC20(s.token).balanceOf(address(this));
        if (held > 0) engine.redeemLong(id, held, address(this));
        (uint256 written,) = engine.writers(id, address(this));
        if (written > 0) engine.settleWriter(id, address(this));
    }

    function _withdrawVenueCash() internal {
        uint256 cash = margin.getBalance(address(this), address(usdc));
        if (cash > 0) margin.withdraw(cash, address(usdc));
    }

    function _admit(uint256 id) internal {
        OptionsEngine.Series memory s = engine.getSeries(id);
        require(s.collateral == address(usdc) && s.expiry > block.timestamp + QUOTE_CUTOFF, "Ineligible series");
        require(seriesEpoch[id] == 0, "Series already traded");
        address book = _book(id);
        require(bookSeries[book] == 0, "Duplicate series");
        seriesEpoch[id] = epoch;
        bookSeries[book] = id;
        knownBook[book] = true;
        currentSeries.push(id);
    }

    function _book(uint256 id) internal view returns (address) {
        address venue = address(router.venues(id));
        require(venue != address(0), "Unregistered market");
        return IKuruVenue(venue).book();
    }

    function _bookForToken(address token) internal view returns (address) {
        for (uint256 i; i < currentSeries.length; i++) {
            if (engine.getSeries(currentSeries[i]).token == token) return _book(currentSeries[i]);
        }
        return address(0);
    }

    function _requireTradable(uint256 id) internal view {
        require(epoch > 0 && seriesEpoch[id] == epoch && !excluded[id], "Series not in epoch");
        require(block.timestamp + QUOTE_CUTOFF < engine.getSeries(id).expiry, "Quote cutoff");
    }

    function _checkReserves() internal view {
        require(usdc.balanceOf(address(this)) >= pendingDeposits + reservedWithdrawals, "Reserved funds");
    }
}
