// Presets: ready-made, read-only checks (disk, memory, network, ...). Each one only looks at the system: no command here
// changes a file or a setting, installs anything or needs admin rights. Pure data, no UI.
const PS = (s) => `powershell -NoProfile -Command "${s}"`;

export const PRESETS = [
  {
    id: "disk", name: "Disk space", color: "#2563eb",
    why: "Which drives are full, and how much is free.",
    linux: ["df -h -x tmpfs -x devtmpfs"],
    mac: ["df -h"],
    win: [PS("Get-PSDrive -PSProvider FileSystem | Format-Table Name,Used,Free")],
  },
  {
    id: "memory", name: "Memory", color: "#16a34a",
    why: "Free and used memory, and the 8 programs using the most.",
    linux: ["free -h", "ps aux --sort=-%mem | head -n 9"],
    mac: ["vm_stat", "ps aux -m | head -n 9"],
    win: [PS("Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 8 Name,WorkingSet")],
  },
  {
    id: "cpu", name: "Load and busy programs", color: "#ca8a04",
    why: "How busy the machine is and which programs use the most processor time.",
    linux: ["uptime", "ps aux --sort=-%cpu | head -n 9"],
    mac: ["uptime", "ps aux -r | head -n 9"],
    win: [PS("Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name,CPU")],
  },
  {
    id: "network", name: "Network", color: "#0891b2",
    why: "Your addresses and routes, and whether the internet answers (3 pings to 1.1.1.1).",
    linux: ["ip -br addr", "ip route", "ping -c 3 -W 2 1.1.1.1"],
    mac: ["ifconfig | grep -E '^[a-z]|inet '", "netstat -rn | head -n 12", "ping -c 3 1.1.1.1"],
    win: ["ipconfig", "ping -n 3 1.1.1.1"],
  },
  {
    id: "ports", name: "Open ports", color: "#7c3aed",
    why: "Which programs are listening for connections on this machine.",
    linux: ["ss -tulpn"],
    mac: ["lsof -nP -iTCP -sTCP:LISTEN"],
    win: ["netstat -an | findstr LISTENING"],
  },
  {
    id: "services", name: "Failed services", color: "#ea580c",
    why: "Background services that should be running but are not.",
    linux: ["systemctl --failed --no-pager"],
    mac: ["launchctl list | awk '$1==\"-\" && $2!=0'"],
    win: [PS("Get-Service | Where-Object Status -eq Stopped | Where-Object StartType -eq Automatic | Format-Table Name,DisplayName")],
  },
  {
    id: "errors", name: "Recent errors", color: "#dc2626",
    why: "The newest error messages in the system log.",
    linux: ["journalctl -p err -b --no-pager | tail -n 50"],
    mac: ["log show --last 10m --predicate 'messageType == error' | tail -n 50"],
    win: [PS("Get-WinEvent -FilterHashtable @{LogName='System';Level=2} -MaxEvents 30 | Format-Table TimeCreated,ProviderName,Message -Wrap")],
  },
];

/** "win", "mac" or "linux" from the user agent text. */
export function platformOf(ua) {
  return /Windows/i.test(ua) ? "win" : /Mac/i.test(ua) ? "mac" : "linux";
}

/** The commands of a preset for one platform, one per line (the format colour buttons and batch runs use). */
export function presetCommands(p, platform) {
  return (p[platform] || p.linux).join("\n");
}

/** A preset as a colour-button recipe (not saved; pass it to normalize() to save it). */
export function presetAsButton(p, platform) {
  return { id: "preset-" + p.id, name: p.name, color: p.color, cwd: "", where: "tab", commands: presetCommands(p, platform) };
}
