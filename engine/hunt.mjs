#!/usr/bin/env node
"use strict";
/* ============================================================
   Get Me A JOB — hunt engine.
   Runs inside the user's OWN data repo via GitHub Actions
   (workflow_dispatch). Reads data/*.json from the checkout,
   does real job discovery on public employer ATS boards
   (Greenhouse / Lever / Ashby) and the free keyless remote-job
   feeds (RemoteOK, Arbeitnow), evaluates every posting against
   the user's saved titles and rules, and git-commits progress
   back so the web page (polling the repo) shows lanes and
   stages moving.

   Honesty rules (do not weaken):
   - The engine NEVER creates a filing with status "filed" —
     it cannot submit applications. Ready matches are parked
     as "Ready to apply" leads for the user to submit.
   - The big boards (LinkedIn / Indeed / Dice / …) have no
     keyless server API. Their lanes are marked "manual" —
     the engine does not fake searching them.
   - connections.json is never read. No secrets are read,
     printed, or needed: git push uses the Actions token.
   Node 20+, zero dependencies (global fetch + git CLI).
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const FETCH_TIMEOUT_MS = 15000;
const BOARD_POSTING_CAP = 200;   // max postings evaluated per employer board
const DETAIL_FETCH_CAP = 60;     // max Greenhouse detail fetches per board
const HOURLY_YEAR_HOURS = 2080;

const nowISO = () => new Date().toISOString();
const uid = (p) => (p || "id") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o == null ? null : o));
const log = (...a) => console.log("[hunt]", ...a);

/* ---------------- defaults: mirror defaultsFor() in index.html ---------------- */
function defaultsFor(key) {
  switch (key) {
    case "profile": return { name: "", email: "", phone: "",
      address: { street: "", city: "", state: "", zip: "", country: "" },
      resume: { filename: "", added_at: "", text: "" },
      detection: { skills: [], employers: [], titles: [], industries: [], years_experience: "", summary: "" },
      employers: { target: [], excluded: [] },
      wizard_step: 1, updated_at: "" };
    case "coverage": return { specified_title: "", draft: { titles: [], lanes: [], generated_at: "" },
      saved: { titles: [], lanes: [], saved_at: "" }, coverage_saved_at: "", updated_at: "" };
    case "rules": return { remote_only: true, minimum_pay: "", maximum_pay: "",
      posting_max_age_days: 7, block_hands_on: true, block_presales: false,
      focus_sectors: [], always_reject: [], extra_notes: "", updated_at: "" };
    case "runs": return { state: "idle", current_run: null, history: [], lane_controls: [], requests: [], updated_at: "" };
    case "filings": return { filings: [], updated_at: "" };
    case "activity": return { entries: [], updated_at: "" };
  }
  return {};
}

/* Read a data file the way the app's storeLoad does: Object.assign(defaults, parsed).
   Tolerates a missing file, invalid JSON, and the legacy bare-array activity shape. */
function readData(key) {
  const file = path.join(DATA_DIR, key + ".json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (key === "activity" && Array.isArray(parsed)) return Object.assign(defaultsFor(key), { entries: parsed });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return Object.assign(defaultsFor(key), parsed);
  } catch (e) { /* missing or unreadable → defaults */ }
  return defaultsFor(key);
}
function writeData(key, obj) {
  obj.updated_at = nowISO();
  fs.writeFileSync(path.join(DATA_DIR, key + ".json"), JSON.stringify(obj, null, 2) + "\n");
}

/* ---------------- git ---------------- */
function git(args, tolerate = false) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  if (r.status !== 0 && !tolerate) {
    log("git " + args.join(" ") + " failed: " + String(r.stderr || r.stdout || "").trim().slice(0, 300));
  }
  return r;
}
function ensureGitIdentity() {
  const name = process.env.GIT_AUTHOR_NAME || "get-me-a-job engine";
  const email = process.env.GIT_AUTHOR_EMAIL || "engine@users.noreply.github.com";
  const cur = git(["config", "user.email"], true);
  if (cur.status !== 0 || !String(cur.stdout || "").trim()) {
    git(["config", "user.name", name], true);
    git(["config", "user.email", email], true);
  }
}
let pushPending = false;
function push() {
  const r = git(["push"], true);
  if (r.status === 0) { pushPending = false; return true; }
  pushPending = true;
  log("git push failed (will retry later): " + String(r.stderr || "").trim().slice(0, 200));
  return false;
}
function commitData(message) {
  git(["add", "data"], true);
  const st = git(["status", "--porcelain", "data"], true);
  if (st.status === 0 && !String(st.stdout || "").trim()) return false; // nothing changed
  const c = git(["commit", "-m", message], true);
  if (c.status !== 0) { log("git commit failed: " + String(c.stderr || c.stdout || "").trim().slice(0, 200)); return false; }
  push();
  return true;
}
function pullLatest() {
  // Tolerate failure (offline, no remote, diverged): local state stays usable.
  git(["pull", "--rebase"], true);
}

/* ---------------- text helpers ---------------- */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
}
function htmlToText(html) {
  // Greenhouse content is entity-encoded HTML: decode once, strip tags, decode again.
  let t = decodeEntities(String(html || ""));
  t = t.replace(/<[^>]*>/g, " ");
  t = decodeEntities(t);
  return t.replace(/\s+/g, " ").trim();
}
const STOPWORDS = new Set(["the", "a", "an", "of", "for", "and", "or", "in", "at", "to", "i", "ii", "iii", "iv", "v", "1", "2", "3"]);
function titleTokens(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
}
function significantTokens(title) {
  return titleTokens(title).filter((t) => !STOPWORDS.has(t));
}
/* Seniority / level markers — the only words allowed to differ between a
   posting title and a saved title. */
const LEVEL_WORDS = new Set(["senior", "sr", "lead", "principal", "staff",
  "associate", "executive", "junior", "jr", "chief", "head", "vp", "vice", "president"]);
/* Canonical core of a title: its significant words minus level markers,
   sorted — so "Director of Healthcare Operations", "Healthcare Operations
   Director" and "Senior Healthcare Operations Director" share one core,
   while "IT Director", "Director of Analytics" and "Payment Operations
   Specialist" share none with it. A posting matches a saved title ONLY
   when their cores are identical. The previous rule (any 2 shared words,
   or sharing the saved title's last word) parked anything containing
   "operations" or "director" — it has been removed, not relaxed. */
