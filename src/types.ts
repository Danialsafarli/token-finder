/** Shared domain types. Kept free of runtime code so it erases cleanly. */

export interface TokenCandidate {
  mint: string;
  /** Where this mint came from, e.g. ["dexscreener:profiles", "jupiter:recent"]. */
  sources: string[];
  symbol?: string;
  name?: string;
}

export interface PairMetrics {
  pairAddress: string;
  dexId: string;
  baseSymbol: string;
  baseName: string;
  url: string;
  quoteSymbol: string;
  priceUsd: number | null;
  liquidityUsd: number;
  fdv: number | null;
  marketCap: number | null;
  /** Unix ms when the pair was created, null when the source omits it. */
  pairCreatedAt: number | null;
  volume: Timeframes;
  priceChange: Timeframes;
  txns: Record<TimeframeKey, { buys: number; sells: number }>;
  imageUrl?: string;
  websites: string[];
  socials: { type: string; url: string }[];
  boosts: number;
}

export type TimeframeKey = 'm5' | 'h1' | 'h6' | 'h24';
export type Timeframes = Record<TimeframeKey, number>;

export interface JupiterInfo {
  symbol: string | null;
  name: string | null;
  isVerified: boolean;
  tags: string[];
  organicScore: number | null;
  organicScoreLabel: string | null;
  holderCount: number | null;
  liquidityUsd: number | null;
  usdPrice: number | null;
  mcap: number | null;
  firstPoolCreatedAt: number | null;
  audit: {
    mintAuthorityDisabled: boolean | null;
    freezeAuthorityDisabled: boolean | null;
    topHoldersPercentage: number | null;
    devBalancePercentage: number | null;
  };
  stats24h: {
    numBuys: number | null;
    numSells: number | null;
    numTraders: number | null;
    holderChange: number | null;
  };
}

export interface RugcheckInfo {
  /** RugCheck's own risk score; lower is safer. */
  score: number | null;
  /** 0-100 normalised risk, lower is safer. */
  scoreNormalised: number | null;
  risks: { name: string; level: string; description: string; score: number }[];
}

export interface OnChainInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number | null;
  supply: number | null;
  /** Share of supply held by the largest accounts, 0-1. Pool accounts included. */
  top10Share: number | null;
  largestHolderShare: number | null;
}

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface RiskFlag {
  code: string;
  level: RiskLevel;
  message: string;
}

export interface ScoreComponent {
  key: string;
  label: string;
  /** Normalised 0-1 quality for this dimension. */
  value: number;
  weight: number;
  detail: string;
}

export interface Score {
  /** Final 0-100 ranking score after risk penalties. */
  total: number;
  /** 0-100 before risk penalties were applied. */
  base: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  penalty: number;
  components: ScoreComponent[];
  flags: RiskFlag[];
}

export interface TokenSnapshot {
  mint: string;
  symbol: string;
  name: string;
  sources: string[];
  /** Unix ms of this snapshot. */
  at: number;
  /** Best estimate of launch time (earliest pool), unix ms. */
  launchedAt: number | null;
  ageHours: number | null;
  priceUsd: number | null;
  liquidityUsd: number;
  volume24h: number;
  marketCap: number | null;
  fdv: number | null;
  holders: number | null;
  priceChange: Timeframes;
  buyRatio24h: number | null;
  pair: PairMetrics | null;
  jupiter: JupiterInfo | null;
  rugcheck: RugcheckInfo | null;
  onchain: OnChainInfo | null;
  score: Score;
}

export type EventKind =
  | 'discovered'
  | 'score_up'
  | 'score_down'
  | 'liquidity_drop'
  | 'price_spike'
  | 'risk_flag'
  | 'gone';

export interface MonitorEvent {
  id: string;
  at: number;
  kind: EventKind;
  mint: string;
  symbol: string;
  level: RiskLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface HistoryPoint {
  at: number;
  priceUsd: number | null;
  liquidityUsd: number;
  volume24h: number;
  score: number;
}
