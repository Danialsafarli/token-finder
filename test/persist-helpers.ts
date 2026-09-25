/**
 * Fixtures and helpers for the persistence tests.
 *
 * Every test gets its own database in a fresh temp directory, so nothing here
 * can touch the working copy's `data/` or leak state between tests.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/persist/db.ts';
import { Repository } from '../src/persist/repository.ts';
import { LEGACY_SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/core/token-program.ts';
import type {
  Evaluation,
  MonitorEvent,
  OnChainInfo,
  Score,
  TokenSnapshot,
} from '../src/types.ts';

const created: string[] = [];

/** A private temp directory, removed by {@link cleanupTempDirs}. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tf-persist-'));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a handle briefly after close; a leftover temp dir is
      // the OS's problem, not a test failure.
    }
  }
}

export interface Harness {
  db: DatabaseSync;
  repo: Repository;
  dir: string;
  path: string;
  close(): void;
}

/** Opens a migrated database on a fresh temp path. */
export function harness(): Harness {
  const dir = tempDir();
  const path = join(dir, 'token-finder.sqlite');
  const opened = openDatabase({ path });
  if (opened.db === null) throw new Error(`could not open test database: ${opened.failure?.message}`);
  return {
    db: opened.db,
    repo: new Repository(opened.db),
    dir,
    path,
    close: () => {
      try {
        opened.db?.close();
      } catch {
        // Already closed by the test.
      }
    },
  };
}

function score(total: number): Score {
  return {
    total,
    base: total,
    grade: total >= 80 ? 'A' : total >= 60 ? 'B' : 'C',
    penalty: 0,
    coverage: 1,
    ceiling: 100,
    unknown: [],
    components: [],
    flags: [],
  };
}

function evaluation(
  state: Evaluation['state'],
  eligibility: Evaluation['eligibility'],
  overrides: Partial<Evaluation> = {},
): Evaluation {
  return {
    state,
    eligibility,
    stateChangedAt: 1_700_000_000_000,
    previousState: null,
    vetoes: [],
    coverage: {
      eligibleSignals: 13,
      measured: 13,
      unknown: 0,
      conflicted: 0,
      invalid: 0,
      stale: 0,
      unavailable: 0,
      coverage: 1,
      confidence: 0.9,
      providerConcentration: 0.4,
      dominantProvider: 'dexscreener',
    },
    conflicts: [],
    issues: [],
    providerFailures: [],
    historicalDangerEvidence: false,
    ...overrides,
  };
}

export interface SnapshotOverrides {
  mint?: string;
  at?: number;
  score?: number;
  state?: Evaluation['state'];
  eligibility?: Evaluation['eligibility'];
  priceUsd?: number | null;
  liquidityUsd?: number | null;
  volume24h?: number | null;
  holders?: number | null;
  onchain?: OnChainInfo | null;
  evaluation?: Evaluation | null;
  vetoCodes?: string[];
}

