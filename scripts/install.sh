#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/TBLgGamin/ordo.git"
MIN_BUN="1.3.14"
CLI_REL="apps/cli"
INSTALL_DIR="${ORDO_INSTALL_DIR:-$HOME/.ordo}"
SKIP_MODEL=0
UPDATE=0

for arg in "$@"; do
	case "$arg" in
		--skip-model) SKIP_MODEL=1 ;;
		--update) UPDATE=1 ;;
		--install-dir=*) INSTALL_DIR="${arg#*=}" ;;
	esac
done

P=$'\033[38;2;214;201;249m'
PB=$'\033[1;38;2;214;201;249m'
R=$'\033[0m'
step() { printf '%s==>%s %s%s%s\n' "$PB" "$R" "$P" "$1" "$R"; }
info() { printf '%s    %s%s\n' "$P" "$1" "$R"; }
fatal() { printf '%s!!%s %s%s%s\n' "$PB" "$R" "$P" "$1" "$R"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

assert_os() {
	case "$(uname -s)" in
		Darwin|Linux) ;;
		*) fatal "install.sh supports macOS and Linux. On Windows use scripts/install.ps1." ;;
	esac
}

version_ge() {
	# version_ge A B  → true if A >= B
	[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

ensure_path() {
	if [ -d "$HOME/.bun/bin" ]; then
		case ":$PATH:" in *":$HOME/.bun/bin:"*) ;; *) PATH="$HOME/.bun/bin:$PATH"; export PATH ;; esac
	fi
}

ensure_bun() {
	ensure_path
	if ! have bun; then
		step "Installing Bun"
		curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || fatal "Bun install failed."
		ensure_path
		have bun || fatal "Bun was installed but is not on PATH. Open a new shell and re-run."
	fi
	local ver
	ver="$(bun --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
	if [ -z "$ver" ]; then fatal "Could not read the Bun version."; fi
	if ! version_ge "$ver" "$MIN_BUN"; then
		step "Upgrading Bun $ver to $MIN_BUN or newer"
		bun upgrade >/dev/null 2>&1 || true
		ver="$(bun --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
		version_ge "$ver" "$MIN_BUN" || fatal "ordo needs Bun $MIN_BUN+ for Bun.Terminal (PTY). Found $ver."
	fi
	info "Bun $ver"
}

resolve_repo() {
	if [ -f "$INSTALL_DIR/$CLI_REL/package.json" ]; then
		step "Using existing ordo install at $INSTALL_DIR"
		if [ "$UPDATE" = "1" ]; then git -C "$INSTALL_DIR" pull --ff-only >/dev/null 2>&1 || info "git pull failed; continuing."; fi
		return
	fi
	have git || fatal "git is required to clone ordo."
	step "Installing ordo into $INSTALL_DIR"
	git clone "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1 || fatal "Could not download ordo."
}

check_runtime_deps() {
	case "$(uname -s)" in
		Darwin)
			info "Terminal.app is always available; iTerm2/kitty/WezTerm/Alacritty are auto-detected if installed."
			info "Non-scriptable terminals (kitty/WezTerm/…) need Accessibility permission to be tiled." ;;
		Linux)
			local found=""
			for t in kitty wezterm alacritty ghostty gnome-terminal konsole xterm; do
				if have "$t"; then found="$t"; break; fi
			done
			if [ -n "$found" ]; then info "Terminal emulator found: $found"; else info "No known terminal emulator found — install one (e.g. kitty, gnome-terminal) or set ORDO_TERMINAL."; fi
			if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
				info "Wayland session detected: ordo cannot tile windows (no X11). Panes open untiled. Under XWayland (DISPLAY set) tiling works."
			fi ;;
	esac
}

install_deps() {
	step "Installing dependencies"
	( cd "$INSTALL_DIR" && bun install >/dev/null 2>&1 ) || fatal "bun install failed."
	info "Dependencies installed"
}

register_command() {
	step "Registering the ordo command"
	( cd "$INSTALL_DIR/$CLI_REL" && bun link >/dev/null 2>&1 ) || fatal "bun link failed."
	ensure_path
	if have ordo; then info "ordo registered on PATH"; else info "ordo linked, but $HOME/.bun/bin is not on your PATH. Add it and reopen your shell."; fi
}

install_completion() {
	local shell_name rc comp
	shell_name="$(basename "${SHELL:-}")"
	case "$shell_name" in
		zsh) rc="$HOME/.zshrc"; comp="zsh" ;;
		bash) rc="$HOME/.bashrc"; comp="bash" ;;
		*) info "Unknown login shell '$shell_name' — skipping completion. Run: ordo completion bash|zsh"; return ;;
	esac
	step "Registering $comp tab-completion"
	local marker="# >>> ordo completion >>>"
	if [ -f "$rc" ] && grep -qF "$marker" "$rc"; then info "Completion already in $rc"; return; fi
	{
		printf '\n%s\n' "$marker"
		printf 'command -v ordo >/dev/null 2>&1 && eval "$(ordo completion %s)"\n' "$comp"
		printf '# <<< ordo completion <<<\n'
	} >> "$rc"
	info "Completion added to $rc (open a new shell to use tab-complete)"
}

install_model() {
	if [ "$SKIP_MODEL" = "1" ] || [ "${ORDO_TITLE:-}" = "0" ]; then step "Skipping title-model download"; return; fi
	step "Downloading the title model (~230 MB, one-time)"
	( cd "$INSTALL_DIR/$CLI_REL" && bun scripts/setup-model.ts >/dev/null 2>&1 ) && info "Title model ready" || info "Model download failed; ordo retries on first run (titling is best-effort)."
}

summary() {
	printf '\n%s ordo is set up.%s\n' "$PB" "$R"
	printf '%s   app:   %s%s\n' "$P" "$INSTALL_DIR" "$R"
	printf '%s   run:   ordo%s\n' "$P" "$R"
	printf '%s          ordo sessions      (list saved sessions)%s\n' "$P" "$R"
	printf '%s          ordo new           (start a fresh session)%s\n' "$P" "$R"
}

assert_os
resolve_repo
ensure_bun
check_runtime_deps
install_deps
register_command
install_completion
install_model
summary
