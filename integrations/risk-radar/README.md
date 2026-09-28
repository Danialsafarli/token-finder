# Solana Risk Radar integration

Token Finder and [Solana Risk Radar](https://solana-risk-radar.vercel.app) are
separate products and stay that way:

| | Token Finder | Solana Risk Radar |
|---|---|---|
| Question | Which new tokens matter now, and can they be trusted enough to watch? | How risky is this one token, analysed deeply and deterministically? |
| Output | A verdict (integrity, opportunity, momentum, rank) | Its own risk score and report |

Neither score is folded into the other, and Token Finder never embeds or calls
Risk Radar.

## The hand-off

A Token Finder Dossier shows **Deep Risk Analysis**, which opens Risk Radar in
a new tab at

```
https://solana-risk-radar.vercel.app/?address=<mint>&from=token-finder
```

(`RISK_RADAR_URL` changes the base; https only; the mint is validated first,
see `src/server/risk-radar.ts`). The click also copies the mint to the
clipboard.

## The Risk Radar side (not yet applied)

Risk Radar's page does not read `?address=` yet, so today the link opens Risk
Radar and the visitor pastes the mint that was just copied.
`0001-Analyse-a-mint-handed-over-in-the-URL-address.patch` makes it analyse the
handed-over mint on arrival, after the same validation its form applies. It is
one file, sixteen lines, made against Risk Radar `main` at `3fdd5ad`.

It lives here rather than in Risk Radar because changing and redeploying a
separate, live product needs its owner's go-ahead. To apply:

```bash
cd solana-risk-radar
git switch -c feat/accept-address-param
git am /path/to/token-finder/integrations/risk-radar/0001-*.patch
npm run lint && npm test
git push -u origin feat/accept-address-param   # then merge; Vercel redeploys
```
