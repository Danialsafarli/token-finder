/**
 * The ingestion runner's real dependencies.
 *
 * Kept apart from `runner.ts` so the runner stays testable with fakes and
 * never imports the store: only the server and the CLI import this module.
 */

import { config } from '../config.ts';
import { store } from '../core/store.ts';
import * as solanaRpc from '../sources/solana-rpc.ts';
import type { IngestDeps } from './runner.ts';

export function liveIngestDeps(): IngestDeps {
  return {
    rpc: { getSignatures: solanaRpc.getSignatures, getParsedTransaction: solanaRpc.getParsedTransaction },
    chain: store.chain(),
    tokens: () => store.tokens(),
    source: solanaRpc.rpcEndpoint().label,
    commitment: solanaRpc.COMMITMENT,
    settings: {
      tokensPerCycle: config.ingestTokensPerCycle,
      txPerToken: config.ingestTxPerToken,
      poolsPerToken: config.ingestPoolsPerToken,
      minPoolVolumeShare: config.ingestMinPoolVolumeShare,
      launchDiscovery: config.launchDiscoveryEnabled,
      launchTxPerCycle: config.launchTxPerCycle,
      liveWindowMs: config.liveWindowMin * 60_000,
    },
  };
}
