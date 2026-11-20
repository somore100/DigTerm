// "Easy install": package names in an install command that is shown in the terminal output
// (for example the hint `sudo dnf install htop`). Ctrl+click on a name types the command for that one package
// into the prompt. It is never run for you: you read it and press Enter.

const VERBS = {
  apt: ["install"], "apt-get": ["install"], dnf: ["install", "in"], yum: ["install"], zypper: ["install", "in"],
  apk: ["add"], brew: ["install"], pip: ["install"], pip3: ["install"], pipx: ["install"], npm: ["install", "i", "add"],
  cargo: ["install"], winget: ["install"], choco: ["install"], scoop: ["install"], snap: ["install"], flatpak: ["install"], gem: ["install"],
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+@:\/=-]*$/; // no shell characters: safe to type as it is
const STOP = /^(&&|\|\||[;|&<>]+)$/;

// Packages named in the install commands of one line of output.
// Returns [{name, x1, x2, cmd}] with 1-based column ranges like the folder links.
export function installCandidates(text) {
  const words = [...text.matchAll(/\S+/g)].map((m) => {
    const lead = m[0].match(/^["'`]*/)[0].length; // quotes around a word are not part of it
    const trail = m[0].slice(lead).match(/["'`,.;]*$/)[0].length;
    const t = m[0].slice(lead, m[0].length - trail);
    return { t, x1: m.index + lead + 1, x2: m.index + lead + t.length };
  }).filter((w) => w.t);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const mgr = words[i].t;
    const pacman = mgr === "pacman";
    if (!pacman && !VERBS[mgr]) continue;
    const sudo = i > 0 && words[i - 1].t === "sudo";
    let j = i + 1;
    while (j < words.length && words[j].t.startsWith("-") && !(pacman && /^-S[a-z]*$/.test(words[j].t))) j++; // flags before the verb
    const verb = words[j]?.t;
    if (!verb || !(pacman ? /^-S[a-z]*$/.test(verb) : VERBS[mgr].includes(verb))) continue;
    const base = `${sudo ? "sudo " : ""}${mgr} ${pacman ? "-S" : verb === "i" || verb === "in" ? "install" : verb}`;
    for (let k = j + 1; k < words.length; k++) {
      const w = words[k];
      if (STOP.test(w.t) || /[$`(){}<>\\!*?]/.test(w.t)) break; // anything that is more than a name ends the list
      if (w.t.startsWith("-") || !NAME.test(w.t)) continue;
      out.push({ name: w.t, x1: w.x1, x2: w.x2, cmd: `${base} ${w.t}` });
    }
    i = words.length; // one command per line
  }
  return out;
}

// Files that can be listed (not unpacked) with the system's archive tools
export const ARCHIVE = /\.(zip|jar|whl|tar|tgz|tbz2|txz|tar\.(gz|bz2|xz|zst)|7z)$/i;
