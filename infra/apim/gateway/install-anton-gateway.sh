#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

APIM_DIR="/opt/apim-gateway"
ENV_FILE="${APIM_DIR}/anton.env"
COMPOSE_DEST="${APIM_DIR}/docker-compose.apim-gateway.yml"
SERVICE_NAME="nemo-apim-gateway.service"
SERVICE_DEST="/etc/systemd/system/${SERVICE_NAME}"
CONTAINER_NAME="apim-gateway-anton"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SERVICE_SRC="${SCRIPT_DIR}/${SERVICE_NAME}"
COMPOSE_SRC="${SCRIPT_DIR}/docker-compose.apim-gateway.yml"

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

validate_env_file() {
  [[ -f "${ENV_FILE}" ]] || die "Missing ${ENV_FILE}. Create it from apim-gateway.env.example on Anton and add the gateway registration token there only."

  local mode owner_uid owner_user deploy_user deploy_uid current_uid
  mode="$(stat -c '%a' "${ENV_FILE}")"
  owner_uid="$(stat -c '%u' "${ENV_FILE}")"
  owner_user="$(stat -c '%U' "${ENV_FILE}")"
  deploy_user="${SUDO_USER:-$(id -un)}"
  deploy_uid="$(id -u "${deploy_user}" 2>/dev/null || true)"
  current_uid="$(id -u)"

  [[ "${mode}" == "600" ]] || die "${ENV_FILE} must be chmod 600; current mode is ${mode}."

  if [[ "${owner_uid}" != "0" && "${owner_uid}" != "${current_uid}" ]]; then
    if [[ -z "${deploy_uid}" || "${owner_uid}" != "${deploy_uid}" ]]; then
      die "${ENV_FILE} owner must be root or deploy user ${deploy_user}; current owner is ${owner_user}."
    fi
  fi
}

backup_if_exists() {
  local target="$1"
  [[ -e "${target}" ]] || return 0

  local stamp backup suffix
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="${target}.bak.${stamp}"
  suffix=0
  while [[ -e "${backup}" ]]; do
    suffix=$((suffix + 1))
    backup="${target}.bak.${stamp}.${suffix}"
  done

  "${SUDO[@]}" cp -a -- "${target}" "${backup}"
  info "Backed up ${target} to ${backup}"
}

main() {
  require_command stat
  require_command docker
  require_command systemctl

  if [[ "${EUID}" -ne 0 ]]; then
    require_command sudo
  fi

  [[ -f "${SERVICE_SRC}" ]] || die "Missing ${SERVICE_SRC}; run this script from the repo artifact directory."
  [[ -f "${COMPOSE_SRC}" ]] || die "Missing ${COMPOSE_SRC}; run this script from the repo artifact directory."

  validate_env_file

  "${SUDO[@]}" install -d -m 0750 "${APIM_DIR}"

  backup_if_exists "${SERVICE_DEST}"
  backup_if_exists "${COMPOSE_DEST}"

  "${SUDO[@]}" install -m 0644 -o root -g root "${SERVICE_SRC}" "${SERVICE_DEST}"
  "${SUDO[@]}" install -m 0644 -o root -g root "${COMPOSE_SRC}" "${COMPOSE_DEST}"

  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl enable "${SERVICE_NAME}"

  info "Starting ${SERVICE_NAME} without printing ${ENV_FILE}."
  if ! "${SUDO[@]}" systemctl restart "${SERVICE_NAME}"; then
    info "Service failed to start; status follows without printing the env file."
    "${SUDO[@]}" systemctl --no-pager --full status "${SERVICE_NAME}" || true
    exit 1
  fi

  info "Service status:"
  "${SUDO[@]}" systemctl --no-pager --full status "${SERVICE_NAME}" || true

  info "Container status:"
  "${SUDO[@]}" docker ps --filter "name=^/${CONTAINER_NAME}$" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true
}

main "$@"
