# Nemo / VoiceLive APIM operator notes

Concise runbook for the expected Azure API Management self-hosted gateway on
Anton. Do not place secrets in this repository or print them in terminals.

## Expected APIM shape

- APIM service: `darbotlabs`
- Hosted URL: `https://darbotlabs.azure-api.net`
- Configuration endpoint: `https://darbotlabs.configuration.azure-api.net`
- Developer portal: `https://darbotlabs.developer.azure-api.net/`
- Self-hosted gateway: `/gateways/anton`

Values still required before final deployment or rotation:

- Azure tenant ID
- Azure subscription ID
- APIM resource group
- APIM service name confirmation
- Gateway registration token, or approval to generate one
- Entra client/app ID, or desired app name
- Expected audience / API app ID URI

## Artifact and runtime locations

- Repository APIM artifacts live under `infra/apim/`.
- Protected Anton runtime config must stay off-repo:
  - `/opt/apim-gateway/anton.env`
  - `/etc/systemd/system/nemo-apim-gateway.service`
- Do not inspect or commit local `.env` files. Do not run `docker inspect` in a
  way that prints container `Env`.

Known inventory to verify during handoff:

- Anton: `darbot@10.1.0.4`, Docker available, APIM image present.
- Existing Anton runtime may include `/opt/apim-gateway`,
  `apim-gateway-anton`, `nemo-apim-gateway`, and listeners on `8080/8081`.
- Anton local backends observed: `30000`, `8998`, `7880`, `9000`, `9443`,
  `9100`.
- Peer `10.1.0.5`: expected backends open.
- Peer `10.1.0.6`: `30000`, `8998`, `7880` open; `9000`, `9443` not open.
- `az` is absent locally and on Anton; `gh` is absent on Anton; Docker exists.
- APIM `darbotlabs` and Entra settings are not yet verified.

## Service operations

Systemd on Anton:

```bash
ssh darbot@10.1.0.4 'sudo systemctl status nemo-apim-gateway --no-pager'
ssh darbot@10.1.0.4 'sudo systemctl start nemo-apim-gateway'
ssh darbot@10.1.0.4 'sudo systemctl stop nemo-apim-gateway'
ssh darbot@10.1.0.4 'sudo systemctl restart nemo-apim-gateway'
ssh darbot@10.1.0.4 'sudo journalctl -u nemo-apim-gateway -n 100 --no-pager'
```

Docker on Anton:

```bash
ssh darbot@10.1.0.4 "sudo docker ps --filter name=apim-gateway-anton --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
ssh darbot@10.1.0.4 'sudo docker start apim-gateway-anton'
ssh darbot@10.1.0.4 'sudo docker stop apim-gateway-anton'
ssh darbot@10.1.0.4 "sudo docker logs --tail 100 apim-gateway-anton 2>&1 | grep -Ei 'configuration|connected|updated|gateway|error|warn' | grep -Eiv 'token|authorization|password|secret|key='"
```

## Azure CLI safe setup and checks

Install Azure CLI before running these checks; do not install secrets or cloud
credentials on Anton unless explicitly approved.

```bash
command -v az >/dev/null || printf '%s\n' 'Install Azure CLI first.'
export AZURE_TENANT_ID='<tenant-guid>'
export AZURE_SUBSCRIPTION_ID='<subscription-guid>'
export APIM_RESOURCE_GROUP='<resource-group>'
export APIM_SERVICE_NAME='darbotlabs'
export APIM_GATEWAY_ID='anton'

az login --tenant "$AZURE_TENANT_ID"
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az account show --query '{tenant:tenantId,subscription:id,user:user.name}' -o table
az apim show -g "$APIM_RESOURCE_GROUP" -n "$APIM_SERVICE_NAME" \
  --query '{name:name,gatewayUrl:gatewayUrl,portal:developerPortalUrl}' -o table
az apim gateway show -g "$APIM_RESOURCE_GROUP" -n "$APIM_SERVICE_NAME" \
  --gateway-id "$APIM_GATEWAY_ID" --query '{name:name,description:description}' -o table
```

Gateway token generation pattern that never echoes the token:

