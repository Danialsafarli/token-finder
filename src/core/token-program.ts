/**
 * Token program identity and Token-2022 mint extensions.
 *
 * Before this module Token Finder read every mint as though it were legacy SPL
 * Token: it asked for `mintAuthority` and `freezeAuthority`, found both
 * revoked, and called the token safe. A Token-2022 mint can revoke both and
 * still let a third party take tokens out of any wallet, halt every transfer,
 * or freeze each new buyer's account on creation. Those powers live in
 * *extensions*, which the old read never looked at.
 *
 * ## What the safety policy rests on
 *
 * Extension semantics were verified against live sources rather than recalled;
 * `SOURCES` below records which claim came from where. The one that decides the
 * shape of the whole policy is the permanent delegate:
 *
 * > The permanent delegate can transfer or renounce their authority. Can be set
 * > to `None` to permanently renounce.
 * > -- Light Protocol, `RESTRICTED_T22_EXTENSIONS.md`
 *
 * corroborated by the on-chain layout, where the stored delegate is nullable
 * (`PermanentDelegateExtension { delegate: MaybeNull<Address> }` in Anza's
 * Pinocchio; `OptionalNonZeroPubkey` in Anchor's Token-2022 constraints).
 *
 * That distinction is load-bearing. The *extension* is permanent: it must be
 * initialised before `InitializeMint` and can never be removed from the mint.
 * The *delegate* is not: it can be reassigned, or set to `None`, after which
 * nobody can sign as it and the extension is inert. So:
 *
 *   - "PermanentDelegate present" is **not** a risk. Vetoing on it would reject
 *     mints whose issuer has already renounced the power.
 *   - "PermanentDelegate present AND a delegate is set" is a current-state
 *     risk, and - because renouncing is possible - it is **re-checkable**,
 *     exactly like a live mint authority.
 *
 * Had this gone unverified, the obvious reading ("permanent means permanent")
 * would have produced a non-recheckable historical veto that is simply wrong.
 *
 * ## Policy classes
 *
 * Each extension is classified by what it can do to a holder *right now*, not
 * by how alarming its name is. An extension that is present but disarmed earns
 * `NO_CURRENT_RISK_EFFECT`, which is a statement about the present and is
 * reported as such - it is not the same as the extension being absent.
 */

/**
 * Canonical program IDs.
 *
 * Both appear in current official material: the Token-2022 id in the SPL
 * Extension Guide's own CLI examples (`spl-token --program-id Tokenz...`) and
 * in `solana-record-service`'s `TOKEN_2022_PROGRAM_ID`; both ids in the RPC
 * provider documentation for `getTokenAccountsByOwner`'s `programId` filter.
 */
export const LEGACY_SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Which token program owns a mint account.
 *
 * Determined solely from the account's `owner` field. It is never inferred from
 * the presence of extensions: a Token-2022 mint with no extensions is
 * indistinguishable from a legacy mint by that test, and inferring it backwards
 * would make "no extensions found" mean two different things.
 */
export type TokenProgram = 'LEGACY_SPL_TOKEN' | 'TOKEN_2022' | 'UNKNOWN';

export function tokenProgramOf(owner: string | null): TokenProgram {
  if (owner === LEGACY_SPL_TOKEN_PROGRAM_ID) return 'LEGACY_SPL_TOKEN';
  if (owner === TOKEN_2022_PROGRAM_ID) return 'TOKEN_2022';
  return 'UNKNOWN';
}

/**
 * What an extension's current configuration means for a holder.
 *
 * - `HARD_VETO` - a third party can currently take, trap or block the holder's
 *   tokens. Not a scoring matter: the token should not appear among candidates.
 * - `CONDITIONAL_VETO` - dangerous past a threshold, tolerable below it. The
 *   threshold is named in the policy entry.
 * - `PENALTY_ONLY` - reduces what a holder can realise without preventing exit.
 * - `INFORMATIONAL` - worth recording, no effect on safety.
 * - `NO_CURRENT_RISK_EFFECT` - the extension is present but disarmed, so it
 *   asserts nothing about present danger.
 * - `UNKNOWN_POLICY` - the extension was not recognised. It never vetoes, and
 *   it marks extension coverage incomplete.
 */
export type ExtensionPolicy =
  | 'HARD_VETO'
  | 'CONDITIONAL_VETO'
  | 'PENALTY_ONLY'
  | 'INFORMATIONAL'
  | 'NO_CURRENT_RISK_EFFECT'
  | 'UNKNOWN_POLICY';

