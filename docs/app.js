// AgentLeash dashboard - plain JS + ethers v6 (no build step)
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js";

const C = window.AGENTLEASH_CONFIG;
const ART = window.AGENTLEASH_ARTIFACT || null;
const DEMO = window.AGENTLEASH_DEMO || null;

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function paused() view returns (bool)",
  "function leashes(address) view returns (bool active, uint64 expiresAt, uint64 dayStart, uint128 perTxCap, uint128 dailyCap, uint128 spentToday, uint128 totalSpent, uint32 payments)",
  "function merchantAllowed(address,address) view returns (bool)",
  "function invoicePaid(bytes32) view returns (bool)",
  "function deposit(uint256)",
  "function withdraw(address,uint256)",
  "function setupAgent(address,uint128,uint128,uint64,address[])",
  "function setMerchant(address,address,bool)",
  "function revoke(address)",
  "function setPaused(bool)",
  "function pay(address,uint256,bytes32,string)",
  "function canPay(address,address,uint256,bytes32) view returns (uint8)",
  "function spentInWindow(address) view returns (uint256)",
  "function remainingToday(address) view returns (uint256)",
  "function vaultBalance() view returns (uint256)",
  "function getAgents() view returns (address[])",
  "event Deposited(address indexed from, uint256 amount)",
  "event Withdrawn(address indexed to, uint256 amount)",
  "event LeashSet(address indexed agent, uint256 perTxCap, uint256 dailyCap, uint256 expiresAt)",
  "event LeashRevoked(address indexed agent)",
  "event MerchantSet(address indexed agent, address indexed merchant, bool allowed)",
  "event PausedSet(bool isPaused)",
  "event Paid(address indexed agent, address indexed merchant, bytes32 indexed invoiceId, uint256 amount, uint256 spentToday, string memo)",
  "error NotOwner()",
  "error BadInput()",
  "error PaymentBlocked(uint8 code)",
  "error TransferFailed()",
  "error Reentrancy()",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const REASONS = [
  "OK - payment would go through",
  "Vault is paused",
  "Agent has no active leash (revoked or never set)",
  "Agent leash expired",
  "Merchant not approved for this agent",
  "Amount is zero",
  "Over per-payment cap",
  "Over 24h spending cap",
  "Invoice already paid",
  "Vault balance too low",
];
const iface = new ethers.Interface(VAULT_ABI);

// ---------- state ----------
const net = new ethers.Network(C.chainName, C.chainId);
const rpcProvider = new ethers.JsonRpcProvider(C.rpcUrl, net, { staticNetwork: net });
let browserProvider = null;
let signer = null;
let account = null;
let decimals = C.tokenDecimals || 6;
let vaultAddr = pickVault();
let isOwner = false;
let listening = false;

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "-");
const txLink = (h) => `<a href="${C.explorer}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>`;
const addrLink = (a) => `<a href="${C.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>`;
const fmt = (v) => {
  const s = ethers.formatUnits(v, decimals);
  const n = Number(s);
  return (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : s) + " tUSD8";
};

function pickVault() {
  const q = new URLSearchParams(location.search).get("vault");
  if (q && ethers.isAddress(q)) return ethers.getAddress(q);
  if (C.vault && ethers.isAddress(C.vault)) return ethers.getAddress(C.vault);
  const ls = safeGet("agentleash.vault");
  if (ls && ethers.isAddress(ls)) return ethers.getAddress(ls);
  return null;
}
function deployBlock() {
  if (C.deployBlock) return Number(C.deployBlock);
  const b = Number(safeGet("agentleash.block") || 0);
  return Number.isFinite(b) ? b : 0;
}
function safeGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), isErr ? 9000 : 5000);
}

function errText(e) {
  if (!e) return "Unknown error";
  if (e.code === "ACTION_REJECTED" || e.code === 4001) return "You cancelled it in the wallet.";
  const data = e.data || (e.error && e.error.data) || (e.info && e.info.error && e.info.error.data);
  if (e.revert && e.revert.name) return revertText(e.revert.name, e.revert.args);
  if (typeof data === "string" && data.startsWith("0x")) {
    try {
      const p = iface.parseError(data);
      if (p) return revertText(p.name, p.args);
    } catch (_) {}
  }
  return e.shortMessage || e.reason || e.message || String(e);
}
function revertText(name, args) {
  if (name === "PaymentBlocked") return "Blocked by contract: " + (REASONS[Number(args[0])] || "code " + args[0]);
  if (name === "NotOwner") return "Only the vault owner can do this.";
  if (name === "BadInput") return "Bad input (check addresses, caps and expiry).";
  if (name === "TransferFailed") return "Token transfer failed (check balance / approval).";
  return name;
}

