/**
 * The hand-off to Solana Risk Radar: the mint travels in the URL, validated,
 * and nothing unsafe is ever linked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskRadarLink } from '../src/server/risk-radar.ts';

test('Risk Radar receives the selected mint, and only a valid mint on an https base', () => {
  const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const link = riskRadarLink(mint, 'https://solana-risk-radar.vercel.app');
  assert.ok(link);
  const url = new URL(link.url);
  assert.equal(url.origin, 'https://solana-risk-radar.vercel.app');
  assert.equal(url.searchParams.get('address'), mint, 'the mint is carried automatically');
  assert.equal(url.searchParams.get('from'), 'token-finder');
  assert.equal(link.mint, mint);

  // A base with a path and a stale query keeps its path and loses the query.
  assert.equal(riskRadarLink(mint, 'https://radar.example/app?x=1#y')!.url, `https://radar.example/app/?address=${mint}&from=token-finder`);

  assert.equal(riskRadarLink('not-a-mint', 'https://radar.example'), null);
  assert.equal(riskRadarLink(`${mint}"><script>`, 'https://radar.example'), null);
  assert.equal(riskRadarLink(mint, 'http://radar.example'), null, 'https only');
  assert.equal(riskRadarLink(mint, 'javascript:alert(1)'), null);
  assert.equal(riskRadarLink(mint, null), null, 'not configured: no link');
});
