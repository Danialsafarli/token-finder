const $ = (id) => document.getElementById(id);

const state = {
  tokens: [],
  seen: new Set(),
  selected: null,
};

const fmtUsd = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs === 0) return '$0';
  return `$${value.toPrecision(3)}`;
};

const fmtAge = (hours) => {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
};

const fmtNum = (value) =>
  value === null || value === undefined ? '—' : value.toLocaleString('en-US');

const pct = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
};

const moveClass = (value) => (value > 0 ? 'up' : value < 0 ? 'down' : 'muted');

const ago = (ts) => {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

function filterParams() {
  const params = new URLSearchParams({
    sort: $('f-sort').value,
    minScore: $('f-minscore').value,
    maxAgeH: $('f-maxage').value,
    minLiquidity: $('f-minliq').value,
    limit: '200',
  });
  const query = $('f-query').value.trim();
  if (query) params.set('q', query);
  if ($('f-hiderisky').checked) params.set('hideRisky', '1');
  return params;
}

/** Worst risk level present on a token, used for the table pill. */
function worstFlag(token) {
  const order = ['critical', 'high', 'medium', 'low'];
  for (const level of order) {
    const hit = token.score.flags.find((flag) => flag.level === level);
    if (hit) return hit;
  }
  return null;
}

/**
 * A score built on partial evidence is marked at the point it is read. Without
 * this the number looks identical to a fully-evidenced one.
 */
function coveragePill(score) {
  const coverage = score?.coverage;
  if (typeof coverage !== 'number' || coverage >= 0.999) return '';
  const level = coverage < 0.6 ? 'medium' : 'low';
  return ` <span class="pill ${level}" title="Only ${Math.round(coverage * 100)}% of scoring evidence was available. Missing evidence earns no points, so this token cannot exceed ${Math.round(score.ceiling)} before penalties. Unknown: ${(score.unknown ?? []).join(', ') || 'none'}">${Math.round(coverage * 100)}%</span>`;
}

/** Null priceChange means no pair ever existed; render '—', never 0.0%. */
const EMPTY_CHANGE = { m5: null, h1: null, h6: null, h24: null };

/**
 * Ranking status. Kept to a single short badge in the table - the evidence
 * behind it belongs in the detail drawer, not in a column people scan.
 */
const STATUS_PILL = {
  QUALIFIED: { cls: 'info', text: 'qualified' },
  WATCH: { cls: 'low', text: 'watch' },
  INSUFFICIENT_DATA: { cls: 'medium', text: 'no data' },
  REJECTED: { cls: 'critical', text: 'rejected' },
};

function statusPill(token) {
  const eligibility = token.evaluation?.eligibility;
  if (!eligibility) return '';
  const pill = STATUS_PILL[eligibility];
  if (!pill) return '';
  const vetoes = token.evaluation?.vetoes ?? [];
  const title = vetoes.length
    ? vetoes.map((v) => `${v.code}: ${v.reason}`).join('\n')
    : `Ranking status: ${eligibility}`;
  return `<span class="pill ${pill.cls}" title="${escapeAttr(title)}">${pill.text}</span>`;
}

const escapeAttr = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function rowHtml(token, index) {
  const flag = worstFlag(token);
  const verified = token.jupiter?.isVerified;
  const icon = token.pair?.imageUrl;
  const change = token.priceChange ?? EMPTY_CHANGE;

  return `
    <tr data-mint="${token.mint}" class="${state.seen.has(token.mint) ? '' : 'flash'}">
      <td class="num muted">${index + 1}</td>
      <td>
        <div class="tok">
          ${icon ? `<img src="${icon}" alt="" loading="lazy" onerror="this.remove()" />` : '<img alt="" />'}
          <div>
            <div class="sym">${token.symbol}${verified ? ' <span class="pill info">ver</span>' : ''}${statusPill(token)}</div>
            <div class="nm">${token.name || ''}</div>
          </div>
        </div>
      </td>
      <td class="num"><span class="score grade-${token.score.grade}">${token.score.total.toFixed(0)}</span>${coveragePill(token.score)}</td>
      <td class="num">${fmtUsd(token.priceUsd)}</td>
      <td class="num ${moveClass(change.h1)}">${pct(change.h1)}</td>
      <td class="num ${moveClass(change.h6)}">${pct(change.h6)}</td>
      <td class="num ${moveClass(change.h24)}">${pct(change.h24)}</td>
      <td class="num">${fmtUsd(token.liquidityUsd)}</td>
      <td class="num">${fmtUsd(token.volume24h)}</td>
      <td class="num">${fmtNum(token.holders)}</td>
      <td class="num">${fmtAge(token.ageHours)}</td>
      <td>${flag ? `<span class="pill ${flag.level}">${flag.code.replace('rugcheck:', '')}</span>` : '<span class="muted">—</span>'}</td>
    </tr>`;
}

function renderTable() {
  const body = $('tokens-body');

  if (state.tokens.length === 0) {
    body.innerHTML = '<tr class="empty"><td colspan="12">Nothing matches these filters yet.</td></tr>';
    $('result-count').textContent = '';
    return;
  }

  body.innerHTML = state.tokens.map(rowHtml).join('');
  for (const token of state.tokens) state.seen.add(token.mint);
  $('result-count').textContent = `${state.tokens.length} tokens`;
}

async function loadTokens() {
  const response = await fetch(`/api/tokens?${filterParams()}`);
  const data = await response.json();
  state.tokens = data.tokens ?? [];
  renderTable();
}

/** Inline sparkline of the stored score/price history. */
function sparkline(points, key) {
  const values = points.map((point) => point[key]).filter((value) => Number.isFinite(value));
  if (values.length < 2) return '<p class="muted">Not enough history yet.</p>';

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = 100 / (values.length - 1);

  const path = values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(2)},${(100 - ((value - min) / span) * 100).toFixed(2)}`)
    .join(' ');

  const rising = values[values.length - 1] >= values[0];

  return `<svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none">
    <path d="${path}" fill="none" stroke="${rising ? 'var(--up)' : 'var(--down)'}" stroke-width="2" vector-effect="non-scaling-stroke" />
  </svg>`;
}

function drawerHtml(token, history) {
  const components = token.score.components
    .map((component) => {
      // An unknown component shows no bar. A 0%-wide bar is indistinguishable
      // from a measured zero, which is exactly the conflation being removed.
      if (component.value === null) {
        return `
        <div class="bar-row">
          <span>${component.label}</span>
          <div class="bar unknown"></div>
          <span class="num muted">?</span>
          <span class="detail">unknown — ${component.unknownReason ?? 'no evidence'} · weight ${(component.weight * 100).toFixed(0)}% · earns 0</span>
        </div>`;
      }
      return `
        <div class="bar-row">
          <span>${component.label}</span>
          <div class="bar"><i style="width:${(component.value * 100).toFixed(0)}%"></i></div>
          <span class="num muted">${(component.value * 100).toFixed(0)}</span>
          <span class="detail">${component.detail} · weight ${(component.weight * 100).toFixed(0)}%</span>
        </div>`;
    })
    .join('');

  const score = token.score;
  // Snapshots stored before evidence coverage existed have no coverage field.
  // They are replaced on the next scan; until then, say so rather than
  // rendering NaN% or throwing on a missing `unknown` array.
  const unknownList = score.unknown ?? [];
  const coverageBlock =
    typeof score.coverage !== 'number'
      ? `
    <div class="section-title">Evidence coverage</div>
    <p class="muted">Not recorded — this snapshot predates evidence tracking. It will be refreshed on the next scan.</p>`
      : `
    <div class="section-title">Evidence coverage</div>
    <p class="muted">
      ${Math.round(score.coverage * 100)}% of scoring weight was backed by real data.
      Missing evidence earns no points, so this token could not have scored above
      <b>${Math.round(score.ceiling)}</b> before penalties.
      ${unknownList.length ? `No data for: <b>${unknownList.join(', ')}</b>.` : 'Every component was measured.'}
    </p>`;

  const evaluation = token.evaluation;
  const vetoBlock =
    !evaluation || evaluation.vetoes.length === 0
      ? ''
      : `
    <div class="section-title">Hard veto — not ranked</div>
    ${evaluation.vetoes
      .map(
        (veto) => `
      <div class="flag">
        <span class="pill critical">${veto.code}</span>
        <span>
          ${veto.reason}
          <br /><span class="muted">source: ${veto.source} · observed: ${escapeAttr(veto.observedValue)} ·
          ${new Date(veto.at).toLocaleString()} ·
          ${veto.recheckable ? 'can clear on fresh evidence' : 'permanent'}</span>
        </span>
      </div>`,
      )
      .join('')}`;

  const evidenceBlock = !evaluation
    ? ''
    : `
    <div class="section-title">Evidence accounting</div>
    <div class="stat-grid">
      <div class="stat"><span>Status</span><b>${evaluation.eligibility}</b></div>
      <div class="stat"><span>State</span><b>${evaluation.state}</b></div>
      <div class="stat"><span>Coverage</span><b>${Math.round(evaluation.coverage.coverage * 100)}%</b></div>
      <div class="stat"><span>Confidence</span><b>${Math.round(evaluation.coverage.confidence * 100)}%</b></div>
      <div class="stat"><span>Measured</span><b>${evaluation.coverage.measured}/${evaluation.coverage.eligibleSignals}</b></div>
      <div class="stat"><span>Unknown</span><b>${evaluation.coverage.unknown}</b></div>
      <div class="stat"><span>Conflicted</span><b>${evaluation.coverage.conflicted}</b></div>
      <div class="stat"><span>Invalid</span><b>${evaluation.coverage.invalid}</b></div>
      <div class="stat"><span>Stale</span><b>${evaluation.coverage.stale}</b></div>
    </div>
    <p class="muted">
      Score, coverage and confidence are separate. Coverage is how much of the score rests on real
      observation; confidence is what those observations are worth after disagreement, age and
      single-provider dependence. Most evidence here came from
      <b>${evaluation.coverage.dominantProvider ?? 'no single provider'}</b>
      (${Math.round(evaluation.coverage.providerConcentration * 100)}% of what is known).
    </p>
    ${
      evaluation.conflicts.length
        ? `<p class="muted">Providers disagreed on: <b>${evaluation.conflicts.join(', ')}</b>. The conservative reading was used.</p>`
        : ''
    }
    ${
      evaluation.issues.length
        ? `<p class="muted">${evaluation.issues.length} provider field(s) rejected at the boundary: ${evaluation.issues
            .slice(0, 5)
            .map((i) => `<code>${i.field}</code> (${i.reason})`)
            .join(', ')}.</p>`
        : ''
    }`;

  const imp = token.impersonation;
  const impersonationBlock = !imp
    ? ''
    : `
    <div class="section-title">Impersonation screening (advisory)</div>
    <p class="muted">
      ${
        imp.status === 'assessed'
          ? `Probability <b>${imp.probability.toFixed(2)}</b> that the naming mimics an established token —
             model <code>${imp.model ?? 'unknown'}</code>, assessed ${new Date(imp.at).toLocaleString()}.
             Compared against ${imp.evidence.referenceMints.length} reference token(s) from list
             <code>${imp.evidence.referenceListId}</code>.
             This is a judgement about naming only: <b>not proof of fraud</b>, and it does not affect the score.`
          : `<b>Not assessed</b> (${imp.reason}). This is not a clean bill of health — the check simply did not run.`
      }
    </p>`;

  const flags = token.score.flags.length
    ? token.score.flags
        .map(
          (flag) => `<div class="flag"><span class="pill ${flag.level}">${flag.level}</span><span>${flag.message}</span></div>`,
        )
        .join('')
    : '<p class="muted">No flags raised.</p>';

  const links = [
    token.pair?.url ? `<a href="${token.pair.url}" target="_blank" rel="noreferrer">DexScreener</a>` : '',
    `<a href="https://jup.ag/swap/SOL-${token.mint}" target="_blank" rel="noreferrer">Jupiter</a>`,
    `<a href="https://rugcheck.xyz/tokens/${token.mint}" target="_blank" rel="noreferrer">RugCheck</a>`,
    `<a href="https://solscan.io/token/${token.mint}" target="_blank" rel="noreferrer">Solscan</a>`,
    ...(token.pair?.websites ?? []).map((url) => `<a href="${url}" target="_blank" rel="noreferrer">Website</a>`),
    ...(token.pair?.socials ?? []).map((social) => `<a href="${social.url}" target="_blank" rel="noreferrer">${social.type}</a>`),
  ]
    .filter(Boolean)
    .join('');

  return `
    <h2>
      <span class="score grade-${token.score.grade}">${token.score.total.toFixed(0)}</span>
      ${token.symbol}
      <button class="close" id="drawer-close" aria-label="Close">×</button>
    </h2>
    <div class="mint" title="Click to copy">${token.mint}</div>

    <div class="stat-grid">
      <div class="stat"><span>Price</span><b>${fmtUsd(token.priceUsd)}</b></div>
      <div class="stat"><span>Liquidity</span><b>${fmtUsd(token.liquidityUsd)}</b></div>
      <div class="stat"><span>Vol 24h</span><b>${fmtUsd(token.volume24h)}</b></div>
      <div class="stat"><span>Market cap</span><b>${fmtUsd(token.marketCap)}</b></div>
      <div class="stat"><span>Holders</span><b>${fmtNum(token.holders)}</b></div>
      <div class="stat"><span>Age</span><b>${fmtAge(token.ageHours)}</b></div>
      <div class="stat"><span>1h</span><b class="${moveClass(token.priceChange?.h1 ?? null)}">${pct(token.priceChange?.h1 ?? null)}</b></div>
      <div class="stat"><span>Buys 24h</span><b>${token.buyRatio24h === null ? '—' : `${(token.buyRatio24h * 100).toFixed(0)}%`}</b></div>
      <div class="stat"><span>Penalty</span><b>${token.score.penalty.toFixed(0)}%</b></div>
    </div>

    <div class="section-title">Score history</div>
    ${sparkline(history, 'score')}

    <div class="section-title">Price history</div>
    ${sparkline(history, 'priceUsd')}

    <div class="section-title">Score breakdown (base ${token.score.base.toFixed(0)})</div>
    ${components}
    ${coverageBlock}
    ${vetoBlock}
    ${evidenceBlock}
    ${impersonationBlock}

    <div class="section-title">Risk flags</div>
    ${flags}

    <div class="section-title">Discovered via</div>
    <div class="pills">${token.sources.map((source) => `<span class="pill low">${source}</span>`).join('')}</div>

    <div class="links">${links}</div>`;
}

async function openDrawer(mint) {
  const response = await fetch(`/api/tokens/${mint}`);
  if (!response.ok) return;
  const { token, history } = await response.json();

  state.selected = mint;
  $('drawer-inner').innerHTML = drawerHtml(token, history);
  $('drawer').hidden = false;

  $('drawer-close').onclick = closeDrawer;
  $('drawer-inner').querySelector('.mint').onclick = (event) => {
    navigator.clipboard?.writeText(mint);
    event.target.textContent = 'copied to clipboard';
    setTimeout(() => (event.target.textContent = mint), 1200);
  };
}

function closeDrawer() {
  state.selected = null;
  $('drawer').hidden = true;
}

function renderEvents(events) {
  $('events').innerHTML = events
    .map(
      (event) => `<li class="${event.level}" data-mint="${event.mint}">
        ${event.message}
        <time>${ago(event.at)}</time>
      </li>`,
    )
    .join('');
}

async function loadEvents() {
  const response = await fetch('/api/events?limit=60');
  const data = await response.json();
  renderEvents(data.events ?? []);
}

function prependEvent(event) {
  const list = $('events');
  const item = document.createElement('li');
  item.className = event.level;
  item.dataset.mint = event.mint;
  item.innerHTML = `${event.message}<time>just now</time>`;
  list.prepend(item);
  while (list.children.length > 60) list.lastElementChild.remove();
}

async function loadStatus() {
  const response = await fetch('/api/status');
  const status = await response.json();

  const dot = $('status-dot');
  dot.className = `dot ${status.scanning ? 'busy' : 'live'}`;

  const keys = [status.sources.helius && 'helius', status.sources.birdeye && 'birdeye']
    .filter(Boolean)
    .join(' + ');

  $('status-text').textContent = [
    status.scanning ? 'scanning…' : `scan #${status.scanCount}`,
    status.lastScanAt ? ago(status.lastScanAt) : 'never',
    `${status.tracked} tracked`,
    keys ? `+${keys}` : 'keyless',
  ].join(' · ');

  $('scan-now').disabled = status.scanning;
}

