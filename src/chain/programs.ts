/**
 * Program and mint addresses the data backbone recognises.
 *
 * Each entry says where it was confirmed. "Verified live" means a real mainnet
 * transaction fetched while building this module showed the address in the
 * role described; recall alone is never enough for an address that changes
 * what a transaction is taken to mean.
 */

/**
 * pump.fun bonding-curve program. Verified live: the outer program of every
 * `CreateV2` / `Buy` / `Sell` instruction in the captured fixtures.
 */
export const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * pump.fun's mint-authority PDA. Verified live: it is the `mintAuthority` of
 * the `initializeMint2` in every creation, and it is off-curve (a PDA).
 * Because it takes part only in token creation, the signatures that reference
 * it are - with failures filtered out - exactly pump.fun's launches, which is
 * what makes on-chain launch discovery affordable without a firehose.
 */
export const PUMPFUN_MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

/** Native SOL is wrapped as this mint; SOL-quoted pools are counted in it. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** SOL has nine decimals; a lamport is its base unit. */
export const SOL_DECIMALS = 9;

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Launch venues the backbone can discover on-chain, by name. */
export type LaunchVenue = 'pumpfun';
