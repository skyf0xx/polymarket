// scripts/check-allowances.ts
// Run with: npx ts-node --esm scripts/check-allowances.ts
// Checks current USDC + CTF token allowances for the funder/proxy wallet

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const POLYGON_RPC = process.env.POLYGON_RPC!;
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS!;

// Contracts that need allowance
const EXCHANGE        = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER  = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

const ERC20_ABI = ["function allowance(address owner, address spender) view returns (uint256)"];
const ERC1155_ABI = ["function isApprovedForAll(address account, address operator) view returns (bool)"];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
  const ctf  = new ethers.Contract(CTF, ERC1155_ABI, provider);

  const spenders = [
    { name: "Exchange",          addr: EXCHANGE },
    { name: "NegRisk Exchange",  addr: NEG_RISK_EXCHANGE },
    { name: "NegRisk Adapter",   addr: NEG_RISK_ADAPTER },
  ];

  console.log(`\nChecking allowances for: ${FUNDER_ADDRESS}\n`);

  for (const { name, addr } of spenders) {
    const usdcAllowance = await usdc.allowance(FUNDER_ADDRESS, addr);
    const ctfApproved   = await ctf.isApprovedForAll(FUNDER_ADDRESS, addr);
    const usdcOk = usdcAllowance.gt(ethers.utils.parseUnits("1000000", 6)); // >1M USDC
    console.log(`${name} (${addr})`);
    console.log(`  USDC allowance: ${ethers.utils.formatUnits(usdcAllowance, 6)} ${usdcOk ? "✓" : "✗ NEEDS APPROVAL"}`);
    console.log(`  CTF approved:   ${ctfApproved ? "✓" : "✗ NEEDS APPROVAL"}`);
    console.log();
  }
}

main().catch(console.error);
