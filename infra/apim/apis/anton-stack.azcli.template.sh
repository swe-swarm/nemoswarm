#!/usr/bin/env bash
set -euo pipefail

# Azure CLI template for Anton stack APIM APIs and policies.
#
# This template is intentionally non-secret: it does not accept or print gateway
# tokens or access tokens. It applies Azure control-plane mutations only when
# APPLY_APIM_CHANGES=true is set by the operator.
#
# Required environment:
#   AZURE_SUBSCRIPTION_ID  Azure subscription containing the APIM service
#   APIM_RESOURCE_GROUP    Resource group containing the APIM service
#   ENTRA_TENANT_ID        Entra tenant ID or verified tenant name
#   ENTRA_AUDIENCE         API audience, client ID, or application ID URI
#
# Optional environment:
#   APIM_SERVICE_NAME      Defaults to darbotlabs
#   APIM_GATEWAY_ID        Defaults to anton; recorded for operator context only
#   APPLY_APIM_CHANGES     Defaults to false; set true to execute Azure mutations
#
# Intentionally disabled:
#   LiveKit :7880 WebRTC/media and PersonaPlex/Moshi :8998 websocket routes are
#   not created here. Validate APIM/self-hosted-gateway websocket and media
#   behavior explicitly before exposing those services.

APIM_SERVICE_NAME="${APIM_SERVICE_NAME:-darbotlabs}"
APIM_GATEWAY_ID="${APIM_GATEWAY_ID:-anton}"
APPLY_APIM_CHANGES="${APPLY_APIM_CHANGES:-false}"

AZURE_SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-}"
APIM_RESOURCE_GROUP="${APIM_RESOURCE_GROUP:-}"
ENTRA_TENANT_ID="${ENTRA_TENANT_ID:-}"
ENTRA_AUDIENCE="${ENTRA_AUDIENCE:-}"

require_value() {
  local name="$1"
  local value="$2"

  if [[ -z "$value" || "$value" == "{{"* || "$value" == *"}}" ]]; then
    printf 'ERROR: set %s before running this template.\n' "$name" >&2
    exit 2
  fi
}

require_value "AZURE_SUBSCRIPTION_ID" "$AZURE_SUBSCRIPTION_ID"
require_value "APIM_RESOURCE_GROUP" "$APIM_RESOURCE_GROUP"
require_value "APIM_SERVICE_NAME" "$APIM_SERVICE_NAME"
require_value "ENTRA_TENANT_ID" "$ENTRA_TENANT_ID"
require_value "ENTRA_AUDIENCE" "$ENTRA_AUDIENCE"

if [[ "$APPLY_APIM_CHANGES" != "true" ]]; then
  printf 'Dry run only. Set APPLY_APIM_CHANGES=true to create/update APIM resources.\n' >&2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
POLICY_DIR="$(cd -- "${SCRIPT_DIR}/../policies" && pwd)"

run_step() {
  local description="$1"
  shift

  if [[ "$APPLY_APIM_CHANGES" == "true" ]]; then
    printf 'Applying: %s\n' "$description" >&2
    "$@"
  else
    printf '[dry-run] %s\n' "$description" >&2
  fi
}

render_policy() {
  local policy_file="$1"
  local policy_xml

  policy_xml="$(<"$policy_file")"
  policy_xml="${policy_xml//\{\{ENTRA_TENANT_ID\}\}/$ENTRA_TENANT_ID}"
  policy_xml="${policy_xml//\{\{ENTRA_AUDIENCE\}\}/$ENTRA_AUDIENCE}"
  printf '%s' "$policy_xml"
}

ensure_backend() {
  local backend_id="$1"
  local backend_url="$2"

  if [[ "$APPLY_APIM_CHANGES" != "true" ]]; then
    printf '[dry-run] ensure backend %s -> %s\n' "$backend_id" "$backend_url" >&2
    return
  fi

  if az apim backend show \
      --resource-group "$APIM_RESOURCE_GROUP" \
      --service-name "$APIM_SERVICE_NAME" \
      --backend-id "$backend_id" \
      --only-show-errors \
      -o none 2>/dev/null; then
    az apim backend update \
      --resource-group "$APIM_RESOURCE_GROUP" \
      --service-name "$APIM_SERVICE_NAME" \
      --backend-id "$backend_id" \
      --set "url=$backend_url" "protocol=http" \
      --only-show-errors \
      -o none
  else
    az apim backend create \
      --resource-group "$APIM_RESOURCE_GROUP" \
      --service-name "$APIM_SERVICE_NAME" \
      --backend-id "$backend_id" \
      --protocol http \
      --url "$backend_url" \
      --only-show-errors \
      -o none
  fi
}