function titleCore(title) {
  return significantTokens(title).filter((t) => !LEVEL_WORDS.has(t)).sort().join(" ");
}
function titleMatches(postingTitle, savedTitles) {
  const core = titleCore(postingTitle);
  if (!core) return null;
  for (const saved of savedTitles || []) {
    if (titleCore(saved) === core) return saved;
  }
  return null;
}
function hasRemoteSignal(location, text) {
  return /\b(remote|work from home|work-from-home|wfh|distributed|telecommut|work from anywhere|anywhere)\b/i
    .test(String(location || "") + " " + String(text || ""));
}
/* Places that pin a posting to a non-US labor market. A posting whose
   stated location is one of these — with no US / worldwide signal — is
   not remote work for this user, however the board labels it (the feeds
   in particular mark EU-restricted roles "remote"). */
const NON_US_PLACES = ["germany", "berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne", "köln", "stuttgart", "düsseldorf", "leipzig", "dresden", "hannover", "nuremberg", "nürnberg", "austria", "vienna", "wien", "switzerland", "zurich", "zürich", "geneva", "bern", "netherlands", "amsterdam", "rotterdam", "utrecht", "eindhoven", "belgium", "brussels", "france", "paris", "lyon", "spain", "madrid", "barcelona", "valencia", "portugal", "lisbon", "porto", "italy", "milan", "rome", "poland", "warsaw", "kraków", "wroclaw", "gdansk", "czech", "prague", "praha", "slovakia", "bratislava", "hungary", "budapest", "romania", "bucharest", "cluj", "bulgaria", "sofia", "croatia", "zagreb", "serbia", "belgrade", "greece", "athens", "ireland", "dublin", "united kingdom", "uk", "london", "manchester", "edinburgh", "england", "scotland", "wales", "sweden", "stockholm", "gothenburg", "malmö", "norway", "oslo", "denmark", "copenhagen", "finland", "helsinki", "estonia", "tallinn", "latvia", "riga", "lithuania", "vilnius", "iceland", "reykjavik", "europe", "eu only", "emea", "india", "bangalore", "bengaluru", "hyderabad", "pune", "mumbai", "delhi", "chennai", "pakistan", "lahore", "karachi", "bangladesh", "dhaka", "philippines", "manila", "vietnam", "hanoi", "ho chi minh", "thailand", "bangkok", "indonesia", "jakarta", "singapore", "malaysia", "kuala lumpur", "china", "beijing", "shanghai", "shenzhen", "japan", "tokyo", "osaka", "korea", "seoul", "australia", "sydney", "melbourne", "brisbane", "perth", "new zealand", "auckland", "wellington", "canada", "toronto", "vancouver", "montreal", "calgary", "ottawa", "mexico", "mexico city", "guadalajara", "brazil", "são paulo", "sao paulo", "rio de janeiro", "argentina", "buenos aires", "chile", "santiago", "colombia", "bogotá", "peru", "lima", "south africa", "cape town", "johannesburg", "nigeria", "lagos", "kenya", "nairobi", "egypt", "cairo", "israel", "tel aviv", "united arab emirates", "dubai", "abu dhabi", "saudi arabia", "riyadh", "qatar", "doha", "turkey", "istanbul", "ankara", "ukraine", "kyiv", "russia", "moscow"];
const US_SIGNALS = /\b(usa|u\.s\.a\.|united states|us only|u\.s\. only|worldwide|world wide|anywhere|global|americas|north america)\b/i;
function locationBlocksUS(location) {
  const loc = String(location || "").toLowerCase();
  if (!loc.trim()) return false;
  if (US_SIGNALS.test(loc)) return false;
  const words = new Set(loc.split(/[^a-zà-ÿ]+/).filter(Boolean));
  return NON_US_PLACES.some((p) => (p.includes(" ") ? loc.includes(p) : words.has(p)));
}
/* Parse a pay figure to an annual USD number. Returns null when unparseable. */
function amountToAnnual(rawValue, isK, isHourly) {
  let v = rawValue;
  if (isK) v *= 1000;
  if (isHourly) v *= HOURLY_YEAR_HOURS;
  return v;
}
function parseMinimumPay(str) {
  const s = String(str || "").trim();
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k)?/i);
  if (!m) return null;
  const hourly = /\/\s*hr|per hour|hourly|\bhr\b/i.test(s);
  const annual = amountToAnnual(parseFloat(m[1]), !!m[2], hourly);
  return annual >= 1000 ? annual : null;
}
/* Highest stated pay in a posting's text as { annual, raw, hourly } —
   raw is the figure exactly as printed, for evidence quotes — or null
   when no pay is stated. */
function parsePayTop(text) {
  const s = String(text || "");
  let best = null;
  const re = /\$\s?([\d,]+(?:\.\d+)?)\s*(k)?/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(raw)) continue;
    const tail = s.slice(re.lastIndex, re.lastIndex + 14);
    const hourly = /^\s*(?:\/|per\s)?\s*(hr|hour|hourly)\b/i.test(tail);
    const annual = amountToAnnual(raw, !!m[2], hourly);
    // Sanity floor: ignore small dollar figures (fees, budgets, product prices).
    if (annual >= 10000 || (hourly && raw >= 10)) {
      if (best == null || annual > best.annual) {
        best = { annual, raw: m[0].replace(/\s+/g, "") + (hourly ? "/hr" : ""), hourly };
      }
    }
  }
  return best;
}
/* Highest stated annual pay in a posting's text, or null when no pay is stated. */
function parsePostingMaxPay(text) {
  const top = parsePayTop(text);
  return top ? top.annual : null;
}
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");

/* ---------------- evidence + sweep-discipline helpers ----------------
   The evaluation below mirrors the Sweep Tracker's sweep logic:
   JD-first (never a verdict from a title or snippet), every screened
   posting dispositioned exactly once, each disposition carrying the
   12-rule secondary check with evidence quoted from the posting. */
function toISODate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return isNaN(d) ? null : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}
/* Whole days between the posting's activity date and now; null when
   the board publishes no date. A future date counts as 0 (fresh). */
function postingAgeDays(postedAt) {
  const iso = toISODate(postedAt);
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days < 0 ? 0 : days;
}
function sentencesOf(text) {
  return String(text || "").replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 25);
}
/* First sentence of the posting matching re — verbatim evidence. */
function sentenceWith(text, re) {
  const s = sentencesOf(text).find((x) => re.test(x));
  return s ? s.slice(0, 220) : "";
}
function firstDutyQuote(text) {
  const ss = sentencesOf(text);
  const duty = ss.find((x) => /\b(responsible|responsibilities|lead|develop|design|manage|build|drive|ensure|support|collaborate|own|deliver|oversee|partner)\b/i.test(x));
  return (duty || ss[0] || String(text || "").slice(0, 180)).slice(0, 200);
}
function signalHit(text, res) {
  for (const re of res) {
    const s = sentenceWith(text, re);
    if (s) return s;
  }
  return "";
}
/* A REQUIRED office/hybrid schedule (the sweep's not-remote test). An
   offered choice — "remote or hybrid" — is remote-eligible and is
   checked separately before this can fail a posting. */
