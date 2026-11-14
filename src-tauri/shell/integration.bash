# Digterm shell integration (bash): marks prompt/command/output boundaries with OSC 133.
# Every marker carries a secret that only this shell knows, so output from programs cannot fake a command boundary.
__dt_tok=$DIGTERM_MARK
unset DIGTERM_MARK
[ -f ~/.bashrc ] && . ~/.bashrc
__dt_first=1
__dt_precmd() {
  local ec=$?
  if [ -z "$__dt_first" ]; then printf '\e]133;D;%s;%s\a' "$ec" "$__dt_tok"; fi
  __dt_first=
}
PROMPT_COMMAND="__dt_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1='\[\e]133;A;'"$__dt_tok"'\a\]'"$PS1"'\[\e]133;B;'"$__dt_tok"'\a\]'
PS0=$'\e]133;C;'"$__dt_tok"$'\a'"$PS0"
