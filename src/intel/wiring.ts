/**
 * The intelligence runner's real dependencies.
 *
 * Kept apart from `runner.ts` so the runner stays testable with fakes and
 * never imports the store: only the server and the CLI import this module.
 */

import { config } from '../config.ts';
import { store } from '../core/store.ts';
import * as solanaRpc from '../sources/solana-rpc.ts';
import type { IntelDeps } from './runner.ts';

export function liveIntelDeps(): IntelDeps {
  return {
    history: {
      history: solanaRpc.addressHistory,
      signatures: (address, limit) => solanaRpc.getSignatures(address, { limit }),
      transaction: solanaRpc.getParsedTransaction,
    },
    chain: store.chain(),
    intel: store.intel(),
    tokens: () => store.tokens(),
    source: solanaRpc.rpcEndpoint().label,
    commitment: solanaRpc.COMMITMENT,
    settings: {
      tokensPerCycle: config.intelTokensPerCycle,
      walletsPerToken: config.intelWalletsPerToken,
      txPerWallet: config.intelTxPerWallet,
      ascLimit: config.intelAscLimit,
      graphDepth: config.intelGraphDepth,
      requestsPerCycle: config.intelRequestsPerCycle,
      cycleMaxMs: config.intelCycleMaxMs,
      profileTtlMs: config.intelProfileTtlHours * 3_600_000,
      tokenRefreshMs: config.intelTokenRefreshMin * 60_000,
      liveWindowMs: config.liveWindowMin * 60_000,
    },
  };
}
