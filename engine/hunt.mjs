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
    case "rules": return { remote_only: true, minimum_pay: "", focus_sectors: [], always_reject: [],
      extra_notes: "", updated_at: "" };
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
/* A posting matches a saved title when they share ≥2 significant tokens,
   or share the saved title's head/family word (its last significant token,
   e.g. "analyst" in "Data Analyst" — "Business Analyst" qualifies). */
function titleMatches(postingTitle, savedTitles) {
  const pToks = significantTokens(postingTitle);
  const pSet = new Set(pToks);
  for (const saved of savedTitles || []) {
    const sToks = significantTokens(saved);
    if (!sToks.length) continue;
    const shared = sToks.filter((t) => pSet.has(t)).length;
    if (shared >= 2) return saved;
    const family = sToks[sToks.length - 1];
    if (family.length >= 4 && pSet.has(family)) return saved;
  }
  return null;
}
function hasRemoteSignal(location, text) {
  return /\b(remote|work from home|work-from-home|wfh|distributed|telecommut|work from anywhere|anywhere)\b/i
    .test(String(location || "") + " " + String(text || ""));
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
/* Highest stated annual pay in a posting's text, or null when no pay is stated. */
function parsePostingMaxPay(text) {
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
      if (best == null || annual > best) best = annual;
    }
  }
  return best;
}
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");

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
        url: j.absolute_url || "", description: "", atsId: j.id })) };
    }
    const lv = await fetchJSON("https://api.lever.co/v0/postings/" + encodeURIComponent(slug) + "?mode=json");
    if (Array.isArray(lv)) {
      return { source: "Lever", slug, postings: lv.map((p) => ({
        company: employer, title: p.text || "", location: (p.categories && p.categories.location) || "",
        url: p.hostedUrl || p.applyUrl || "",
        description: p.descriptionPlain || htmlToText(p.description || "") })) };
    }
    const ab = await fetchJSON("https://api.ashbyhq.com/posting-api/job-board/" + encodeURIComponent(slug));
    if (ab && Array.isArray(ab.jobs)) {
      return { source: "Ashby", slug, postings: ab.jobs.map((j) => ({
        company: employer, title: j.title || "", location: j.locationName || (j.location && j.location.name) || "",
        url: j.jobUrl || j.applyUrl || "",
        description: j.descriptionPlain || htmlToText(j.descriptionHtml || "") })) };
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
        statedPay: (j.salary_max || j.salary_min) ? Math.max(j.salary_max || 0, j.salary_min || 0) : null });
    }
  } else log("RemoteOK feed unavailable — skipped.");
  const an = await fetchJSON("https://www.arbeitnow.com/api/job-board-api");
  if (an && Array.isArray(an.data)) {
    for (const j of an.data) {
      out.push({ company: j.company_name || "", title: j.title || "", location: j.location || "",
        url: j.url || "", description: htmlToText(j.description || ""),
        source: "Arbeitnow", remoteFlag: j.remote === true });
    }
  } else log("Arbeitnow feed unavailable — skipped.");
  return out;
}