function reader() {
  return browserProvider || rpcProvider;
}
function vault(withSigner = false) {
  return new ethers.Contract(vaultAddr, ART ? ART.abi : VAULT_ABI, withSigner ? signer : reader());
}
function token(withSigner = false) {
  return new ethers.Contract(C.token, ERC20_ABI, withSigner ? signer : reader());
}
function busy(btn, on) {
  if (btn) btn.disabled = on;
}
function needWallet() {
  if (!signer) { toast("Connect your wallet first.", true); return false; }
  return true;
}
function needVault() {
  if (!vaultAddr) { toast("Deploy the vault first.", true); return false; }
  return true;
}
function parseAmount(v, label) {
  const s = String(v || "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(label + ": enter a number like 0.20");
  return ethers.parseUnits(s, decimals);
}
function parseAddr(v, label) {
  const s = String(v || "").trim();
  if (!ethers.isAddress(s)) throw new Error(label + ": not a valid 0x address");
  return ethers.getAddress(s);
}

// ---------- wallet ----------
async function ensureChain() {
  const hex = "0x" + C.chainId.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
    if (code === 4902 || /unrecognized|not been added|unknown chain/i.test((e && e.message) || "")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: C.chainName,
          rpcUrls: [C.rpcUrl],
          nativeCurrency: { name: C.nativeSymbol, symbol: C.nativeSymbol, decimals: 18 },
          blockExplorerUrls: [C.explorer],
        }],
      });
    } else {
      throw e;
    }
  }
}

async function connect() {
  if (!window.ethereum) { toast("No wallet found. Install MetaMask (or a similar wallet).", true); return; }
  const btn = $("connectBtn");
  busy(btn, true);
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureChain();
    browserProvider = new ethers.BrowserProvider(window.ethereum, "any");
    signer = await browserProvider.getSigner();
    account = await signer.getAddress();
    btn.textContent = short(account);
    $("netBadge").className = "badge ok";
    if (!listening && window.ethereum.on) {
      listening = true; // only after connecting, so the network switch above does not reload the page
      window.ethereum.on("accountsChanged", () => location.reload());
      window.ethereum.on("chainChanged", () => location.reload());
    }
    await loadAll();
  } catch (e) {
    toast(errText(e), true);
  } finally {
    busy(btn, false);
  }
}

// ---------- loading ----------
async function loadAll() {
  $("deployCard").classList.toggle("hidden", !!vaultAddr);
  try {
    decimals = Number(await token().decimals());
  } catch (_) { /* keep config value */ }

  if (account) {
    try {
      const [tb, gb] = await Promise.all([token().balanceOf(account), reader().getBalance(account)]);
      $("myToken").textContent = fmt(tb);
      $("myGas").textContent = Number(ethers.formatEther(gb)).toFixed(4) + " " + C.nativeSymbol;
    } catch (_) {}
  }

  if (!vaultAddr) {
    document.querySelectorAll(".owner-only").forEach((el) => el.classList.add("hidden"));
    $("activity").innerHTML = '<li class="muted">No vault deployed yet.</li>';
    return;
  }
  $("vaultAddr").innerHTML = addrLink(vaultAddr);

  try {
    const v = vault();
    const [owner, bal, paused] = await Promise.all([v.owner(), v.vaultBalance(), v.paused()]);
    $("vaultOwner").innerHTML = addrLink(owner);
    $("vaultBal").textContent = fmt(bal);
    $("vaultStatus").innerHTML = paused ? '<span class="bad">⏸ Paused</span>' : '<span class="ok">● Active</span>';
    $("pauseBtn").textContent = paused ? "Resume vault" : "Pause vault";
    isOwner = !!account && owner.toLowerCase() === account.toLowerCase();
    document.querySelectorAll(".owner-only").forEach((el) => el.classList.toggle("hidden", !isOwner));
  } catch (e) {
    $("vaultStatus").innerHTML = '<span class="bad">Could not read vault. Connect your wallet and press Refresh.</span>';
  }

  if ($("agentInput").value) await loadAgent();
  await loadActivity();
}

