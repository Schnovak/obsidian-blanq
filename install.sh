#!/usr/bin/env bash
# ───────────────────────────────────────────────────────
#  Blanq Worksheet — Obsidian Plugin Installer
# ───────────────────────────────────────────────────────
set -euo pipefail

PLUGIN_ID="blanq-worksheet"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Colors ──
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# ── Helpers ──
info()  { echo -e "  ${CYAN}▸${NC} $1"; }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; }
err()   { echo -e "  ${RED}✗${NC} $1"; }
step()  { echo -e "\n${BOLD}${MAGENTA}[$1]${NC} ${BOLD}$2${NC}"; }

header() {
  echo ""
  echo -e "${BOLD}${CYAN}  ┌──────────────────────────────────────┐${NC}"
  echo -e "${BOLD}${CYAN}  │      Blanq Worksheet Installer       │${NC}"
  echo -e "${BOLD}${CYAN}  │   Offline PDF blank detection for     │${NC}"
  echo -e "${BOLD}${CYAN}  │          Obsidian                     │${NC}"
  echo -e "${BOLD}${CYAN}  └──────────────────────────────────────┘${NC}"
  echo ""
}

# ── Find Obsidian config ──
find_obsidian_config() {
  local configs=()

  # Windows (via WSL)
  for userdir in /mnt/c/Users/*/; do
    local wincfg="${userdir}AppData/Roaming/obsidian/obsidian.json"
    [ -f "$wincfg" ] && configs+=("$wincfg")
  done

  # Linux
  local linuxcfg="$HOME/.config/obsidian/obsidian.json"
  [ -f "$linuxcfg" ] && configs+=("$linuxcfg")

  # macOS
  local maccfg="$HOME/Library/Application Support/obsidian/obsidian.json"
  [ -f "$maccfg" ] && configs+=("$maccfg")

  # Flatpak (Linux)
  local flatcfg="$HOME/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json"
  [ -f "$flatcfg" ] && configs+=("$flatcfg")

  printf '%s\n' "${configs[@]}"
}

# ── Extract vaults from obsidian.json ──
extract_vaults() {
  local config_file="$1"
  # Parse JSON with python if available, else try jq, else basic grep
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, sys, os
with open('$config_file') as f:
    data = json.load(f)
vaults = data.get('vaults', {})
for vid, vinfo in vaults.items():
    path = vinfo.get('path', '')
    if path and os.path.isdir(path):
        print(path)
" 2>/dev/null
  elif command -v jq &>/dev/null; then
    jq -r '.vaults | to_entries[] | .value.path' "$config_file" 2>/dev/null | while read -r p; do
      [ -d "$p" ] && echo "$p"
    done
  else
    grep -oP '"path"\s*:\s*"\K[^"]+' "$config_file" 2>/dev/null | while read -r p; do
      [ -d "$p" ] && echo "$p"
    done
  fi
}

# ── Check prerequisites ──
check_prereqs() {
  step "1/4" "Checking prerequisites"

  local missing=0

  if command -v node &>/dev/null; then
    ok "Node.js $(node --version)"
  else
    err "Node.js not found — install from https://nodejs.org"
    missing=1
  fi

  if command -v npm &>/dev/null; then
    ok "npm $(npm --version)"
  else
    err "npm not found"
    missing=1
  fi

  # Check for the model file
  local model_file="$SCRIPT_DIR/FFDNet-S.onnx"
  local parent_model="$SCRIPT_DIR/../FFDNet-S.onnx"

  if [ -f "$model_file" ]; then
    ok "Model found: FFDNet-S.onnx ($(du -h "$model_file" | cut -f1))"
    MODEL_PATH="$model_file"
  elif [ -f "$parent_model" ]; then
    ok "Model found: ../FFDNet-S.onnx ($(du -h "$parent_model" | cut -f1))"
    MODEL_PATH="$parent_model"
  else
    err "FFDNet-S.onnx not found in plugin directory or parent directory"
    echo ""
    warn "Place the model file next to this installer or in the parent directory."
    missing=1
  fi

  if [ $missing -ne 0 ]; then
    echo ""
    err "Missing prerequisites. Fix the above issues and try again."
    exit 1
  fi
}

# ── Build plugin ──
build_plugin() {
  step "2/4" "Building plugin"

  cd "$SCRIPT_DIR"

  if [ ! -d "node_modules" ]; then
    info "Installing dependencies..."
    npm install --silent 2>&1 | tail -1
    ok "Dependencies installed"
  else
    ok "Dependencies already installed"
  fi

  info "Building..."
  npm run build --silent 2>&1
  ok "Plugin built successfully"

  # Verify output
  if [ ! -f "$SCRIPT_DIR/main.js" ]; then
    err "Build failed — main.js not found"
    exit 1
  fi

  ok "main.js ($(du -h "$SCRIPT_DIR/main.js" | cut -f1))"
}

# ── Discover & select vaults ──
select_vaults() {
  step "3/4" "Finding Obsidian vaults"

  local all_vaults=()

  while IFS= read -r cfg; do
    [ -z "$cfg" ] && continue
    info "Found config: ${DIM}$cfg${NC}"
    while IFS= read -r vault; do
      [ -z "$vault" ] && continue
      all_vaults+=("$vault")
    done < <(extract_vaults "$cfg")
  done < <(find_obsidian_config)

  # Also scan common locations for .obsidian folders
  local search_dirs=("$HOME/Documents" "$HOME/Desktop" "$HOME")
  for userdir in /mnt/c/Users/*/; do
    [ -d "${userdir}Documents" ] && search_dirs+=("${userdir}Documents")
    [ -d "${userdir}Desktop" ] && search_dirs+=("${userdir}Desktop")
    [ -d "${userdir}OneDrive" ] && search_dirs+=("${userdir}OneDrive")
  done

  for sdir in "${search_dirs[@]}"; do
    [ -d "$sdir" ] || continue
    while IFS= read -r obsdir; do
      local vdir="$(dirname "$obsdir")"
      # Deduplicate
      local dup=0
      for existing in "${all_vaults[@]}"; do
        [ "$existing" = "$vdir" ] && dup=1 && break
      done
      [ $dup -eq 0 ] && all_vaults+=("$vdir")
    done < <(find "$sdir" -maxdepth 4 -name ".obsidian" -type d 2>/dev/null)
  done

  if [ ${#all_vaults[@]} -eq 0 ]; then
    warn "No Obsidian vaults found automatically."
    echo ""
    echo -e "  Enter the path to your vault manually:"
    read -rp "  > " manual_path
    manual_path="${manual_path%/}"
    if [ -d "$manual_path" ]; then
      all_vaults+=("$manual_path")
    else
      err "Directory not found: $manual_path"
      exit 1
    fi
  fi

  # Display vaults
  echo ""
  echo -e "  ${BOLD}Found ${#all_vaults[@]} vault(s):${NC}"
  echo ""
  for i in "${!all_vaults[@]}"; do
    local vname="$(basename "${all_vaults[$i]}")"
    local vpath="${all_vaults[$i]}"
    # Check if plugin already installed
    local status=""
    if [ -d "$vpath/.obsidian/plugins/$PLUGIN_ID" ]; then
      status=" ${DIM}(already installed — will update)${NC}"
    fi
    echo -e "    ${BOLD}$((i+1))${NC}) ${GREEN}$vname${NC}${status}"
    echo -e "       ${DIM}$vpath${NC}"
  done

  echo ""
  echo -e "  ${BOLD}Select vaults to install to:${NC}"
  echo -e "  ${DIM}Enter numbers separated by spaces, 'a' for all, or 'q' to quit${NC}"
  read -rp "  > " selection

  if [ "$selection" = "q" ]; then
    info "Cancelled."
    exit 0
  fi

  SELECTED_VAULTS=()

  if [ "$selection" = "a" ] || [ "$selection" = "A" ]; then
    SELECTED_VAULTS=("${all_vaults[@]}")
  else
    for num in $selection; do
      local idx=$((num - 1))
      if [ $idx -ge 0 ] && [ $idx -lt ${#all_vaults[@]} ]; then
        SELECTED_VAULTS+=("${all_vaults[$idx]}")
      else
        warn "Skipping invalid selection: $num"
      fi
    done
  fi

  if [ ${#SELECTED_VAULTS[@]} -eq 0 ]; then
    err "No vaults selected."
    exit 1
  fi

  ok "Selected ${#SELECTED_VAULTS[@]} vault(s)"
}

# ── Install to vaults ──
install_to_vaults() {
  step "4/4" "Installing plugin"

  local files_to_copy=(
    "main.js"
    "manifest.json"
  )

  # Collect WASM/mjs files
  for f in "$SCRIPT_DIR"/*.wasm "$SCRIPT_DIR"/*.mjs; do
    [ -f "$f" ] && files_to_copy+=("$(basename "$f")")
  done

  for vault in "${SELECTED_VAULTS[@]}"; do
    local vname="$(basename "$vault")"
    local dest="$vault/.obsidian/plugins/$PLUGIN_ID"

    info "Installing to ${BOLD}$vname${NC}..."

    mkdir -p "$dest"

    # Copy plugin files
    for f in "${files_to_copy[@]}"; do
      local src="$SCRIPT_DIR/$f"
      if [ -f "$src" ]; then
        cp "$src" "$dest/"
      fi
    done

    # Copy model
    cp "$MODEL_PATH" "$dest/FFDNet-S.onnx"

    local total_size="$(du -sh "$dest" | cut -f1)"
    ok "Installed to $vname ($total_size)"
  done
}

# ── Next steps ──
show_next_steps() {
  echo ""
  echo -e "${BOLD}${CYAN}  ┌──────────────────────────────────────┐${NC}"
  echo -e "${BOLD}${CYAN}  │          Installation Complete        │${NC}"
  echo -e "${BOLD}${CYAN}  └──────────────────────────────────────┘${NC}"
  echo ""
  echo -e "  ${BOLD}Next steps:${NC}"
  echo ""
  echo -e "    ${BOLD}1.${NC} Open Obsidian"
  echo -e "    ${BOLD}2.${NC} Go to ${CYAN}Settings → Community Plugins${NC}"
  echo -e "    ${BOLD}3.${NC} Make sure ${CYAN}Restricted mode${NC} is ${YELLOW}turned off${NC}"
  echo -e "    ${BOLD}4.${NC} Find ${GREEN}Blanq Worksheet${NC} in the installed plugins list"
  echo -e "    ${BOLD}5.${NC} Click the ${CYAN}toggle${NC} to enable it"
  echo ""
  echo -e "  ${BOLD}Usage:${NC}"
  echo ""
  echo -e "    ${GREEN}•${NC} Click any PDF in your vault → opens in Blanq automatically"
  echo -e "    ${GREEN}•${NC} Right-click a PDF → ${CYAN}Open in Blanq${NC}"
  echo -e "    ${GREEN}•${NC} Command palette → ${CYAN}Open Blanq Worksheet${NC}"
  echo -e "    ${GREEN}•${NC} Click detected blanks to type answers"
  echo -e "    ${GREEN}•${NC} Click ${CYAN}Save${NC} to write answers into the PDF"
  echo ""
  echo -e "  ${BOLD}Optional — AI Fill:${NC}"
  echo ""
  echo -e "    ${GREEN}•${NC} Go to ${CYAN}Settings → Blanq Worksheet${NC}"
  echo -e "    ${GREEN}•${NC} Add your Anthropic or OpenAI API key"
  echo -e "    ${GREEN}•${NC} Click ${CYAN}AI Fill${NC} to auto-fill worksheet answers"
  echo ""
  echo -e "  ${DIM}Blank detection works fully offline — no internet needed.${NC}"
  echo -e "  ${DIM}AI Fill is optional and requires an API key + internet.${NC}"
  echo ""
}

# ── Main ──
main() {
  header
  check_prereqs
  build_plugin
  select_vaults
  install_to_vaults
  show_next_steps
}

main "$@"