/** Source provenance for each verified semantic claim. */
export const SOURCES = {
  permanentDelegateRenounceable:
    'Light Protocol RESTRICTED_T22_EXTENSIONS.md ("Can be set to None to permanently renounce"); corroborated by Pinocchio PermanentDelegateExtension { delegate: MaybeNull<Address> } and Anchor OptionalNonZeroPubkey',
  permanentDelegatePowers:
    'SPL Token-2022 Extension Guide: "unlimited delegate privileges over any account for that mint, meaning that it can burn or transfer any amount of tokens"',
  extensionFixedAtInit:
    'solana-developers/program-examples permanent-delegate: "extensions live in the space past the base mint and Token-2022 rejects initializing them once InitializeMint has run"',
  jsonParsedShape:
    'Helius "Agave 4.2: The Migration Checklist": each entry is {"extension": "<name>", "state": {...}}, undecodable ones arrive as {"extension": "unparseableExtension"}',
  emptyExtensionsNotProof:
    'Helius "Agave 4.2: The Migration Checklist": on Agave 4.1 a single unrecognised extension made the node return "extensions": [], hiding every extension including known ones',
  permissionedBurn:
    'SPL Token-2022 Extension Guide, Permissioned Burn: "every burn must be co-signed by that authority in addition to the token account owner or delegate ... The burn authority can be rotated, or cleared entirely, using the SetAuthority instruction". It restricts burning rather than granting seizure, and it does not touch transfers.',
  confidentialTransferFee:
    'Solana Confidential Transfer Issuer Guide: the ConfidentialTransferFeeConfig authority "enables or disables harvesting" of withheld fees. Light Protocol lists it among NON_RESTRICTED_EXTENSIONS.',
  restrictedSet:
    'Convergent across three independent production systems - Light Protocol compressed-token, Kora, Meteora DLMM - which all refuse PermanentDelegate, Pausable, TransferFee, TransferHook and DefaultAccountState mints',
} as const;

/**
 * The extension registry.
 *
 * `risk` inspects the parsed `state` object and answers one question: is the
 * dangerous condition live right now? It returns `null` when the state could
 * not be read, which becomes UNKNOWN - never "safe". Every extractor is written
 * to fail that way, because the exact `state` field names for the newer
 * extensions are not pinned by the documentation retrieved, and an extractor
 * that guessed wrong must not be able to manufacture a clean bill of health.
 */
export interface ExtensionRule {
  /** jsonParsed `extension` name, lower-cased for matching. */
  id: string;
  /**
   * Other spellings seen for the same extension. The Rust enum, the CLI and
   * the jsonParsed output do not always agree on the `Config` suffix, and a
   * name we fail to match degrades to UNKNOWN_POLICY - safe, but it would mark
   * every such mint incomplete for no reason.
   */
  aliases?: string[];
  label: string;
  /** Policy when {@link risk} reports the condition live. */
  policy: ExtensionPolicy;
  /** Why this policy, in terms of what the holder loses. */
  rationale: string;
  /**
   * Whether the dangerous condition can be cleared by the issuer. Drives
   * `recheckable` on any veto this produces.
   */
  recheckable: boolean;
  /** Live-risk test. `true` armed, `false` disarmed, `null` unreadable. */
  risk: (state: Record<string, unknown> | null) => boolean | null;
  /** Extra audit detail, e.g. the fee in basis points. */
  detail?: (state: Record<string, unknown> | null) => string | null;
  /**
   * Policy-relevant scalar, for extensions whose danger is a matter of degree.
   * Returns null when it cannot be read, which never clears a threshold.
   */
  magnitude?: (state: Record<string, unknown> | null) => number | null;
}

/** The all-zero address, which is how a renounced optional pubkey can render. */
const ZERO_ADDRESS = '11111111111111111111111111111111';

