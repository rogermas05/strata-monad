// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IExpiryOracle {
    function livePrice(bytes32 asset) external view returns (uint256 price, uint64 publishedAt);
    function settlementPrice(bytes32 asset, uint64 expiry) external view returns (uint256);
    function finalize(bytes32 asset, uint64 expiry, bytes[] calldata proof) external payable returns (uint256);
}

/// @notice Controllable development oracle. Never represents authenticated Pyth prices.
contract DemoOracle is Ownable, IExpiryOracle {
    struct Observation {
        uint256 price;
        uint64 timestamp;
    }

    mapping(bytes32 => Observation[]) private observations;
    mapping(bytes32 => mapping(uint64 => uint256)) public settlementPrice;

    event PricePublished(bytes32 indexed asset, uint256 price, uint64 timestamp);
    event Finalized(bytes32 indexed asset, uint64 indexed expiry, uint256 price, uint64 publishedAt, bytes32 proofHash);

    constructor() Ownable(msg.sender) {}

    function publish(bytes32 asset, uint256 price) external onlyOwner {
        require(price > 0 && price <= 1e18, "Invalid price");
        Observation[] storage values = observations[asset];
        require(values.length == 0 || values[values.length - 1].timestamp < block.timestamp, "Duplicate timestamp");
        values.push(Observation(price, uint64(block.timestamp)));
        emit PricePublished(asset, price, uint64(block.timestamp));
    }

    function livePrice(bytes32 asset) external view returns (uint256, uint64) {
        Observation[] storage values = observations[asset];
        if (values.length == 0) return (0, 0);
        Observation storage latest = values[values.length - 1];
        return (latest.price, latest.timestamp);
    }

    function finalize(bytes32 asset, uint64 expiry, bytes[] calldata) external payable returns (uint256 price) {
        require(msg.value == 0 && expiry <= block.timestamp, "Invalid finalization");
        price = settlementPrice[asset][expiry];
        if (price != 0) return price;
        Observation[] storage values = observations[asset];
        // Binary search the first observation at/after expiry. Callers cannot choose a later tick.
        uint256 lo;
        uint256 hi = values.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (values[mid].timestamp < expiry) lo = mid + 1;
            else hi = mid;
        }
        require(lo < values.length, "No post-expiry observation");
        Observation storage observation = values[lo];
        price = observation.price;
        settlementPrice[asset][expiry] = price;
        emit Finalized(asset, expiry, price, observation.timestamp, bytes32(0));
    }
}

interface IPythCore {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    struct PriceFeed {
        bytes32 id;
        Price price;
        Price emaPrice;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
    function getUpdateFee(bytes[] calldata updates) external view returns (uint256);
    function parsePriceFeedUpdates(bytes[] calldata updates, bytes32[] calldata ids, uint64 minTime, uint64 maxTime)
        external
        payable
        returns (PriceFeed[] memory);
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updates,
        bytes32[] calldata ids,
        uint64 minTime,
        uint64 maxTime
    ) external payable returns (PriceFeed[] memory);
}

/// @notice Shared Pyth normalization (8-decimal prices) and payload bounds.
library PythPrice {
    uint256 internal constant MAX_UPDATES = 8;
    uint256 internal constant MAX_PROOF_BYTES = 65536;

    function normalized(IPythCore.Price memory p) internal pure returns (uint256 value) {
        require(p.price > 0 && p.expo >= -18 && p.expo <= 8, "Invalid price");
        int32 shift = p.expo + 8;
        value = uint64(p.price);
        value = shift >= 0 ? value * (10 ** uint32(shift)) : value / (10 ** uint32(-shift));
        require(value > 0 && value <= 1e18, "Price out of range");
    }

    /// Live prices must carry confidence within 1% and must not be from the future.
    function live(IPythCore pyth, bytes32 asset) internal view returns (uint256, uint64) {
        IPythCore.Price memory p = pyth.getPriceUnsafe(asset);
        require(p.price > 0 && uint256(p.conf) * 10000 <= uint256(uint64(p.price)) * 100, "Wide confidence");
        require(p.publishTime <= block.timestamp, "Future price");
        return (normalized(p), uint64(p.publishTime));
    }

    function checkProof(bytes[] calldata proof) internal pure {
        require(proof.length > 0 && proof.length <= MAX_UPDATES, "Invalid proof request");
        uint256 totalBytes;
        for (uint256 i; i < proof.length; ++i) {
            totalBytes += proof[i].length;
        }
        require(totalBytes > 0 && totalBytes <= MAX_PROOF_BYTES, "Proof too large");
    }
}

