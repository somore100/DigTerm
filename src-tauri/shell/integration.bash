# Digterm shell integration (bash): marks prompt/command/output boundaries with OSC 133.
[ -f ~/.bashrc ] && . ~/.bashrc
__dt_first=1
__dt_precmd() {
  local ec=$?
  if [ -z "$__dt_first" ]; then printf '\e]133;D;%s\a' "$ec"; fi
  __dt_first=
}
PROMPT_COMMAND="__dt_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]'
PS0=$'\e]133;C\a'"$PS0"