const HYBRID_REQ_RE = /\b(hybrid\s+(role|position|work model|schedule|environment)|days?\s+(per|a)\s+week\s+in\s+(the\s+)?office|in-office\s+\d|on-?site\s+\d+\s+days?|work\s+from\s+(the\s+)?office\s+\d|must\s+(live|be\s+located|reside)\s+within\s+commuting|required\s+to\s+work\s+on-?site)\b/i;
const REMOTE_OPTION_RE = /\b(fully remote|100% remote|remote or hybrid|work from anywhere|remote-first|remote first|entirely remote)\b/i;
/* Whole-role hands-on execution signals — deliberately narrow, the
   sweep's whole-role test: the role IS coding/building, not an
   architect/lead role that merely touches tooling. */
const HANDS_ON_RES = [
  /\b\d{2,3}\s?%\s+of\s+(your\s+)?time\s+(is\s+)?(spent\s+)?(coding|programming|developing|writing code|hands-on)/i,
  /\bspend\s+(most|the majority)\s+of\s+your\s+time\s+(writing code|coding|developing|programming)/i,
  /\bhands-on\s+(keyboard|coding|development|programming)\b/i,
  /\bwrite\s+production(-grade)?\s+code\b/i,
  /\bday-to-day\s+(coding|programming|software development)\b/i,
  /\bprimarily\s+(a\s+)?(coding|programming|individual-contributor\s+coding)\b/i,
];
/* Core sales-duty signals for the pre-sales bar: a quoted CORE sales
   duty (quota / pipeline / win strategy) — an implementation role
   that merely mentions partnering with sales does not trip this. */
const PRESALES_RES = [
  /\b(carry|carrying|own|owning|meet|meeting|achieve|achieving)\s+(a\s+|your\s+)?(sales\s+)?quota\b/i,
  /\bpipeline\s+generation\b/i,
  /\bwin\s+strateg(y|ies)\b/i,
  /\b(sales|revenue)\s+targets?\s+(of|assigned|you)\b/i,
  /\b(demos?|demonstrations)\s+to\s+close\s+(deals|business)\b/i,
  /\bpartner\s+with\s+sales\s+to\s+close\b/i,
];
/* Cross-profession skill vocabulary for the experience-alignment test:
   skills a posting can REQUIRE. The user's own résumé skills are
   unioned in at judgment time, so a profession-specific term the
   résumé itself uses is always recognized. */
const SKILL_LEXICON = ["azure", "aws", "amazon web services", "gcp", "google cloud",
  "kubernetes", "docker", "terraform", "bicep", "arm templates", "devops", "ci/cd",
  "sql", "nosql", "postgresql", "mysql", "mongodb", "data modeling", "etl",
  "python", "java", "javascript", "typescript", "c#", ".net", "react", "angular", "node.js",
  "networking", "vpn", "firewalls", "cybersecurity", "security architecture", "identity management",
  "active directory", "entra", "okta", "vmware", "hyper-v", "linux", "windows server",
  "machine learning", "data analysis", "tableau", "power bi", "excel", "salesforce", "sap", "oracle",
  "project management", "agile", "scrum", "program management", "stakeholder management",
  "budgeting", "forecasting", "financial modeling", "accounting", "gaap", "auditing", "compliance",
  "risk management", "hipaa", "ehr", "epic", "cerner", "clinical", "patient care", "nursing",
  "healthcare operations", "claims", "underwriting", "supply chain", "logistics", "procurement",
  "cad", "autocad", "solidworks", "marketing strategy", "seo", "content marketing",
  "cloud architecture", "solution architecture", "enterprise architecture", "microservices",
  "api design", "system integration", "disaster recovery", "business continuity"];
function extractSkills(text) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9#+. ]+/g, " ") + " ";
  const found = SKILL_LEXICON.filter((s) => t.includes(" " + s + " ") || t.includes(" " + s + ",") || t.includes(" " + s + "."));
  const resumeSkills = ((engine.profile && engine.profile.detection && engine.profile.detection.skills) || [])
    .map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  for (const s of resumeSkills) if (t.includes(s) && !found.includes(s)) found.push(s);
  return found;
}
/* Remote verdict under the sweep's remote-language rule. Returns
   { ok, evidence }: ok=false carries the verbatim reason. */
function remoteVerdict(posting, jd) {
  const loc = String(posting.location || "");
  if (locationBlocksUS(loc)) {
    return { ok: false, evidence: "Location: " + loc + " — restricted to a non-US location." };
  }
  const text = String(jd || "");
  const hybridReq = sentenceWith(text, HYBRID_REQ_RE);
  const remoteOption = REMOTE_OPTION_RE.test(text) || REMOTE_OPTION_RE.test(loc);
  if (hybridReq && !remoteOption) {
    return { ok: false, evidence: "Not fully remote — the posting requires: \u201C" + hybridReq + "\u201D" };
  }
  if (posting.remoteFlag === true || hasRemoteSignal(loc, text)) {
    const q = sentenceWith(text, /\b(remote|work from home|work from anywhere|distributed)\b/i);
    return { ok: true, evidence: "Remote confirmed" + (loc ? " — location: " + loc : "") +
      (q ? ". Posting states: \u201C" + q + "\u201D" : ".") };
  }
  return { ok: false, evidence: "Location: " + (loc || "not stated") + " — no remote signal anywhere in the posting." };
}
/* Experience alignment: the posting's named skill requirements vs the
   user's résumé (detection skills + full résumé text). A core mismatch
   fails ONLY when the posting names 3+ required skills and the résumé
   covers none of them — minor gaps still pass, per the sweep. */
