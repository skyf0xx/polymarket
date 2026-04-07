// src/redeemer.ts
// Redeems resolved market positions on-chain via the CTF contract.
// Called during maintenance after positions are hydrated from the Data API.
// Redeeming both YES (indexSet=1) and NO (indexSet=2) clears them from the UI.

import { ethers } from "ethers";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { PositionTracker } from "./position-tracker.js";

const log = createLogger("redeemer");

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ZERO_BYTES32 = ethers.constants.HashZero;

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] indexSets)",
];

export async function redeemResolvedPositions(
  signer: ethers.Signer,
  positions: PositionTracker,
): Promise<void> {
  const redeemable = positions.getRedeemable();
  if (redeemable.length === 0) return;

  log.info(`Redeeming ${redeemable.length} resolved position(s)...`);

  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);

  // Deduplicate by conditionId — both YES and NO tokens share one conditionId,
  // so we only need one redeemPositions call per market.
  const seen = new Set<string>();

  for (const pos of redeemable) {
    if (seen.has(pos.conditionId)) continue;
    seen.add(pos.conditionId);

    try {
      log.info(`Redeeming conditionId=${pos.conditionId} slug=${pos.slug}`);

      const tx: ethers.ContractTransaction = await ctf.redeemPositions(
        USDC_ADDRESS,
        ZERO_BYTES32,
        pos.conditionId,
        [1, 2], // both YES and NO index sets
      );

      log.info(`Redeem tx sent: ${tx.hash} (conditionId=${pos.conditionId})`);
      const receipt = await tx.wait(1);
      log.info(
        `Redeem confirmed: block=${receipt.blockNumber} conditionId=${pos.conditionId}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Redeem failed for conditionId=${pos.conditionId}: ${message}`);
    }
  }
}