/* ---------------- run state ---------------- */
const engine = {
  runs: null, filings: null, activity: null, profile: null, coverage: null, rules: null,
  checkedThisRun: 0, leadsThisRun: 0, rejectedThisRun: 0,
  dedupe: new Set(), newFilings: [], stopSeen: false,
};
const filingKey = (company, role, url) =>
  [company, role, url].map((x) => String(x || "").trim().toLowerCase()).join("|");

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
    engine.leadsThisRun + " ready-to-apply leads, " + engine.rejectedThisRun + " rejected.");
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
async function evaluatePosting(posting, source, ctx) {
  const cur = engine.runs.current_run;
  cur.evaluated_extra = (cur.evaluated_extra || 0) + 1;
  engine.checkedThisRun++;
  const rules = engine.rules;
  const savedTitles = (engine.coverage.saved && engine.coverage.saved.titles) || [];

  const matchedTitle = titleMatches(posting.title, savedTitles);
  if (!matchedTitle) return; // not one of the user's titles — ignored silently

  const excluded = ((engine.profile.employers && engine.profile.employers.excluded) || [])
    .some((e) => String(e).trim().toLowerCase() === String(posting.company).trim().toLowerCase());
  if (excluded) return; // excluded employer — skipped silently

  const key = filingKey(posting.company, posting.title, posting.url);
  if (engine.dedupe.has(key)) return; // already recorded in an earlier run

  const now = nowISO();
  const base = { id: uid("fil"), company: posting.company, role: posting.title, where: source,
    filed_at: now, date: now.slice(0, 10), url: posting.url || undefined };

  const rejectKw = (rules.always_reject || []).find((kw) => kw &&
    posting.title.toLowerCase().includes(String(kw).trim().toLowerCase()));
  if (rejectKw) {
    addFiling({ ...base, status: "rejected",
      reason: "Matches your always-reject list: " + rejectKw,
      check: { verdict: "rejected", rules: [
        { rule: "Always-reject list", status: "fail", evidence: "Title contains “" + rejectKw + "”" },
        { rule: "Title matches your saved titles", status: "pass", evidence: posting.title } ] } });
    return;
  }

  await ensureDescription(posting, ctx);
  const remote = posting.remoteFlag === true || hasRemoteSignal(posting.location, posting.description);

  if (rules.remote_only && !remote) {
    addFiling({ ...base, status: "rejected", reason: "Not remote",
      check: { verdict: "rejected", rules: [
        { rule: "Remote-only", status: "fail", evidence: "Location: " + (posting.location || "not stated") + " — no remote signal in the posting" },
        { rule: "Title matches your saved titles", status: "pass", evidence: posting.title } ] } });
    return;
  }

  const minAnnual = parseMinimumPay(rules.minimum_pay);
  const maxPay = posting.statedPay != null ? posting.statedPay : parsePostingMaxPay(posting.description);
  if (minAnnual != null && maxPay != null && maxPay < minAnnual) {
    addFiling({ ...base, status: "rejected", reason: "Pay below your minimum",
      check: { verdict: "rejected", rules: [
        { rule: "Minimum pay", status: "fail", evidence: "Posting tops out at " + money(maxPay) + "/yr; your minimum is " + money(minAnnual) + "/yr" },
        { rule: "Title matches your saved titles", status: "pass", evidence: posting.title } ] } });
    return;
  }

  addFiling({ ...base, status: "parked",
    reason: "Ready to apply — found by the hunt engine on " + source + ". Open the posting, apply, then record it as filed.",
    check: { verdict: "ready", rules: [
      { rule: "Title matches your saved titles", status: "pass", evidence: posting.title },
      { rule: "Remote-only", status: remote ? "pass" : "grey",
        evidence: remote ? ("Remote — " + (posting.location || "posting states remote work"))
                         : (rules.remote_only ? "Remote confirmed" : "Remote-only rule is off; location: " + (posting.location || "not stated")) },
      { rule: "Minimum pay", status: (minAnnual != null && maxPay != null) ? "pass" : "grey",
        evidence: (minAnnual != null && maxPay != null)
          ? ("Posting tops out at " + money(maxPay) + "/yr; your minimum is " + money(minAnnual) + "/yr")
          : (minAnnual == null ? "No minimum pay set" : "No pay stated in the posting") } ] } });
}

/* ---------------- main ---------------- */
async function main() {
  if (!fs.existsSync(DATA_DIR)) { log("No data/ directory in this repo — nothing to do."); return; }
  ensureGitIdentity();
  loadAll();

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
    engine.leadsThisRun + " ready-to-apply leads, " + engine.rejectedThisRun + " rejected.");
  persistRuns();
  persistFilings();
  commitData("hunt: run complete");
  if (pushPending) push(); // final push retried once
  log("Run complete: " + engine.checkedThisRun + " checked, " + engine.leadsThisRun + " leads, " + engine.rejectedThisRun + " rejected.");
}

main().catch((e) => {
  console.error("[hunt] Fatal: " + (e && e.stack || e));
  try { if (pushPending) push(); } catch (_) { /* nothing more to do */ }
  process.exit(1);
});