/// @notice Immutable verifier and fixed unique-first-update policy. Evidence retrieval is permissionless.
contract PythExpiryOracle is IExpiryOracle {
    struct Evidence {
        uint64 publishedAt;
        int64 rawPrice;
        uint64 confidence;
        int32 exponent;
        bytes32 proofHash;
    }

    bytes32 public constant POLICY_ID = keccak256("STRATA_PYTH_UNIQUE_FIRST_V1");
    IPythCore public immutable pyth;
    mapping(bytes32 => mapping(uint64 => uint256)) public settlementPrice;
    mapping(bytes32 => mapping(uint64 => Evidence)) public evidence;

    event Finalized(bytes32 indexed asset, uint64 indexed expiry, uint256 price, uint64 publishedAt, bytes32 proofHash);

    constructor(address verifier) {
        require(verifier.code.length > 0, "Invalid verifier");
        pyth = IPythCore(verifier);
    }

    function livePrice(bytes32 asset) external view returns (uint256, uint64) {
        return PythPrice.live(pyth, asset);
    }

    function finalize(bytes32 asset, uint64 expiry, bytes[] calldata proof) external payable returns (uint256 price) {
        require(expiry <= block.timestamp, "Invalid proof request");
        PythPrice.checkProof(proof);
        require(settlementPrice[asset][expiry] == 0, "Already finalized");
        uint256 fee = pyth.getUpdateFee(proof);
        // Exact payment avoids accumulating caller refunds in a settlement contract.
        require(msg.value == fee, "Exact fee required");
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = asset;
        IPythCore.PriceFeed[] memory result =
            pyth.parsePriceFeedUpdatesUnique{value: fee}(proof, ids, expiry, uint64(block.timestamp));
        require(result.length == 1 && result[0].id == asset, "Wrong feed");
        require(result[0].price.publishTime >= expiry && result[0].price.publishTime <= block.timestamp, "Wrong time");
        // Existing claims use the canonical first update even when confidence
        // is wide. New issuance is separately guarded by livePrice confidence.
        price = PythPrice.normalized(result[0].price);
        settlementPrice[asset][expiry] = price;
        bytes32 proofHash = keccak256(abi.encode(proof));
        IPythCore.Price memory observation = result[0].price;
        evidence[asset][expiry] =
            Evidence(uint64(observation.publishTime), observation.price, observation.conf, observation.expo, proofHash);
        emit Finalized(asset, expiry, price, uint64(observation.publishTime), proofHash);
    }
}

/**
 * @notice Session-close settlement for assets that trade on a schedule (equities,
 * ETFs, metals, FX). Expiries are listed at a session close; the settlement price
 * is the latest Pyth update published at or before expiry. Anyone may propose a
 * verified candidate during the challenge window, and only a strictly later valid
 * update can replace it, so the final value is the last print before expiry and no
 * caller can select a convenient earlier one.
 */