function experienceVerdict(jd) {
  const det = (engine.profile && engine.profile.detection) || {};
  const resumeSkills = (det.skills || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  const resumeText = String((engine.profile && engine.profile.resume && engine.profile.resume.text) || "").toLowerCase();
  if (!resumeSkills.length && !resumeText) {
    return { status: "grey", evidence: "No résumé on file to align against — upload your résumé so the hunt can judge fit." };
  }
  const jdSkills = extractSkills(jd);
  if (!jdSkills.length) {
    return { status: "grey", evidence: "The posting names no specific skill requirements to compare with your résumé." };
  }
  const have = jdSkills.filter((s) => resumeSkills.includes(s) || resumeText.includes(s));
  const missing = jdSkills.filter((s) => !have.includes(s));
  if (jdSkills.length >= 3 && have.length === 0) {
    const req = sentenceWith(jd, /\b(require|required|must have|you bring|qualifications|experience with)\b/i);
    return { status: "fail", evidence: "Core mismatch — the posting requires " + missing.join(", ") +
      ", and none of them appear anywhere in your résumé." + (req ? " Requirement as written: \u201C" + req + "\u201D" : "") };
  }
  return { status: "pass", evidence: "Posting skills (" + jdSkills.join(", ") + ") — your résumé covers " +
    (have.length ? have.join(", ") : "the posting's general domain") +
    (missing.length ? "; gaps: " + missing.join(", ") + " (not core — the sweep files through minor gaps)" : "") + "." };
}
/* The secondary check, in the sweep's canonical rule order. Every
   disposition carries all of these; buildCheck fills any rule the
   judgment did not reach with an honest grey. */
const CANON_RULES = ["full JD read", "experience alignment", "duplicate check",
  "employer exclusions", "100% remote US", "pay band", "posting freshness",
  "tailored resume", "veteran answer", "screening answers", "pre-sales bar",
  "filing proof", "hands-on duties"];
function buildCheck(verdict, byName) {
  return { verdict, rules: CANON_RULES.map((n) => byName[n] ||
    { rule: n, status: "grey", evidence: "Not reached — an earlier gate decided this posting." }) };
}

/* ---------------- employer → ATS board resolution ---------------- */
const LEGAL_SUFFIXES = new Set(["inc", "llc", "corp", "corporation", "company", "co", "ltd", "limited", "llp", "lp", "pc", "pllc"]);
function normalizeEmployerName(name) {
  let s = String(name || "").toLowerCase().replace(/&/g, " and ").replace(/[.,'"®™()]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.startsWith("the ")) s = s.slice(4);
  const words = s.split(" ").filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}
/* Well-known employers whose board slug is not the obvious normalization. */
const CURATED_SLUGS = {
  "target": "target", "target corporation": "target",
  "best buy": "bestbuy",
  "stripe": "stripe", "coinbase": "coinbase", "airbnb": "airbnb",
  "doordash": "doordash", "shopify": "shopify", "spotify": "spotify",
  "netflix": "netflix", "uber": "uber", "lyft": "lyft",
  "gitlab": "gitlab", "datadog": "datadog", "cloudflare": "cloudflare",
  "figma": "figma", "asana": "asana", "dropbox": "dropbox",
  "hubspot": "hubspot", "zendesk": "zendesk",
};
function slugCandidates(employer) {
  const norm = normalizeEmployerName(employer);
  const out = [];
  const pushCand = (c) => { if (c && !out.includes(c)) out.push(c); };
  if (CURATED_SLUGS[norm]) pushCand(CURATED_SLUGS[norm]);
  pushCand(norm.replace(/\s+/g, ""));
  pushCand(norm.replace(/\s+/g, "-"));
  pushCand(norm.split(" ")[0]);
  return out;
}
function isPlaceholderSite(site) {
  const s = String(site || "");
  return /career pages/i.test(s) || s.includes("…") || /^employer career/i.test(s) || /^job boards/i.test(s);
}

async function fetchJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "get-me-a-job-engine/1.0" } });
    if (res.status !== 200) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
/* Try Greenhouse → Lever → Ashby for each slug candidate. First board that
   answers 200 with a jobs array wins. Returns { source, slug, postings } or null. */
async function resolveBoard(employer) {
  for (const slug of slugCandidates(employer)) {
    const gh = await fetchJSON("https://boards-api.greenhouse.io/v1/boards/" + encodeURIComponent(slug) + "/jobs");
    if (gh && Array.isArray(gh.jobs)) {
      return { source: "Greenhouse", slug, postings: gh.jobs.map((j) => ({
        company: employer, title: j.title || "", location: (j.location && j.location.name) || "",
        url: j.absolute_url || "", description: "", atsId: j.id,
        posted_at: toISODate(j.created_at || j.updated_at) })) };
    }
    const lv = await fetchJSON("https://api.lever.co/v0/postings/" + encodeURIComponent(slug) + "?mode=json");
    if (Array.isArray(lv)) {
      return { source: "Lever", slug, postings: lv.map((p) => ({
        company: employer, title: p.text || "", location: (p.categories && p.categories.location) || "",
        url: p.hostedUrl || p.applyUrl || "",
        description: p.descriptionPlain || htmlToText(p.description || ""),
        posted_at: toISODate(p.createdAt) })) };
    }
    const ab = await fetchJSON("https://api.ashbyhq.com/posting-api/job-board/" + encodeURIComponent(slug));
    if (ab && Array.isArray(ab.jobs)) {
      return { source: "Ashby", slug, postings: ab.jobs.map((j) => ({
        company: employer, title: j.title || "", location: j.locationName || (j.location && j.location.name) || "",
        url: j.jobUrl || j.applyUrl || "",
        description: j.descriptionPlain || htmlToText(j.descriptionHtml || ""),
        posted_at: toISODate(j.publishedAt || j.createdAt) })) };
    }
  }
  return null;
}
/* Greenhouse list payloads carry no description; fetch the job detail for
   postings that passed the title screen so remote/pay rules can be judged.
   ctx.detailBudget caps detail fetches per board so one huge board cannot
   stall the run; past the cap, postings are judged on location alone. */
async function ensureDescription(posting, ctx) {
  if (!ctx || !ctx.board || posting.description) return;
  if (ctx.board.source !== "Greenhouse" || posting.atsId == null) return;
  if (ctx.detailBudget.count >= DETAIL_FETCH_CAP) return;
  ctx.detailBudget.count++;
  const detail = await fetchJSON("https://boards-api.greenhouse.io/v1/boards/" +
    encodeURIComponent(ctx.board.slug) + "/jobs/" + encodeURIComponent(posting.atsId));
  if (detail && detail.content) posting.description = htmlToText(detail.content);
}

/* ---------------- free keyless feeds (queried once per run) ---------------- */
async function fetchFeeds() {
  const out = [];
  const ro = await fetchJSON("https://remoteok.com/api");
  if (Array.isArray(ro)) {
    for (const j of ro) {
      if (!j || !j.position || !j.company) continue; // first element(s) are metadata
      out.push({ company: j.company, title: j.position, location: j.location || "",
        url: j.url || "", description: htmlToText(j.description || ""), source: "RemoteOK",
        posted_at: toISODate(j.date),
        statedPay: (j.salary_max || j.salary_min) ? Math.max(j.salary_max || 0, j.salary_min || 0) : null });
    }
  } else log("RemoteOK feed unavailable — skipped.");
  const an = await fetchJSON("https://www.arbeitnow.com/api/job-board-api");
  if (an && Array.isArray(an.data)) {
    for (const j of an.data) {
      out.push({ company: j.company_name || "", title: j.title || "", location: j.location || "",
        url: j.url || "", description: htmlToText(j.description || ""),
        source: "Arbeitnow", remoteFlag: j.remote === true,
        posted_at: toISODate(j.created_at) });
    }
  } else log("Arbeitnow feed unavailable — skipped.");
  return out;
}

