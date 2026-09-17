// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OptionsEngine} from "./OptionsEngine.sol";

interface IExactVenue {
    function base() external view returns (address);
    function quote() external view returns (address);
    function buy(uint256 quantity, uint256 maxCost, address recipient) external returns (uint256 cost);
    function sell(uint256 quantity, uint256 minProceeds, address recipient) external returns (uint256 proceeds);
}

/// @notice Original bounded development orderbook, explicitly distinct from Kuru.
contract DemoOrderBook is IExactVenue, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Order {
        address owner;
        bool isBuy;
        uint256 price;
        uint256 remaining;
        uint256 reserved;
        uint8 slot;
    }

    address public immutable base;
    address public immutable quote;
    uint64 public immutable expiry;
    uint256 public nextId;
    uint256[64] public slots;
    mapping(uint256 => Order) public orders;

    event OrderCreated(uint256 indexed id, address indexed owner, bool isBuy, uint256 price, uint256 quantity);
    event OrderCancelled(uint256 indexed id, address indexed owner);
    event Trade(
        uint256 indexed id,
        address indexed maker,
        address indexed taker,
        bool takerBuy,
        uint256 quantity,
        uint256 price,
        uint256 quoteAmount
    );

    constructor(address base_, address quote_, uint64 expiry_) {
        base = base_;
        quote = quote_;
        expiry = expiry_;
    }

    function place(bool isBuy, uint256 price, uint256 quantity) external nonReentrant returns (uint256 id) {
        require(block.timestamp < expiry && price > 0 && quantity >= 1e15 && quantity % 1e15 == 0, "Invalid order");
        uint256 opposite = _best(!isBuy);
        if (opposite != 0) {
            require(isBuy ? price < orders[opposite].price : price > orders[opposite].price, "Post-only would cross");
        }
        uint8 slot;
        bool found;
        for (uint8 i; i < 64; i++) {
            if (slots[i] == 0) {
                slot = i;
                found = true;
                break;
            }
        }
        require(found, "Book full");
        uint256 reserve = isBuy ? Math.mulDiv(quantity, price, 1e18, Math.Rounding.Ceil) : quantity;
        IERC20(isBuy ? quote : base).safeTransferFrom(msg.sender, address(this), reserve);
        id = ++nextId;
        slots[slot] = id;
        orders[id] = Order(msg.sender, isBuy, price, quantity, reserve, slot);
        emit OrderCreated(id, msg.sender, isBuy, price, quantity);
    }

    function cancel(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        require(o.owner == msg.sender && o.remaining > 0, "Not active owner");
        uint256 reserve = o.reserved;
        o.remaining = 0;
        o.reserved = 0;
        slots[o.slot] = 0;
        IERC20(o.isBuy ? quote : base).safeTransfer(msg.sender, reserve);
        emit OrderCancelled(id, msg.sender);
    }

    function _best(bool isBuy) internal view returns (uint256 best) {
        for (uint8 i; i < 64; i++) {
            uint256 id = slots[i];
            Order storage o = orders[id];
            if (id == 0 || o.remaining == 0 || o.isBuy != isBuy) continue;
            if (
                best == 0 || (isBuy ? o.price > orders[best].price : o.price < orders[best].price)
                    || (o.price == orders[best].price && id < best)
            ) best = id;
        }
    }

    function bestBidAsk() external view returns (uint256 bid, uint256 ask) {
        uint256 b = _best(true);
        uint256 a = _best(false);
        return (orders[b].price, orders[a].price);
    }

    function activeOrders() external view returns (uint256[] memory ids, Order[] memory values) {
        uint256 count;
        for (uint8 i; i < 64; i++) {
            if (slots[i] != 0) count++;
        }
        ids = new uint256[](count);
        values = new Order[](count);
        uint256 k;
        for (uint8 i; i < 64; i++) {
            if (slots[i] != 0) {
                ids[k] = slots[i];
                values[k++] = orders[slots[i]];
            }
        }
    }

    function buy(uint256 quantity, uint256 maxCost, address recipient) external nonReentrant returns (uint256 cost) {
        require(
            block.timestamp < expiry && quantity > 0 && quantity % 1e15 == 0 && recipient != address(0), "Invalid trade"
        );
        uint256 left = quantity;
        while (left > 0) {
            uint256 id = _best(false);
            require(id != 0, "Insufficient liquidity");
            Order storage o = orders[id];
            require(o.owner != msg.sender, "Self trade");
            uint256 filled = Math.min(left, o.remaining);
            uint256 value = Math.mulDiv(filled, o.price, 1e18, Math.Rounding.Ceil);
            cost += value;
            require(cost <= maxCost, "Premium limit");
            o.remaining -= filled;
            o.reserved -= filled;
            if (o.remaining == 0) slots[o.slot] = 0;
            left -= filled;
            IERC20(quote).safeTransferFrom(msg.sender, o.owner, value);
            IERC20(base).safeTransfer(recipient, filled);
            emit Trade(id, o.owner, msg.sender, true, filled, o.price, value);
        }
    }

    function sell(uint256 quantity, uint256 minProceeds, address recipient)
        external
        nonReentrant
        returns (uint256 proceeds)
    {
        require(
            block.timestamp < expiry && quantity > 0 && quantity % 1e15 == 0 && recipient != address(0), "Invalid trade"
        );
        uint256 left = quantity;
        while (left > 0) {
            uint256 id = _best(true);
            require(id != 0, "Insufficient liquidity");
            Order storage o = orders[id];
            require(o.owner != msg.sender, "Self trade");
            uint256 filled = Math.min(left, o.remaining);
            uint256 remainingReserve = Math.mulDiv(o.remaining - filled, o.price, 1e18, Math.Rounding.Ceil);
            uint256 value = o.reserved - remainingReserve;
            o.remaining -= filled;
            o.reserved = remainingReserve;
            if (o.remaining == 0) slots[o.slot] = 0;
            left -= filled;
            proceeds += value;
            IERC20(base).safeTransferFrom(msg.sender, o.owner, filled);
            IERC20(quote).safeTransfer(recipient, value);
            emit Trade(id, o.owner, msg.sender, false, filled, o.price, value);
        }
        require(proceeds >= minProceeds, "Premium limit");
    }
}