/** A complete, valid TokenSnapshot. Overrides only what a test cares about. */
export function snapshot(overrides: SnapshotOverrides = {}): TokenSnapshot {
  const at = overrides.at ?? 1_700_000_000_000;
  const evalBlock =
    overrides.evaluation === null
      ? null
      : (overrides.evaluation ??
        evaluation(overrides.state ?? 'QUALIFIED', overrides.eligibility ?? 'QUALIFIED', {
          vetoes: (overrides.vetoCodes ?? []).map((code) => ({
            code: code as Evaluation['vetoes'][number]['code'],
            nature: 'current-state' as const,
            reason: 'test veto',
            source: 'test',
            observedValue: 'x',
            at,
            recheckable: true,
          })),
        }));

  return {
    mint: overrides.mint ?? 'So11111111111111111111111111111111111111112',
    symbol: 'TEST',
    name: 'Test Token',
    sources: ['test'],
    at,
    launchedAt: at - 3_600_000,
    ageHours: 1,
    priceUsd: overrides.priceUsd === undefined ? 0.5 : overrides.priceUsd,
    liquidityUsd: overrides.liquidityUsd === undefined ? 50_000 : overrides.liquidityUsd,
    volume24h: overrides.volume24h === undefined ? 120_000 : overrides.volume24h,
    marketCap: 900_000,
    fdv: 1_000_000,
    holders: overrides.holders === undefined ? 400 : overrides.holders,
    priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 },
    buyRatio24h: 0.55,
    pair: {
      pairAddress: 'PoolAddr1111111111111111111111111111111111',
      dexId: 'raydium',
      baseSymbol: 'TEST',
      baseName: 'Test Token',
      url: 'https://example.invalid/pair',
      quoteSymbol: 'SOL',
      priceUsd: 0.5,
      liquidityUsd: 50_000,
      fdv: 1_000_000,
      marketCap: 900_000,
      pairCreatedAt: at - 3_600_000,
      volume: { m5: 100, h1: 1_000, h6: 10_000, h24: 120_000 },
      priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 },
      txns: {
        m5: { buys: 5, sells: 4 },
        h1: { buys: 50, sells: 40 },
        h6: { buys: 300, sells: 240 },
        h24: { buys: 1_200, sells: 900 },
      },
      websites: [],
      socials: [],
      boosts: 0,
      issues: [],
    },
    jupiter: null,
    rugcheck: null,
    onchain: overrides.onchain === undefined ? legacyOnchain() : overrides.onchain,
    impersonation: null,
    score: score(overrides.score ?? 75),
    evaluation: evalBlock,
  };
}

export function legacyOnchain(overrides: Partial<OnChainInfo> = {}): OnChainInfo {
  return {
    programId: LEGACY_SPL_TOKEN_PROGRAM_ID,
    tokenProgram: 'LEGACY_SPL_TOKEN',
    extensions: [],
    extensionsComplete: true,
    mintAuthority: null,
    freezeAuthority: null,
    mintAuthorityStated: true,
    freezeAuthorityStated: true,
    decimals: 9,
    supply: 1_000_000,
    rawSupply: '1000000000000000',
    rawTop10: null,
    largestAccountsCount: null,
    top10Share: null,
    largestHolderShare: null,
    issues: [],
    ...overrides,
  };
}

/** A Token-2022 mint with a u64 supply past exact float range. */
export function token2022Onchain(overrides: Partial<OnChainInfo> = {}): OnChainInfo {
  return legacyOnchain({
    programId: TOKEN_2022_PROGRAM_ID,
    tokenProgram: 'TOKEN_2022',
    decimals: 255,
    // BONK's real on-chain supply: 8799438501691764747 > Number.MAX_SAFE_INTEGER.
    rawSupply: '8799438501691764747',
    rawTop10: '8799438501691764000',
    largestAccountsCount: 10,
    top10Share: 0.999999999,
    largestHolderShare: 0.5,
    ...overrides,
  });
}

export function event(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    id: 'evt-1',
    at: 1_700_000_000_000,
    kind: 'discovered',
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'TEST',
    level: 'info',
    message: 'discovered',
    ...overrides,
  };
}

/** A legacy v1 state.json body, as the JSON store actually wrote it. */
export function legacyState(options: { tokens?: number; points?: number } = {}): string {
  const tokenCount = options.tokens ?? 2;
  const pointCount = options.points ?? 3;
  const tokens: Record<string, unknown> = {};
  const history: Record<string, unknown[]> = {};

  for (let i = 0; i < tokenCount; i++) {
    const mint = `Legacy${String(i).padStart(38, '0')}`;
    // v1 snapshots have no `evaluation` key at all - that is the whole point.
    const snap = snapshot({ mint, at: 1_700_000_000_000 + i }) as unknown as Record<string, unknown>;
    delete snap['evaluation'];
    tokens[mint] = snap;
    history[mint] = Array.from({ length: pointCount }, (_, p) => ({
      at: 1_700_000_000_000 + p * 60_000,
      priceUsd: 0.1 * (p + 1),
      liquidityUsd: 1_000 * (p + 1),
      volume24h: 500 * (p + 1),
      score: 50 + p,
    }));
  }

  return JSON.stringify({
    version: 1,
    lastScanAt: 1_700_000_100_000,
    scanCount: 7,
    tokens,
    history,
    events: [event()],
  });
}
