// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC-20 interface (tUSD8 is a 6-decimals USDC-style token).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title AgentLeash - a tUSD8 vault that lets AI agents pay, but only on a leash.
/// @notice The owner deposits tUSD8 and gives each agent a "leash":
///         a per-payment cap, a rolling 24h cap, an expiry time and a list of
///         approved merchants. The agent can only call pay(). Every rule is
///         enforced on-chain, so even a hacked or prompt-injected agent cannot
///         overspend. The owner can revoke an agent or pause everything instantly.
contract AgentLeash {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Leash {
        bool active;        // false = never set or revoked
        uint64 expiresAt;   // unix seconds; agent cannot pay after this
        uint64 dayStart;    // start of the current 24h spending window
        uint128 perTxCap;   // max amount for one payment (token units)
        uint128 dailyCap;   // max total inside one 24h window
        uint128 spentToday; // spent inside the current window
        uint128 totalSpent; // lifetime spent by this agent
        uint32 payments;    // lifetime number of payments
    }

    // Result codes shared by canPay() and pay()
    uint8 public constant OK = 0;
    uint8 public constant CODE_PAUSED = 1;
    uint8 public constant CODE_NO_LEASH = 2;
    uint8 public constant CODE_EXPIRED = 3;
    uint8 public constant CODE_MERCHANT_NOT_ALLOWED = 4;
    uint8 public constant CODE_ZERO_AMOUNT = 5;
    uint8 public constant CODE_OVER_PER_TX_CAP = 6;
    uint8 public constant CODE_OVER_DAILY_CAP = 7;
    uint8 public constant CODE_INVOICE_ALREADY_PAID = 8;
    uint8 public constant CODE_VAULT_LOW = 9;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public immutable owner;
    IERC20 public immutable token;
    bool public paused;

    mapping(address => Leash) public leashes;
    mapping(address => mapping(address => bool)) public merchantAllowed; // agent => merchant => allowed
    mapping(bytes32 => bool) public invoicePaid;

    address[] private agentList;
    mapping(address => bool) private agentKnown;

    uint256 private lockState = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event LeashSet(address indexed agent, uint256 perTxCap, uint256 dailyCap, uint256 expiresAt);
    event LeashRevoked(address indexed agent);
    event MerchantSet(address indexed agent, address indexed merchant, bool allowed);
    event PausedSet(bool isPaused);
    event Paid(
        address indexed agent,
        address indexed merchant,
        bytes32 indexed invoiceId,
        uint256 amount,
        uint256 spentToday,
        string memo
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error BadInput();
    error PaymentBlocked(uint8 code);
    error TransferFailed();
    error Reentrancy();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (lockState != 1) revert Reentrancy();
        lockState = 2;
        _;
        lockState = 1;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address token_) {
        if (token_ == address(0) || token_.code.length == 0) revert BadInput();
        owner = msg.sender;
        token = IERC20(token_);
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    /// @notice Anyone can top up the vault (needs approve() first).
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadInput();
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Owner takes tUSD8 back out of the vault.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0) || amount == 0) revert BadInput();
        _safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------------------
    // Owner controls
    // ---------------------------------------------------------------------

    /// @notice Create or update an agent's leash and approve merchants in one transaction.
    function setupAgent(
        address agent,
        uint128 perTxCap,
        uint128 dailyCap,
        uint64 expiresAt,
        address[] calldata merchants
    ) external onlyOwner {
        if (agent == address(0) || perTxCap == 0 || dailyCap < perTxCap) revert BadInput();
        if (expiresAt <= block.timestamp) revert BadInput();

        Leash storage l = leashes[agent];
        l.active = true;
        l.perTxCap = perTxCap;
        l.dailyCap = dailyCap;
        l.expiresAt = expiresAt;
        if (l.dayStart == 0) l.dayStart = uint64(block.timestamp);

        if (!agentKnown[agent]) {
            agentKnown[agent] = true;
            agentList.push(agent);
        }

        for (uint256 i = 0; i < merchants.length; i++) {
            address m = merchants[i];
            if (m == address(0)) revert BadInput();
            merchantAllowed[agent][m] = true;
            emit MerchantSet(agent, m, true);
        }

        emit LeashSet(agent, perTxCap, dailyCap, expiresAt);
    }

    function setMerchant(address agent, address merchant, bool allowed) external onlyOwner {
        if (agent == address(0) || merchant == address(0)) revert BadInput();
        merchantAllowed[agent][merchant] = allowed;
        emit MerchantSet(agent, merchant, allowed);
    }

    /// @notice Instantly stop an agent. Its next pay() call reverts.
    function revoke(address agent) external onlyOwner {
        leashes[agent].active = false;
        emit LeashRevoked(agent);
    }

    /// @notice Emergency stop for every agent at once.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    // ---------------------------------------------------------------------
    // Agent payment
    // ---------------------------------------------------------------------

    /// @notice Called by an agent to pay a merchant invoice from the vault.
    /// @param invoiceId keccak256 of the invoice id string; each id can be paid only once.
    function pay(address merchant, uint256 amount, bytes32 invoiceId, string calldata memo)
        external
        nonReentrant
    {
        uint8 code = _check(msg.sender, merchant, amount, invoiceId);
        if (code != OK) revert PaymentBlocked(code);

        Leash storage l = leashes[msg.sender];
        if (block.timestamp >= uint256(l.dayStart) + 1 days) {
            l.dayStart = uint64(block.timestamp);
            l.spentToday = 0;
        }

        // amount <= perTxCap (uint128) was checked in _check, so the cast is safe.
        uint128 amt = uint128(amount);
        l.spentToday += amt;
        l.totalSpent += amt;
        l.payments += 1;
        invoicePaid[invoiceId] = true;

        _safeTransfer(merchant, amount);
        emit Paid(msg.sender, merchant, invoiceId, amount, l.spentToday, memo);
    }

    // ---------------------------------------------------------------------
    // Views (used by the agent pre-check and the dashboard)
    // ---------------------------------------------------------------------

    /// @notice Dry-run of pay(). Returns 0 if the payment would succeed, else a reason code.
    function canPay(address agent, address merchant, uint256 amount, bytes32 invoiceId)
        external
        view
        returns (uint8)
    {
        return _check(agent, merchant, amount, invoiceId);
    }

    function spentInWindow(address agent) public view returns (uint256) {
        Leash storage l = leashes[agent];
        if (block.timestamp >= uint256(l.dayStart) + 1 days) return 0;
        return l.spentToday;
    }

    function remainingToday(address agent) external view returns (uint256) {
        Leash storage l = leashes[agent];
        if (!l.active || block.timestamp >= l.expiresAt) return 0;
        uint256 spent = spentInWindow(agent);
        return spent >= l.dailyCap ? 0 : uint256(l.dailyCap) - spent;
    }

    function vaultBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function getAgents() external view returns (address[] memory) {
        return agentList;
    }

    function reasonText(uint8 code) external pure returns (string memory) {
        if (code == OK) return "OK";
        if (code == CODE_PAUSED) return "Vault is paused";
        if (code == CODE_NO_LEASH) return "Agent has no active leash (revoked or never set)";
        if (code == CODE_EXPIRED) return "Agent leash expired";
        if (code == CODE_MERCHANT_NOT_ALLOWED) return "Merchant not approved for this agent";
        if (code == CODE_ZERO_AMOUNT) return "Amount is zero";
        if (code == CODE_OVER_PER_TX_CAP) return "Over per-payment cap";
        if (code == CODE_OVER_DAILY_CAP) return "Over 24h spending cap";
        if (code == CODE_INVOICE_ALREADY_PAID) return "Invoice already paid";
        if (code == CODE_VAULT_LOW) return "Vault balance too low";
        return "Unknown";
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _check(address agent, address merchant, uint256 amount, bytes32 invoiceId)
        internal
        view
        returns (uint8)
    {
        if (paused) return CODE_PAUSED;
        Leash storage l = leashes[agent];
        if (!l.active) return CODE_NO_LEASH;
        if (block.timestamp >= l.expiresAt) return CODE_EXPIRED;
        if (!merchantAllowed[agent][merchant]) return CODE_MERCHANT_NOT_ALLOWED;
        if (amount == 0) return CODE_ZERO_AMOUNT;
        if (amount > l.perTxCap) return CODE_OVER_PER_TX_CAP;
        if (spentInWindow(agent) + amount > l.dailyCap) return CODE_OVER_DAILY_CAP;
        if (invoicePaid[invoiceId]) return CODE_INVOICE_ALREADY_PAID;
        if (token.balanceOf(address(this)) < amount) return CODE_VAULT_LOW;
        return OK;
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
