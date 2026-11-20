// Usage: npm run set-vault -- <vaultAddress> <deployBlock>
// Saves the deployed vault address into docs/config.js (website) and agent/vault.json (agent).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const NET = require("./network.js");

const root = path.join(__dirname, "..");
const addr = (process.argv[2] || "").trim();
const block = parseInt(process.argv[3] || "0", 10);

if (!ethers.isAddress(addr)) {
  console.error("Wrong address. Use: npm run set-vault -- 0xYourVaultAddress 1234567");
  process.exit(1);
}
const vault = ethers.getAddress(addr);
const deployBlock = Number.isFinite(block) && block > 0 ? block : 0;

writeConfig(root, vault, deployBlock);
fs.writeFileSync(
  path.join(root, "agent", "vault.json"),
  JSON.stringify({ vault, deployBlock }, null, 2)
);
console.log("OK - vault saved: " + vault + " (block " + deployBlock + ")");

function writeConfig(rootDir, vaultAddr, blk) {
  const cfg = Object.assign({}, NET, { vault: vaultAddr, deployBlock: blk });
  fs.writeFileSync(
    path.join(rootDir, "docs", "config.js"),
    "// Network + vault settings for the dashboard (written by scripts/set-vault.js)\n" +
      "window.AGENTLEASH_CONFIG = " +
      JSON.stringify(cfg, null, 2) +
      ";\n"
  );
}