async function loadAgent() {
  if (!needVault()) return;
  let a;
  try { a = parseAddr($("agentInput").value, "Agent"); } catch (e) { toast(e.message, true); return; }
  try {
    const v = vault();
    const [l, spent, left] = await Promise.all([v.leashes(a), v.spentInWindow(a), v.remainingToday(a)]);
    const now = Math.floor(Date.now() / 1000);
    const exp = Number(l.expiresAt);
    let state = '<span class="muted">Never set</span>';
    if (exp > 0) {
      if (!l.active) state = '<span class="bad">Revoked</span>';
      else if (exp <= now) state = '<span class="bad">Expired</span>';
      else state = '<span class="ok">Active</span>';
    }
    $("aActive").innerHTML = state;
    $("aPerTx").textContent = fmt(l.perTxCap);
    $("aDaily").textContent = fmt(l.dailyCap);
    $("aSpent").textContent = fmt(spent);
    $("aLeft").textContent = fmt(left);
    $("aExp").textContent = exp ? new Date(exp * 1000).toLocaleString() : "-";
    $("aCount").textContent = String(l.payments);
    $("aTotal").textContent = fmt(l.totalSpent);
  } catch (e) {
    toast("Could not read agent: " + errText(e), true);
  }
}

async function loadActivity() {
  const list = $("activity");
  try {
    const logs = await fetchLogs();
    if (!logs.length) { list.innerHTML = '<li class="muted">No activity yet.</li>'; return; }
    logs.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
    const rows = [];
    for (const lg of logs.reverse()) {
      let ev;
      try { ev = iface.parseLog(lg); } catch (_) { continue; }
      if (!ev) continue;
      const a = ev.args;
      let text = "";
      if (ev.name === "Paid") text = `<span class="pill paid">PAID</span>${fmt(a.amount)} agent ${addrLink(a.agent)} → merchant ${addrLink(a.merchant)} · "${esc(a.memo)}"`;
      else if (ev.name === "Deposited") text = `<span class="pill">DEPOSIT</span>${fmt(a.amount)} from ${addrLink(a.from)}`;
      else if (ev.name === "Withdrawn") text = `<span class="pill">WITHDRAW</span>${fmt(a.amount)} to ${addrLink(a.to)}`;
      else if (ev.name === "LeashSet") text = `<span class="pill">LEASH</span>agent ${addrLink(a.agent)} · ${fmt(a.perTxCap)}/payment · ${fmt(a.dailyCap)}/24h · until ${new Date(Number(a.expiresAt) * 1000).toLocaleString()}`;
      else if (ev.name === "MerchantSet") text = `<span class="pill">MERCHANT</span>${addrLink(a.merchant)} ${a.allowed ? "approved" : "removed"} for agent ${addrLink(a.agent)}`;
      else if (ev.name === "LeashRevoked") text = `<span class="pill revoke">REVOKED</span>agent ${addrLink(a.agent)}`;
      else if (ev.name === "PausedSet") text = `<span class="pill revoke">${a.isPaused ? "PAUSED" : "RESUMED"}</span>vault`;
      else continue;
      rows.push(`<li>${text} · ${txLink(lg.transactionHash)} <span class="muted">block ${lg.blockNumber}</span></li>`);
    }
    list.innerHTML = rows.join("") || '<li class="muted">No activity yet.</li>';
  } catch (e) {
    list.innerHTML = '<li class="muted">Could not load activity. Connect your wallet and press Refresh.</li>';
  }
}

