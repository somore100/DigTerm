// Masking of sensitive details in copied text. Pure text-to-text; the saved output is never changed.
// Off by default. Everything it hides is replaced by a label such as <ip-1>, and the same value always gets
// the same label inside one piece of text, so a log stays readable ("<ip-1> connected, <ip-1> closed").

const KEY = "digterm.mask";
export const MASK_DEFAULTS = { on: false, ips: true, emails: true, users: true, secrets: true, macs: true };
export const MASK_KINDS = [
  ["ips", "IP addresses"],
  ["emails", "Email addresses"],
  ["users", "User names in paths (/home/name)"],
  ["secrets", "Passwords, tokens and keys"],
  ["macs", "MAC addresses"],
];

export function loadMask() {
  try {
    return { ...MASK_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...MASK_DEFAULTS };
  }
}

export function saveMask(m) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {}
}

const ID = String.raw`[A-Za-z0-9_.-]*`;
const SECRET_KEY = String.raw`(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization|credential)`;

export function maskText(text, o = MASK_DEFAULTS) {
  const labels = { ip: new Map(), email: new Map(), mac: new Map() };
  const label = (kind, value) => {
    const m = labels[kind];
    const k = value.toLowerCase();
    if (!m.has(k)) m.set(k, m.size + 1);
    return `<${kind}-${m.get(k)}>`;
  };
  let t = text;

  if (o.secrets) {
    t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<private key>");
    t = t.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:@\/]+):([^\s@\/]+)@/gi, "$1<user>:<secret>@"); // user:password@host
    t = t.replace(new RegExp(String.raw`\b(${ID}${SECRET_KEY}${ID})(\s*[:=]\s*)(?!(?:Bearer|Basic)\b)("[^"]*"|'[^']*'|[^\s,;&]+)`, "gi"), "$1$2<secret>");
    t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 <secret>");
    t = t.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<secret>");
    t = t.replace(/\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bsk-[A-Za-z0-9_-]{20,}\b/g, "<secret>");
    t = t.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<secret>"); // JWT
  }
  if (o.emails) t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => label("email", m));
  if (o.users) {
    t = t.replace(/\/(home|Users)\/([^\/\s'"<>:]+)/g, "/$1/<user>");
    t = t.replace(/([A-Za-z]:\\Users\\)([^\\\s'"<>:]+)/gi, "$1<user>");
  }
  if (o.macs) t = t.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, (m) => label("mac", m));
  if (o.ips) {
    t = t.replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, (m) =>
      m.startsWith("127.") || m === "0.0.0.0" ? m : label("ip", m)); // loopback is not sensitive
  }
  return t;
}

// Used by every Copy button: masks only when the user has turned masking on.
export function maskCopy(text) {
  const m = loadMask();
  return m.on ? maskText(text, m) : text;
}