/// @notice Interface declarations only; no Kuru implementation is copied or redeployed.
interface IKuruBook {
    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256);
    function addBuyOrder(uint32 price, uint96 size, bool postOnly) external;
    function placeAndExecuteMarketSell(uint96 size, uint256 minOut, bool margin, bool fillOrKill)
        external
        payable
        returns (uint256);
}

interface IKuruMargin {
    function deposit(address user, address token, uint256 amount) external payable;
    function withdraw(uint256 amount, address token) external;
    function getBalance(address user, address token) external view returns (uint256);
}

/// @notice Exact-quantity adapter admitted only for zero-fee option markets, with precision checks.
contract KuruExactAdapter is IExactVenue, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable base;
    address public immutable quote;
    IKuruBook public immutable book;
    IKuruMargin public immutable margin;
    uint32 public immutable pricePrecision;
    uint96 public immutable sizePrecision;
    uint96 public immutable minSize;
    uint96 public immutable maxSize;
    uint32 public immutable tick;
    uint64 public immutable expiry;
    address public immutable recoveryRecipient;

    event DonationsRecovered(uint256 baseAmount, uint256 quoteAmount);

    constructor(address book_, address margin_, uint64 expiry_) {
        recoveryRecipient = msg.sender;
        book = IKuruBook(book_);
        margin = IKuruMargin(margin_);
        expiry = expiry_;
        (
            uint32 p,
            uint96 z,
            address b,
            uint256 bd,
            address q,
            uint256 qd,
            uint32 t,
            uint96 min,
            uint96 max,
            uint256 tf,
            uint256 mf
        ) = book.getMarketParams();
        require(bd == 18 && qd == 6 && tf == 0 && mf == 0, "Unsupported market");
        base = b;
        quote = q;
        pricePrecision = p;
        sizePrecision = z;
        tick = t;
        minSize = min;
        maxSize = max;
    }

    function _recoverDonations() internal {
        // Kuru permits third-party deposits to any margin account. A one-unit
        // donation must not permanently block an exact-fill adapter.
        uint256 freeBase = margin.getBalance(address(this), base);
        uint256 freeQuote = margin.getBalance(address(this), quote);
        if (freeBase > 0) margin.withdraw(freeBase, base);
        if (freeQuote > 0) margin.withdraw(freeQuote, quote);
        uint256 b = IERC20(base).balanceOf(address(this));
        uint256 q = IERC20(quote).balanceOf(address(this));
        if (b > 0) IERC20(base).safeTransfer(recoveryRecipient, b);
        if (q > 0) IERC20(quote).safeTransfer(recoveryRecipient, q);
        if (b > 0 || q > 0) emit DonationsRecovered(b, q);
    }

    function recoverDonations() external nonReentrant {
        _recoverDonations();
    }

    function _size(uint256 quantity) internal view returns (uint96 size) {
        uint256 scaled = Math.mulDiv(quantity, sizePrecision, 1e18);
        require(
            scaled >= minSize && scaled <= maxSize && Math.mulDiv(scaled, 1e18, sizePrecision) == quantity,
            "Invalid lot"
        );
        return uint96(scaled);
    }

    function buy(uint256 quantity, uint256 maxCost, address recipient) external nonReentrant returns (uint256 cost) {
        require(block.timestamp < expiry && recipient != address(0), "Invalid trade");
        uint96 size = _size(quantity);
        _recoverDonations();
        require(maxCost > 0, "Invalid premium limit");
        // The user bounds aggregate spend, not the weighted average as a per-unit limit.
        // Crossing the full admissible ladder is safe: only maxCost is deposited, and
        // Kuru debits actual spend. Insufficient funding or a partial remainder reverts.
        // A price cap at maxCost / quantity would incorrectly reject multi-level fills.
        uint32 scaledPrice = ((type(uint32).max - 1) / tick) * tick;
        uint256 beforeBase = IERC20(base).balanceOf(address(this));
        IERC20(quote).safeTransferFrom(msg.sender, address(this), maxCost);
        IERC20(quote).forceApprove(address(margin), maxCost);
        margin.deposit(address(this), quote, maxCost);
        book.addBuyOrder(scaledPrice, size, false);
        // A partial fill and any resting remainder revert together with all maker fills.
        require(margin.getBalance(address(this), base) == quantity, "Not exact fill");
        uint256 refund = margin.getBalance(address(this), quote);
        cost = maxCost - refund;
        margin.withdraw(quantity, base);
        if (refund > 0) margin.withdraw(refund, quote);
        require(IERC20(base).balanceOf(address(this)) - beforeBase == quantity, "Incorrect delivery");
        IERC20(base).safeTransfer(recipient, quantity);
        if (refund > 0) IERC20(quote).safeTransfer(msg.sender, refund);
        IERC20(quote).forceApprove(address(margin), 0);
    }

    function sell(uint256 quantity, uint256 minProceeds, address recipient)
        external
        nonReentrant
        returns (uint256 proceeds)
    {
        require(block.timestamp < expiry && recipient != address(0), "Invalid trade");
        uint96 size = _size(quantity);
        _recoverDonations();
        uint256 beforeQuote = IERC20(quote).balanceOf(address(this));
        IERC20(base).safeTransferFrom(msg.sender, address(this), quantity);
        IERC20(base).forceApprove(address(book), quantity);
        proceeds = book.placeAndExecuteMarketSell(size, minProceeds, false, true);
        require(
            IERC20(quote).balanceOf(address(this)) - beforeQuote == proceeds && proceeds >= minProceeds,
            "Incorrect proceeds"
        );
        IERC20(base).forceApprove(address(book), 0);
        IERC20(quote).safeTransfer(recipient, proceeds);
    }
}

