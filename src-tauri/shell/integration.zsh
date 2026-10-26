# Digterm shell integration (zsh): marks prompt/command/output boundaries with OSC 133.
ZDOTDIR="$DT_USER_ZDOTDIR"
[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"
autoload -Uz add-zsh-hook
__dt_started=
__dt_preexec() { printf '\e]133;C\a' }
__dt_precmd() {
  local ec=$?
  [[ -n $__dt_started ]] && printf '\e]133;D;%s\a' "$ec"
  __dt_started=1
  [[ $PS1 == *']133;A'* ]] || PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
}
add-zsh-hook preexec __dt_preexec
add-zsh-hook precmd __dt_precmd
