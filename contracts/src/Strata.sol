// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice STRATA. Stake-only until the owner permanently enables transfers.
contract StrataToken is ERC20, Ownable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    bool public transfersEnabled;
    mapping(address => bool) public minters;
    /// @notice Contracts that may move locked tokens (staking, distributor).
    mapping(address => bool) public transferAllowed;

    event MinterSet(address indexed account, bool allowed);
    event TransferAllowedSet(address indexed account, bool allowed);
    event TransfersEnabled();

    constructor() ERC20("Strata", "STRATA") Ownable(msg.sender) {}

    function setMinter(address account, bool allowed) external onlyOwner {
        minters[account] = allowed;
        emit MinterSet(account, allowed);
    }

    function setTransferAllowed(address account, bool allowed) external onlyOwner {
        transferAllowed[account] = allowed;
        emit TransferAllowedSet(account, allowed);
    }

    function enableTransfers() external onlyOwner {
        transfersEnabled = true;
        emit TransfersEnabled();
    }

    function mint(address to, uint256 amount) external {
        require(minters[msg.sender], "Minter only");
        require(totalSupply() + amount <= MAX_SUPPLY, "Max supply");
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(
            transfersEnabled || from == address(0) || to == address(0) || transferAllowed[from] || transferAllowed[to],
            "Transfers locked"
        );
        super._update(from, to, value);
    }
}

/// @notice Staked STRATA earns the USDC sent here (vault performance fees).
/// @dev Rewards are any USDC balance not yet accounted; they accrue to stakers
/// pro rata at the next sync. Unstaking stops rewards immediately, then cools down.
contract StrataStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant SCALE = 1e36;

    IERC20 public immutable strata;
    IERC20 public immutable usdc;
    uint64 public immutable cooldown;

    uint256 public totalStaked;
    uint256 public rewardPerToken;
    /// @notice USDC already distributed into rewardPerToken and not yet claimed.
    uint256 public accounted;

    mapping(address => uint256) public staked;
    mapping(address => uint256) public rewardPaid;
    mapping(address => uint256) public earnedStored;
    mapping(address => uint256) public cooling;
    mapping(address => uint64) public unlockAt;

    event Staked(address indexed account, address indexed payer, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 unlockAt);
    event Unstaked(address indexed account, uint256 amount);
    event RewardsDistributed(uint256 amount, uint256 rewardPerToken);
    event RewardsClaimed(address indexed account, uint256 amount);

    constructor(address strata_, address usdc_, uint64 cooldown_) {
        require(strata_.code.length > 0 && usdc_.code.length > 0, "Invalid config");
        strata = IERC20(strata_);
        usdc = IERC20(usdc_);
        cooldown = cooldown_;
    }

    function sync() public {
        uint256 balance = usdc.balanceOf(address(this));
        if (totalStaked == 0 || balance <= accounted) return;
        uint256 fresh = balance - accounted;
        rewardPerToken += Math.mulDiv(fresh, SCALE, totalStaked);
        accounted = balance;
        emit RewardsDistributed(fresh, rewardPerToken);
    }

    function earned(address account) public view returns (uint256) {
        uint256 perToken = rewardPerToken;
        uint256 balance = usdc.balanceOf(address(this));
        if (totalStaked > 0 && balance > accounted) perToken += Math.mulDiv(balance - accounted, SCALE, totalStaked);
        return earnedStored[account] + Math.mulDiv(staked[account], perToken - rewardPaid[account], SCALE);
    }

    function stake(uint256 amount) external nonReentrant {
        _stake(msg.sender, msg.sender, amount);
    }

    function stakeFor(address account, uint256 amount) external nonReentrant {
        _stake(account, msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external nonReentrant {
        _accrue(msg.sender);
        require(amount > 0 && staked[msg.sender] >= amount, "Insufficient stake");
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        cooling[msg.sender] += amount;
        uint64 unlock = uint64(block.timestamp) + cooldown;
        unlockAt[msg.sender] = unlock;
        emit UnstakeRequested(msg.sender, amount, unlock);
    }

    function withdraw() external nonReentrant {
        uint256 amount = cooling[msg.sender];
        require(amount > 0 && block.timestamp >= unlockAt[msg.sender], "Cooling down");
        cooling[msg.sender] = 0;
        strata.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        _accrue(msg.sender);
        amount = earnedStored[msg.sender];
        if (amount == 0) return 0;
        earnedStored[msg.sender] = 0;
        accounted -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit RewardsClaimed(msg.sender, amount);
    }

    function _stake(address account, address payer, uint256 amount) internal {
        require(amount > 0 && account != address(0), "Invalid stake");
        _accrue(account);
        staked[account] += amount;
        totalStaked += amount;
        strata.safeTransferFrom(payer, address(this), amount);
        emit Staked(account, payer, amount);
    }

    function _accrue(address account) internal {
        sync();
        earnedStored[account] += Math.mulDiv(staked[account], rewardPerToken - rewardPaid[account], SCALE);
        rewardPaid[account] = rewardPerToken;
    }
}

interface IStrataMint {
    function mint(address to, uint256 amount) external;
}

interface IStrataStake {
    function stakeFor(address account, uint256 amount) external;
}

/// @notice Converts published points into STRATA through cumulative Merkle claims.
contract StrataDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable strata;
    IStrataStake public immutable staking;
    address public publisher;
    bytes32 public root;
    uint256 public rootEpoch;
    mapping(address => uint256) public claimed;

    event RootPublished(bytes32 root, uint256 indexed epoch);
    event Claimed(address indexed account, uint256 amount, bool staked);
    event PublisherChanged(address publisher);

    constructor(address strata_, address staking_, address publisher_) Ownable(msg.sender) {
        require(strata_.code.length > 0 && staking_.code.length > 0 && publisher_ != address(0), "Invalid config");
        strata = IERC20(strata_);
        staking = IStrataStake(staking_);
        publisher = publisher_;
    }

    function setPublisher(address next) external onlyOwner {
        require(next != address(0), "Invalid publisher");
        publisher = next;
        emit PublisherChanged(next);
    }

    /// @notice Roots are cumulative: each one supersedes the last.
    function publish(bytes32 next, uint256 epoch) external {
        require(msg.sender == publisher || msg.sender == owner(), "Publisher only");
        require(epoch > rootEpoch, "Stale epoch");
        root = next;
        rootEpoch = epoch;
        emit RootPublished(next, epoch);
    }

    /// @notice Anyone may deliver an account's tokens; only the account may choose to stake them.
    function claim(address account, uint256 cumulative, bytes32[] calldata proof, bool stake)
        external
        nonReentrant
        returns (uint256 amount)
    {
        require(!stake || msg.sender == account, "Account only");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
        require(MerkleProof.verifyCalldata(proof, root, leaf), "Invalid proof");
        require(cumulative > claimed[account], "Nothing to claim");
        amount = cumulative - claimed[account];
        claimed[account] = cumulative;
        if (stake) {
            IStrataMint(address(strata)).mint(address(this), amount);
            strata.forceApprove(address(staking), amount);
            staking.stakeFor(account, amount);
        } else {
            IStrataMint(address(strata)).mint(account, amount);
        }
        emit Claimed(account, amount, stake);
    }
}
