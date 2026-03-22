// src/wallet.ts
// Fetch on-chain USDC balance for the funder wallet.

import { ethers } from "ethers";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("wallet");

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC on Polygon

const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

export async function getUsdcBalance(): Promise<number | null> {
  try {
    const provider = new ethers.providers.JsonRpcProvider(
      config.polygonRpc,
      137,
    );

    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    const raw: ethers.BigNumber = await usdc.balanceOf(config.funderAddress);
    const balance = parseFloat(ethers.utils.formatUnits(raw, 6));
    log.info(
      `USDC balance for ${config.funderAddress}: $${balance.toFixed(2)}`,
    );
    return balance;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to fetch USDC balance: ${message}`);
    return null;
  }
}
