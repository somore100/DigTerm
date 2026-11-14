# Digterm shell integration (zsh): marks prompt/command/output boundaries with OSC 133.
# Every marker carries a secret that only this shell knows, so output from programs cannot fake a command boundary.
__dt_tok=$DIGTERM_MARK
unset DIGTERM_MARK
ZDOTDIR="$DT_USER_ZDOTDIR"
[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"
autoload -Uz add-zsh-hook
__dt_started=
__dt_preexec() { printf '\e]133;C;%s\a' "$__dt_tok" }
__dt_precmd() {
  local ec=$?
  [[ -n $__dt_started ]] && printf '\e]133;D;%s;%s\a' "$ec" "$__dt_tok"
  __dt_started=1
  [[ $PS1 == *']133;A'* ]] || PS1=$'%{\e]133;A;'"$__dt_tok"$'\a%}'"$PS1"$'%{\e]133;B;'"$__dt_tok"$'\a%}'
}
add-zsh-hook preexec __dt_preexec
add-zsh-hook precmd __dt_precmd
