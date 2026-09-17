// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP7702Utils} from "@openzeppelin/contracts/account/utils/EIP7702Utils.sol";
import {IExpiryOracle} from "./Oracle.sol";

contract OptionToken is ERC20 {
    address public immutable engine;
    uint256 public immutable seriesId;

    constructor(string memory name_, string memory symbol_, uint256 id) ERC20(name_, symbol_) {
        engine = msg.sender;
        seriesId = id;
    }

    function mint(address to, uint256 quantity) external {
        require(msg.sender == engine, "Engine only");
        _mint(to, quantity);
    }

    function burn(address from, uint256 quantity) external {
        require(msg.sender == engine, "Engine only");
        _burn(from, quantity);
    }
}

contract OptionsEngine is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    enum Kind {
        Call,
        Put,
        BullSpread,
        BearSpread
    }

    struct Series {
        address token;
        address underlying;
        address collateral;
        bytes32 asset;
        uint64 expiry;
        Kind kind;
        uint256 strike;
        uint256 upperStrike;
        uint256 escrow;
        uint256 shortQuantity;
        uint256 writers;
        uint256 cap;
    }

    struct Writer {
        uint256 quantity;
        uint256 collateral;
    }

    struct Unwind {
        uint256 seriesId;
        address writer;
        address holder;
        uint256 quantity;
        uint256 payment;
        uint256 writerNonce;
        uint256 holderNonce;
        uint256 deadline;
    }

    bytes32 private constant UNWIND_TYPEHASH = keccak256(
        "Unwind(uint256 seriesId,address writer,address holder,uint256 quantity,uint256 payment,uint256 writerNonce,uint256 holderNonce,uint256 deadline)"
    );
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("Claim(uint256 seriesId,address holder,uint256 quantity,uint256 nonce,uint256 deadline)");
    IExpiryOracle public immutable oracle;
    IERC20 public immutable usdc;
    uint256 public seriesCount;
    bool public issuancePaused;
    uint64 public immutable maxPriceAge;
    mapping(uint256 => Series) public series;
    mapping(uint256 => mapping(address => Writer)) public writers;
    mapping(bytes32 => bool) public seriesExists;
    mapping(address => bool) public approvedUnderlying;
    mapping(address => uint256) public nonces;

    event SeriesCreated(
        uint256 indexed id,
        address token,
        address underlying,
        bytes32 asset,
        uint64 expiry,
        Kind kind,
        uint256 strike,
        uint256 upperStrike
    );
    event Written(
        uint256 indexed id, address indexed writer, address indexed receiver, uint256 quantity, uint256 collateral
    );
    event Closed(uint256 indexed id, address indexed writer, uint256 quantity, uint256 collateral);
    event Redeemed(uint256 indexed id, address indexed holder, address recipient, uint256 quantity, uint256 payout);
    event WriterSettled(uint256 indexed id, address indexed writer, address recipient, uint256 collateralReturned);
    event Unwound(
        uint256 indexed id, address indexed writer, address indexed holder, uint256 quantity, uint256 payment
    );
    event IssuancePauseChanged(bool paused);

    constructor(address stablecoin, address oracle_, uint64 priceAge) Ownable(msg.sender) EIP712("Strata", "1") {
        require(
            stablecoin.code.length > 0 && oracle_.code.length > 0 && IERC20Metadata(stablecoin).decimals() == 6
                && priceAge > 0,
            "Invalid config"
        );
        usdc = IERC20(stablecoin);
        oracle = IExpiryOracle(oracle_);
        maxPriceAge = priceAge;
    }

    function approveUnderlying(address token, bool approved) external onlyOwner {
        require(token.code.length > 0 && IERC20Metadata(token).decimals() == 18, "18 decimal underlying required");
        approvedUnderlying[token] = approved;
    }

    function pauseIssuance(bool value) external onlyOwner {
        issuancePaused = value;
        emit IssuancePauseChanged(value);
    }

    function createSeries(
        address underlying,
        bytes32 asset,
        uint64 expiry,
        Kind kind,
        uint256 strike,
        uint256 upperStrike,
        uint256 cap,
        string calldata symbol
    ) external onlyOwner returns (uint256 id) {
        // Calls deliver the underlying token, so they need an approved token. Cash-settled
        // kinds pay dUSDC and may list assets with no token (equities, metals, FX).
        require(
            asset != bytes32(0)
                && (
                    kind == Kind.Call
                        ? approvedUnderlying[underlying]
                        : underlying == address(0) || approvedUnderlying[underlying]
                ),
            "Unapproved underlying"
        );
        require(
            expiry > block.timestamp && expiry <= block.timestamp + 365 days && strike > 0 && strike <= 1e18 && cap > 0,
            "Invalid terms"
        );
        require(
            kind == Kind.Call || kind == Kind.Put ? upperStrike == 0 : upperStrike > strike && upperStrike <= 1e18,
            "Invalid upper strike"
        );
        bytes32 key = keccak256(abi.encode(underlying, asset, expiry, kind, strike, upperStrike));
        require(!seriesExists[key], "Duplicate series");
        seriesExists[key] = true;
        id = ++seriesCount;
        OptionToken token = new OptionToken(string.concat("Strata ", symbol), symbol, id);
        series[id] = Series(
            address(token),
            underlying,
            kind == Kind.Call ? underlying : address(usdc),
            asset,
            expiry,
            kind,
            strike,
            upperStrike,
            0,
            0,
            0,
            cap
        );
        emit SeriesCreated(id, address(token), underlying, asset, expiry, kind, strike, upperStrike);
    }

    function getSeries(uint256 id) external view returns (Series memory) {
        return _series(id);
    }

    function _series(uint256 id) internal view returns (Series storage s) {
        s = series[id];
        require(s.token != address(0), "Unknown series");
    }

    function requiredCollateral(uint256 id, uint256 quantity) public view returns (uint256) {
        Series storage s = _series(id);
        if (s.kind == Kind.Call) return quantity;
        uint256 rate = s.kind == Kind.Put ? s.strike : s.upperStrike - s.strike;
        return Math.mulDiv(quantity, rate, 1e20, Math.Rounding.Ceil);
    }

    function healthy(uint256 id) public view returns (bool) {
        Series storage s = _series(id);
        (uint256 price, uint64 timestamp) = oracle.livePrice(s.asset);
        return price > 0 && timestamp <= block.timestamp && block.timestamp - timestamp <= maxPriceAge;
    }

    function write(uint256 id, uint256 quantity, address receiver) external nonReentrant {
        Series storage s = _series(id);
        require(!issuancePaused && block.timestamp < s.expiry && healthy(id), "Issuance unavailable");
        require(quantity > 0 && receiver != address(0), "Invalid write");
        Writer storage w = writers[id][msg.sender];
        uint256 next = requiredCollateral(id, w.quantity + quantity);
        uint256 added = next - w.collateral;
        require(s.escrow + added <= s.cap, "Exposure cap");
        uint256 beforeBalance = IERC20(s.collateral).balanceOf(address(this));
        IERC20(s.collateral).safeTransferFrom(msg.sender, address(this), added);
        require(IERC20(s.collateral).balanceOf(address(this)) - beforeBalance == added, "Unsupported collateral");
        if (w.quantity == 0) s.writers++;
        w.quantity += quantity;
        w.collateral = next;
        s.shortQuantity += quantity;
        s.escrow += added;
        OptionToken(s.token).mint(receiver, quantity);
        emit Written(id, msg.sender, receiver, quantity, added);
    }

    function closeWrite(uint256 id, uint256 quantity) external nonReentrant {
        Series storage s = _series(id);
        require(block.timestamp < s.expiry && quantity > 0, "Cannot close");
        Writer storage w = writers[id][msg.sender];
        require(quantity <= w.quantity, "Insufficient obligation");
        uint256 next = requiredCollateral(id, w.quantity - quantity);
        uint256 released = w.collateral - next;
        OptionToken(s.token).burn(msg.sender, quantity);
        w.quantity -= quantity;
        w.collateral = next;
        s.shortQuantity -= quantity;
        s.escrow -= released;
        if (w.quantity == 0) s.writers--;
        IERC20(s.collateral).safeTransfer(msg.sender, released);
        emit Closed(id, msg.sender, quantity, released);
    }

    function _payout(uint256 id, uint256 quantity, uint256 price, Math.Rounding rounding)
        internal
        view
        returns (uint256)
    {
        Series storage s = _series(id);
        if (s.kind == Kind.Call) return price > s.strike ? Math.mulDiv(quantity, price - s.strike, price, rounding) : 0;
        uint256 payoff;
        if (s.kind == Kind.Put) {
            payoff = price < s.strike ? s.strike - price : 0;
        } else if (s.kind == Kind.BullSpread) {
            payoff = price > s.strike ? Math.min(price - s.strike, s.upperStrike - s.strike) : 0;
        } else {
            payoff = price < s.upperStrike ? Math.min(s.upperStrike - price, s.upperStrike - s.strike) : 0;
        }
        return Math.mulDiv(quantity, payoff, 1e20, rounding);
    }

    function previewPayout(uint256 id, uint256 quantity, uint256 price) external view returns (uint256) {
        require(price > 0 && price <= 1e18, "Invalid price");
        return _payout(id, quantity, price, Math.Rounding.Floor);
    }

    function _settlement(uint256 id) internal view returns (uint256 price) {
        Series storage s = _series(id);
        require(block.timestamp >= s.expiry, "Not expired");
        price = oracle.settlementPrice(s.asset, s.expiry);
        require(price > 0, "Settlement pending");
    }

    function redeemLong(uint256 id, uint256 quantity, address recipient) external nonReentrant {
        _redeem(id, msg.sender, quantity, recipient);
    }

    function _redeem(uint256 id, address holder, uint256 quantity, address recipient) internal {
        require(quantity > 0 && recipient != address(0), "Invalid claim");
        uint256 price = _settlement(id);
        Series storage s = _series(id);
        uint256 payout = _payout(id, quantity, price, Math.Rounding.Floor);
        OptionToken(s.token).burn(holder, quantity);
        s.escrow -= payout;
        IERC20(s.collateral).safeTransfer(recipient, payout);
        emit Redeemed(id, holder, recipient, quantity, payout);
    }

    function redeemWithSignature(
        uint256 id,
        address holder,
        uint256 quantity,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        require(block.timestamp <= deadline, "Expired authorization");
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, id, holder, quantity, nonces[holder]++, deadline)));
        require(_isAuthorized(holder, digest, signature), "Invalid authorization");
        _redeem(id, holder, quantity, holder);
    }

    /// @notice Revoke every outstanding Claim/Unwind signature using the old nonce.
    function invalidateAuthorizations() external {
        emit AuthorizationsInvalidated(msg.sender, ++nonces[msg.sender]);
    }

    event AuthorizationsInvalidated(address indexed account, uint256 nonce);

    function settleWriter(uint256 id, address recipient) external nonReentrant {
        require(recipient != address(0), "Invalid recipient");
        uint256 price = _settlement(id);
        Series storage s = _series(id);
        Writer memory w = writers[id][msg.sender];
        require(w.quantity > 0, "No writer position");
        uint256 returned = w.collateral - _payout(id, w.quantity, price, Math.Rounding.Ceil);
        delete writers[id][msg.sender];
        s.shortQuantity -= w.quantity;
        s.writers--;
        s.escrow -= returned;
        IERC20(s.collateral).safeTransfer(recipient, returned);
        emit WriterSettled(id, msg.sender, recipient, returned);
    }

    function unwindUnresolved(Unwind calldata u, bytes calldata writerSignature, bytes calldata holderSignature)
        external
        nonReentrant
    {
        Series storage s = _series(u.seriesId);
        require(block.timestamp >= s.expiry && oracle.settlementPrice(s.asset, s.expiry) == 0, "Not unresolved");
        require(
            block.timestamp <= u.deadline && u.quantity > 0 && u.writer != u.holder && u.writer != address(0)
                && u.holder != address(0),
            "Invalid unwind"
        );
        require(u.writerNonce == nonces[u.writer]++ && u.holderNonce == nonces[u.holder]++, "Invalid nonce");
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    UNWIND_TYPEHASH,
                    u.seriesId,
                    u.writer,
                    u.holder,
                    u.quantity,
                    u.payment,
                    u.writerNonce,
                    u.holderNonce,
                    u.deadline
                )
            )
        );
        require(
            _isAuthorized(u.writer, digest, writerSignature) && _isAuthorized(u.holder, digest, holderSignature),
            "Invalid signatures"
        );
        Writer storage w = writers[u.seriesId][u.writer];
        require(u.quantity <= w.quantity, "Insufficient obligation");
        uint256 next = requiredCollateral(u.seriesId, w.quantity - u.quantity);
        uint256 released = w.collateral - next;
        OptionToken(s.token).burn(u.holder, u.quantity);
        w.quantity -= u.quantity;
        w.collateral = next;
        s.shortQuantity -= u.quantity;
        s.escrow -= released;
        if (w.quantity == 0) s.writers--;
        usdc.safeTransferFrom(u.writer, u.holder, u.payment);
        IERC20(s.collateral).safeTransfer(u.writer, released);
        emit Unwound(u.seriesId, u.writer, u.holder, u.quantity, u.payment);
    }

    function sweepDust(uint256 id) external nonReentrant {
        Series storage s = _series(id);
        _settlement(id);
        require(s.writers == 0 && IERC20(s.token).totalSupply() == 0, "Outstanding claims");
        uint256 amount = s.escrow;
        s.escrow = 0;
        IERC20(s.collateral).safeTransfer(owner(), amount);
    }

    function _isAuthorized(address signer, bytes32 digest, bytes memory signature) internal view returns (bool) {
        // Delegated EOAs retain their key authority even when the delegation
        // implementation does not expose ERC-1271. Ordinary contract wallets
        // continue to use their own ERC-1271 policy.
        if (signer.code.length == 0 || (signer.code.length == 23 && EIP7702Utils.fetchDelegate(signer) != address(0))) {
            address recovered;
            ECDSA.RecoverError err;
            if (signature.length == 64) {
                bytes32 r;
                bytes32 vs;
                assembly ("memory-safe") {
                    r := mload(add(signature, 0x20))
                    vs := mload(add(signature, 0x40))
                }
                (recovered, err,) = ECDSA.tryRecover(digest, r, vs);
            } else {
                (recovered, err,) = ECDSA.tryRecover(digest, signature);
            }
            if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        }
        return SignatureChecker.isValidSignatureNow(signer, digest, signature);
    }
}