/* ---------------- run state ---------------- */
const engine = {
  runs: null, filings: null, activity: null, profile: null, coverage: null, rules: null,
  checkedThisRun: 0, leadsThisRun: 0, rejectedThisRun: 0, notEvaluatedThisRun: 0,
  dedupe: new Set(), newFilings: [], stopSeen: false,
};
/* Disposition identity is employer + title (normalized) — the sweep's
   dedupe rule. The same role re-posted under a new URL or route is the
   same lead: it is never dispositioned twice, and a role already in
   filings.json never resurfaces as a fresh lead. */
const filingKey = (company, role) =>
  [company, role].map((x) => String(x || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()).join("|");

function loadAll() {
  engine.profile = readData("profile");
  engine.coverage = readData("coverage");
  engine.rules = readData("rules");
  engine.runs = readData("runs");
  engine.filings = readData("filings");
  engine.activity = readData("activity");
  engine.dedupe = new Set((engine.filings.filings || []).map((f) => filingKey(f.company, f.role, f.url)));
}
function stageList(stateMap) {
  const S = (name, state, detail) => ({ name, state, detail: detail || "" });
  return [
    S("Preparing", stateMap.Preparing || "done", stateMap.PreparingDetail || "Saved titles, lanes and rules loaded."),
    S("Discovering", stateMap.Discovering || "queued", stateMap.DiscoveringDetail || ""),
    S("Evaluating", stateMap.Evaluating || "queued", stateMap.EvaluatingDetail || ""),
    S("Filing", stateMap.Filing || "queued", stateMap.FilingDetail || ""),
    S("Closeout", stateMap.Closeout || "queued", stateMap.CloseoutDetail || ""),
  ];
}
function initLaneEntry(lane) {
  const entry = clone(lane);
  if (lane.kind === "board") {
    entry.done = 0; entry.total = 1; entry.status = "manual";
    entry.detail = "LinkedIn/Indeed/Dice searches run in your signed-in browser; the engine covers employer boards directly.";
  } else {
    const employers = (lane.sites || []).filter((s) => s && !isPlaceholderSite(s));
    entry.done = 0; entry.total = employers.length; entry.status = "queued"; entry.detail = "";
  }
  return entry;
}
/* Merge the engine's run state into a FRESH read of runs.json so page-written
   fields (lane_controls, requests) are never clobbered. Returns the fresh
   state's state value (so callers can detect a page-side Stop). */
function persistRuns() {
  const fresh = readData("runs");
  const freshState = fresh.state;
  // Remember a page-side Stop even if this write briefly restores "running":
  // the next stopRequested() will see stopSeen and close the run out.
  if (freshState === "stopped" && engine.runs.state === "running") engine.stopSeen = true;
  fresh.state = engine.runs.state;
  fresh.current_run = engine.runs.current_run;
  fresh.history = engine.runs.history;
  writeData("runs", fresh);
  engine.runs = fresh;
  return freshState;
}
function persistFilings() {
  const fresh = readData("filings");
  const ids = new Set((fresh.filings || []).map((f) => f.id));
  for (const f of engine.newFilings) if (!ids.has(f.id)) (fresh.filings = fresh.filings || []).push(f);
  writeData("filings", fresh);
  engine.filings = fresh;
}
/* Mirrors the app's logActivity: fresh read, unshift, cap 400, write through
   immediately (a later re-read must never clobber the new entry). */
function logActivityEntry(kind, message) {
  const fresh = readData("activity");
  fresh.entries = Array.isArray(fresh.entries) ? fresh.entries : [];
  fresh.entries.unshift({ id: uid("act"), at: nowISO(), kind: kind || "info", message: String(message || "") });
  fresh.entries = fresh.entries.slice(0, 400);
  engine.activity = fresh;
  writeData("activity", fresh);
}
function commitProgress(message) {
  persistRuns();
  persistFilings();
  commitData(message || "hunt: progress");
}
/* Stop check: re-read runs.json from disk (after a pull). Returns true when
   the page has set state "stopped" — the run must close out and exit. */
function stopRequested() {
  if (engine.stopSeen) return true;
  pullLatest();
  const fresh = readData("runs");
  return fresh.state === "stopped";
}
function stopCloseout() {
  const cur = engine.runs.current_run;
  if (cur) {
    cur.ended_at = nowISO();
    cur.engine_updated_at = nowISO();
    cur.stages = (cur.stages || []).map((s) =>
      s.state === "done" ? s : { name: s.name, state: "stopped", detail: s.name === "Closeout" ? "Run stopped." : (s.detail || "Run stopped.") });
    engine.runs.history = Array.isArray(engine.runs.history) ? engine.runs.history : [];
    if (!engine.runs.history.some((h) => h.id === cur.id)) engine.runs.history.unshift(cur);
  }
  engine.runs.current_run = null;
  engine.runs.state = "stopped";
  logActivityEntry("run", "Hunt engine run stopped: " + engine.checkedThisRun + " postings checked, " +
    engine.leadsThisRun + " ready-to-apply leads, " + engine.rejectedThisRun + " rejected" +
    (engine.notEvaluatedThisRun ? ", " + engine.notEvaluatedThisRun + " not evaluated (full posting text unavailable)" : "") + ".");
  persistRuns();       // keeps state "stopped"
  persistFilings();
  commitData("hunt: run stopped");
  if (pushPending) push();
  log("Run stopped by the page — closed out and exiting.");
}

/* ---------------- evaluation ---------------- */
function addFiling(f) {
  engine.newFilings.push(f);
  engine.dedupe.add(filingKey(f.company, f.role, f.url));
  if (f.status === "parked") engine.leadsThisRun++;
  if (f.status === "rejected") engine.rejectedThisRun++;
}
/* ---------------- evaluation — the sweep discipline ----------------
   Gate facts (excluded employer, always-reject term) reject on sight,
   exactly as in the sweep — posting-intrinsic facts are the one
   exception to JD-first, and the check says so honestly. Everything
   else is judged only after the FULL posting text has been read. */
function gateReject(base, category, reason, failName, failEvidence, jdEvidence) {
  const R = {};
  R["duplicate check"] = { rule: "duplicate check", status: "pass",
    evidence: "No earlier disposition for " + base.company + " — " + base.role +
      " in filings.json (employer + title identity)." };
  if (jdEvidence) R["full JD read"] = { rule: "full JD read", status: "pass", evidence: jdEvidence };
  const extra = [];
  if (CANON_RULES.includes(failName)) R[failName] = { rule: failName, status: "fail", evidence: failEvidence };
  else extra.push({ rule: failName, status: "fail", evidence: failEvidence });
  const check = buildCheck("rejected", R);
  for (const e of extra) check.rules.push(e);
  return { ...base, status: "rejected", category, reason, check };
}

/* Judge one posting whose FULL text has been read. Pure with respect
   to run state (no counters, no writes), so the workaround pass can
   judge a second copy of the same role. Returns the disposition. */
function judgePosting(posting, source, matchedTitle) {
  const rules = engine.rules;
  const jd = String(posting.description || "");
  const now = nowISO();
  const base = { id: uid("fil"), company: posting.company, role: posting.title, where: source,
    filed_at: now, date: now.slice(0, 10), url: posting.url || undefined };
  if (posting.posted_at) base.posted_at = posting.posted_at;
  const R = {};
  const set = (name, status, evidence) => { R[name] = { rule: name, status, evidence }; };

  set("full JD read", "pass", "Full posting text read (" + jd.length + " characters) before any verdict — " +
    "never a judgment from a title or snippet. Matches your saved title \u201C" + matchedTitle + "\u201D. " +
    "Core text: \u201C" + firstDutyQuote(jd) + "\u201D");
  set("duplicate check", "pass", "No earlier disposition for " + posting.company + " — " + posting.title +
    " in filings.json (employer + title identity).");
  set("employer exclusions", "pass", posting.company + " is not on your excluded-employer list.");

  /* 100% remote US — the sweep's remote-language rule. */
  const rem = remoteVerdict(posting, jd);
  if (rules.remote_only) set("100% remote US", rem.ok ? "pass" : "fail", rem.evidence);
  else set("100% remote US", "grey", "Remote-only rule is off in your rules. " + rem.evidence);

  /* Pay band — the TOP of the published range must sit inside the
     band; unpublished pay is always eligible. */
  const minAnnual = parseMinimumPay(rules.minimum_pay);
  const maxAnnual = parseMinimumPay(rules.maximum_pay);
  const top = posting.statedPay != null
    ? { annual: posting.statedPay, raw: money(posting.statedPay), hourly: false }
    : parsePayTop(jd);
  let payFail = false;
  if (!top) {
    set("pay band", (minAnnual == null && maxAnnual == null) ? "grey" : "pass",
      (minAnnual == null && maxAnnual == null)
        ? "No pay band set in your rules, and no pay stated in the posting."
        : "No pay stated in the posting — unpublished pay stays eligible under your band.");
  } else if (minAnnual != null && top.annual < minAnnual) {
    payFail = true;
    set("pay band", "fail", "Posting tops out at " + top.raw + " (\u2248 " + money(top.annual) +
      "/yr); your band floor is " + money(minAnnual) + "/yr.");
  } else if (maxAnnual != null && top.annual > maxAnnual) {
    payFail = true;
    set("pay band", "fail", "Posting tops out at " + top.raw + " (\u2248 " + money(top.annual) +
      "/yr); your band ceiling is " + money(maxAnnual) + "/yr.");
  } else {
    set("pay band", "pass", "Posting tops out at " + top.raw + " (\u2248 " + money(top.annual) + "/yr) — inside your band" +
      (minAnnual != null ? " (floor " + money(minAnnual) + ")" : "") +
      (maxAnnual != null ? " (ceiling " + money(maxAnnual) + ")" : "") + ".");
  }

  /* Posting freshness — eligibility window; dateless postings are
     dated from discovery, as the sweep dates ATS pages. */
  const maxAge = Number(rules.posting_max_age_days);
  const age = postingAgeDays(posting.posted_at);
  const postedDate = posting.posted_at ? String(posting.posted_at).slice(0, 10) : "";
  let stale = false;
  if (!(maxAge > 0)) set("posting freshness", "grey", "No posting-age limit set in your rules.");
  else if (age == null) set("posting freshness", "pass", "The board publishes no posting date — treated as " +
    "current, found " + now.slice(0, 10) + " (dateless postings are dated from discovery).");
  else if (age > maxAge) {
    stale = true;
    set("posting freshness", "fail", "Posted " + postedDate + " — " + age +
      " days old; your eligibility window is " + maxAge + " days.");
  } else set("posting freshness", "pass", "Posted " + postedDate + " — " + age +
    " day(s) old, inside your " + maxAge + "-day window.");

  /* Hands-on duties — whole-role test. */
  let handsOnQuote = "";
  if (rules.block_hands_on === false) {
    set("hands-on duties", "grey", "Hands-on duties bar is off in your rules.");
  } else {
    handsOnQuote = signalHit(jd, HANDS_ON_RES);
    set("hands-on duties", handsOnQuote ? "fail" : "pass", handsOnQuote
      ? "The role's core duties are hands-on execution: \u201C" + handsOnQuote + "\u201D"
      : "No whole-role hands-on execution duties in the posting text.");
  }

  /* Pre-sales bar — a quoted CORE sales duty only. */
  let presalesQuote = "";
  if (rules.block_presales !== true) {
    set("pre-sales bar", "grey", "Pre-sales bar is off in your rules.");
  } else {
    presalesQuote = signalHit(jd, PRESALES_RES);
    set("pre-sales bar", presalesQuote ? "fail" : "pass", presalesQuote
      ? "Core sales duty in the posting: \u201C" + presalesQuote + "\u201D"
      : "No core sales duties (quota / pipeline / win strategy) in the posting text.");
  }

  /* Experience alignment against the résumé. */
  const exp = experienceVerdict(jd);
  set("experience alignment", exp.status, exp.evidence);

  /* Filing-stage rules — honest greys at evaluation time. */
  set("tailored resume", "grey", "Applies when you apply: tailor your résumé to this posting's duties first — the engine never submits applications.");
  set("veteran answer", "grey", "Screening questions are answered by you inside the employer's form; the engine never answers them.");
  set("screening answers", "grey", "Your saved answers live in the app (the answers step) for you to use in the employer's form.");
  set("filing proof", "grey", "No submission yet — this point is checked when an application is filed.");

  /* Adjudication — first failing gate in sweep order names the reject. */
  const fails = [];
  if (rules.remote_only && !rem.ok) fails.push(["not-remote", "Not remote — " + rem.evidence]);
  if (payFail) fails.push(["pay-outside-band", "Pay outside your band — posting tops out at " +
    top.raw + " (\u2248 " + money(top.annual) + "/yr)."]);
  if (stale) fails.push(["stale-posting", "Stale posting — posted " + postedDate + ", " +
    age + " days old (your window: " + maxAge + " days)."]);
  if (handsOnQuote) fails.push(["hands-on-duties", "Hands-on role — core duties are hands-on execution: \u201C" + handsOnQuote + "\u201D"]);
  if (presalesQuote) fails.push(["pre-sales", "Pre-sales role — core sales duty: \u201C" + presalesQuote + "\u201D"]);
  if (exp.status === "fail") fails.push(["experience-mismatch", "Experience mismatch — the posting's core requirements are absent from your résumé."]);

  if (fails.length) {
    for (const n of ["tailored resume", "veteran answer", "screening answers", "filing proof"]) {
      set(n, "grey", "Not applicable — the posting was rejected before filing.");
    }
    return { ...base, status: "rejected", category: fails[0][0], reason: fails[0][1],
      check: buildCheck("rejected", R) };
  }
  return { ...base, status: "parked",
    reason: "Ready to apply — matches your saved title \u201C" + matchedTitle + "\u201D and passed every " +
      "rule in the secondary check. Open the posting, apply, then record it as filed.",
    check: buildCheck("ready", R) };
}

const JUDGMENT_CATEGORIES = new Set(["not-remote", "pay-outside-band", "stale-posting",
  "hands-on-duties", "pre-sales", "experience-mismatch"]);

/* Workarounds before a judgment reject stands (the sweep's rule): an
   aggregator listing's facts are surface-reported, so the employer's
   own board copy of the same role is checked and its text governs. */
async function workaroundPass(posting, source, matchedTitle, original) {
  const note = (status, evidence) => ({ rule: "workarounds tried", status, evidence });
  try {
    const resolver = engine.boardResolver || resolveBoard;
    const board = await resolver(posting.company);
    if (board) {
      const bp = (board.postings || []).find((b) => titleCore(b.title) === titleCore(posting.title));
      if (bp) {
        const bctx = { board, detailBudget: { count: 0 } };
        await ensureDescription(bp, bctx);
        if (bp.description && String(bp.description).trim()) {
          const bf = judgePosting(bp, board.source, matchedTitle);
          bf.check.rules.push(note("pass", "Judged first from the " + source + " listing; the employer's own " +
            board.source + " board posting for the same role was then read and governs this verdict."));
          if (bf.status === "parked") {
            bf.reason = "Ready to apply — the employer's own " + board.source + " board confirms this role " +
              "passes every rule (the " + source + " listing did not). Matches your saved title \u201C" + matchedTitle + "\u201D.";
          }
          return bf;
        }
      }
      original.check.rules.push(note("pass", "Employer's own board (" + board.source + ") checked for the " +
        "same role — no governing copy could be read; the reject stands on the " + source + " text."));
      return original;
    }
    original.check.rules.push(note("pass", "Employer's own board checked — no public board found for " +
      posting.company + "; alternate routes checked: none available. The reject stands on the " + source + " text."));
    return original;
  } catch (e) {
    original.check.rules.push(note("grey", "Employer-board workaround check failed (" +
      String(e && e.message || e).slice(0, 80) + ") — the reject stands on the " + source + " text."));
    return original;
  }
}

async function evaluatePosting(posting, source, ctx) {
  const cur = engine.runs.current_run;
  cur.evaluated_extra = (cur.evaluated_extra || 0) + 1;
  engine.checkedThisRun++;
  const rules = engine.rules;
  const savedTitles = (engine.coverage.saved && engine.coverage.saved.titles) || [];

  const matchedTitle = titleMatches(posting.title, savedTitles);
  if (!matchedTitle) return; // not one of the user's titles — ignored silently

  const key = filingKey(posting.company, posting.title);
  if (engine.dedupe.has(key)) return; // already dispositioned (employer + title identity)

  const now = nowISO();
  const base = { id: uid("fil"), company: posting.company, role: posting.title, where: source,
    filed_at: now, date: now.slice(0, 10), url: posting.url || undefined };
  if (posting.posted_at) base.posted_at = posting.posted_at;

  /* Gate facts reject on sight — the sweep's posting-intrinsic exception. */
  const excluded = ((engine.profile.employers && engine.profile.employers.excluded) || [])
    .some((e) => String(e).trim().toLowerCase() === String(posting.company).trim().toLowerCase());
  if (excluded) {
    addFiling(gateReject(base, "employer-excluded",
      "Excluded employer — " + posting.company + " is on your excluded-employer list.",
      "employer exclusions", posting.company + " appears in profile.json employers.excluded."));
    return;
  }
  const titleKw = (rules.always_reject || []).find((kw) => kw &&
    posting.title.toLowerCase().includes(String(kw).trim().toLowerCase()));
  if (titleKw) {
    addFiling(gateReject(base, "always-reject",
      "Matches your always-reject list: " + titleKw,
      "always-reject list", "Title contains \u201C" + titleKw + "\u201D."));
    return;
  }

  await ensureDescription(posting, ctx);
  if (!posting.description || !String(posting.description).trim()) {
    /* JD-first discipline: a posting whose full text cannot be loaded
       is NOT EVALUATED — never rejected or parked from a snippet. */
    engine.notEvaluatedThisRun++;
    return;
  }
  const jdText = String(posting.description);
  const jdKw = (rules.always_reject || []).find((kw) => kw &&
    jdText.toLowerCase().includes(String(kw).trim().toLowerCase()));
  if (jdKw) {
    const idx = jdText.toLowerCase().indexOf(String(jdKw).trim().toLowerCase());
    const quote = sentenceWith(jdText, new RegExp(String(jdKw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")) ||
      jdText.slice(Math.max(0, idx - 40), idx + 120).trim();
    addFiling(gateReject(base, "always-reject",
      "Matches your always-reject list: " + jdKw,
      "always-reject list", "Posting text contains \u201C" + jdKw + "\u201D: \u201C" + quote + "\u201D",
      "Full posting text read (" + jdText.length + " characters) before this verdict."));
    return;
  }

  let filing = judgePosting(posting, source, matchedTitle);
  if (filing.status === "rejected" && JUDGMENT_CATEGORIES.has(filing.category) &&
      (source === "RemoteOK" || source === "Arbeitnow")) {
    filing = await workaroundPass(posting, source, matchedTitle, filing);
  }
  addFiling(filing);
}

/* Parks left behind by looser matching that no longer match the saved
   titles under the current matcher are not leads — remove them, so a
   fixed matcher also cleans the dashboard it already polluted. Only
   parked rows are touched; filed rows are history and never move. */
function pruneStaleParks() {
  const savedTitles = (engine.coverage.saved && engine.coverage.saved.titles) || [];
  if (!savedTitles.length || !engine.filings || !Array.isArray(engine.filings.filings)) return 0;
  const before = engine.filings.filings.length;
  engine.filings.filings = engine.filings.filings.filter((f) =>
    !f || f.status !== "parked" || titleMatches(f.role, savedTitles) != null);
  const removed = before - engine.filings.filings.length;
  if (removed > 0) {
    engine.dedupe = new Set(engine.filings.filings.map((f) => filingKey(f.company, f.role, f.url)));
    logActivityEntry("run", "Removed " + removed + " previously parked lead(s) that do not match your saved titles under the current title matcher.");
    log("Pruned " + removed + " stale parked lead(s).");
  }
  return removed;
}

/* ---------------- main ---------------- */
async function main() {
  if (!fs.existsSync(DATA_DIR)) { log("No data/ directory in this repo — nothing to do."); return; }
  ensureGitIdentity();
  loadAll();
  pruneStaleParks();

  /* 1 — pick up or create the run */
  let cur = engine.runs.current_run;
  if (!cur) {
    const saved = engine.coverage.saved || { titles: [], lanes: [] };
    cur = { id: "run-" + Date.now(), started_at: nowISO(),
      titles: clone(saved.titles || []), lanes: (saved.lanes || []).map(initLaneEntry), evaluated_extra: 0 };
    engine.runs.current_run = cur;
  } else {
    cur.lanes = (cur.lanes || []).map((l) =>
      (typeof l.done === "number" && typeof l.total === "number") ? l : initLaneEntry(l));
    if (typeof cur.evaluated_extra !== "number") cur.evaluated_extra = 0;
  }
  engine.runs.state = "running";
  cur.engine_updated_at = nowISO();
  cur.stages = stageList({ Discovering: "active", DiscoveringDetail: "Searching employer job boards." });
  commitProgress("hunt: run started");
  log("Run " + cur.id + " started: " + (cur.titles || []).length + " titles, " + cur.lanes.length + " lanes.");

  /* 2–3 — lanes */
  for (const lane of cur.lanes) {
    if (stopRequested()) { stopCloseout(); return; }
    if (lane.kind === "board") {
      // Already initialised as manual at pickup; nothing to search server-side.
      log("Board lane “" + lane.name + "” marked manual (no keyless server API).");
      continue;
    }
    lane.status = "searching";
    const employers = (lane.sites || []).filter((s) => s && !isPlaceholderSite(s));
    const results = [];
    for (const employer of employers) {
      try {
        const board = await resolveBoard(employer);
        if (board) {
          const postings = board.postings.slice(0, BOARD_POSTING_CAP);
          const ctx = { board, detailBudget: { count: 0 } };
          for (const p of postings) await evaluatePosting(p, board.source, ctx);
          results.push(employer + ": " + board.source + " board found — " + postings.length + " postings checked");
        } else {
          results.push(employer + ": no public board found");
        }
      } catch (e) {
        results.push(employer + ": lookup failed (" + String(e && e.message || e).slice(0, 80) + ")");
        log("Employer " + employer + " failed: " + (e && e.message || e));
      }
      lane.done = (lane.done || 0) + 1;
      lane.detail = results[results.length - 1];
      cur.engine_updated_at = nowISO();
      if (stopRequested()) { stopCloseout(); return; }
      commitProgress("hunt: progress");
    }
    lane.status = "done";
    lane.detail = results.join(" · ") || "No employer career pages to check in this lane.";
    cur.engine_updated_at = nowISO();
    commitProgress("hunt: progress");
    if (stopRequested()) { stopCloseout(); return; }
    log("Lane “" + lane.name + "” done: " + lane.detail);
  }

  /* 3b — free feeds, once per run */
  if (stopRequested()) { stopCloseout(); return; }
  try {
    const feedPostings = await fetchFeeds();
    for (const p of feedPostings) await evaluatePosting(p, p.source, null);
    log("Feeds checked: " + feedPostings.length + " postings.");
  } catch (e) {
    log("Feed pass failed (skipped): " + (e && e.message || e));
  }

  /* 7 — finish */
  cur.stages = stageList({
    Discovering: "done", DiscoveringDetail: "Every saved lane checked.",
    Evaluating: "done", EvaluatingDetail: "Postings were evaluated as they were found, against your saved titles and rules.",
    Filing: "done", FilingDetail: "Ready-to-apply leads queued in Parked — submissions happen in your browser.",
    Closeout: "active", CloseoutDetail: "Saving the run record." });
  cur.engine_updated_at = nowISO();
  commitProgress("hunt: progress");

  cur.ended_at = nowISO();
  cur.stages = stageList({
    Discovering: "done", DiscoveringDetail: "Every saved lane checked.",
    Evaluating: "done", EvaluatingDetail: "Postings were evaluated as they were found, against your saved titles and rules.",
    Filing: "done", FilingDetail: "Ready-to-apply leads queued in Parked — submissions happen in your browser.",
    Closeout: "done", CloseoutDetail: "Run record saved to runs.json." });
  engine.runs.history = Array.isArray(engine.runs.history) ? engine.runs.history : [];
  if (!engine.runs.history.some((h) => h.id === cur.id)) engine.runs.history.unshift(cur);
  engine.runs.current_run = null;
  engine.runs.state = "idle";
  logActivityEntry("run", "Hunt engine run complete: " + engine.checkedThisRun + " postings checked, " +
    engine.leadsThisRun + " ready-to-apply leads, " + engine.rejectedThisRun + " rejected" +
    (engine.notEvaluatedThisRun ? ", " + engine.notEvaluatedThisRun + " not evaluated (full posting text unavailable — never judged from a snippet)" : "") + ".");
  persistRuns();
  persistFilings();
  commitData("hunt: run complete");
  if (pushPending) push(); // final push retried once
  log("Run complete: " + engine.checkedThisRun + " checked, " + engine.leadsThisRun + " leads, " + engine.rejectedThisRun + " rejected.");
}

const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  main().catch((e) => {
    console.error("[hunt] Fatal: " + (e && e.stack || e));
    try { if (pushPending) push(); } catch (_) { /* nothing more to do */ }
    process.exit(1);
  });
}
/* Test hooks — used only by tests/engine-logic.test.mjs. The GitHub
   Actions workflow runs the file as main and never touches these. */
export const __test = { engine, titleCore, titleMatches, locationBlocksUS,
  hasRemoteSignal, parseMinimumPay, parsePostingMaxPay, parsePayTop,
  postingAgeDays, toISODate, signalHit, HANDS_ON_RES, PRESALES_RES,
  remoteVerdict, experienceVerdict, judgePosting, evaluatePosting,
  gateReject, buildCheck, CANON_RULES, filingKey };