/** Reads an optional pubkey field. `true` set, `false` renounced, `null` unreadable. */
function pubkeySet(state: Record<string, unknown> | null, ...fields: string[]): boolean | null {
  if (state === null) return null;
  for (const field of fields) {
    if (!(field in state)) continue;
    const value = state[field];
    if (value === null || value === undefined) return false;
    if (typeof value !== 'string') return null;
    return value !== ZERO_ADDRESS && value.length > 0;
  }
  // The extension is present but none of the field names we know appeared.
  // That is a gap in our parser, not evidence that the authority is unset.
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads the higher of the two scheduled transfer fees, in basis points. */
function transferFeeBps(state: Record<string, unknown> | null): number | null {
  if (state === null) return null;
  const bps: number[] = [];
  for (const key of ['newerTransferFee', 'olderTransferFee']) {
    const fee = asRecord(state[key]);
    const raw = fee?.['transferFeeBasisPoints'];
    if (typeof raw === 'number' && Number.isFinite(raw)) bps.push(raw);
  }
  return bps.length === 0 ? null : Math.max(...bps);
}

/**
 * Basis points at which a transfer fee stops being a cost and becomes a trap.
 *
 * At 50% every round trip surrenders half the position to the fee authority.
 * For a speculative position that is not a worse price, it is a different
 * instrument. Below it the fee is a real cost and is penalised, not vetoed.
 * Operator-tunable, and explicitly not calibrated against outcome data.
 */
export const TRANSFER_FEE_VETO_BPS = 5_000;

export const EXTENSION_RULES: ExtensionRule[] = [
  {
    id: 'permanentdelegate',
    label: 'Permanent delegate',
    policy: 'HARD_VETO',
    rationale:
      'A permanent delegate can transfer or burn any amount from any account holding this mint, without the holder\'s consent. That is strictly worse than a live freeze authority: freezing traps the position, a delegate takes it.',
    // Verified: the delegate can be set to None, so this condition can clear.
    recheckable: true,
    risk: (state) => pubkeySet(state, 'delegate', 'permanentDelegate'),
    detail: (state) => {
      const set = pubkeySet(state, 'delegate', 'permanentDelegate');
      if (set === null) return 'delegate field unreadable';
      return set ? 'delegate is set' : 'delegate renounced to None';
    },
  },
  {
    id: 'nontransferable',
    label: 'Non-transferable',
    policy: 'HARD_VETO',
    rationale:
      'The mint forbids transfers outright. Whatever a venue quotes, the position cannot be sold on.',
    // NonTransferable carries no authority, so nothing can turn it off.
    recheckable: false,
    risk: () => true,
  },
  {
    id: 'pausableconfig',
    aliases: ['pausable'],
    label: 'Pausable',
    policy: 'HARD_VETO',
    rationale:
      'A pause authority can halt every transfer of this mint at once. While paused nobody can exit; while an authority exists it can be paused at any moment.',
    recheckable: true,
    risk: (state) => {
      if (state === null) return null;
      if (state['paused'] === true) return true;
      return pubkeySet(state, 'authority', 'pauseAuthority');
    },
    detail: (state) => (state?.['paused'] === true ? 'currently paused' : 'pause authority is set'),
  },
  {
    id: 'defaultaccountstate',
    label: 'Default account state',
    policy: 'HARD_VETO',
    rationale:
      'New token accounts for this mint are created frozen, so a buyer receives a position they cannot move until an authority thaws it individually.',
    recheckable: true,
    risk: (state) => {
      if (state === null) return null;
      const raw = state['accountState'] ?? state['state'];
      if (typeof raw !== 'string') return null;
      return raw.toLowerCase() === 'frozen';
    },
    detail: (state) => {
      const raw = state?.['accountState'] ?? state?.['state'];
      return typeof raw === 'string' ? `default state is ${raw}` : null;
    },
  },
  {
    id: 'transferhook',
    label: 'Transfer hook',
    policy: 'HARD_VETO',
    rationale:
      'Every transfer calls out to a third-party program that can reject it. Token Finder does not analyse that program, so it cannot say the hook is benign - and a hook that refuses sells is indistinguishable, from the outside, from one that does not. Light Protocol, Kora and Meteora DLMM all refuse these mints for the same reason.',
    recheckable: true,
    risk: (state) => pubkeySet(state, 'programId', 'hookProgramId'),
    detail: (state) => {
      const id = state?.['programId'];
      return typeof id === 'string' ? `hook program ${id}` : null;
    },
  },
  {
    id: 'transferfeeconfig',
    label: 'Transfer fee',
    policy: 'CONDITIONAL_VETO',
    rationale:
      `A transfer fee is an exit tax withheld on every transfer. Below ${TRANSFER_FEE_VETO_BPS / 100}% it is a real cost and is penalised; at or above it, a round trip surrenders most of the position to the fee authority.`,
    recheckable: true,
    risk: (state) => {
      const bps = transferFeeBps(state);
      return bps === null ? null : bps > 0;
    },
    detail: (state) => {
      const bps = transferFeeBps(state);
      return bps === null ? 'fee schedule unreadable' : `${(bps / 100).toFixed(2)}% fee`;
    },
    magnitude: transferFeeBps,
  },
  {
    id: 'confidentialtransfermint',
    aliases: ['confidentialtransfer'],
    label: 'Confidential transfers',
    policy: 'INFORMATIONAL',
    rationale:
      'Balances can be moved into a confidential form, which makes holder concentration partly unobservable. It does not trap a position, but it does mean concentration figures for this mint are a lower bound.',
    recheckable: false,
    risk: () => true,
  },
  {
    id: 'interestbearingconfig',
    aliases: ['interestbearingmint'],
    label: 'Interest bearing',
    policy: 'INFORMATIONAL',
    rationale:
      'Rebases the *displayed* amount over time. Raw balances and therefore holder concentration are unaffected; only `uiAmount` moves, which is one reason holder math here reads raw amounts.',
    recheckable: false,
    risk: () => true,
  },
  {
    id: 'scaleduiamountconfig',
    aliases: ['scaleduiamount'],
    label: 'Scaled UI amount',
    policy: 'INFORMATIONAL',
    rationale:
      'Applies an authority-settable multiplier to the *displayed* amount. Raw balances are unchanged, so concentration computed from raw amounts is unaffected - but any figure taken from `uiAmount` would move when the multiplier does.',
    recheckable: false,
    risk: () => true,
  },
  {
    id: 'mintcloseauthority',
    label: 'Mint close authority',
    policy: 'INFORMATIONAL',
    rationale:
      'The mint account can be closed, but only once its supply is zero. For a mint with a live market this cannot be exercised, so it carries no current risk to a holder.',
    recheckable: true,
    risk: () => true,
  },
  {
    id: 'permissionedburnconfig',
    aliases: ['permissionedburn'],
    label: 'Permissioned burn',
    policy: 'INFORMATIONAL',
    rationale:
      'Burning requires a co-signature from a burn authority, so a holder cannot destroy their own tokens unilaterally. It restricts burning rather than granting seizure - the authority cannot move or take a balance it does not own - and it leaves transfers, and therefore selling, untouched.',
    // Clearing the authority to None re-enables the standard burn instructions.
    recheckable: true,
    risk: () => true,
  },
  {
    id: 'confidentialtransferfeeconfig',
    aliases: ['confidentialtransferfee'],
    label: 'Confidential transfer fee',
    policy: 'INFORMATIONAL',
    rationale:
      'Accounting for fees withheld on confidential transfers. Its authority governs harvesting withheld fees, not holder balances, and Light Protocol classes it as non-restricted.',
    recheckable: false,
    risk: () => true,
  },
  {
    id: 'confidentialmintburn',
    label: 'Confidential mint and burn',
    policy: 'INFORMATIONAL',
    rationale:
      'Supply can be issued and burned against confidential balances, which keeps total supply encrypted. It grants no power over a position held by someone else, but it does mean supply figures for this mint may be incomplete.',
    recheckable: false,
    risk: () => true,
  },
  { id: 'metadatapointer', label: 'Metadata pointer', policy: 'INFORMATIONAL', rationale: 'Points at where metadata lives. No effect on transfers or balances.', recheckable: false, risk: () => true },
  { id: 'tokenmetadata', label: 'Token metadata', policy: 'INFORMATIONAL', rationale: 'On-mint metadata. No effect on transfers or balances.', recheckable: false, risk: () => true },
  { id: 'grouppointer', label: 'Group pointer', policy: 'INFORMATIONAL', rationale: 'Collection membership pointer. No effect on transfers or balances.', recheckable: false, risk: () => true },
  { id: 'groupmemberpointer', label: 'Group member pointer', policy: 'INFORMATIONAL', rationale: 'Collection membership pointer. No effect on transfers or balances.', recheckable: false, risk: () => true },
  { id: 'tokengroup', label: 'Token group', policy: 'INFORMATIONAL', rationale: 'Collection grouping. No effect on transfers or balances.', recheckable: false, risk: () => true },
  { id: 'tokengroupmember', label: 'Token group member', policy: 'INFORMATIONAL', rationale: 'Collection grouping. No effect on transfers or balances.', recheckable: false, risk: () => true },
];

const RULES_BY_ID = new Map<string, ExtensionRule>();
for (const rule of EXTENSION_RULES) {
  RULES_BY_ID.set(rule.id, rule);
  for (const alias of rule.aliases ?? []) RULES_BY_ID.set(alias, rule);
}

/**
 * The marker Agave emits for an extension it could decode the type of but not
 * the body. Its presence means the extension list is not a complete picture.
 */
export const UNPARSEABLE_EXTENSION = 'unparseableextension';

export function ruleFor(extension: string): ExtensionRule | null {
  return RULES_BY_ID.get(extension.toLowerCase()) ?? null;
}