function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('alert', (message) => {
    prependEvent(JSON.parse(message.data));
  });

  source.addEventListener('scan', () => {
    loadTokens();
    loadStatus();
  });

  source.onerror = () => {
    $('status-dot').className = 'dot';
  };
}

function wireFilters() {
  const rerun = () => {
    loadTokens();
  };

  $('f-sort').onchange = rerun;
  $('f-hiderisky').onchange = rerun;

  let debounce;
  $('f-query').oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(rerun, 220);
  };

  $('f-minscore').oninput = (event) => {
    $('f-minscore-val').textContent = event.target.value;
    clearTimeout(debounce);
    debounce = setTimeout(rerun, 180);
  };

  $('f-maxage').oninput = (event) => {
    $('f-maxage-val').textContent = `${event.target.value}h`;
    clearTimeout(debounce);
    debounce = setTimeout(rerun, 180);
  };

  $('f-minliq').oninput = (event) => {
    $('f-minliq-val').textContent = fmtUsd(Number(event.target.value));
    clearTimeout(debounce);
    debounce = setTimeout(rerun, 180);
  };

  $('scan-now').onclick = async () => {
    $('scan-now').disabled = true;
    await fetch('/api/scan', { method: 'POST' });
    loadStatus();
  };

  $('tokens-body').onclick = (event) => {
    const row = event.target.closest('tr[data-mint]');
    if (row) openDrawer(row.dataset.mint);
  };

  $('events').onclick = (event) => {
    const item = event.target.closest('li[data-mint]');
    if (item) openDrawer(item.dataset.mint);
  };

  $('drawer').onclick = (event) => {
    if (event.target.id === 'drawer') closeDrawer();
  };

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
    if (event.key === '/' && document.activeElement !== $('f-query')) {
      event.preventDefault();
      $('f-query').focus();
    }
  });
}

wireFilters();
connectStream();
loadStatus();
loadEvents();
loadTokens();

setInterval(loadStatus, 15_000);
setInterval(loadTokens, 60_000);
