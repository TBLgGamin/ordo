#!/usr/bin/env bash
set -uo pipefail

INSTALL_DIR="${ORDO_INSTALL_DIR:-$HOME/.ordo}"
KEEP_DATA=0
for arg in "$@"; do
	case "$arg" in
		--keep-data) KEEP_DATA=1 ;;
		--install-dir=*) INSTALL_DIR="${arg#*=}" ;;
	esac
done

if [ "$(uname -s)" = "Darwin" ]; then
	DATA_DIR="$HOME/Library/Application Support/ordo"
else
	DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ordo"
fi

P=$'\033[38;2;214;201;249m'
PB=$'\033[1;38;2;214;201;249m'
R=$'\033[0m'
step() { printf '%s==>%s %s%s%s\n' "$PB" "$R" "$P" "$1" "$R"; }
info() { printf '%s    %s%s\n' "$P" "$1" "$R"; }
have() { command -v "$1" >/dev/null 2>&1; }

stop_daemon() {
	local info_file="$DATA_DIR/daemon.json"
	[ -f "$info_file" ] || return 0
	step "Stopping the session daemon"
	local pid
	pid="$(grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$info_file" | grep -oE '[0-9]+' | head -n1)"
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
		kill "$pid" 2>/dev/null && info "stopped daemon (pid $pid)"
	else
		info "no running daemon found"
	fi
}

unregister_command() {
	step "Removing the ordo command"
	if have bun && [ -f "$INSTALL_DIR/apps/cli/package.json" ]; then
		( cd "$INSTALL_DIR/apps/cli" && bun unlink >/dev/null 2>&1 ) && info "unlinked the ordo command"
	fi
	rm -f "$HOME/.bun/bin/ordo" 2>/dev/null || true
}

remove_completion() {
	step "Removing tab-completion"
	local removed=0
	for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
		[ -f "$rc" ] || continue
		if grep -qF "# >>> ordo completion >>>" "$rc"; then
			# Delete the block between the markers (inclusive).
			sed -i.ordobak '/# >>> ordo completion >>>/,/# <<< ordo completion <<</d' "$rc" 2>/dev/null \
				|| sed -i '' '/# >>> ordo completion >>>/,/# <<< ordo completion <<</d' "$rc" 2>/dev/null || true
			rm -f "$rc.ordobak" 2>/dev/null || true
			info "removed completion from $rc"
			removed=1
		fi
	done
	[ "$removed" = "0" ] && info "no ordo completion block found"
}

remove_app() {
	step "Removing ordo application files"
	if [ -d "$INSTALL_DIR" ]; then rm -rf "$INSTALL_DIR" && info "removed $INSTALL_DIR"; else info "no application directory to remove"; fi
}

remove_data() {
	if [ "$KEEP_DATA" = "1" ]; then step "Keeping saved sessions + title model (--keep-data)"; return; fi
	step "Removing saved sessions, scrollback, and the title model"
	if [ -d "$DATA_DIR" ]; then rm -rf "$DATA_DIR" && info "removed $DATA_DIR"; else info "no data directory to remove"; fi
}

printf '\n%s Uninstalling ordo.%s\n' "$PB" "$R"
stop_daemon
unregister_command
remove_completion
remove_app
remove_data
printf '\n%s ordo removed.%s\n' "$PB" "$R"
[ "$KEEP_DATA" = "1" ] && printf '%s   data kept at %s%s\n' "$P" "$DATA_DIR" "$R"