// Logs come from the block explorer API first (no block-range limit),
// then fall back to the RPC in 1000-block chunks (the RPC's max range).
async function fetchLogs() {
  const from = deployBlock();
  try {
    const url = `${C.explorer}/api?module=logs&action=getLogs&address=${vaultAddr}&fromBlock=${from}&toBlock=latest`;
    const r = await fetch(url);
    const j = await r.json();
    if (Array.isArray(j.result)) {
      return j.result.map((l) => ({
        topics: (l.topics || []).filter((t) => t),
        data: l.data,
        blockNumber: parseInt(l.blockNumber, 16),
        index: parseInt(l.logIndex || "0x0", 16) || 0,
        transactionHash: l.transactionHash,
      }));
    }
  } catch (_) { /* fall back to RPC */ }

  const p = reader();
  const latest = await p.getBlockNumber();
  const STEP = 1000;
  let start = from || Math.max(0, latest - 20 * STEP);
  if (latest - start > 60 * STEP) start = latest - 60 * STEP; // keep the fallback fast
  const ranges = [];
  for (let s = start; s <= latest; s += STEP) ranges.push([s, Math.min(latest, s + STEP - 1)]);
  const out = [];
  for (let i = 0; i < ranges.length; i += 6) {
    const parts = await Promise.all(
      ranges.slice(i, i + 6).map(([a, b]) => p.getLogs({ address: vaultAddr, fromBlock: a, toBlock: b }))
    );
    for (const part of parts) for (const l of part) out.push({ topics: l.topics, data: l.data, blockNumber: l.blockNumber, index: l.index, transactionHash: l.transactionHash });
  }
  return out;
}

// ---------- actions ----------
async function deploy() {
  if (!needWallet()) return;
  if (!ART || !ART.bytecode || ART.bytecode.length < 10) { toast("artifact.js missing. Run: npm run compile", true); return; }
  const btn = $("deployBtn");
  busy(btn, true);
  try {
    const factory = new ethers.ContractFactory(ART.abi, ART.bytecode, signer);
    const c = await factory.deploy(C.token);
    const tx = c.deploymentTransaction();
    $("deployOut").innerHTML = "Deploying… " + txLink(tx.hash);
    const rc = await tx.wait();
    const addr = await c.getAddress();
    vaultAddr = addr;
    safeSet("agentleash.vault", addr);
    safeSet("agentleash.block", String(rc.blockNumber));
    $("deployOut").innerHTML =
      `<span class="ok">Deployed!</span> ${addrLink(addr)} (block ${rc.blockNumber})<br>` +
      `Run this in PowerShell to save it:<code>npm run set-vault -- ${addr} ${rc.blockNumber}</code>`;
    $("deployCard").classList.remove("hidden");
    $("deployBtn").classList.add("hidden");
    await loadAll();
    $("deployCard").classList.remove("hidden");
  } catch (e) {
    toast(errText(e), true);
  } finally {
    busy(btn, false);
  }
}

function logStep(text) {
  const li = document.createElement("li");
  li.innerHTML = "⏳ " + text;
  $("setupLog").appendChild(li);
  return {
    done: (hash) => { li.innerHTML = "✅ " + text + (hash ? " · " + txLink(hash) : ""); },
    fail: (msg) => { li.innerHTML = "❌ " + text + " · " + esc(msg); },
  };
}

async function runTx(label, send) {
  const step = logStep(label);
  try {
    const tx = await send();
    const rc = await tx.wait();
    if (!rc || rc.status !== 1) throw new Error("transaction reverted");
    step.done(tx.hash);
    return rc;
  } catch (e) {
    step.fail(errText(e));
    throw e;
  }
}

async function setup() {
  if (!needWallet() || !needVault()) return;
  if (!isOwner) { toast("Only the vault owner can do this.", true); return; }
  const btn = $("setupBtn");
  let agent, merchants, perTx, daily, dep, gas, hours;
  try {
    agent = parseAddr($("fAgent").value, "Agent");
    merchants = $("fMerchants").value.split(/[\s,]+/).filter(Boolean).map((m) => parseAddr(m, "Merchant"));
    if (!merchants.length) throw new Error("Add at least one merchant");
    perTx = parseAmount($("fPerTx").value, "Max per payment");
    daily = parseAmount($("fDaily").value, "Max per 24h");
    dep = parseAmount($("fDeposit").value, "Deposit");
    const g = String($("fGas").value || "0").trim();
    if (!/^\d+(\.\d+)?$/.test(g)) throw new Error("Gas: enter a number like 0.5");
    gas = ethers.parseEther(g);
    hours = Number($("fHours").value);
    if (!(hours >= 1)) throw new Error("Expiry must be at least 1 hour");
    if (perTx === 0n || daily < perTx) throw new Error("24h cap must be at least the per-payment cap");
  } catch (e) { toast(e.message, true); return; }

  busy(btn, true);
  $("setupLog").innerHTML = "";
  try {
    const t = token(true);
    if (dep > 0n) {
      const have = await token().balanceOf(account);
      if (have < dep) throw new Error("You only have " + fmt(have) + ". Lower the deposit.");
      const allowance = await token().allowance(account, vaultAddr);
      if (allowance < dep) await runTx("Approve tUSD8 for the vault", () => t.approve(vaultAddr, dep));
      await runTx("Deposit " + fmt(dep) + " into vault", () => vault(true).deposit(dep));
    }
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.round(hours * 3600));
    await runTx("Set leash + approve " + merchants.length + " merchant(s)", () =>
      vault(true).setupAgent(agent, perTx, daily, expiresAt, merchants)
    );
    if (gas > 0n) {
      await runTx("Send " + ethers.formatEther(gas) + " " + C.nativeSymbol + " gas to agent", () =>
        signer.sendTransaction({ to: agent, value: gas })
      );
    }
    const s = logStep("All done. Now run the agent: npm run agent");
    s.done();
    $("agentInput").value = agent;
    await loadAll();
  } catch (e) {
    toast(errText(e), true);
  } finally {
    busy(btn, false);
  }
}

