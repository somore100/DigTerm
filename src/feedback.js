// Reusable "Leave feedback" form. It knows nothing about Digterm: pass the app name, version, the address to send
// to and four small helpers (see renderFeedbackForm). Nothing is sent from here: the report is composed and handed to
// the user's own email app (or webmail, or the clipboard), so no email password or key ever lives in the app.
export const FEEDBACK_TYPES = [
  ["Bug Report", "BUG"],
  ["Feature Suggestion", "FEATURE"],
  ["General Feedback", "FEEDBACK"],
  ["Question", "QUESTION"],
  ["Other", "OTHER"],
];

// system: null, or [[label, value], ...] as returned by the backend's system_info
export function buildReport({ appName, appVersion, type, name, title, description, system }) {
  const tag = (FEEDBACK_TYPES.find(([label]) => label === type) ?? FEEDBACK_TYPES[4])[1];
  const lines = [
    `App: ${appName}`,
    `Version: ${appVersion}`,
    `Report type: ${type}`,
    `Name: ${name.trim() || "(not given)"}`,
    "",
    `Title: ${title.trim()}`,
    "",
    "Description:",
    description.trim(),
  ];
  if (system) {
    lines.push("", "System information (included by the sender):", ...system.map(([k, v]) => `${k}: ${v}`));
  }
  return { subject: `[${appName}] [${tag}] ${title.trim()}`, body: lines.join("\n") };
}

const query = (subject, body) => `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
export const mailtoUrl = (to, subject, body) => `mailto:${to}?${query(subject, body)}`;
export const gmailUrl = (to, subject, body) =>
  `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

// cfg: { appName, appVersion, to, getSystemInfo(): Promise<[[k, v]]>, openMailto(url), openUrl(url), copy(text) }
export function renderFeedbackForm(root, cfg) {
  root.classList.add("fb");
  root.innerHTML = `
    <label>Report type <select class="fb-type"></select></label>
    <div class="fb-app note"></div>
    <label>Your name (optional) <input type="text" class="fb-name" maxlength="80" /></label>
    <label>Title <input type="text" class="fb-title" maxlength="120" placeholder="e.g. The viewer crashes on large files" /></label>
    <label>Description <textarea class="fb-desc" rows="6" placeholder="What happened, what you expected, or what you would like to see"></textarea></label>
    <label class="fb-check"><input type="checkbox" class="fb-sys" /> Include my computer specifications</label>
    <div class="note">Operating system, CPU, graphics card, memory and architecture. No names, serial numbers or addresses.</div>
    <details class="fb-preview"><summary>Preview exactly what will be sent</summary><pre></pre></details>
    <div class="warn fb-warn"></div>
    <div class="fb-actions">
      <button class="linkbtn fb-mail">Open in email app</button>
      <button class="linkbtn fb-gmail">Open in Gmail</button>
      <button class="linkbtn fb-copy">Copy report</button>
    </div>
    <div class="note fb-note"></div>`;
  const $ = (s) => root.querySelector(s);
  const typeEl = $(".fb-type");
  for (const [label] of FEEDBACK_TYPES) typeEl.add(new Option(label, label));
  $(".fb-app").textContent = `${cfg.appName} ${cfg.appVersion} · goes to ${cfg.to}`;
  $(".fb-note").textContent = "Nothing is sent by this window itself: your email app opens with the report ready, and it is only sent when you press Send there.";
  const warn = $(".fb-warn");
  let system = null;

  const report = () => buildReport({
    appName: cfg.appName, appVersion: cfg.appVersion, type: typeEl.value,
    name: $(".fb-name").value, title: $(".fb-title").value || "(no title yet)", description: $(".fb-desc").value || "(no description yet)", system,
  });
  const refresh = () => {
    const r = report();
    $(".fb-preview pre").textContent = `To: ${cfg.to}\nSubject: ${r.subject}\n\n${r.body}`;
  };
  root.addEventListener("input", refresh);
  typeEl.addEventListener("change", refresh);
  refresh();

  $(".fb-sys").addEventListener("change", async (e) => {
    if (!e.target.checked) { system = null; refresh(); return; }
    e.target.disabled = true;
    try { system = await cfg.getSystemInfo(); } catch (err) { system = [["System information", `could not be read: ${err}`]]; }
    e.target.disabled = false;
    $(".fb-preview").open = true; // show what was collected
    refresh();
  });

  // required fields: a title and a description
  function ready() {
    warn.textContent = "";
    if (!$(".fb-title").value.trim()) { warn.textContent = "Please enter a title."; $(".fb-title").focus(); return null; }
    if (!$(".fb-desc").value.trim()) { warn.textContent = "Please describe the problem or suggestion."; $(".fb-desc").focus(); return null; }
    return report();
  }
  const done = (msg, ok = true) => { warn.textContent = ok ? "" : msg; if (ok) $(".fb-note").textContent = msg; };

  $(".fb-mail").onclick = async () => {
    const r = ready();
    if (!r) return;
    try {
      await cfg.openMailto(mailtoUrl(cfg.to, r.subject, r.body));
      done("Your email app should now show the report. Press Send there to submit it. If nothing opened, use Open in Gmail or Copy report." + (r.body.length > 1500 ? " This report is long: if your email app cuts it off, use Copy report." : ""));
    } catch (err) {
      done(`Could not open an email app: ${err}. Try Open in Gmail or Copy report.`, false);
    }
  };
  $(".fb-gmail").onclick = async () => {
    const r = ready();
    if (!r) return;
    try {
      await cfg.openUrl(gmailUrl(cfg.to, r.subject, r.body));
      done("Gmail opened in your browser with the report ready. Press Send there to submit it.");
    } catch (err) {
      done(`Could not open the browser: ${err}`, false);
    }
  };
  $(".fb-copy").onclick = async () => {
    const r = ready();
    if (!r) return;
    try {
      await cfg.copy(`To: ${cfg.to}\nSubject: ${r.subject}\n\n${r.body}`);
      done(`Copied. Paste it into an email to ${cfg.to}.`);
    } catch (err) {
      done(`Could not copy: ${err}`, false);
    }
  };
}
