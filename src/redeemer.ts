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
const USDC_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
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
  const unique = redeemable.filter((pos) => {
    if (seen.has(pos.conditionId)) return false;
    seen.add(pos.conditionId);
    return true;
  });

  // Fire all txs in parallel — don't block maintenance on confirmations.
  for (const pos of unique) {
    const { conditionId, slug } = pos;
    log.info(`Redeeming conditionId=${conditionId} slug=${slug}`);

    ctf
      .redeemPositions(
        USDC_ADDRESS,
        ZERO_BYTES32,
        conditionId,
        [1, 2], // both YES and NO index sets
        { maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei") },
      )
      .then((tx: ethers.ContractTransaction) => {
        log.info(`Redeem tx sent: ${tx.hash} (conditionId=${conditionId})`);
        return tx.wait(1);
      })
      .then((receipt: ethers.ContractReceipt) => {
        log.info(
          `Redeem confirmed: block=${receipt.blockNumber} conditionId=${conditionId}`,
        );
      })
      .catch((err: unknown) => {
        if (
          err instanceof Error &&
          (err as any).code === "TRANSACTION_REPLACED" &&
          (err as any).receipt?.status === 1
        ) {
          const e = err as any;
          log.info(
            `Redeem replaced+confirmed: block=${e.receipt.blockNumber} hash=${e.replacement.hash} conditionId=${conditionId}`,
          );
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Redeem failed for conditionId=${conditionId}: ${message}`);
      });
  }
}
