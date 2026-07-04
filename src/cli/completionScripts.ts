const POWERSHELL = `Register-ArgumentCompleter -Native -CommandName ordo -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
    if ([string]::IsNullOrEmpty($wordToComplete)) { $words += '' }
    (& ordo __complete @words) 2>$null | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}`

const BASH = `_ordo_completions() {
    local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
    if [ "\${COMP_WORDS[COMP_CWORD]}" = "" ]; then words+=(""); fi
    local IFS=$'\\n'
    COMPREPLY=( $(ordo __complete "\${words[@]}" 2>/dev/null) )
}
complete -F _ordo_completions ordo`

const ZSH = `_ordo() {
    local -a words
    words=("\${(@)words[2,CURRENT]}")
    local out
    out=$(ordo __complete "\${words[@]}" 2>/dev/null)
    compadd -- \${(f)out}
}
compdef _ordo ordo`

export function completionScript(shell: string): string {
	if (shell === "powershell" || shell === "pwsh") return POWERSHELL
	if (shell === "bash") return BASH
	if (shell === "zsh") return ZSH
	return ""
}