contract StrategyRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Leg {
        uint256 seriesId;
        bool isBuy;
        uint256 quantity;
        uint256 premiumLimit;
    }

    OptionsEngine public immutable engine;
    IERC20 public immutable usdc;
    mapping(uint256 => IExactVenue) public venues;

    event VenueRegistered(uint256 indexed id, address venue);
    event Executed(address indexed owner, uint256 legs, uint256 funding, uint256 refund);

    constructor(address engine_) Ownable(msg.sender) {
        engine = OptionsEngine(engine_);
        usdc = engine.usdc();
    }

    function register(uint256 id, address venue) external onlyOwner {
        require(address(venues[id]) == address(0) && venue.code.length > 0, "Already registered");
        OptionsEngine.Series memory s = engine.getSeries(id);
        IExactVenue v = IExactVenue(venue);
        require(v.base() == s.token && v.quote() == address(usdc), "Wrong market");
        venues[id] = v;
        emit VenueRegistered(id, venue);
    }

    function execute(Leg[] calldata legs, uint256 funding, uint256 maxNetDebit, uint256 minNetCredit, uint256 deadline)
        external
        nonReentrant
    {
        require(block.timestamp <= deadline && legs.length > 0 && legs.length <= 4, "Invalid strategy");
        uint256 beforeBalance = usdc.balanceOf(address(this));
        if (funding > 0) usdc.safeTransferFrom(msg.sender, address(this), funding);
        for (uint256 i; i < legs.length; i++) {
            Leg calldata l = legs[i];
            OptionsEngine.Series memory s = engine.getSeries(l.seriesId);
            require(l.quantity > 0 && block.timestamp < s.expiry && engine.healthy(l.seriesId), "Market unavailable");
            IExactVenue v = venues[l.seriesId];
            require(address(v) != address(0), "Unregistered market");
            if (l.isBuy) {
                require(usdc.balanceOf(address(this)) >= beforeBalance + l.premiumLimit, "Peak funding insufficient");
                usdc.forceApprove(address(v), l.premiumLimit);
                v.buy(l.quantity, l.premiumLimit, msg.sender);
                usdc.forceApprove(address(v), 0);
            } else {
                IERC20(s.token).safeTransferFrom(msg.sender, address(this), l.quantity);
                IERC20(s.token).forceApprove(address(v), l.quantity);
                v.sell(l.quantity, l.premiumLimit, address(this));
                IERC20(s.token).forceApprove(address(v), 0);
            }
        }
        uint256 refund = usdc.balanceOf(address(this)) - beforeBalance;
        require(
            refund >= funding ? refund - funding >= minNetCredit : funding - refund <= maxNetDebit && minNetCredit == 0,
            "Net premium protection"
        );
        if (refund > 0) usdc.safeTransfer(msg.sender, refund);
        emit Executed(msg.sender, legs.length, funding, refund);
    }
}
