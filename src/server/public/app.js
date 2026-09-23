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

function rowHtml(token, index) {
  const flag = worstFlag(token);
  const verified = token.jupiter?.isVerified;
  const icon = token.pair?.imageUrl;

  return `
    <tr data-mint="${token.mint}" class="${state.seen.has(token.mint) ? '' : 'flash'}">
      <td class="num muted">${index + 1}</td>
      <td>
        <div class="tok">
          ${icon ? `<img src="${icon}" alt="" loading="lazy" onerror="this.remove()" />` : '<img alt="" />'}
          <div>
            <div class="sym">${token.symbol}${verified ? ' <span class="pill info">ver</span>' : ''}</div>
            <div class="nm">${token.name || ''}</div>
          </div>
        </div>
      </td>
      <td class="num"><span class="score grade-${token.score.grade}">${token.score.total.toFixed(0)}</span></td>
      <td class="num">${fmtUsd(token.priceUsd)}</td>
      <td class="num ${moveClass(token.priceChange.h1)}">${pct(token.priceChange.h1)}</td>
      <td class="num ${moveClass(token.priceChange.h6)}">${pct(token.priceChange.h6)}</td>
      <td class="num ${moveClass(token.priceChange.h24)}">${pct(token.priceChange.h24)}</td>
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
    .map(
      (component) => `
        <div class="bar-row">
          <span>${component.label}</span>
          <div class="bar"><i style="width:${(component.value * 100).toFixed(0)}%"></i></div>
          <span class="num muted">${(component.value * 100).toFixed(0)}</span>
          <span class="detail">${component.detail} · weight ${(component.weight * 100).toFixed(0)}%</span>
        </div>`,
    )
    .join('');

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
      <div class="stat"><span>1h</span><b class="${moveClass(token.priceChange.h1)}">${pct(token.priceChange.h1)}</b></div>
      <div class="stat"><span>Buys 24h</span><b>${token.buyRatio24h === null ? '—' : `${(token.buyRatio24h * 100).toFixed(0)}%`}</b></div>
      <div class="stat"><span>Penalty</span><b>${token.score.penalty.toFixed(0)}%</b></div>
    </div>

    <div class="section-title">Score history</div>
    ${sparkline(history, 'score')}

    <div class="section-title">Price history</div>
    ${sparkline(history, 'priceUsd')}

    <div class="section-title">Score breakdown (base ${token.score.base.toFixed(0)})</div>
    ${components}

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
