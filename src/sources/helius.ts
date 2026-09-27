import { config, hasHelius } from '../config.ts';
import { getOutcome, type ProviderResult } from '../util/http.ts';
import { TtlCache } from '../util/cache.ts';
import { notConfigured, type ProviderFailure } from '../util/failure.ts';
import {
  ValidationReport,
  validDecimals,
  validMint,
  validRawAmount,
} from '../core/validate.ts';
import { exactRatio } from '../util/num.ts';
import {
  ruleFor,
  tokenProgramOf,
  UNPARSEABLE_EXTENSION,
  type TokenProgram,
} from '../core/token-program.ts';
import type { MintExtension, OnChainInfo } from '../types.ts';
import { classifyHolderRoles, type HolderRoles } from '../core/holder-roles.ts';

const cache = new TtlCache<OnChainInfo | null>(10 * 60_000);

const rpcUrl = (): string => `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;

/**
 * Size of a bare SPL mint account, in bytes.
 *
 * A Token-2022 mint carrying any extension is strictly larger: the base mint,
 * then 83 bytes of padding, then one byte of account type, then the extensions
 * themselves. So `space === 82` is positive proof that no extension exists,
 * and `space > 82` with an empty extension list is proof that the node did not
 * decode them - which is the difference between "none" and "we cannot tell".
 *
 * Source: Anza Pinocchio `InitializePermanentDelegate` - "The mint must have
 * exactly enough space allocated for the base mint (82 bytes), plus 83 bytes of
 * padding, 1 byte reserved for the account type, then space required for this
 * extension, plus any others."
 */
const BASE_MINT_SPACE = 82;

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

async function rpc<T>(
  method: string,
  params: unknown[],
  options: { retries?: number; timeoutMs?: number } = {},
): Promise<ProviderResult<T>> {
  const outcome = await getOutcome<RpcResponse<T>>('helius', rpcUrl(), {
    method: 'POST',
    body: { jsonrpc: '2.0', id: method, method, params },
    retries: options.retries ?? 1,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  if (outcome.failure !== null) return { data: null, failure: outcome.failure };

  // A JSON-RPC error body is a 200 response carrying a refusal, so it has to be
  // recognised here rather than by the HTTP layer.
  const rpcError = outcome.data?.error;
  if (rpcError !== undefined) {
    return {
      data: null,
      failure: {
        provider: 'helius',
        kind: 'INVALID_RESPONSE',
        message: (rpcError.message ?? 'rpc error').slice(0, 200),
        at: Date.now(),
        retryable: false,
      },
    };
  }

  return { data: outcome.data?.result ?? null, failure: null };
}

interface RawExtension {
  extension?: unknown;
  state?: unknown;
}

interface MintAccount {
  value?: {
    /** Base58 program that owns the mint account - the token program. */
    owner?: unknown;
    /** Account data length. Distinguishes a bare mint from an extended one. */
    space?: unknown;
    data?: {
      space?: unknown;
      parsed?: {
        info?: {
          mintAuthority?: unknown;
          freezeAuthority?: unknown;
          decimals?: unknown;
          supply?: unknown;
          extensions?: unknown;
        };
      };
    };
  };
}

interface LargestAccounts {
  /**
   * `amount` is the raw base-unit balance as a decimal string, and it is the
   * only balance field read. `uiAmount` and `uiAmountString` are declared here
   * to document the real response shape, not because anything consumes them -
   * see the holder-math note on {@link onchainInfo} for why.
   */
  value?: {
    address?: unknown;
    amount?: unknown;
    uiAmount?: unknown;
    uiAmountString?: unknown;
  }[];
}

// ---------------------------------------------------------------------------
// getTokenLargestAccounts guard
// ---------------------------------------------------------------------------
//
// Measured live (2026-09-27): p50 2.8 s, p95 4.2 s, and under a burst of 5/s
// half the calls came back as a JSON-RPC error "account index service
// overloaded" inside an HTTP 200. On a token with millions of holder accounts
// (USDC) it is refused outright: "Too many accounts requested".
//
// So the method gets its own lane, separate from every other Helius call:
// - at most two in flight; a third waits rather than piling on;
// - an 8 s timeout and no retry - a slow answer is not worth a second wait;
// - an overload report opens a breaker for five minutes, during which the
//   method is not called at all and concentration is UNAVAILABLE;
// - "too many accounts" is remembered per mint for a day, because the answer
//   will not change and the call is the most expensive one we make.
// Nothing here can stall a scan: every path returns within the timeout.

const LARGEST_TIMEOUT_MS = 8_000;
const LARGEST_MAX_IN_FLIGHT = 2;
const OVERLOAD_COOLDOWN_MS = 5 * 60_000;
const TOO_LARGE_TTL_MS = 24 * 3_600_000;

const largestGuard = {
  inFlight: 0,
  waiters: [] as (() => void)[],
  breakerUntil: 0,
  overloads: 0,
  timeouts: 0,
  tooLarge: new Map<string, number>(),
  calls: 0,
  skipped: 0,
};

export interface LargestAccountsGuardState {
  breakerOpenUntil: number | null;
  overloads: number;
  timeouts: number;
  tooLargeMints: number;
  calls: number;
  skipped: number;
  inFlight: number;
}

export function largestAccountsGuardState(now: number = Date.now()): LargestAccountsGuardState {
  return {
    breakerOpenUntil: largestGuard.breakerUntil > now ? largestGuard.breakerUntil : null,
    overloads: largestGuard.overloads,
    timeouts: largestGuard.timeouts,
    tooLargeMints: [...largestGuard.tooLarge.values()].filter((until) => until > now).length,
    calls: largestGuard.calls,
    skipped: largestGuard.skipped,
    inFlight: largestGuard.inFlight,
  };
}

/** Test seam: forget the guard's memory. */
export function resetLargestAccountsGuard(): void {
  largestGuard.inFlight = 0;
  largestGuard.waiters = [];
  largestGuard.breakerUntil = 0;
  largestGuard.overloads = 0;
  largestGuard.timeouts = 0;
  largestGuard.tooLarge.clear();
  largestGuard.calls = 0;
  largestGuard.skipped = 0;
}

function skip(message: string): ProviderResult<never> {
  largestGuard.skipped += 1;
  return {
    data: null,
    failure: { provider: 'helius', kind: 'PROVIDER_UNAVAILABLE', message, at: Date.now(), retryable: false },
  };
}

/**
 * Calls getTokenLargestAccounts through the guard. `call` is injectable so
 * the guard can be tested without a network.
 */
export async function guardedLargestAccounts<T>(
  mint: string,
  call: () => Promise<ProviderResult<T>> = () =>
    rpc<T>('getTokenLargestAccounts', [mint], { retries: 0, timeoutMs: LARGEST_TIMEOUT_MS }),
  now: () => number = Date.now,
): Promise<ProviderResult<T>> {
  if (largestGuard.breakerUntil > now()) return skip('largest-accounts paused after an overload report');
  const tooLargeUntil = largestGuard.tooLarge.get(mint);
  if (tooLargeUntil !== undefined && tooLargeUntil > now()) {
    return skip('too many holder accounts for getTokenLargestAccounts');
  }

  if (largestGuard.inFlight >= LARGEST_MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => largestGuard.waiters.push(resolve));
  }
  largestGuard.inFlight += 1;
  try {
    // Re-checked after any wait: an overload reported meanwhile applies here too.
    if (largestGuard.breakerUntil > now()) return skip('largest-accounts paused after an overload report');
    largestGuard.calls += 1;
    const result = await call();
    const message = result.failure?.message ?? '';
    if (/overload/i.test(message)) {
      largestGuard.overloads += 1;
      largestGuard.breakerUntil = now() + OVERLOAD_COOLDOWN_MS;
    } else if (/too many accounts/i.test(message)) {
      largestGuard.tooLarge.set(mint, now() + TOO_LARGE_TTL_MS);
    } else if (result.failure?.kind === 'TIMEOUT') {
      largestGuard.timeouts += 1;
      // Two timeouts read as a struggling index: step back for a minute.
      if (largestGuard.timeouts % 2 === 0) largestGuard.breakerUntil = now() + 60_000;
    }
    return result;
  } finally {
    largestGuard.inFlight -= 1;
    largestGuard.waiters.shift()?.();
  }
}

/** Result of reading the extension list off a mint account. */
interface ExtensionRead {
  extensions: MintExtension[] | null;
  complete: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parses the `extensions` array off a jsonParsed Token-2022 mint.
 *
 * Shape, per Helius's Agave 4.2 migration notes: each entry is
 * `{"extension": "<name>", "state": {...}}`, and an extension the node could
 * not decode arrives as `{"extension": "unparseableExtension"}`.
 *
 * Three rules govern everything here:
 *
 * 1. **An unrecognised extension name is never ignored.** It becomes an
 *    `UNKNOWN_POLICY` entry and marks the read incomplete. Silently skipping it
 *    would let a future extension with real powers pass as a clean mint.
 * 2. **An unreadable `state` is UNKNOWN, not safe.** Every rule's risk test
 *    returns `null` when it cannot find the fields it needs, and `null` never
 *    vetoes and never reassures.
 * 3. **Completeness is measured, not assumed.** See {@link BASE_MINT_SPACE}.
 */
function readExtensions(
  program: TokenProgram,
  rawExtensions: unknown,
  space: number | null,
): ExtensionRead {
  // The legacy program has no extension mechanism at all, so "none" here is a
  // structural fact about the program rather than an observation that could
  // have come back empty for the wrong reason.
  if (program === 'LEGACY_SPL_TOKEN') return { extensions: [], complete: true };
  if (program !== 'TOKEN_2022') return { extensions: null, complete: false };

  const bareMint = space !== null && space <= BASE_MINT_SPACE;

  if (!Array.isArray(rawExtensions)) {
    // No list at all. Only a provably bare mint can be called extension-free.
    return bareMint ? { extensions: [], complete: true } : { extensions: null, complete: false };
  }

  const entries = rawExtensions as RawExtension[];
  if (entries.length === 0) {
    // An empty list on an account larger than a bare mint means the node
    // returned nothing for extensions that demonstrably exist.
    return bareMint ? { extensions: [], complete: true } : { extensions: [], complete: false };
  }

  let complete = true;
  const extensions: MintExtension[] = [];

  for (const entry of entries) {
    const name = typeof entry?.extension === 'string' ? entry.extension : null;
    if (name === null) {
      complete = false;
      continue;
    }

    const state = asRecord(entry.state);

    if (name.toLowerCase() === UNPARSEABLE_EXTENSION) {
      complete = false;
      extensions.push({
        id: name,
        label: 'Undecodable extension',
        policy: 'UNKNOWN_POLICY',
        active: null,
        rationale:
          'The node recognised an extension here but could not decode it, so what it permits is unknown.',
        recheckable: false,
        detail: null,
        magnitude: null,
      });
      continue;
    }

    const rule = ruleFor(name);
    if (rule === null) {
      // A name this build does not know. Never a veto - the gate never fires on
      // UNKNOWN - but the mint is not fully understood and says so.
      complete = false;
      extensions.push({
        id: name,
        label: name,
        policy: 'UNKNOWN_POLICY',
        active: null,
        rationale:
          'This build does not recognise this extension, so its effect on holders is unknown.',
        recheckable: false,
        detail: null,
        magnitude: null,
      });
      continue;
    }

    const active = rule.risk(state);
    if (active === null) complete = false;

    extensions.push({
      id: name,
      label: rule.label,
      policy: rule.policy,
      active,
      rationale: rule.rationale,
      recheckable: rule.recheckable,
      detail: rule.detail?.(state) ?? null,
      magnitude: rule.magnitude?.(state) ?? null,
    });
  }

  return { extensions, complete };
}

/**
 * Authority state, token program, mint extensions and holder concentration,
 * straight from the chain. Returns null when no Helius key is configured -
 * every caller treats the on-chain block as optional enrichment.
 *
 * ## Holder math
 *
 * Concentration is an exact integer ratio of raw base units on both sides.
 * Nothing here divides a raw amount by a UI amount, and `uiAmount` is not read
 * at all. Three separate reasons, only one of which is precision:
 *
 * - `uiAmount` is nullable, and the previous code dropped null entries from the
 *   holder list. A dropped holder understates concentration, which fails toward
 *   *safety* - the one direction a safety metric must never fail in.
 * - The identity `uiAmount == amount / 10^decimals` does not hold under the
 *   ScaledUiAmount or InterestBearing extensions, both of which rebase the
 *   displayed figure while leaving raw balances untouched. Reading raw amounts
 *   makes those extensions irrelevant to concentration, which is correct.
 * - A `u64` supply exceeds what `number` represents exactly once a mint has
 *   more than ~9e15 base units, which nine decimals reaches at nine million
 *   whole tokens.
 *
 * Caveat, unchanged: the largest accounts include AMM pool vaults, so
 * `top10Share` is an upper bound on genuine holder concentration rather than a
 * clean insider metric, and the safety gate does not veto on it.
 */
export interface OnchainContext {
  /** Pool addresses a market provider or collection names for this mint. */
  pools?: string[];
  /** A bonding curve a launch record names. */
  curves?: string[];
}

export async function onchainInfo(mint: string, context: OnchainContext = {}): Promise<ProviderResult<OnChainInfo>> {
  // Not configured is a distinct, permanent condition: there is nothing to
  // retry and nothing wrong, but the signal is UNAVAILABLE, not UNKNOWN.
  if (!hasHelius()) return { data: null, failure: notConfigured('helius') };

  const hit = cache.get(mint);
  if (hit !== undefined) return { data: hit, failure: null };

  const result = await (async (): Promise<ProviderResult<OnChainInfo>> => {
    // The two RPC calls are independent: a failure of one must not discard the
    // other's answer, so neither can reject the pair.
    const [accountResult, largestResult] = await Promise.all([
      rpc<MintAccount>('getAccountInfo', [mint, { encoding: 'jsonParsed' }]),
      guardedLargestAccounts<LargestAccounts>(mint),
    ]);

    const failure: ProviderFailure | null = accountResult.failure ?? largestResult.failure;
    const account = accountResult.data;
    const largest = largestResult.data;

    if (!account?.value?.data?.parsed?.info && !largest) return { data: null, failure };

    const info = parseMint(account, largest, largestResult.failure !== null);
    if (info.largestAccountsCount !== null && info.largestAccountsCount > 0 && largest?.value) {
      info.holderRoles = await holderRolesFor(largest, info.rawSupply, context);
    }
    return {
      data: info,
      // A partial answer is still an answer; the failure is reported alongside
      // it so the gap is attributable.
      failure,
    };
  })();

  if (result.data !== null) cache.set(mint, result.data);
  return result;
}

/**
 * Labels the largest accounts by their owners' roles: one getMultipleAccounts
 * call for all of them. A failure leaves the roles null - the raw figure
 * stands on its own, as it always has.
 */
async function holderRolesFor(
  largest: LargestAccounts,
  rawSupply: string | null,
  context: OnchainContext,
): Promise<HolderRoles | null> {
  const entries = (largest.value ?? []).flatMap((e) =>
    typeof e?.address === 'string' && typeof e.amount === 'string' && /^\d+$/.test(e.amount)
      ? [{ tokenAccount: e.address, amount: BigInt(e.amount) }]
      : [],
  );
  if (entries.length === 0) return null;
  const accounts = await rpc<{ value?: unknown[] }>('getMultipleAccounts', [
    entries.map((e) => e.tokenAccount),
    { encoding: 'jsonParsed' },
  ]);
  if (accounts.failure !== null) return null;
  const owners = new Map<string, string | null>();
  (accounts.data?.value ?? []).forEach((value, i) => {
    const owner = (value as { data?: { parsed?: { info?: { owner?: unknown } } } } | null)?.data?.parsed?.info?.owner;
    owners.set(entries[i]?.tokenAccount ?? '', typeof owner === 'string' ? owner : null);
  });
  return classifyHolderRoles(entries, owners, rawSupply === null ? null : BigInt(rawSupply), {
    pools: new Set(context.pools ?? []),
    curves: new Set(context.curves ?? []),
  });
}

/**
 * Turns the two raw RPC responses into an {@link OnChainInfo}.
 *
 * Split out from {@link onchainInfo} so the parsing - which is where every
 * correctness question in this file lives - can be exercised against literal
 * RPC payloads without a network.
 *
 * @param largestFailed whether the holder call failed, as distinct from
 *   returning no accounts. A failure means concentration is unknown; an empty
 *   list means it was measured and there are no holders.
 */
export function parseMint(
  account: MintAccount | null,
  largest: LargestAccounts | null,
  largestFailed: boolean,
): OnChainInfo {
  const info = account?.value?.data?.parsed?.info;
  const report = new ValidationReport('helius');

  // --- token program ----------------------------------------------------
  // Read only from the account's owner. Never inferred from whether
  // extensions were found: a Token-2022 mint with no extensions looks exactly
  // like a legacy mint by that test, so inferring backwards would make "no
  // extensions" mean two incompatible things.
  const programId =
    account?.value?.owner === undefined || account?.value?.owner === null
      ? null
      : validMint(report, 'programId', account.value.owner);
  const tokenProgram = tokenProgramOf(programId);

  const rawSpace = account?.value?.space ?? account?.value?.data?.space;
  const space = typeof rawSpace === 'number' && Number.isFinite(rawSpace) ? rawSpace : null;

  const { extensions, complete: extensionsComplete } = readExtensions(
    tokenProgram,
    info?.extensions,
    space,
  );

  // --- authorities ------------------------------------------------------
  // An authority is either a base58 address (live) or null (revoked). A
  // non-address value is rejected, not read as "revoked" - that misreading
  // turns an unparseable response into a clean bill of health.
  const mintAuthority =
    info?.mintAuthority === null || info?.mintAuthority === undefined
      ? null
      : validMint(report, 'mintAuthority', info.mintAuthority);
  const freezeAuthority =
    info?.freezeAuthority === null || info?.freezeAuthority === undefined
      ? null
      : validMint(report, 'freezeAuthority', info.freezeAuthority);

  // Whether the response actually asserted an authority field, as opposed to
  // omitting it. `null` from the chain means revoked; absent means unknown.
  const mintAuthorityStated = info !== undefined && 'mintAuthority' in info;
  const freezeAuthorityStated = info !== undefined && 'freezeAuthority' in info;

  // --- supply and decimals ----------------------------------------------
  const decimals = validDecimals(report, 'decimals', info?.decimals);
  const rawSupply = validRawAmount(report, 'supply', info?.supply);

  // Whole-token supply, for display only. Nothing divides by this: the
  // concentration ratio below uses raw base units on both sides, so there is
  // no code path where a missing `decimals` can silently mix units.
  const supply =
    rawSupply === null
      ? null
      : decimals === null
        ? null
        : Number(rawSupply) / 10 ** decimals;

  // --- holder concentration ---------------------------------------------
  const entries = largest?.value ?? [];
  const holders: bigint[] = [];
  let holdersUsable = !largestFailed;

  for (const [index, entry] of entries.entries()) {
    const amount = validRawAmount(report, `largestAccounts[${index}].amount`, entry?.amount);
    if (amount === null) {
      // A holder we could not read is not a holder with no balance. Dropping
      // it would understate concentration, so the whole set is withdrawn and
      // concentration becomes non-measured. The node reported this account
      // exists; we simply do not know how much it holds.
      report.reject(
        'top10Share',
        `holder balance at index ${index} could not be read, so concentration is unknown`,
        entry?.amount,
      );
      holdersUsable = false;
      break;
    }
    holders.push(amount);
  }

  holders.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  const rawTop10 = holders.slice(0, 10).reduce((sum, amount) => sum + amount, 0n);
  const usableSupply = rawSupply !== null && rawSupply > 0n ? rawSupply : null;

  const rawShare =
    holdersUsable && usableSupply !== null ? exactRatio(rawTop10, usableSupply) : null;

  // A share above 1 means the supply reading and the balances disagree, so
  // neither can be trusted. With exact integer arithmetic on both sides this
  // is no longer a rounding artefact - the division truncates downward, so
  // anything over 1 is a genuine contradiction. Impossible, therefore
  // rejected rather than capped.
  const top10Share =
    rawShare !== null && rawShare > 1
      ? report.reject('top10Share', 'holder balances exceed total supply', rawShare)
      : rawShare;

  const biggest = holders[0];
  const largestHolderShare =
    top10Share !== null && usableSupply !== null && biggest !== undefined
      ? exactRatio(biggest, usableSupply)
      : null;

  return {
    programId,
    tokenProgram,
    extensions,
    extensionsComplete,
    mintAuthority,
    freezeAuthority,
    mintAuthorityStated,
    freezeAuthorityStated,
    decimals,
    supply,
    // BigInt does not survive JSON, and these are persisted on the
    // snapshot, so they travel as exact decimal strings.
    rawSupply: rawSupply === null ? null : rawSupply.toString(),
    rawTop10: holdersUsable && holders.length > 0 ? rawTop10.toString() : null,
    largestAccountsCount: holdersUsable ? holders.length : null,
    top10Share,
    largestHolderShare,
    issues: report.issues,
  };
}
