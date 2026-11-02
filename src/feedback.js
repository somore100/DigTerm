// Reusable "Leave feedback" form (same logic and payload as the feedback_kit used in the Python apps). It knows
// nothing about the host app: pass the app name, version, the address, an optional relay endpoint and a few helpers
// (see renderFeedbackForm). No credentials live here:
//   - endpoint set: "Send" POSTs the report as JSON to a relay you own (docs/feedback-relay.gs forwards it to the inbox);
//   - the buttons below it hand the same text to the user's own email app, to Gmail, or to the clipboard.
export const FEEDBACK_TYPES = [
  ["Bug Report", "BUG"],
  ["Feature Suggestion", "FEATURE"],
  ["General Feedback", "FEEDBACK"],
  ["Question", "QUESTION"],
  ["Other", "OTHER"],
];
export const MAX_TITLE = 120, MAX_NAME = 60, MAX_DESC = 4000;

// Returns a list of problems (empty when the report can be sent).
export function validate({ title, description }) {
  const errs = [];
  if (!title.trim()) errs.push("Please enter a title.");
  else if (title.trim().length < 4) errs.push("The title is too short.");
  if (!description.trim()) errs.push("Please describe the problem or suggestion.");
  else if (description.trim().length < 10) errs.push("The description is too short to be useful.");
  return errs;
}

const oneLine = (s) => s.split(/\s+/).filter(Boolean).join(" ");

// system: null, or [[label, value], ...] (only what the user agreed to send)
export function buildReport({ appName, appVersion, type, name, title, description, system }) {
  const [, tag] = FEEDBACK_TYPES.find(([label]) => label === type) ?? FEEDBACK_TYPES[4];
  const lines = [
    "== FEEDBACK REPORT ==",
    `App:      ${appName}`,
    `Version:  ${appVersion}`,
    `Type:     ${type}`,
    `From:     ${name.trim() || "(not given)"}`,
    `Title:    ${oneLine(title)}`,
    "",
    "== DESCRIPTION ==",
    description.trim(),
    "",
    ...(system ? ["== SYSTEM (sent because the user ticked the box) ==", ...system.map(([k, v]) => `${k}: ${v}`)] : ["== SYSTEM ==", "(not included)"]),
    "",
  ];
  return { subject: `[${appName}] [${tag}] ${oneLine(title).slice(0, MAX_TITLE)}`, body: lines.join("\n"), tag };
}

const enc = encodeURIComponent;
export const mailtoUrl = (to, subject, body) => `mailto:${to}?subject=${enc(subject)}&body=${enc(body)}`;
export const gmailUrl = (to, subject, body) => `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(subject)}&body=${enc(body)}`;

// POSTs {to, subject, body, app, version, type} as text/plain (a "simple" request: no CORS preflight).
// Returns {ok, message}; never throws.
export async function sendToRelay({ endpoint, to, appName, appVersion }, report, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ to, subject: report.subject, body: report.body, app: appName, version: appVersion, type: report.tag }),
      redirect: "follow",
      signal: ctl.signal,
    });
    const text = (await res.text()).slice(0, 2000);
    if (res.ok && !/"ok"\s*:\s*false/i.test(text)) return { ok: true, message: "Thank you! Your feedback was sent." };
    return { ok: false, message: `The server answered ${res.status}. Please try again later, or use one of the other buttons.` };
  } catch {
    return { ok: false, message: "Could not confirm that the report arrived (no answer from the server). Check your connection, or use one of the other buttons." };
  } finally {
    clearTimeout(timer);
  }
}

// cfg: { appName, appVersion, to, endpoint?, getSystemInfo(): Promise<[[k, v]]>, openMailto(url), openUrl(url), copy(text), fetchImpl? }
export function renderFeedbackForm(root, cfg) {
  root.classList.add("fb");
  root.innerHTML = `
    <label>Report type <select class="fb-type"></select></label>
    <div class="fb-app note"></div>
    <label>Your name (optional) <input type="text" class="fb-name" maxlength="${MAX_NAME}" /></label>
    <label>Title <input type="text" class="fb-title" maxlength="${MAX_TITLE}" placeholder="e.g. The viewer crashes on large files" /></label>
    <label>Description <textarea class="fb-desc" rows="6" maxlength="${MAX_DESC}" placeholder="What happened, what you expected, or what you would like to see"></textarea></label>
    <label class="fb-check"><input type="checkbox" class="fb-sys" /> Include my computer specifications</label>
    <div class="note">Operating system and version, CPU, graphics card, memory, architecture and the app version. No names, host name, serial numbers, addresses or file paths.</div>
    <details class="fb-preview"><summary>Preview exactly what will be sent</summary><pre></pre></details>
    <div class="warn fb-warn"></div>
    <div class="fb-actions">
      <button class="linkbtn fb-send" hidden>Send</button>
      <span class="note fb-or" hidden>or send it yourself:</span>
      <button class="linkbtn fb-mail">Open in email app</button>
      <button class="linkbtn fb-gmail">Open in Gmail</button>
      <button class="linkbtn fb-copy">Copy report</button>
    </div>
    <div class="note fb-note"></div>`;
  const $ = (s) => root.querySelector(s);
  const typeEl = $(".fb-type");
  for (const [label] of FEEDBACK_TYPES) typeEl.add(new Option(label, label));
  const relay = !!cfg.endpoint;
  $(".fb-app").textContent = `${cfg.appName} ${cfg.appVersion} · goes to ${cfg.to}`;
  $(".fb-note").textContent = relay
    ? "Send delivers the report over HTTPS to the support inbox. The other buttons open your own email app, Gmail or the clipboard instead. Nothing is sent until you press one."
    : "Your email app opens with the report ready, and it is only sent when you press Send there. Nothing is sent by this window itself.";
  $(".fb-send").hidden = !relay;
  $(".fb-or").hidden = !relay;
  const warn = $(".fb-warn");
  let system = null;

  const fields = () => ({ name: $(".fb-name").value, title: $(".fb-title").value, description: $(".fb-desc").value });
  const report = () => {
    const f = fields();
    return buildReport({ appName: cfg.appName, appVersion: cfg.appVersion, type: typeEl.value, ...f, title: f.title || "(no title yet)", description: f.description || "(no description yet)", system });
  };
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
    try { system = [...(await cfg.getSystemInfo()), ["App version", cfg.appVersion]]; } catch (err) { system = [["System information", `could not be read: ${err}`]]; }
    e.target.disabled = false;
    $(".fb-preview").open = true; // show what was collected
    refresh();
  });

  function ready() {
    const f = fields();
    const errs = validate(f);
    warn.textContent = errs.join(" ");
    if (errs.length) { $(f.title.trim().length < 4 ? ".fb-title" : ".fb-desc").focus(); return null; }
    return report();
  }
  const done = (msg, ok = true) => { warn.textContent = ok ? "" : msg; if (ok) $(".fb-note").textContent = msg; };

  $(".fb-send").onclick = async () => {
    const r = ready();
    if (!r) return;
    const btn = $(".fb-send");
    btn.disabled = true;
    btn.textContent = "Sending…";
    const res = await sendToRelay(cfg, r, { fetchImpl: cfg.fetchImpl });
    if (res.ok) { btn.textContent = "Sent ✓"; done(res.message); return; }
    btn.disabled = false;
    btn.textContent = "Send";
    done(res.message, false);
  };
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