function currentAgent() {
  const v = $("agentInput").value || $("fAgent").value || (DEMO && DEMO.agent) || "";
  return parseAddr(v, "Agent");
}

async function revoke() {
  if (!needWallet() || !needVault()) return;
  let a;
  try { a = currentAgent(); } catch (e) { toast(e.message, true); return; }
  const btn = $("revokeBtn");
  busy(btn, true);
  try {
    const tx = await vault(true).revoke(a);
    toast("Revoking agent…");
    await tx.wait();
    toast("Agent " + short(a) + " revoked.");
    $("agentInput").value = a;
    await loadAll();
  } catch (e) { toast(errText(e), true); } finally { busy(btn, false); }
}

async function togglePause() {
  if (!needWallet() || !needVault()) return;
  const btn = $("pauseBtn");
  busy(btn, true);
  try {
    const p = await vault().paused();
    const tx = await vault(true).setPaused(!p);
    toast(p ? "Resuming…" : "Pausing…");
    await tx.wait();
    toast(p ? "Vault resumed." : "Vault paused. All agents are stopped.");
    await loadAll();
  } catch (e) { toast(errText(e), true); } finally { busy(btn, false); }
}

async function withdrawAll() {
  if (!needWallet() || !needVault()) return;
  const btn = $("withdrawBtn");
  busy(btn, true);
  try {
    const bal = await vault().vaultBalance();
    if (bal === 0n) { toast("Vault is empty."); return; }
    const tx = await vault(true).withdraw(account, bal);
    toast("Withdrawing " + fmt(bal) + "…");
    await tx.wait();
    toast("Withdrawn " + fmt(bal) + ".");
    await loadAll();
  } catch (e) { toast(errText(e), true); } finally { busy(btn, false); }
}

async function tryPay() {
  if (!needVault()) return;
  const out = $("tryOut");
  try {
    const a = currentAgent();
    const m = parseAddr($("tMerchant").value, "Merchant");
    const amt = parseAmount($("tAmount").value, "Amount");
    const inv = String($("tInvoice").value || "").trim();
    if (!inv) throw new Error("Invoice id: enter any text");
    const code = Number(await vault().canPay(a, m, amt, ethers.id(inv)));
    out.innerHTML = code === 0
      ? `<span class="ok">✅ ${REASONS[0]}</span>`
      : `<span class="bad">⛔ ${esc(REASONS[code] || "code " + code)}</span>`;
  } catch (e) {
    out.innerHTML = `<span class="bad">${esc(e.message && !e.code ? e.message : errText(e))}</span>`;
  }
}

// ---------- init ----------
function init() {
  if (DEMO) {
    $("fAgent").value = DEMO.agent || "";
    $("fMerchants").value = (DEMO.merchants || []).join("\n");
    $("agentInput").value = DEMO.agent || "";
    $("tMerchant").value = (DEMO.merchants && DEMO.merchants[0]) || "";
  }
  $("connectBtn").onclick = connect;
  $("deployBtn").onclick = deploy;
  $("refreshBtn").onclick = loadAll;
  $("setupBtn").onclick = setup;
  $("revokeBtn").onclick = revoke;
  $("pauseBtn").onclick = togglePause;
  $("withdrawBtn").onclick = withdrawAll;
  $("agentBtn").onclick = loadAgent;
  $("tryBtn").onclick = tryPay;
  loadAll();
}
init();
