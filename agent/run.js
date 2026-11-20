// The AI payment agent. It reads invoices and pays them from the AgentLeash vault.
// The agent itself is NOT trusted: before each payment it asks the contract (canPay),
// and even if the agent skipped that check, the contract would still refuse.
//
// Usage:
//   npm run agent              -> run the demo invoices
//   npm run agent -- --fresh   -> same invoices with new ids (to re-run the demo another day)
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const NET = require("../scripts/network.js");

const dir = __dirname;
const root = path.join(dir, "..");
const REASONS = [
  "OK",
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

function need(file, hint) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) {
    console.error("Missing " + file + ". " + hint);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function withRetry(fn, label, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries) throw e;
      console.log("   (network hiccup on " + label + ", retry " + i + "/" + (tries - 1) + ")");
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function main() {
  const fresh = process.argv.includes("--fresh");
  const { privateKey } = need("agent-key.json", "Run: npm run setup-agent");
  const { vault } = need("vault.json", "Run: npm run set-vault -- <vaultAddress> <block>");
  const invoices = need("invoices.json", "Run: npm run setup-agent");
  const artifactPath = path.join(root, "build", "AgentLeash.json");
  if (!fs.existsSync(artifactPath)) {
    console.error("Missing build/AgentLeash.json. Run: npm run compile");
    process.exit(1);
  }
  const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const network = new ethers.Network(NET.chainName, NET.chainId);
  const provider = new ethers.JsonRpcProvider(NET.rpcUrl, network, { staticNetwork: network });
  const wallet = new ethers.Wallet(privateKey, provider);
  const leash = new ethers.Contract(vault, abi, wallet);
  const token = new ethers.Contract(
    NET.token,
    ["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"],
    provider
  );

  const decimals = Number(await withRetry(() => token.decimals(), "decimals"));
  const gas = await withRetry(() => provider.getBalance(wallet.address), "gas balance");
  const vaultBal = await withRetry(() => token.balanceOf(vault), "vault balance");

  console.log("=== AgentLeash payment agent ===");
  console.log("Agent : " + wallet.address);
  console.log("Vault : " + vault);
  console.log("Vault balance : " + ethers.formatUnits(vaultBal, decimals) + " " + NET.tokenSymbol);
  console.log("Agent gas     : " + ethers.formatEther(gas) + " " + NET.nativeSymbol);
  if (gas === 0n) {
    console.error("\nAgent has no " + NET.nativeSymbol + " for gas. Use 'Run demo setup' on the dashboard first.");
    process.exit(1);
  }

  const suffix = fresh ? "-" + Date.now().toString(36) : "";
  const results = [];

  for (const inv of invoices) {
    const invoiceKey = inv.id + suffix;
    const invoiceId = ethers.id(invoiceKey);
    const amount = ethers.parseUnits(inv.amount, decimals);
    console.log("\n> " + invoiceKey + " | " + inv.amount + " " + NET.tokenSymbol + " | " + inv.memo);

    const code = Number(
      await withRetry(() => leash.canPay(wallet.address, inv.merchant, amount, invoiceId), "canPay")
    );
    if (code !== 0) {
      const reason = REASONS[code] || "Unknown";
      console.log("  BLOCKED by contract: " + reason);
      results.push({ invoice: invoiceKey, amount: inv.amount, status: "BLOCKED", reason });
      continue;
    }

    try {
      // Sent once only (no blind resend). A duplicate send is impossible anyway: the invoice id is single-use on-chain.
      const tx = await leash.pay(inv.merchant, amount, invoiceId, inv.memo);
      console.log("  sent, waiting for confirmation... " + tx.hash);
      const receipt = await tx.wait(1, 180000);
      if (!receipt || receipt.status !== 1) throw new Error("transaction reverted");
      const link = NET.explorer + "/tx/" + tx.hash;
      console.log("  PAID  " + link);
      results.push({ invoice: invoiceKey, amount: inv.amount, status: "PAID", tx: tx.hash, link });
    } catch (e) {
      // Check on-chain whether it went through after all (async confirmation edge case)
      let paid = false;
      try {
        paid = await withRetry(() => leash.invoicePaid(invoiceId), "invoicePaid");
      } catch (_) {}
      const msg = (e && (e.shortMessage || e.message)) || String(e);
      console.log(paid ? "  PAID (confirmed on-chain after a slow response)" : "  FAILED: " + msg);
      results.push({ invoice: invoiceKey, amount: inv.amount, status: paid ? "PAID" : "FAILED", reason: paid ? "" : msg });
    }
  }

  const remaining = await withRetry(() => leash.remainingToday(wallet.address), "remaining");
  console.log("\n=== Summary ===");
  for (const r of results) console.log(r.status.padEnd(8) + r.invoice.padEnd(22) + r.amount + "  " + (r.reason || r.link || ""));
  console.log("Remaining 24h allowance: " + ethers.formatUnits(remaining, decimals) + " " + NET.tokenSymbol);

  fs.writeFileSync(
    path.join(dir, "last-run.json"),
    JSON.stringify({ time: new Date().toISOString(), agent: wallet.address, vault, results }, null, 2)
  );
  console.log("Saved agent/last-run.json");
}

main().catch((e) => {
  console.error("\nAgent stopped: " + ((e && (e.shortMessage || e.message)) || e));
  process.exit(1);
});