```bash
umask 077
EXPIRY="$(date -u -d '+30 days' '+%Y-%m-%dT%H:%M:%SZ')"
TOKEN_FILE="$HOME/.nemo-apim-gateway-token"
az apim gateway generate-token \
  --resource-group "$APIM_RESOURCE_GROUP" \
  --service-name "$APIM_SERVICE_NAME" \
  --gateway-id "$APIM_GATEWAY_ID" \
  --key-type primary \
  --expiry "$EXPIRY" \
  --query value -o tsv > "$TOKEN_FILE"
scp "$TOKEN_FILE" darbot@10.1.0.4:/home/darbot/apim-gateway-token.new
ssh darbot@10.1.0.4 'sudo install -d -m 700 -o root -g root /opt/apim-gateway && sudo install -m 600 -o root -g root /home/darbot/apim-gateway-token.new /opt/apim-gateway/apim-gateway-token.new && rm -f /home/darbot/apim-gateway-token.new'
rm -f "$TOKEN_FILE"
```

After copying, update `/opt/apim-gateway/anton.env` with `sudoedit` or a
root-only automation path, restart `nemo-apim-gateway`, then remove
`/opt/apim-gateway/apim-gateway-token.new`.

## Secret rotation

APIM gateway token:

1. Generate a new short-lived gateway token with the non-echoing pattern above.
2. Update only `/opt/apim-gateway/anton.env` on Anton; preserve mode `600`.
3. Restart with `sudo systemctl restart nemo-apim-gateway`.
4. Verify smoke tests below.
5. Regenerate or revoke the old gateway key in APIM only after the new token is
   confirmed healthy.

Entra app credentials:

1. Create a new credential with `--append`; redirect the secret to a protected
   file or approved secret store, never stdout:

   ```bash
   umask 077
   export ENTRA_CLIENT_ID='<app-client-id>'
   END_DATE="$(date -u -d '+180 days' '+%Y-%m-%dT%H:%M:%SZ')"
   az ad app credential reset --id "$ENTRA_CLIENT_ID" --append \
     --display-name "nemo-apim-$(date -u '+%Y%m%d')" \
     --end-date "$END_DATE" --query password -o tsv \
     > "$HOME/.nemo-entra-client-secret"
   ```

2. Update the approved APIM named value, Key Vault secret, or protected Anton
   config from that file without printing it.
3. Restart or refresh dependent services.
4. Validate authenticated calls.
5. Delete the old credential by key ID after validation:

   ```bash
   az ad app credential delete --id "$ENTRA_CLIENT_ID" --key-id '<old-key-id>'
   rm -f "$HOME/.nemo-entra-client-secret"
   ```

## Smoke tests

Set the route placeholders to deployed APIM paths before running.

```bash
export APIM_LOCAL='http://127.0.0.1:8080'
export NEMO_ROUTE='<published-nemotron-or-nemo-route>'
```

Container running:

```bash
ssh darbot@10.1.0.4 "sudo docker ps --filter name=apim-gateway-anton --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
```

Ports `8080/8081` listening:

```bash
ssh darbot@10.1.0.4 "ss -ltnp '( sport = :8080 or sport = :8081 )'"
```

Configuration fetch / log status without dumping secrets:

```bash
ssh darbot@10.1.0.4 "sudo journalctl -u nemo-apim-gateway --since '15 min ago' --no-pager | grep -Ei 'configuration|connected|updated|gateway|error|warn' | grep -Eiv 'token|authorization|password|secret|key=' | tail -50"
```

Unauthenticated request should be rejected with `401`:

```bash
ssh darbot@10.1.0.4 "curl -sS -o /dev/null -w '%{http_code}\n' '$APIM_LOCAL/$NEMO_ROUTE'"
```

Authenticated request with a Bearer token placeholder should succeed:

```bash
read -r -s TOKEN
{ printf 'header = "Authorization: Bearer '; printf '%s' "$TOKEN"; printf '"\n'; } \
  | ssh darbot@10.1.0.4 "curl -sS -o /dev/null -w '%{http_code}\n' -K - '$APIM_LOCAL/$NEMO_ROUTE'"
unset TOKEN
```

Backend route reaches Nemotron/Nemo without exposing credentials:

```bash
read -r -s TOKEN
{ printf 'header = "Authorization: Bearer '; printf '%s' "$TOKEN"; printf '"\n'; } \
  | ssh darbot@10.1.0.4 "curl -sS -o /dev/null -w 'HTTP %{http_code} in %{time_total}s\n' -K - '$APIM_LOCAL/$NEMO_ROUTE/health'"
unset TOKEN
```

## Protocol limits

- LiveKit WebRTC/media is unsupported through this APIM gateway unless
  separately validated. Do not proxy ICE, RTP/SRTP, TURN, or media streams
  through APIM; use APIM only for validated HTTP control/token routes.
- PersonaPlex/Moshi websocket paths are limited until separately validated.
  Keep them direct or behind a specifically tested APIM websocket API/policy.

## Repo validation reminder

After repository changes, run:

```bash
npm test
```