contract PythSessionCloseOracle is IExpiryOracle {
    struct Candidate {
        uint64 publishedAt;
        int64 rawPrice;
        uint64 confidence;
        int32 exponent;
        uint256 price;
        bytes32 proofHash;
    }

    bytes32 public constant POLICY_ID = keccak256("STRATA_PYTH_LATEST_AT_OR_BEFORE_EXPIRY_V1");
    IPythCore public immutable pyth;
    /// Oldest acceptable candidate before expiry; covers weekends and holidays.
    uint64 public immutable lookback;
    /// Period after expiry during which later candidates may still be proposed.
    uint64 public immutable challengeWindow;
    mapping(bytes32 => mapping(uint64 => Candidate)) public candidate;
    mapping(bytes32 => mapping(uint64 => uint256)) public settlementPrice;

    event CandidateProposed(
        bytes32 indexed asset,
        uint64 indexed expiry,
        uint256 price,
        uint64 publishedAt,
        bytes32 proofHash,
        address proposer
    );
    event Finalized(bytes32 indexed asset, uint64 indexed expiry, uint256 price, uint64 publishedAt, bytes32 proofHash);

    constructor(address verifier, uint64 lookback_, uint64 challengeWindow_) {
        require(verifier.code.length > 0, "Invalid verifier");
        require(lookback_ >= 1 hours && lookback_ <= 7 days, "Invalid lookback");
        require(challengeWindow_ >= 5 minutes && challengeWindow_ <= 2 days, "Invalid challenge window");
        pyth = IPythCore(verifier);
        lookback = lookback_;
        challengeWindow = challengeWindow_;
    }

    function livePrice(bytes32 asset) external view returns (uint256, uint64) {
        return PythPrice.live(pyth, asset);
    }

    function propose(bytes32 asset, uint64 expiry, bytes[] calldata proof) public payable {
        _propose(asset, expiry, proof);
    }

    /// @dev With a proof: proposes a candidate (returns 0 while the window is open).
    /// Without a proof after the window: fixes the best candidate permanently.
    function finalize(bytes32 asset, uint64 expiry, bytes[] calldata proof) external payable returns (uint256 price) {
        price = settlementPrice[asset][expiry];
        if (price != 0) {
            require(msg.value == 0 && proof.length == 0, "Already finalized");
            return price;
        }
        if (proof.length > 0) {
            _propose(asset, expiry, proof);
            return 0;
        }
        require(msg.value == 0, "No fee without proof");
        require(block.timestamp >= uint256(expiry) + challengeWindow, "Challenge window open");
        Candidate storage c = candidate[asset][expiry];
        require(c.publishedAt != 0, "No candidate");
        price = c.price;
        settlementPrice[asset][expiry] = price;
        emit Finalized(asset, expiry, price, c.publishedAt, c.proofHash);
    }

    function _propose(bytes32 asset, uint64 expiry, bytes[] calldata proof) internal {
        require(settlementPrice[asset][expiry] == 0, "Already finalized");
        require(expiry > lookback && expiry <= block.timestamp, "Not expired");
        require(block.timestamp < uint256(expiry) + challengeWindow, "Challenge window closed");
        PythPrice.checkProof(proof);
        uint256 fee = pyth.getUpdateFee(proof);
        require(msg.value == fee, "Exact fee required");
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = asset;
        IPythCore.PriceFeed[] memory result =
            pyth.parsePriceFeedUpdates{value: fee}(proof, ids, expiry - lookback, expiry);
        require(result.length == 1 && result[0].id == asset, "Wrong feed");
        IPythCore.Price memory observation = result[0].price;
        require(observation.publishTime >= expiry - lookback && observation.publishTime <= expiry, "Wrong time");
        Candidate storage current = candidate[asset][expiry];
        require(observation.publishTime > current.publishedAt, "Not a later observation");
        uint256 price = PythPrice.normalized(observation);
        bytes32 proofHash = keccak256(abi.encode(proof));
        candidate[asset][expiry] = Candidate(
            uint64(observation.publishTime), observation.price, observation.conf, observation.expo, price, proofHash
        );
        emit CandidateProposed(asset, expiry, price, uint64(observation.publishTime), proofHash, msg.sender);
    }
}

/**
 * @notice Per-asset settlement routing behind the engine's single oracle slot.
 * Each asset is bound once to an adapter and a live-price age; bindings are
 * permanent, so the settlement policy of existing claims can never be swapped.
 */