ensure_api() {
  local api_id="$1"
  local display_name="$2"
  local api_path="$3"
  local service_url="$4"

  if [[ "$APPLY_APIM_CHANGES" != "true" ]]; then
    printf '[dry-run] ensure API %s at /%s -> %s\n' "$api_id" "$api_path" "$service_url" >&2
    return
  fi

  if az apim api show \
      --resource-group "$APIM_RESOURCE_GROUP" \
      --service-name "$APIM_SERVICE_NAME" \
      --api-id "$api_id" \
      --only-show-errors \
      -o none 2>/dev/null; then
    az apim api update \
      --resource-group "$APIM_RESOURCE_GROUP" \
      --service-name "$APIM_SERVICE_NAME" \
      --api-id "$api_id" \
      --set "displayName=$display_name" "path=$api_path" "serviceUrl=$service_url" "subscriptionRequired=false" "protocols[0]=http" "protocols[1]=https" \
      --only-show-errors \
      -o none
  else
    az apim api create \
      --resource-group "$APIM_RESOURCE_GROUP" \
      --service-name "$APIM_SERVICE_NAME" \
      --api-id "$api_id" \
      --display-name "$display_name" \
      --path "$api_path" \
      --service-url "$service_url" \
      --protocols http https \
      --subscription-required false \
      --only-show-errors \
      -o none
  fi
}

ensure_gateway_api_association() {
  local api_id="$1"
  local url

  if [[ "$APPLY_APIM_CHANGES" != "true" ]]; then
    printf '[dry-run] associate API %s with self-hosted gateway %s\n' "$api_id" "$APIM_GATEWAY_ID" >&2
    return
  fi

  url="https://management.azure.com/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${APIM_RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_SERVICE_NAME}/gateways/${APIM_GATEWAY_ID}/apis/${api_id}?api-version=2024-05-01"
  az rest --method put --url "$url" --body '{}' --only-show-errors -o none
}

ensure_catchall_operations() {
  local api_id="$1"
  local operation_prefix="$2"
  local method
  local method_lc
  local operation_id

  for method in GET POST PUT PATCH DELETE OPTIONS HEAD; do
    method_lc="${method,,}"
    operation_id="${operation_prefix}-${method_lc}-catchall"

    if [[ "$APPLY_APIM_CHANGES" != "true" ]]; then
      printf '[dry-run] ensure %s catch-all operation for %s\n' "$method" "$api_id" >&2
      continue
    fi

    if az apim api operation show \
        --resource-group "$APIM_RESOURCE_GROUP" \
        --service-name "$APIM_SERVICE_NAME" \
        --api-id "$api_id" \
        --operation-id "$operation_id" \
        --only-show-errors \
        -o none 2>/dev/null; then
      az apim api operation update \
        --resource-group "$APIM_RESOURCE_GROUP" \
        --service-name "$APIM_SERVICE_NAME" \
        --api-id "$api_id" \
        --operation-id "$operation_id" \
        --set "displayName=${method} catch-all" "method=$method" "urlTemplate=/*" \
        --only-show-errors \
        -o none
    else
      az apim api operation create \
        --resource-group "$APIM_RESOURCE_GROUP" \
        --service-name "$APIM_SERVICE_NAME" \
        --api-id "$api_id" \
        --operation-id "$operation_id" \
        --display-name "${method} catch-all" \
        --method "$method" \
        --url-template "/*" \
        --only-show-errors \
        -o none
    fi
  done
}

apply_api_policy() {
  local api_id="$1"
  local policy_file="$2"
  local policy_xml

  if [[ "$APPLY_APIM_CHANGES" != "true" ]]; then
    printf '[dry-run] apply policy %s to API %s\n' "$policy_file" "$api_id" >&2
    return
  fi

  policy_xml="$(render_policy "$policy_file")"
  az apim api policy create \
    --resource-group "$APIM_RESOURCE_GROUP" \
    --service-name "$APIM_SERVICE_NAME" \
    --api-id "$api_id" \
    --xml-content "$policy_xml" \
    --only-show-errors \
    -o none
}

run_step "select Azure subscription" \
  az account set --subscription "$AZURE_SUBSCRIPTION_ID" --only-show-errors

# Nemotron/llama-server over APIM.
ensure_backend "anton-nemotron-primary" "http://10.1.0.4:30000"
ensure_api "anton-nemotron" "Anton Nemotron" "anton/nemotron" "http://10.1.0.4:30000"
ensure_gateway_api_association "anton-nemotron"
ensure_catchall_operations "anton-nemotron" "nemotron"
apply_api_policy "anton-nemotron" "${POLICY_DIR}/anton-nemotron-policy.xml"

# Nemo/DarbotLM supported HTTP control/API routes over APIM.
# To use :9443 later, first validate APIM gateway TLS trust/SNI and then update
# both the API service URL and anton-nemo-policy.xml set-backend-service URL.
ensure_backend "anton-nemo-primary" "http://10.1.0.4:9000"
ensure_api "anton-nemo" "Anton Nemo DarbotLM" "anton/nemo" "http://10.1.0.4:9000"
ensure_gateway_api_association "anton-nemo"
ensure_catchall_operations "anton-nemo" "nemo"
apply_api_policy "anton-nemo" "${POLICY_DIR}/anton-nemo-policy.xml"

cat >&2 <<SUMMARY
APIM template complete.
Service: ${APIM_SERVICE_NAME}
Hosted URL: https://${APIM_SERVICE_NAME}.azure-api.net
Self-hosted gateway registration noted: ${APIM_GATEWAY_ID}

Gateway deployment files and gateway tokens are intentionally not managed here.
APIs were associated with self-hosted gateway '${APIM_GATEWAY_ID}' when
APPLY_APIM_CHANGES=true was used.
SUMMARY
