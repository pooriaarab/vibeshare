# Tunnel providers

`vibeshare --tunnel` uses the stock registry from `@pooriaarab/vibe-core` 0.7.0.
`DEFAULT_PROVIDER_ORDER` has 12 names:

getvibe, cloudflared, tailscale, ngrok, localtunnel, tunnelmole, bore, zrok, frp, localhost_run, serveo, pinggy

`getvibe` is always detectable. It is a placeholder URL shape, not a production relay. Pass `--tunnel <name>` or rely on detect-cascade for the others. Each provider only forwards ciphertext.