contract OracleRouter is Ownable, IExpiryOracle {
    struct Binding {
        IExpiryOracle adapter;
        uint64 maxLiveAge;
    }

    mapping(bytes32 => Binding) public bindings;

    event AssetBound(bytes32 indexed asset, address indexed adapter, uint64 maxLiveAge);

    constructor() Ownable(msg.sender) {}

    function bind(bytes32 asset, address adapter, uint64 maxLiveAge) external onlyOwner {
        require(asset != bytes32(0) && adapter.code.length > 0, "Invalid binding");
        require(maxLiveAge > 0 && maxLiveAge <= 1 days, "Invalid live age");
        require(address(bindings[asset].adapter) == address(0), "Asset already bound");
        bindings[asset] = Binding(IExpiryOracle(adapter), maxLiveAge);
        emit AssetBound(asset, adapter, maxLiveAge);
    }

    function _binding(bytes32 asset) internal view returns (Binding storage b) {
        b = bindings[asset];
        require(address(b.adapter) != address(0), "Unknown asset");
    }

    /// Prices older than the asset's own limit read as unavailable, so scheduled
    /// markets stop accepting new exposure when their session closes.
    function livePrice(bytes32 asset) external view returns (uint256 price, uint64 publishedAt) {
        Binding storage b = _binding(asset);
        (price, publishedAt) = b.adapter.livePrice(asset);
        if (publishedAt > block.timestamp || block.timestamp - publishedAt > b.maxLiveAge) price = 0;
    }

    function settlementPrice(bytes32 asset, uint64 expiry) external view returns (uint256) {
        return _binding(asset).adapter.settlementPrice(asset, expiry);
    }

    function finalize(bytes32 asset, uint64 expiry, bytes[] calldata proof) external payable returns (uint256) {
        return _binding(asset).adapter.finalize{value: msg.value}(asset, expiry, proof);
    }
}

/**
 * @notice Controlled development oracle for scheduled markets. Mirrors the
 * session-close policy: settlement is the latest recorded observation at or
 * before expiry (within the lookback), fixed only after the challenge window.
 * Never represents authenticated Pyth prices.
 */
contract DemoSessionOracle is Ownable, IExpiryOracle {
    struct Observation {
        uint256 price;
        uint64 timestamp;
    }

    uint64 public immutable lookback;
    uint64 public immutable challengeWindow;
    mapping(bytes32 => Observation[]) private observations;
    mapping(bytes32 => mapping(uint64 => uint256)) public settlementPrice;

    event PricePublished(bytes32 indexed asset, uint256 price, uint64 timestamp);
    event Finalized(bytes32 indexed asset, uint64 indexed expiry, uint256 price, uint64 publishedAt, bytes32 proofHash);

    constructor(uint64 lookback_, uint64 challengeWindow_) Ownable(msg.sender) {
        require(lookback_ >= 1 hours && lookback_ <= 7 days, "Invalid lookback");
        require(challengeWindow_ > 0 && challengeWindow_ <= 2 days, "Invalid challenge window");
        lookback = lookback_;
        challengeWindow = challengeWindow_;
    }

    function publish(bytes32 asset, uint256 price) external onlyOwner {
        require(price > 0 && price <= 1e18, "Invalid price");
        Observation[] storage values = observations[asset];
        require(values.length == 0 || values[values.length - 1].timestamp < block.timestamp, "Duplicate timestamp");
        values.push(Observation(price, uint64(block.timestamp)));
        emit PricePublished(asset, price, uint64(block.timestamp));
    }

    function livePrice(bytes32 asset) external view returns (uint256, uint64) {
        Observation[] storage values = observations[asset];
        if (values.length == 0) return (0, 0);
        Observation storage latest = values[values.length - 1];
        return (latest.price, latest.timestamp);
    }

    function finalize(bytes32 asset, uint64 expiry, bytes[] calldata) external payable returns (uint256 price) {
        require(msg.value == 0, "No fee");
        price = settlementPrice[asset][expiry];
        if (price != 0) return price;
        require(expiry > lookback && block.timestamp >= uint256(expiry) + challengeWindow, "Challenge window open");
        Observation[] storage values = observations[asset];
        // Binary search the first observation after expiry; the one before it is the close.
        uint256 lo;
        uint256 hi = values.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (values[mid].timestamp <= expiry) lo = mid + 1;
            else hi = mid;
        }
        require(lo > 0 && values[lo - 1].timestamp >= expiry - lookback, "No observation before expiry");
        Observation storage observation = values[lo - 1];
        price = observation.price;
        settlementPrice[asset][expiry] = price;
        emit Finalized(asset, expiry, price, observation.timestamp, bytes32(0));
    }
}
