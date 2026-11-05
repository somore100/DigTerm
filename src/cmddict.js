// Linux/macOS shell <-> Windows (cmd / PowerShell) command dictionary. Reference only: nothing is translated or run.
export const COMMANDS = [
  ["List files", "ls -la", "dir", "Get-ChildItem (ls, dir)"],
  ["Change folder", "cd /path", "cd /d C:\\path", "Set-Location (cd)"],
  ["Current folder", "pwd", "cd", "Get-Location (pwd)"],
  ["Show a file", "cat file", "type file", "Get-Content (cat, type)"],
  ["Follow a file's end", "tail -f file", "(none)", "Get-Content file -Wait -Tail 20"],
  ["First lines of a file", "head -n 10 file", "(none)", "Get-Content file -TotalCount 10"],
  ["Copy a file", "cp a b", "copy a b", "Copy-Item (cp)"],
  ["Move or rename", "mv a b", "move a b / ren a b", "Move-Item (mv)"],
  ["Delete a file", "rm file", "del file", "Remove-Item (rm)"],
  ["Delete a folder", "rm -r dir", "rmdir /s dir", "Remove-Item -Recurse dir"],
  ["Make a folder", "mkdir -p a/b", "mkdir a\\b", "New-Item -ItemType Directory a\\b"],
  ["Create an empty file", "touch file", "type nul > file", "New-Item file"],
  ["Search text in files", "grep -rn text .", "findstr /s /n text *", "Select-String -Path * -Pattern text"],
  ["Find files by name", "find . -name '*.txt'", "dir /s /b *.txt", "Get-ChildItem -Recurse -Filter *.txt"],
  ["Where is a command", "which cmd", "where cmd", "Get-Command cmd"],
  ["Clear the screen", "clear", "cls", "Clear-Host (cls)"],
  ["Print text", "echo hi", "echo hi", "Write-Output hi (echo)"],
  ["Environment variable", "echo $HOME", "echo %USERPROFILE%", "$env:USERPROFILE"],
  ["Set a variable", "export A=1", "set A=1", "$env:A = \"1\""],
  ["List processes", "ps aux", "tasklist", "Get-Process"],
  ["Stop a process", "kill PID", "taskkill /PID PID", "Stop-Process -Id PID"],
  ["Disk space", "df -h", "wmic logicaldisk get size,freespace", "Get-PSDrive"],
  ["Memory use", "free -h", "systeminfo", "Get-CimInstance Win32_OperatingSystem"],
  ["Network addresses", "ip a", "ipconfig", "Get-NetIPAddress"],
  ["Network connections", "ss -tulpn", "netstat -ano", "Get-NetTCPConnection"],
  ["Ping", "ping -c 4 host", "ping host", "Test-Connection host"],
  ["Download a file", "curl -O url", "curl -O url", "Invoke-WebRequest url -OutFile f"],
  ["Count lines", "wc -l file", "find /c /v \"\" file", "(Get-Content file).Count"],
  ["Sort lines", "sort file", "sort file", "Get-Content file | Sort-Object"],
  ["Compare files", "diff a b", "fc a b", "Compare-Object (gc a) (gc b)"],
  ["Run as administrator", "sudo cmd", "(open an admin terminal)", "Start-Process -Verb RunAs"],
  ["Edit a file", "nano file", "notepad file", "notepad file"],
  ["Show command help", "man cmd", "help cmd", "Get-Help cmd"],
  ["Read command history", "history", "doskey /history", "Get-History"],
  ["Open a file or folder", "xdg-open path", "start path", "Invoke-Item path"],
  ["Permissions", "chmod +x file", "icacls file /grant ...", "Set-Acl"],
  ["Join commands", "a && b", "a && b", "a; if ($?) { b }"],
];

export const COLUMNS = ["Task", "Linux / macOS", "Windows cmd", "PowerShell"];

// every row whose text contains all the words typed
export function searchCommands(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return COMMANDS.filter((r) => words.every((w) => r.some((c) => c.toLowerCase().includes(w))));
}
