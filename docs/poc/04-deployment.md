# 04 — Deployment (Oracle Cloud, HTTPS)

**Deadline:** working by the **end of week 2**. Remote tests need it, so don't leave it for week 4.

## Target setup

```
browser ──https/wss──► Caddy :443 ──┬─ /api/*, /ws/* ──► Spring Boot 127.0.0.1:8080
                       (auto TLS)   └─ everything else ─► client/dist (static, SPA fallback)
```

One VM, one domain, same origin for the page, API and WebSocket (no CORS issues).

## Steps

1. **VM:** OCI Always Free instance (Ampere A1 or AMD micro), Ubuntu LTS.
2. **Firewall, two places:**
   - VCN security list: allow TCP 80 and 443 inbound.
   - The VM itself: Oracle's Ubuntu images ship with **iptables rules that block everything except SSH**. Add rules for 80/443 and persist them (`netfilter-persistent save`). This is the most common "it doesn't work" cause on OCI.
3. **Domain:** HTTPS needs a hostname. A free option is a DuckDNS subdomain pointing at the VM's public IP, or any domain a team member owns.
4. **Java:** install JDK 21+; run the server jar as a **systemd service** with `server.address=127.0.0.1` (only Caddy is exposed) and `app.ws.allowed-origins=https://<domain>`.
5. **Caddy** (gets and renews Let's Encrypt certificates automatically; proxies WebSockets without extra config):
   ```
   <domain> {
       header {
           X-Content-Type-Options nosniff
           Referrer-Policy no-referrer
           Content-Security-Policy "frame-ancestors 'none'"
           -Server
       }
       handle /api/* {
           reverse_proxy 127.0.0.1:8080
       }
       handle /ws/* {
           reverse_proxy 127.0.0.1:8080
       }
       handle {
           root * /srv/listening/client
           try_files {path} /index.html
           file_server
       }
   }
   ```
6. **Deploy script** (`deploy.sh` in the repo, committed): build `server` (`./mvnw -q package -DskipTests`) and `client` (`npm run build`), copy the jar + `dist/` with `scp`/`rsync`, restart the service. GitLab CI is optional for later.
7. **Logs:** the server's `logs/` directory lives on the VM. Document where it is, so the event logs can be downloaded for evaluation.

## VM hardening (do this before the first deploy)
- **Only ports 22, 80, 443** open, in both the VCN security list and the VM's iptables.
- **SSH with keys only:** `PasswordAuthentication no` and `PermitRootLogin no` in `sshd_config`.
- **Automatic security updates:** `unattended-upgrades`.
- Run the server as a dedicated unprivileged user (`listening`), not root; only Caddy binds ports 80/443.
- Caddy replaces any client-sent `X-Forwarded-For` with the real client IP (it trusts no proxies by default). The server relies on this for its per-IP rate limits (`server.forward-headers-strategy=native`). Don't add a CDN or second proxy in front without configuring `trusted_proxies`.

## Abuse limits (server defaults, `app.*` in `application.properties`)
| Limit | Default |
|---|---|
| Rooms created per client IP | 10 per 10 min |
| Uploads per client IP | 60 per 10 min |
| Rooms on the server | 500 |
| Members per room | 20 |
| Tracks per room | 30 |
| Total storage | 3 GB |
| Idle room deleted after | 10 min without members |
| WebSocket messages per connection | bursts of 100, 20/s sustained |
| Time to send `hello` | 10 s |

Size the storage limit to the VM's free disk space (leave room for logs and the OS).

## Notes
- Clock sync uses only the server's monotonic clock, so the VM's wall-clock time doesn't matter. Still, keep `systemd-timesyncd` on for readable log timestamps.
- Note the VM's region in the report: RTT to it affects the results.
- Don't run anything else heavy on the VM during measurements (CPU load delays `pong` handling).

## Verification

| # | Check | Pass |
|---|---|---|
| D1 | `https://<domain>` loads the client, valid certificate | ☐ |
| D2 | Room link `https://<domain>/r/<id>` loads directly (SPA fallback) | ☐ |
| D3 | DevTools → Network → WS: connection to `wss://<domain>/ws/rooms/<id>` is open, `ping`/`pong` frames visible | ☐ |
| D4 | 45 MB upload succeeds through Caddy | ☐ |
| D5 | Port 8080 is **not** reachable from outside (`curl http://<ip>:8080` fails) | ☐ |
| D6 | Sync panel RTT from a phone on mobile data is plausible (typically 20–100 ms) | ☐ |
| D7 | Server restart (`systemctl restart`) → app works again without manual steps | ☐ |
| D8 | Per-IP limits use the real client IP: phone on mobile data and laptop on Wi-Fi don't share a limit (11 room creations from the laptop → 429, phone still works) | ☐ |
| D9 | SSH with a password is refused; `ss -tlnp` shows only 22, 80, 443 on public interfaces | ☐ |
| D10 | `curl -I https://<domain>` shows the security headers | ☐ |
