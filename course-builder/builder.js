// builder.js
//
// The Course Builder page. All of the logic that touches the file lives in ./format/hssweek.js;
// this file is the screens, the drag and drop, and the wiring between them. Nothing here talks
// to a server: the only requests are the page's own files. The week in progress is saved to
// this browser only (localStorage, or IndexedDB when that is full) so a refresh does not lose
// it; Clear draft deletes it. Children's names live in `state.names`, a separate object keyed by
// lane id that is used for lane labels on screen and handed to readyChecks (which only reads
// it). The week object never carries them, and the saved draft never does either.

import * as H from "./format/hssweek.js";
import { lessonsDoneShouldPlay, mountMarkTally, playLessonsDone, syncMarkTally } from "./mark-tally.js?v=20261007b";

// MARK: - State

const state = {
  week: null,
  names: {},            // { laneId: firstName }: on screen only, never in the file
  courseDefaults: null, // format/course-defaults.json, loaded once
  titlePatterns: {},    // { courseId: "Lesson {n}" } from the grade band, for pattern fill
  suggestedCredits: {}, // { courseId: 0.5 }: the credits a grade-band suggestion came with (fix 11); page and draft only
  ui: {
    screen: 0,
    selectedCourseId: null,
    workspaceCourseId: null,
    placingCourseId: null,
    activeLaneIndex: 0,
    openDayMenu: null,
    preview: { laneId: null, day: "mon", weekIndex: 0, startOn: null },
    workspace: { selectedRow: null, selectedField: "title", toc: null, replace: false },
    downloaded: false,
    changedSinceDownload: false,
    allowedNames: [],      // names she said aren't names, this visit only; never saved or written
    saveFailed: false,
    saveStale: false,
    lastSavedAt: null,
    undoReplace: null,     // JSON of the courses before the last "Replace with the color"
    privateSession: false, // Start-screen box: nothing is written to this device
    reopened: false,       // the week came from "Open a file I made"
    lessonsSkipped: false, // "Skip for now" on the empty-courses question (the Lessons step counts as done)
    previewSeen: false,    // the Preview step has been looked at
    search: "",            // the lesson-title search, this screen only; never saved, never written
    openRow: null,         // the one lesson row open on a phone
    added: null,           // the "lessons added" moment: { text, indexes }
  },
};

// MARK: - The draft in this browser (Quarry's fix 1, Josh's go on October 6, 2026)

const DRAFT_KEY = "hss.courseBuilder.draft";
/** Set only when a draft had to go to IndexedDB (localStorage full), so the database is never opened otherwise (Quarry's BUG-20261006-13). */
const IDB_MARK = "hss.courseBuilder.idb";
const tabToken = crypto.randomUUID();
let saveTimer = null;

function idbInUse() {
  try { return localStorage.getItem(IDB_MARK) === "1"; } catch { return true; }
}

function idb(mode, fn) {
  return new Promise((resolve) => {
    if (!("indexedDB" in window)) { resolve(null); return; }
    try {
      const open = indexedDB.open("hss-course-builder", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("draft");
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction("draft", mode);
          const req = fn(tx.objectStore("draft"));
          req.onsuccess = () => resolve(req.result ?? true);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
    } catch { resolve(null); }
  });
}

/** The week and the title patterns, never the names. */
function draftPayload() {
  return { savedAt: new Date().toISOString(), tab: tabToken, rev: (state.ui.draftRev ?? 0) + 1, week: week(), titlePatterns: state.titlePatterns, suggestedCredits: state.suggestedCredits };
}

function readLocalDraft() {
  try { const text = localStorage.getItem(DRAFT_KEY); return text ? JSON.parse(text) : null; } catch { return null; }
}

async function readDraft() {
  return readLocalDraft() ?? (idbInUse() ? await idb("readonly", (store) => store.get("draft")) : null);
}

async function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
  if (idbInUse()) {
    await idb("readwrite", (store) => store.delete("draft"));
    try { localStorage.removeItem(IDB_MARK); } catch { /* keep going */ }
    try { indexedDB.deleteDatabase("hss-course-builder"); } catch { /* nothing to drop */ }
  }
  state.ui.lastSavedAt = null;
  state.ui.draftRev = 0;
  setSaveStatus("");
}

function setSaveStatus(text, tone = "") {
  const node = $("#save-status");
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
}

function scheduleSave() {
  if (!week() || state.ui.privateSession) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraftNow, 1000);
}

/** Another tab's newer draft: say so, offer to load it, and offer to keep this tab's work (fix 1, check 8). */
function goStale(stored) {
  state.ui.saveStale = true;
  const when = new Date(stored.savedAt);
  const node = $("#save-status");
  if (!node) return;
  node.replaceChildren(`This week was changed in another tab at ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. This tab is not saving. `,
    el("button", { type: "button", class: "cb-link-btn", onclick: () => location.reload() }, "Load the newer draft"), " \u00b7 ",
    el("button", { type: "button", class: "cb-link-btn", onclick: downloadCopy }, "Download this tab\u2019s copy"));
  node.dataset.tone = "warn";
}

/** The stored draft, from either store, when it is newer than what this tab loaded or saved. */
async function newerDraftElsewhere() {
  const stored = readLocalDraft() ?? (idbInUse() ? await idb("readonly", (store) => store.get("draft")) : null);
  if (!stored || stored.tab === tabToken) return null;
  const rev = Number(stored.rev ?? 0);
  // A tab that never loaded or saved a draft (draftRev undefined) must not write over one that exists.
  if (state.ui.draftRev === undefined || rev > (state.ui.draftRev ?? 0)) return stored;
  return null;
}

async function saveDraftNow() {
  if (!week() || state.ui.saveStale) return;
  const newer = await newerDraftElsewhere();
  if (newer) { goStale(newer); return; }
  const payload = draftPayload();
  setSaveStatus("Saving\u2026");
  let where = null;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(payload)); where = "local"; } catch { where = null; }
  if (!where) {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* keep going */ }
    where = (await idb("readwrite", (store) => store.put(payload, "draft"))) ? "idb" : null;
    if (where) { try { localStorage.setItem(IDB_MARK, "1"); } catch { /* the database is still read when localStorage is unusable */ } }
  }
  if (!where) {
    state.ui.saveFailed = true;
    setSaveStatusFailed();
    return;
  }
  state.ui.saveFailed = false;
  state.ui.lastSavedAt = payload.savedAt;
  state.ui.draftRev = payload.rev;
  setSaveStatus(`Saved on this device \u00b7 ${new Date(payload.savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  $("#clear-draft").hidden = false;
}

/** The copy a failed save asks for: the file as it stands, no readiness gate (she can fix things in the app). */
function downloadCopy() {
  if (!week()) return;
  const text = H.serialize(week(), { updatedAt: week().updatedAt });
  const blob = new Blob([text], { type: H.MIME });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: H.fileName(week()) });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function setSaveStatusFailed() {
  const node = $("#save-status");
  if (!node) return;
  node.replaceChildren("Couldn\u2019t save on this device. ", el("button", { type: "button", class: "cb-link-btn", onclick: downloadCopy }, "Download a copy"), " before you close the tab.");
  node.dataset.tone = "warn";
}

async function offerRestore() {
  const draft = await readDraft();
  if (!draft?.week?.format) return false;
  const dialog = $("#restore-dialog");
  if (!dialog?.showModal) return false;
  const when = new Date(draft.savedAt);
  const whenText = Number.isNaN(when.getTime()) ? "" : ` from ${when.toLocaleDateString([], { weekday: "long" })} ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  $("#restore-text").textContent = `A week${whenText} (${H.draftSummary(draft.week)}) is saved on this device.`;
  return new Promise((resolve) => {
    const resume = $("#restore-resume"), fresh = $("#restore-fresh");
    const done = () => { resume.onclick = null; fresh.onclick = null; dialog.close(); };
    resume.onclick = () => {
      done();
      state.week = draft.week;
      state.titlePatterns = draft.titlePatterns ?? {};
      state.suggestedCredits = draft.suggestedCredits ?? {};
      state.names = {};
      state.ui.lastSavedAt = draft.savedAt;
      state.ui.draftRev = draft.rev ?? 0;
      $("#clear-draft").hidden = false;
      setSaveStatus(`Saved on this device \u00b7 ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      go(1);
      resolve(true);
    };
    fresh.onclick = async () => {
      // Start over deletes the old draft after one confirm; the next change makes a new one.
      if (!window.confirm("Delete the saved week? This can\u2019t be undone.")) return;
      done();
      await clearDraft();
      resolve(false);
    };
    dialog.showModal();
  });
}

async function clearDraftFromButton() {
  if (!window.confirm("Clear the week saved on this device? The page starts over and this can\u2019t be undone.")) return;
  clearTimeout(saveTimer);
  await clearDraft();
  state.week = null;
  state.names = {};
  state.titlePatterns = {};
  state.ui.selectedCourseId = null;
  state.ui.workspaceCourseId = null;
  state.ui.downloaded = false;
  state.ui.changedSinceDownload = false;
  state.ui.allowedNames = [];
  state.ui.lessonsSkipped = false;
  state.ui.previewSeen = false;
  state.ui.search = "";
  $("#clear-draft").hidden = true;
  go(0);
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const isNarrow = () => window.matchMedia("(max-width: 640px)").matches;
const uuid = () => crypto.randomUUID();

/** Build an element: el("button", { class: "btn", onclick: fn, "aria-label": "x" }, "text", child, ...). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style" && typeof value === "object") {
      // Custom properties ("--lane") need setProperty; Object.assign silently drops them, which
      // is why no lane color reached a block, lane head or card until October 6, 2026.
      for (const [name, v] of Object.entries(value)) { if (v == null) continue; if (name.startsWith("--")) node.style.setProperty(name, v); else node.style[name] = v; }
    }
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const ICONS = {
  "Language Arts": "text-book-closed", Math: "function", Science: "atom", "Social Studies": "globe-americas",
  "Foreign Language": "character-bubble", "Fine Arts": "paintpalette", "PE & Health": "figure-run",
  "Bible & Religion": "book", Technology: "desktopcomputer", "Life Skills": "house", Elective: "star", Other: "square-grid-2x2",
};

function icon(subject, cls = "cb-icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${ICONS[subject] ?? ICONS.Other}`);
  svg.append(use);
  return svg;
}

// MARK: - Model helpers

const week = () => state.week;
const lanes = () => week()?.lanes ?? [];
const courses = () => week()?.courses ?? [];
const laneById = (id) => lanes().find((l) => l.laneId === id);
const courseById = (id) => courses().find((c) => c.courseId === id);
const shownDays = () => (week()?.week.days ?? []).map((d) => d.day);
const dayEntry = (code) => week()?.week.days.find((d) => d.day === code);
const isDayOn = (code) => dayEntry(code)?.on !== false;
const WEEK_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const sortDays = (codes) => [...new Set(codes)].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
const laneHex = (lane) => `#${lane?.colorHex ?? "2E6B9E"}`;
const gradeText = (grade) => (grade == null ? "" : H.GRADES.find((g) => g.value === grade)?.long ?? "");
/** The lane label on screen: the first name typed on screen 1 if there is one, else the color. */
const laneTitle = (lane) => (state.names[lane.laneId]?.trim() || H.laneLabel(lane));
const laneAndGrade = (lane) => `${laneTitle(lane)}${lane.grade == null ? "" : ` · ${gradeText(lane.grade)}`}`;
const courseLanes = (course) => course.laneIds.map(laneById).filter(Boolean);
const isTogether = (course) => course.laneIds.length >= 2;
const minutesLabel = (m) => `${m} min`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "Math", "Math and Art", "Math, Art and Latin". */
function joinNames(names) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
const transcriptShown = (course) => courseLanes(course).length > 0 && courseLanes(course).every((l) => (l.grade ?? 9) >= 9);

function usedColors() {
  return new Set(lanes().map((l) => l.color));
}

function nextFreeColor() {
  return H.LANE_COLORS.find((c) => !usedColors().has(c.name))?.name ?? H.LANE_COLORS[0].name;
}

function touch() {
  state.ui.changedSinceDownload = true;
  scheduleSave();
  if (week()) week().updatedAt = isoNow();
}

function isoNow() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// MARK: - Screens and navigation

const SCREENS = [0, 1, 2, 3, 4, 5, 6];

function go(n) {
  if (!week() && n !== 0) return;
  if (n === 4 && !state.ui.workspaceCourseId) n = 3;
  state.ui.screen = n;
  for (const id of SCREENS) {
    const section = $(`#screen-${id}`);
    if (section) section.hidden = id !== n;
  }
  const done = stepsDone();
  $$("#cb-steps button").forEach((button) => {
    const target = Number(button.dataset.go);
    const current = target === n || (n === 4 && target === 3);
    if (current) button.setAttribute("aria-current", "step"); else button.removeAttribute("aria-current");
    button.disabled = !week() && target !== 0;
    // A small moss check once a step is done (Marlow's idea 6); "done" is in the accessible name, so color is not the only signal.
    const tick = button.querySelector(".cb-step-done");
    if (done.has(target) && !tick) button.append(el("span", { class: "cb-step-done", "aria-hidden": "true" }, "\u2713"), el("span", { class: "visually-hidden cb-step-done-text" }, ", done"));
    else if (!done.has(target) && tick) { tick.remove(); button.querySelector(".cb-step-done-text")?.remove(); }
  });
  if (n === 5) state.ui.previewSeen = true;
  renderPhoneBar(n);
  if (n === 1) renderLanesScreen();
  if (n === 2) renderWeek();
  if (n === 3) renderLessonsStep();
  if (n === 4) renderWorkspace();
  if (n === 5) renderPreview();
  if (n === 6) { renderReview(); renderChecks(); }
  if (n !== 2) stopPlacing();
  const top = $("#builder").getBoundingClientRect().top + window.scrollY - 70;
  window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  syncMarkTally(state.ui.screen);
}

/** Which steps are finished: a child added, a course on a day, every course with lessons (or skipped), the preview seen. */
function stepsDone() {
  const done = new Set();
  if (!week()) return done;
  if (lanes().length) done.add(1);
  if (courses().some((c) => c.days.length > 0)) done.add(2);
  if (courses().length && (courses().every((c) => c.lessons.length > 0) || state.ui.lessonsSkipped)) done.add(3);
  if (state.ui.previewSeen) done.add(5);
  return done;
}

/** The phone's bottom bar (Marlow's idea 7): Back, "Step N of 6", Next, going where the in-page buttons go. */
const STEP_NUMBER = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 4, 5: 5, 6: 6 };
function renderPhoneBar(n) {
  const bar = $("#phone-bar");
  if (!bar) return;
  const back = $("#phone-back"), next = $("#phone-next"), label = $("#phone-step");
  label.textContent = `Step ${STEP_NUMBER[n] ?? 1} of 6`;
  const nav = {
    0: [null, () => startWeek()],
    1: [() => go(0), () => lanesNext()],
    2: [() => go(1), () => go(3)],
    3: [() => go(2), () => askAboutEmptyCourses(() => go(5))],
    4: [() => closeWorkspace(), () => askAboutEmptyCourses(() => go(5))],
    5: [() => go(3), () => go(6)],
    6: [() => go(5), null],
  }[n] ?? [null, null];
  back.onclick = nav[0];
  next.onclick = nav[1];
  back.disabled = !nav[0];
  next.disabled = !nav[1] || (!week() && n !== 0);
  next.textContent = n === 0 ? "Start" : n === 4 ? "Next: preview" : "Next";
}

/** 2.0 #1, "Open a file I made": the file is the model, so it opens as it is; nothing it carries is dropped. */
async function openFile(file) {
  const note = $("#open-note");
  const say = (text, tone = "") => { note.hidden = false; note.textContent = text; note.dataset.tone = tone; };
  let text;
  try { text = await file.text(); } catch { say("That file couldn\u2019t be read.", "warn"); return; }
  const result = H.parseFile(text, { draft: true, settleUnknown: true });
  if (!result.ok) { say(result.errors[0]?.message ?? "This file isn\u2019t a Course Builder week.", "warn"); return; }
  if (week() && courses().length && !window.confirm("Replace the week in progress with this file?")) return;
  clearTimeout(saveTimer);
  state.week = result.week;
  state.names = {};
  state.titlePatterns = {};
  state.suggestedCredits = {};
  state.ui.reopened = true;
  if (state.ui.draftRev === undefined) state.ui.draftRev = 0;
  state.ui.downloaded = false;
  state.ui.changedSinceDownload = false;
  state.ui.allowedNames = [];
  state.ui.undoReplace = null;
  const unknown = result.warnings.filter((w) => w.code === "unknownValue").length;
  const noDays = result.warnings.filter((w) => w.code === "noDays").length;
  const warn = (unknown ? ` ${unknown === 1 ? "One value" : `${unknown} values`} this version doesn\u2019t know ${unknown === 1 ? "was" : "were"} set to the app\u2019s default.` : "")
    + (noDays ? ` ${plural(noDays, "course")} ${noDays === 1 ? "has" : "have"} no days yet; Review your plan will say which.` : "");
  say(`Opened ${file.name} (${H.draftSummary(result.week)}). ${H.COPY.addOnly}${warn}`);
  touch();
  go(1);
}

function startWeek() {
  let fresh = false;
  if (!week()) {
    state.week = H.newWeek({ uuid });
    state.names = {};
    state.titlePatterns = {};
    state.suggestedCredits = {};
    // Starting fresh after the restore prompt, or with no draft at all, means this tab owns the draft from here.
    if (state.ui.draftRev === undefined) state.ui.draftRev = 0;
    // The first lane is already there (Marlow's idea 5, Josh's pick, October 6, 2026). It is not
    // saved until she changes something, so an untouched first lane never becomes a draft.
    H.newLane(week(), { color: nextFreeColor(), grade: 3, uuid });
    fresh = true;
  }
  go(1);
  if (fresh) $("#lane-grade-0")?.focus();
}

// MARK: - Screen 1: Who's learning?

function renderLanesScreen() {
  const list = $("#lanes-list");
  list.replaceChildren();
  if (lanes().length === 0) {
    list.append(el("p", { class: "muted" }, "No one yet. Add a child to make the first lane."));
  }
  lanes().forEach((lane, index) => {
    const nameId = `lane-name-${index}`;
    const colorId = `lane-color-${index}`;
    const gradeId = `lane-grade-${index}`;
    const colorSelect = el("select", { id: colorId, onchange: (e) => { changeLaneColor(lane, e.target.value); } },
      H.LANE_COLORS.map((c) => el("option", { value: c.name, selected: c.name === lane.color, disabled: c.name !== lane.color && usedColors().has(c.name) }, c.label)));
    const gradeSelect = el("select", { id: gradeId, onchange: (e) => { lane.grade = Number(e.target.value); touch(); } },
      H.GRADES.map((g) => el("option", { value: g.value, selected: g.value === lane.grade }, g.long)));
    const nameInput = el("input", { type: "text", id: nameId, autocomplete: "off", autocapitalize: "words", maxlength: 40, value: state.names[lane.laneId] ?? "", placeholder: "Optional",
      oninput: (e) => { const v = e.target.value; if (v.trim()) state.names[lane.laneId] = v; else delete state.names[lane.laneId]; } });
    list.append(el("div", { class: "cb-lane-row" },
      el("div", { class: "cb-dot", style: { background: laneHex(lane) }, "aria-hidden": "true" }),
      el("div", { class: "cb-field" }, el("label", { for: colorId }, "Color"), colorSelect),
      el("div", { class: "cb-field" }, el("label", { for: gradeId }, "Grade"), gradeSelect),
      el("div", { class: "cb-field name" }, el("label", { for: nameId }, "First name"), nameInput),
      el("button", { type: "button", class: "cb-link-btn", onclick: () => removeLane(lane) }, "Remove"),
      // Under the whole row, not inside the name field: there it made that field taller than the
      // other two and pushed the name box out of line with Color and Grade.
      el("p", { class: "hint" }, H.COPY.nameHint),
    ));
  });
  $("#add-lane").disabled = lanes().length >= H.LIMITS.lanes;
  $("#add-lane").textContent = lanes().length >= H.LIMITS.lanes ? `Up to ${H.LIMITS.lanes} children` : "Add a child";
  renderSchoolYear();
}

function changeLaneColor(lane, color) {
  const swatch = H.LANE_COLORS.find((c) => c.name === color);
  if (!swatch) return;
  lane.color = swatch.name;
  lane.colorHex = swatch.hex;
  touch();
  renderLanesScreen();
}

function addLane() {
  if (lanes().length >= H.LIMITS.lanes) return;
  const grade = lanes().length ? lanes()[lanes().length - 1].grade : 3;
  H.newLane(week(), { color: nextFreeColor(), grade, uuid });
  touch();
  renderLanesScreen();
  const inputs = $$("#lanes-list select");
  inputs[inputs.length - 1]?.focus();
}

function removeLane(lane) {
  const owned = courses().filter((c) => c.laneIds.includes(lane.laneId));
  const alone = owned.filter((c) => c.laneIds.length === 1);
  if (alone.length && !window.confirm(`Remove ${laneTitle(lane)}'s lane and its ${plural(alone.length, "course")}?`)) return;
  week().lanes = lanes().filter((l) => l.laneId !== lane.laneId);
  for (const course of owned) course.laneIds = course.laneIds.filter((id) => id !== lane.laneId);
  week().courses = courses().filter((c) => c.laneIds.length > 0);
  delete state.names[lane.laneId];
  touch();
  renderLanesScreen();
}

function renderSchoolYear() {
  const box = $("#school-year-options");
  box.replaceChildren();
  const options = H.schoolYearOptions(new Date());
  options.forEach((option, i) => {
    const id = `school-year-${i}`;
    box.append(el("label", { for: id },
      el("input", { type: "radio", name: "schoolYear", id, value: option.startYear, checked: week().schoolYear.startYear === option.startYear,
        onchange: () => { week().schoolYear = { ...option }; touch(); } }),
      option.label));
  });
}

function lanesNext() {
  if (lanes().length === 0) {
    addLane();
    return;
  }
  go(2);
}

// MARK: - Screen 2: the week grid

function renderWeek() {
  renderLaneTabs();
  renderGrid();
  renderPanel();
  $("#toggle-weekend").textContent = shownDays().includes("sat") ? "Hide weekend days" : "Add weekend days";
}

function renderLaneTabs() {
  const tabs = $("#lane-tabs");
  tabs.replaceChildren();
  if (state.ui.activeLaneIndex >= lanes().length) state.ui.activeLaneIndex = 0;
  lanes().forEach((lane, i) => {
    tabs.append(el("button", { type: "button", role: "tab", "aria-selected": String(i === state.ui.activeLaneIndex), style: { "--lane": laneHex(lane) },
      onclick: () => { state.ui.activeLaneIndex = i; renderWeek(); } },
      el("span", { class: "cb-dot", style: { background: laneHex(lane) }, "aria-hidden": "true" }), laneTitle(lane)));
  });
}

function renderGrid() {
  const grid = $("#week-grid");
  grid.replaceChildren();
  const days = shownDays();
  grid.style.setProperty("--days", String(days.length));
  grid.append(el("div", { class: "cb-corner" }, "Lanes"));
  for (const code of days) grid.append(dayHeader(code));

  lanes().forEach((lane, laneIndex) => {
    const active = laneIndex === state.ui.activeLaneIndex;
    const head = el("div", { class: `cb-lanehead${active ? " is-active" : ""}`, style: { "--lane": laneHex(lane) } },
      el("div", { class: "cb-lanename" }, el("span", { class: "cb-dot", style: { background: laneHex(lane) }, "aria-hidden": "true" }), laneTitle(lane),
        lane.grade == null ? null : el("span", { class: "cb-grade" }, gradeText(lane.grade))),
      el("div", { class: "cb-tray", dataset: { lane: lane.laneId } }, unplacedBlocks(lane),
        laneIndex === 0 && courses().length === 0 ? el("p", { class: "cb-tray-hint" }, "Tap Add a course, pick one, and it lands on its usual days.") : null),
      addCourseButton(lane));
    grid.append(head);
    for (const code of days) {
      const row = el("div", { class: `cb-dayrow${active ? " is-active" : ""}` }, dayHeader(code, true), dayCell(lane, code));
      grid.append(row);
    }
  });
  renderPlacingNote();
}

function dayHeader(code, mobile = false) {
  const entry = dayEntry(code);
  const off = entry?.on === false;
  const menuKey = `${mobile ? "m-" : ""}${code}`;
  const details = el("details", { class: `cb-dayhead${off ? " cb-day-off" : ""}${mobile ? " cb-mobile-day" : ""}`, open: state.ui.openDayMenu === menuKey });
  // The menu stays open while the grid re-renders behind it (ticking the box re-renders); closing it refreshes the label.
  details.addEventListener("toggle", () => {
    const was = state.ui.openDayMenu;
    state.ui.openDayMenu = details.open ? menuKey : (was === menuKey ? null : was);
    if (!details.open && was === menuKey) renderGrid();
  });
  const summary = el("summary", { "aria-label": `${H.dayName(code)}${off ? ", grayed out" : ""}. Day options.` }, el("span", null, mobile ? H.dayName(code) : H.shortDayName(code), entry?.label ? el("span", { class: "cb-daylabel" }, entry.label) : (off ? el("span", { class: "cb-daylabel" }, "grayed out") : null)));
  const suffix = mobile ? `-m-${code}` : `-${code}`;
  const checkId = `day-off${suffix}`;
  const labelId = `day-label${suffix}`;
  const menu = el("div", { class: "cb-daymenu" },
    el("label", { for: checkId }, el("input", { type: "checkbox", id: checkId, checked: off, onchange: (e) => { setDayOff(code, e.target.checked, entry?.label ?? ""); } }), "Gray out this day"),
    el("label", { class: "stack", for: labelId }, "Label (optional)",
      el("input", { type: "text", id: labelId, maxlength: 40, placeholder: "Co-op, field trip day", value: entry?.label ?? "", oninput: (e) => { entry.label = e.target.value; touch(); } })),
    el("button", { type: "button", class: "btn btn-paper small", onclick: () => { state.ui.openDayMenu = null; renderGrid(); } }, "Done"));
  details.append(summary, menu);
  return details;
}

function setDayOff(code, off, label) {
  const entry = dayEntry(code);
  if (!entry) return;
  entry.on = !off;
  entry.label = off ? label : "";
  touch();
  renderGrid();
}

function toggleWeekend() {
  const days = week().week.days;
  if (shownDays().includes("sat")) {
    const used = courses().filter((c) => c.days.some((d) => d === "sat" || d === "sun"));
    if (used.length && !window.confirm("Some courses sit on the weekend. Hide the weekend days and take them off those courses?")) return;
    for (const c of used) c.days = c.days.filter((d) => d !== "sat" && d !== "sun");
    week().week.days = days.filter((d) => d.day !== "sat" && d.day !== "sun");
  } else {
    for (const day of ["sat", "sun"]) if (!days.some((d) => d.day === day)) days.push({ day, on: true, label: "" });
  }
  touch();
  renderWeek();
}

function addCourseButton(lane) {
  const button = el("button", { type: "button", class: "btn btn-paper cb-add-course", "aria-haspopup": "menu" }, "Add a course");
  button.addEventListener("click", () => openCourseMenu(lane, button));
  return button;
}

let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onMenuKey, true);
}
function onDocPointerDown(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function onMenuKey(e) { if (e.key === "Escape") { closeMenu(); } }

function openCourseMenu(lane, anchor) {
  closeMenu();
  const list = H.gradeBandDefaults(state.courseDefaults, lane.grade);
  const menu = el("div", { class: "cb-menu", role: "menu", "aria-label": `Add a course for ${laneTitle(lane)}` });
  menu.append(el("div", { class: "cb-menu-head" }, lane.grade == null ? "Suggestions" : `${gradeText(lane.grade)} suggestions`));
  for (const item of [...list].sort((a, b) => Number(b.isOn) - Number(a.isOn))) {
    menu.append(el("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); addCourse(lane, item); } },
      el("span", null, icon(item.subject), " ", item.name), el("span", { class: "cb-meta" }, `${item.perWeek}×/wk · ${item.minutes} min`)));
  }
  menu.append(el("hr"));
  menu.append(el("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); addCourse(lane, null); } }, el("span", null, "Something else")));
  // On the body, not inside the lane cell: the week grid clips its overflow, which cut the menu
  // off after its first row on desktop (seen in Chrome). Placed from the button's rectangle,
  // kept inside the viewport, and closed on the next pointerdown outside it as before.
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  menu.style.left = `${left + window.scrollX}px`;
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.width = `${width}px`;
  document.body.append(menu);
  openMenu = menu;
  menu.querySelector("button")?.focus();
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onMenuKey, true);
}

function addCourse(lane, item) {
  const defaults = item ? { name: item.name, subject: item.subject, perWeek: item.perWeek, minutes: item.minutes, credits: item.credits } : {};
  const course = H.newCourse(week(), { laneIds: [lane.laneId], defaults, uuid });
  if (item?.titlePattern) state.titlePatterns[course.courseId] = item.titlePattern;
  if (item && item.credits != null) state.suggestedCredits[course.courseId] = item.credits;
  if (!item) course.days = [];
  if ((lane.grade ?? 9) >= 9) course.targetHours = 0;
  touch();
  state.ui.selectedCourseId = course.courseId;
  renderWeek();
  if (!item) $("#course-panel input[name=name]")?.focus();
}

function removeCourse(course) {
  if (!window.confirm(`Remove ${course.name || "this block"} and its ${plural(course.lessons.length, "lesson row")}?`)) return;
  week().courses = courses().filter((c) => c.courseId !== course.courseId);
  delete state.titlePatterns[course.courseId];
  if (state.ui.selectedCourseId === course.courseId) state.ui.selectedCourseId = null;
  if (state.ui.workspaceCourseId === course.courseId) state.ui.workspaceCourseId = null;
  touch();
  renderWeek();
}

function unplacedBlocks(lane) {
  return courses().filter((c) => c.laneIds[0] === lane.laneId && c.days.length === 0).map((course) =>
    el("div", { class: "cb-trayitem" }, block(course, lane, null), shortcuts(course)));
}

function shortcuts(course) {
  const set = (days) => { course.days = sortDays(days.filter((d) => shownDays().includes(d))); touch(); renderWeek(); };
  return el("div", { class: "cb-shortcuts", "aria-label": `Place ${course.name || "this block"}` },
    el("button", { type: "button", onclick: () => set(shownDays().filter(isDayOn)) }, "Every day"),
    el("button", { type: "button", onclick: () => set(["mon", "wed", "fri"]) }, "M-W-F"),
    el("button", { type: "button", onclick: () => set(["tue", "thu"]) }, "T-Th"));
}

function dayCell(lane, code) {
  const off = !isDayOn(code);
  const cell = el("div", { class: `cb-cell${off ? " cb-day-off" : ""}`, dataset: { lane: lane.laneId, day: code } });
  const here = courses().filter((c) => c.laneIds.includes(lane.laneId) && c.days.includes(code));
  // Teach-together blocks first, so adjacent lanes line them up.
  here.sort((a, b) => Number(isTogether(b)) - Number(isTogether(a)));
  for (const course of here) cell.append(block(course, lane, code));
  if (state.ui.placingCourseId) {
    const placing = courseById(state.ui.placingCourseId);
    if (placing) {
      cell.classList.add("cb-placing-target");
      cell.tabIndex = 0;
      cell.setAttribute("role", "button");
      const on = placing.days.includes(code) && placing.laneIds.includes(lane.laneId);
      cell.setAttribute("aria-label", `${on ? "Take" : "Put"} ${placing.name || "this block"} ${on ? "off" : "on"} ${H.dayName(code)} for ${laneTitle(lane)}`);
      const act = () => placeToggle(placing, lane, code);
      cell.addEventListener("click", (e) => { if (e.target === cell) act(); });
      cell.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
    }
  }
  return cell;
}

function block(course, lane, code) {
  const partners = courseLanes(course).filter((l) => l.laneId !== lane.laneId);
  const together = partners.length > 0;
  // One size for every pill (Josh, October 6, 4:15 PM ET): the minutes capsule carries the number,
  // so height no longer follows minutes.
  const classes = ["cb-block"];
  if (together) classes.push("together");
  if (course.courseId === state.ui.selectedCourseId) classes.push("is-selected");
  if (course.courseId === state.ui.placingCourseId) classes.push("is-placing");
  const node = el("div", { class: classes.join(" "), role: "group", dataset: { course: course.courseId, lane: lane.laneId, day: code ?? "" },
    style: { "--lane": laneHex(lane), "--lane-2": together ? laneHex(partners[0]) : laneHex(lane) } });
  const main = el("button", { type: "button", class: "cb-block-main", "aria-label": `${course.name || "Untitled course"}, ${minutesLabel(course.minutes)}${together ? `, together with ${partners.map(laneTitle).join(" and ")}` : ""}. Open course.` },
    icon(course.subject), el("span", { class: "cb-title" }, course.name || "Untitled"), together ? el("span", { class: "cb-together-tag" }, "Together") : null, el("span", { class: "cb-min" }, course.minutes));
  node.append(main);
  // A click that ends a drag lands on the group (pointer capture), not the button; it is not an open.
  node.addEventListener("click", (e) => {
    if (node.dataset.dragged) { delete node.dataset.dragged; return; }
    if (e.target.closest(".cb-block-main")) selectCourse(course.courseId);
  });
  if (isNarrow()) {
    node.append(el("button", { type: "button", class: "cb-chip cb-place", "aria-pressed": String(state.ui.placingCourseId === course.courseId),
      onclick: () => { if (state.ui.placingCourseId === course.courseId) stopPlacing(); else startPlacing(course.courseId); } }, "Place"));
  } else {
    enableBlockDrag(node, course, lane, code);
  }
  return node;
}

function selectCourse(courseId) {
  state.ui.selectedCourseId = courseId;
  renderWeek();
  if (isNarrow()) $("#course-panel")?.focus();
}

// MARK: - Tap to place (phones, keyboards)

function startPlacing(courseId) {
  state.ui.placingCourseId = courseId;
  renderGrid();
}

function stopPlacing() {
  if (!state.ui.placingCourseId) return;
  state.ui.placingCourseId = null;
  if (state.ui.screen === 2) renderGrid();
}

function placeToggle(course, lane, code) {
  if (!course.laneIds.includes(lane.laneId)) {
    course.laneIds.push(lane.laneId);
    if (!course.days.includes(code)) course.days = sortDays([...course.days, code]);
  } else if (course.days.includes(code)) {
    course.days = course.days.filter((d) => d !== code);
  } else {
    course.days = sortDays([...course.days, code]);
  }
  touch();
  renderWeek();
}

function renderPlacingNote() {
  const note = $("#placing-note");
  const course = courseById(state.ui.placingCourseId);
  if (!course) { note.hidden = true; note.replaceChildren(); return; }
  note.hidden = false;
  note.replaceChildren(`Tap a day to put ${course.name || "this block"} there. Tap it again to take it off. Tap another lane to teach it together.`,
    el("button", { type: "button", class: "btn btn-paper small", onclick: stopPlacing }, "Done placing"));
}

// MARK: - Pointer drag (mouse, pen and iPad touch)

function pointerDrag(handle, { threshold = 6, onStart, onMove, onEnd }) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    const id = e.pointerId;
    let dragging = false;
    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < threshold) return;
        dragging = true;
        try { handle.setPointerCapture(id); } catch { /* fine */ }
        onStart(ev);
      }
      onMove(ev);
    };
    const finish = (ev, cancelled) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      try { handle.releasePointerCapture(id); } catch { /* fine */ }
      if (dragging) onEnd(cancelled ? null : ev);
    };
    const up = (ev) => finish(ev, false);
    const cancel = () => finish(null, true);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
  });
}

let ghost = null;
let dropTarget = null;

function cellUnder(ev) {
  if (!ev) return null;
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  return under?.closest(".cb-cell, .cb-tray, .cb-lanehead") ?? null;
}

function enableBlockDrag(node, course, lane, code) {
  pointerDrag(node, {
    onStart: () => {
      node.classList.add("is-dragging");
      node.dataset.dragged = "1";
      ghost = node.cloneNode(true);
      ghost.classList.add("cb-ghost");
      ghost.classList.remove("is-dragging", "is-selected");
      ghost.style.height = "34px";
      document.body.append(ghost);
    },
    onMove: (ev) => {
      if (ghost) { ghost.style.left = `${ev.clientX + 10}px`; ghost.style.top = `${ev.clientY - 10}px`; }
      const target = cellUnder(ev);
      if (target !== dropTarget) {
        dropTarget?.classList.remove("cb-drop-ok");
        dropTarget = target;
        dropTarget?.classList.add("cb-drop-ok");
      }
    },
    onEnd: (ev) => {
      ghost?.remove();
      ghost = null;
      node.classList.remove("is-dragging");
      dropTarget?.classList.remove("cb-drop-ok");
      const target = ev ? cellUnder(ev) : null;
      dropTarget = null;
      if (!target) { renderGrid(); return; }
      const toLane = target.dataset.lane ?? target.querySelector("[data-lane]")?.dataset.lane ?? null;
      const toDay = target.classList.contains("cb-cell") ? target.dataset.day : null;
      dropBlock(course, lane.laneId, code, toLane, toDay);
    },
  });
}

/** Drop rules: a new lane joins the course (Teach together); a new day is added; within one lane a block moves day to day; onto the tray takes it off the day. */
function dropBlock(course, fromLane, fromDay, toLane, toDay) {
  if (!toLane) { renderGrid(); return; }
  const sameLane = toLane === fromLane;
  if (!course.laneIds.includes(toLane)) course.laneIds.push(toLane);
  if (toDay) {
    if (!isDayOn(toDay) && !course.days.includes(toDay) && !window.confirm(`${H.dayName(toDay)} is grayed out. Put ${course.name || "this block"} there anyway?`)) { renderGrid(); return; }
    const days = new Set(course.days);
    if (sameLane && fromDay && fromDay !== toDay) days.delete(fromDay);
    days.add(toDay);
    course.days = sortDays([...days]);
  } else if (sameLane && fromDay) {
    course.days = course.days.filter((d) => d !== fromDay);
  }
  touch();
  renderWeek();
}

// MARK: - Screen 3: the course panel

function renderPanel() {
  const panel = $("#course-panel");
  const course = courseById(state.ui.selectedCourseId);
  const layout = $(".cb-week-layout");
  if (!course) {
    panel.hidden = true;
    panel.replaceChildren();
    layout.classList.remove("has-panel");
    return;
  }
  panel.hidden = false;
  panel.tabIndex = -1;
  layout.classList.add("has-panel");
  panel.style.setProperty("--lane", laneHex(courseLanes(course)[0]));
  panel.replaceChildren();
  const field = (labelText, input, hint) => el("div", { class: "cb-field" }, el("label", { for: input.id }, labelText), input, hint ? el("p", { class: "hint" }, hint) : null);
  const id = (name) => `course-${name}`;

  panel.append(el("div", { class: "cb-panel-head" },
    el("h3", null, icon(course.subject), el("span", { id: "panel-title" }, course.name || "New course")),
    el("button", { type: "button", class: "cb-close", "aria-label": "Close course panel", onclick: () => closePanel(course.courseId) }, "×")));

  // 1. Name and subject
  const nameInput = el("input", { type: "text", id: id("name"), name: "name", value: course.name, maxlength: H.LIMITS.name, required: true, autocomplete: "off",
    oninput: (e) => { course.name = e.target.value; touch(); $("#panel-title").textContent = course.name || "New course"; refreshBlocks(course); } });
  const subjectSelect = el("select", { id: id("subject"), onchange: (e) => { course.subject = e.target.value; touch(); renderWeek(); } },
    H.SUBJECTS.map((s) => el("option", { value: s, selected: s === course.subject }, s)));
  panel.append(el("div", { class: "cb-two" }, field("Name", nameInput), field("Subject", subjectSelect)));

  // 2. Schedule
  panel.append(el("fieldset", { class: "cb-group" }, el("legend", null, "Schedule"),
    el("div", { class: "cb-choice" }, H.SCHEDULE_MODES.map((mode) => el("label", null,
      el("input", { type: "radio", name: "scheduleMode", value: mode, checked: course.scheduleMode === mode, onchange: () => { course.scheduleMode = mode; touch(); renderWeek(); } }),
      el("span", null, mode, el("span", { class: "cb-detail" }, SCHEDULE_DETAIL[mode])))))));

  // 3. Days and minutes
  const dayButtons = el("div", { class: "cb-days", role: "group", "aria-label": "Days" }, shownDays().map((code) => el("button", { type: "button", "aria-pressed": String(course.days.includes(code)), class: isDayOn(code) ? "" : "off",
    "aria-label": `${H.dayName(code)}${isDayOn(code) ? "" : " (grayed out)"}`,
    onclick: () => { course.days = course.days.includes(code) ? course.days.filter((d) => d !== code) : sortDays([...course.days, code]); touch(); renderWeek(); } }, H.shortDayName(code))));
  const minutesInput = el("input", { type: "number", id: id("minutes"), min: H.LIMITS.minutesMin, max: H.LIMITS.minutesMax, step: 5, value: course.minutes, inputmode: "numeric",
    onchange: (e) => { const v = Number(e.target.value); course.minutes = Number.isFinite(v) ? v : course.minutes; touch(); renderWeek(); } });
  panel.append(el("fieldset", { class: "cb-group" }, el("legend", null, "Days"), dayButtons, shortcuts(course),
    course.scheduleMode === "Loop" ? el("p", { class: "hint" }, "A loop with no days runs on every school day.") : null));
  panel.append(field("Minutes per lesson", minutesInput, "5 to 240, in steps of 5."));

  // Teach together or a separate copy (2.0 #3): ticking a second child asks which she means.
  if (lanes().length > 1) {
    const used = courseLanes(course).map(laneTitle).join(", ");
    const chooser = el("div", { class: "cb-copy-choice", hidden: true });
    const offerChoice = (lane) => {
      chooser.hidden = false;
      chooser.replaceChildren(
        el("p", null, el("b", null, `Also for ${laneTitle(lane)}:`), " the same lessons, or their own?"),
        el("div", { class: "cb-row" },
          el("button", { type: "button", class: "btn btn-slate small", onclick: () => {
            course.laneIds = lanes().map((l) => l.laneId).filter((x) => course.laneIds.includes(x) || x === lane.laneId);
            touch(); renderWeek();
          } }, "Teach together"),
          el("button", { type: "button", class: "btn btn-paper small", onclick: () => {
            const copy = H.duplicateCourse(week(), course.courseId, { laneIds: [lane.laneId], uuid });
            state.titlePatterns[copy.courseId] = state.titlePatterns[course.courseId];
            if (state.suggestedCredits[course.courseId] != null) state.suggestedCredits[copy.courseId] = state.suggestedCredits[course.courseId];
            touch(); state.ui.selectedCourseId = copy.courseId; renderWeek();
          } }, `Make a separate copy for ${laneTitle(lane)}`),
          el("button", { type: "button", class: "cb-link-btn", onclick: () => { chooser.hidden = true; renderWeek(); } }, "Never mind")),
        el("p", { class: "hint", style: { margin: 0 } }, "Teach together: one block, the same lessons, linked in the app. A separate copy: its own lessons, pace, minutes and grading."));
    };
    panel.append(el("fieldset", { class: "cb-group" }, el("legend", null, "Teach together"),
      el("p", { class: "cb-used-by" }, `Used by ${used}`),
      el("div", { class: "cb-checks-inline" }, lanes().map((lane) => {
        const on = course.laneIds.includes(lane.laneId);
        const only = on && course.laneIds.length === 1;
        return el("label", null, el("input", { type: "checkbox", checked: on, disabled: only, onchange: (e) => {
          if (e.target.checked) { e.target.checked = false; offerChoice(lane); return; }
          course.laneIds = course.laneIds.filter((x) => x !== lane.laneId);
          touch(); renderWeek();
        } }), on && course.laneIds[0] === lane.laneId ? laneTitle(lane) : `Also for ${laneTitle(lane)}`);
      })),
      chooser,
      el("p", { class: "hint" }, course.laneIds.length < 2 ? "Tick another child to teach this together, or to make them their own copy."
        : `One block for ${course.laneIds.length === 2 ? "both" : course.laneIds.length === 3 ? "all three" : "all of them"}. Each child keeps their own records in the app.`)));
  }

  // 4. Start on, start at lesson
  const startInput = el("input", { type: "date", id: id("start"), value: course.startDate ?? "", onchange: (e) => { course.startDate = e.target.value || null; touch(); } });
  const startAtInput = el("input", { type: "number", id: id("startAt"), min: 1, step: 1, value: course.startAtLesson ?? 1, inputmode: "numeric",
    onchange: (e) => { course.startAtLesson = Math.max(1, Math.floor(Number(e.target.value)) || 1); e.target.value = course.startAtLesson; touch(); } });
  panel.append(el("div", { class: "cb-two" }, field("Start on", startInput, "Blank means the first school day after you add it."), field("Start at lesson", startAtInput)));

  // 5. Fit
  if (course.scheduleMode !== "Loop") {
    panel.append(el("fieldset", { class: "cb-group" }, el("legend", null, "Fit"),
      el("div", { class: "cb-choice" },
        el("label", null, el("input", { type: "radio", name: "fit", checked: !course.spreadOverYear, onchange: () => { course.spreadOverYear = false; touch(); } }), el("span", null, "One lesson per chosen day")),
        el("label", null, el("input", { type: "radio", name: "fit", checked: Boolean(course.spreadOverYear), onchange: () => { course.spreadOverYear = true; touch(); } }),
          el("span", null, "Spread across the rest of my school year", el("span", { class: "cb-detail" }, "The app picks the fewest of the chosen days that fit before your year ends."))))));
  }

  // 6. Grading
  const gradingSelect = el("select", { id: id("grading"), onchange: (e) => { course.gradingMode = e.target.value; touch(); } },
    H.GRADING_MODES.map((g) => el("option", { value: g, selected: g === course.gradingMode }, g)));
  panel.append(field("Grading", gradingSelect));

  // 7. Transcript (9th grade and up on every lane)
  if (transcriptShown(course)) {
    const levelSelect = el("select", { id: id("level"), onchange: (e) => { course.level = e.target.value; touch(); } }, H.LEVELS.map((l) => el("option", { value: l, selected: l === (course.level ?? "Regular") }, l)));
    const creditsSelect = el("select", { id: id("credits"), onchange: (e) => { course.credits = Number(e.target.value); touch(); } }, H.CREDITS.map((c) => el("option", { value: c, selected: c === (course.credits ?? 1) }, c.toFixed(c % 1 === 0 ? 1 : 2))));
    const targetSelect = el("select", { id: id("target"), onchange: (e) => { course.targetHours = Number(e.target.value); touch(); } }, H.TARGET_HOURS.map((h) => el("option", { value: h, selected: h === (course.targetHours ?? 0) }, h === 0 ? "Not tracked" : `${h} hours`)));
    const showId = id("transcript");
    panel.append(el("fieldset", { class: "cb-group" }, el("legend", null, "Transcript"),
      el("div", { class: "cb-two" }, field("Level", levelSelect), field("Credits", creditsSelect)),
      el("div", { class: "cb-checks-inline" }, el("label", { for: showId }, el("input", { type: "checkbox", id: showId, checked: course.includeOnTranscript !== false, onchange: (e) => { course.includeOnTranscript = e.target.checked; touch(); } }), "Show on transcript")),
      field("Credit target", targetSelect, "Credits from hours, if you track them.")));
  }

  // 8. Curriculum and resources
  const curriculumInput = el("input", { type: "text", id: id("curriculum"), value: course.curriculum ?? "", maxlength: H.LIMITS.curriculum, placeholder: "The book or program you're using", oninput: (e) => { course.curriculum = e.target.value; touch(); } });
  panel.append(field("Curriculum or book", curriculumInput));
  panel.append(resourcesEditor(course));

  // 9. Notes
  const notes = el("textarea", { id: id("notes"), maxlength: H.LIMITS.notes, placeholder: "Goals, pacing, grading notes...", oninput: (e) => { course.notes = e.target.value; touch(); } }, course.notes ?? "");
  panel.append(field("Notes", notes));

  const pacing = H.pacingSentence(course, week());
  if (pacing) panel.append(el("p", { class: "hint cb-pacing", style: { margin: 0 } }, pacing));
  panel.append(el("div", { class: "cb-panel-actions" },
    el("button", { type: "button", class: "btn btn-slate", onclick: () => openWorkspace(course.courseId) },
      course.lessons.length ? `Lessons (${course.lessons.length})` : "Next: add the lessons"),
    duplicateMenu(course),
    el("button", { type: "button", class: "btn btn-paper cb-danger", onclick: () => removeCourse(course) }, "Remove this course")));
  if (isNarrow()) {
    panel.append(el("button", { type: "button", class: "btn btn-slate cb-sheet-done", onclick: () => closePanel(course.courseId) }, "Done"));
  }
}

/** Closes the course panel, keeping every edit, and puts focus back on the block that opened it. */
function closePanel(courseId) {
  state.ui.selectedCourseId = null;
  renderWeek();
  $(`.cb-block[data-course="${courseId}"] .cb-block-main`)?.focus();
}

/** 2.0 #3: Duplicate course to any child; the copy gets fresh ids, so editing one never changes the other. */
function duplicateMenu(course) {
  const details = el("details", { class: "cb-dup" });
  details.append(el("summary", { class: "btn btn-paper" }, "Duplicate course\u2026"));
  const menu = el("div", { class: "cb-dup-menu" }, el("p", { class: "hint", style: { margin: 0 } }, "A copy with its own lessons, for:"));
  for (const lane of lanes()) {
    menu.append(el("button", { type: "button", class: "btn btn-paper small", onclick: () => {
      const copy = H.duplicateCourse(week(), course.courseId, { laneIds: [lane.laneId], uuid });
      copy.name = course.laneIds.includes(lane.laneId) ? `${course.name || "Untitled"} (copy)` : copy.name;
      state.titlePatterns[copy.courseId] = state.titlePatterns[course.courseId];
      if (state.suggestedCredits[course.courseId] != null) state.suggestedCredits[copy.courseId] = state.suggestedCredits[course.courseId];
      touch(); state.ui.selectedCourseId = copy.courseId; renderWeek();
    } }, laneTitle(lane)));
  }
  details.append(menu);
  return details;
}

const SCHEDULE_DETAIL = {
  "On the calendar": "Each lesson has a date. Miss one and it waits on its date until you move it.",
  Loop: "Lessons stay in order with no dates. Today offers the next one; check it off and the next appears. Nothing is pinned to a date, so a day you skip never leaves anything overdue.",
};

/** Update the block labels in the grid without rebuilding it (the name field is being typed in). */
function refreshBlocks(course) {
  $$(`.cb-block[data-course="${course.courseId}"] .cb-title`).forEach((node) => { node.textContent = course.name || "Untitled"; });
}

function resourcesEditor(course) {
  course.resources ??= [];
  const box = el("fieldset", { class: "cb-group" }, el("legend", null, "Resources"));
  course.resources.forEach((resource, i) => {
    const rid = (k) => `res-${i}-${k}`;
    const text = (key, label, extra = {}) => el("div", { class: "cb-field" }, el("label", { for: rid(key) }, label),
      el("input", { type: key === "url" ? "url" : "text", id: rid(key), value: resource[key] ?? "", ...extra, oninput: (e) => { resource[key] = e.target.value; touch(); } }));
    box.append(el("div", { class: "cb-resource" },
      text("title", "Title", { maxlength: H.LIMITS.resourceTitle }),
      el("div", { class: "cb-two" }, text("author", "Author", { maxlength: 200 }),
        el("div", { class: "cb-field" }, el("label", { for: rid("kind") }, "Type"), el("select", { id: rid("kind"), onchange: (e) => { resource.kind = e.target.value; touch(); } }, H.RESOURCE_KINDS.map((k) => el("option", { value: k, selected: k === (resource.kind ?? "Book") }, k))))),
      el("div", { class: "cb-two" }, text("isbn", "ISBN", { maxlength: 20 }), text("url", "Link", { maxlength: 2000, placeholder: "https://" })),
      text("notes", "Notes", { maxlength: 400 }),
      el("button", { type: "button", class: "cb-link-btn", onclick: () => { course.resources.splice(i, 1); touch(); renderPanel(); } }, "Remove resource")));
  });
  box.append(el("button", { type: "button", class: "btn btn-paper small", onclick: () => {
    course.resources.push({ resourceId: uuid(), title: course.curriculum || "", author: "", isbn: "", kind: course.curriculum ? "Curriculum" : "Book", url: "", notes: "" });
    touch(); renderPanel(); $(`#res-${course.resources.length - 1}-title`)?.focus();
  } }, "Add a resource"));
  return box;
}

// MARK: - Screen 4: the lesson workspace

function openWorkspace(courseId, rowIndex = null) {
  state.ui.workspaceCourseId = courseId;
  state.ui.workspace.toc = null;
  // Remember where the workspace was opened from (the Lessons step or the week) so Done goes back there.
  state.ui.workspaceReturn = state.ui.screen === 2 ? 2 : 3;
  go(4);
  if (rowIndex != null) {
    const input = $(`#workspace tr[data-index="${rowIndex}"] .cb-col-title input`);
    input?.focus();
    input?.scrollIntoView({ block: "center", behavior: "instant" });
  }
}

/** Leaves the lesson workspace. The footer's Done passes { celebrate: true }. Back uses the
    same exit and does not. The hop runs only after the workspace has actually closed. */
function closeWorkspace(options) {
  const screenBefore = state.ui.screen;
  state.ui.selectedCourseId = state.ui.workspaceCourseId;
  go(state.ui.workspaceReturn ?? 3);
  if (lessonsDoneShouldPlay({ screenBefore, screenAfter: state.ui.screen, celebrate: options?.celebrate === true })) playLessonsDone();
}

// MARK: - Screen 3: Lessons (one row per course, the next step after the week)

/** Courses with no lesson rows at all, in file order. */
function coursesWithoutLessons() {
  return courses().filter((c) => c.lessons.length === 0);
}

function renderLessonsStep() {
  const host = $("#lessons-list");
  host.replaceChildren();
  if (!courses().length) {
    host.append(el("p", { class: "cb-empty" }, "No courses yet. Go back to the week and add one in a lane."));
    return;
  }
  const warning = nameWarningLine();
  if (warning) host.append(warning);
  // "1 of 2 courses have lessons. The rest can be planned as you go." (Marlow's idea 6; follows adds and deletes).
  const withLessons = courses().filter((c) => c.lessons.length > 0).length;
  const total = courses().length;
  host.append(el("p", { class: "cb-lessons-count", "aria-live": "polite" },
    withLessons === total ? (total === 1 ? "Your course has its lessons." : `All ${total} courses have lessons.`)
      : `${withLessons} of ${total} courses have lessons. The rest can be planned as you go.`));
  const list = el("div", { class: "cb-lesson-list" });
  for (const course of courses()) {
    const first = courseLanes(course)[0];
    const n = course.lessons.length;
    const who = courseLanes(course).map(laneTitle).join(" and ");
    const name = course.name || "Untitled course";
    list.append(el("div", { class: `cb-lesson-row${n ? "" : " empty"}`, style: { "--lane": laneHex(first) } },
      icon(course.subject),
      el("div", { class: "cb-lesson-main" },
        el("b", null, name),
        el("span", { class: "muted small" }, `${who} · ${course.days.length ? course.days.map(H.shortDayName).join(", ") : "no days yet"} · ${minutesLabel(course.minutes)}`),
        n ? null : el("span", { class: "muted small" }, `${H.COPY.todayAsks(name)} and you plan as you go.`)),
      el("span", { class: `cb-lesson-count${n ? "" : " none"}` }, n ? plural(n, "lesson") : "No lessons yet"),
      el("button", { type: "button", class: n ? "btn btn-paper small" : "btn btn-slate small", onclick: () => openWorkspace(course.courseId) }, n ? "Edit lessons" : "Add lessons")));
  }
  host.append(list);
}

/** Before Preview: a course with no lessons gets one plain question, with Skip for now (Josh, October 6, 2026). */
function askAboutEmptyCourses(then) {
  const empty = coursesWithoutLessons();
  const dialog = $("#no-lessons-dialog");
  if (!empty.length || !dialog?.showModal) { then(); return; }
  const names = empty.map((c) => c.name || "Untitled course");
  $("#no-lessons-text").textContent = `${joinNames(names)} ${names.length === 1 ? "has" : "have"} no lessons yet. Add them now, or plan as you go in the app.`;
  const add = $("#no-lessons-add"), skip = $("#no-lessons-skip");
  const done = () => { add.onclick = null; skip.onclick = null; dialog.close(); };
  add.onclick = () => { done(); openWorkspace(empty[0].courseId); };
  skip.onclick = () => { done(); state.ui.lessonsSkipped = true; then(); };
  dialog.showModal();
}

function workspaceCountText(course) {
  return `${H.lessonFooter(course)}${course.lessons.length > H.LIMITS.lessonsPerCourse ? ` The app takes up to ${H.LIMITS.lessonsPerCourse} in one course.` : ""}`;
}

/** The title search (Marlow's "search lesson titles", Josh's pick): a filter on this screen only; nothing is written. */
function searchMatches(lesson) {
  const q = state.ui.search.trim().toLowerCase();
  return !q || String(lesson.title ?? "").toLowerCase().includes(q);
}

function searchBox(course) {
  const input = el("input", { type: "search", id: "ws-search", value: state.ui.search, placeholder: "quiz", autocomplete: "off", "aria-label": "Search lesson titles",
    oninput: (e) => { state.ui.search = e.target.value; applySearch(course); } });
  const count = el("span", { class: "hint cb-search-count", id: "ws-search-count", "aria-live": "polite" });
  return el("div", { class: "cb-search" }, el("label", { for: "ws-search" }, "Find a title"), input, count);
}

/** Shows only the rows whose title contains the search; hidden rows keep every value. */
function applySearch(course) {
  const q = state.ui.search.trim();
  const rows = $$("#workspace tbody tr");
  let shown = 0;
  rows.forEach((tr) => {
    const lesson = course.lessons[Number(tr.dataset.index)];
    const match = !lesson || searchMatches(lesson);
    tr.hidden = !match;
    if (match) shown += 1;
  });
  const count = $("#ws-search-count");
  if (count) count.textContent = q ? `${shown} of ${plural(course.lessons.length, "lesson")} match \u201c${q}\u201d.` : "";
  // Changing several rows and copying down work on row ranges, so they wait until the search is cleared.
  $$("#workspace details[data-tool=\"bulk\"], #workspace details[data-tool=\"copy\"]").forEach((tool) => { tool.hidden = Boolean(q); });
  const note = $("#ws-search-note");
  if (note) note.hidden = !q;
}
function refreshWorkspaceCount(course) { const node = $("#ws-count"); if (node) node.textContent = workspaceCountText(course); }

function renderWorkspace() {
  const host = $("#workspace");
  const course = courseById(state.ui.workspaceCourseId);
  host.replaceChildren();
  if (!course) return;
  const lane = courseLanes(course)[0];
  host.style.setProperty("--lane", laneHex(lane));
  const ws = state.ui.workspace;

  host.append(el("div", { class: "cb-ws-head" },
    el("div", null, el("h2", null, icon(course.subject), course.name || "Untitled course"),
      el("p", { class: "muted small" }, `${courseLanes(course).map(laneAndGrade).join(" and ")} · ${course.scheduleMode} · ${course.days.length ? course.days.map(H.shortDayName).join(", ") : "no days yet"} · ${minutesLabel(course.minutes)}`),
      el("p", { class: "muted small cb-pacing", id: "ws-pacing" }, H.pacingSentence(course, week()))),
    el("button", { type: "button", class: "btn btn-paper", onclick: closeWorkspace }, state.ui.workspaceReturn === 2 ? "Back to the week" : "Back to lessons")));

  // The "lessons added" moment (Marlow's idea 4) takes the toolbar's place until Done.
  if (ws.added) {
    host.append(el("div", { class: "cb-added", role: "status" },
      el("p", null, ws.added.text),
      el("button", { type: "button", class: "btn btn-slate", onclick: () => { ws.added = null; renderWorkspace(); $("#workspace tbody tr .cb-col-title input")?.focus(); } }, "Done, back to lessons")));
  } else {
    const toolbar = el("div", { class: "cb-toolbar" });
    // DOM append turns a null into the word "null" (Josh saw it after Fill down, October 6); only real nodes go in.
    toolbar.append(...[patternFillTool(course), tocTool(course), copyDownTool(course),
      course.lessons.length ? bulkEditTool(course) : null,
      el("button", { type: "button", class: "btn btn-paper", onclick: () => { addRow(course); } }, "Add a lesson")].filter(Boolean));
    if (course.lessons.length > 12) toolbar.append(jumpTools(course));
    host.append(toolbar);
    if (course.lessons.length) host.append(searchBox(course), el("p", { class: "hint", id: "ws-search-note", hidden: true, style: { margin: "0 0 0.6rem" } }, "Clear the search to change several rows or copy down."));
    const bulkNote = lastBulkNote();
    if (bulkNote) host.append(bulkNote);
  }

  const table = el("table", { class: "cb-table" },
    el("thead", null, el("tr", null,
      el("th", { class: "cb-col-tick", scope: "col" }, el("span", { class: "visually-hidden" }, "Include")),
      el("th", { class: "cb-col-handle", scope: "col" }, el("span", { class: "visually-hidden" }, "Reorder")),
      el("th", { class: "cb-num", scope: "col" }, "#"),
      el("th", { class: "cb-col-title", scope: "col" }, "Title"),
      el("th", { class: "cb-col-details", scope: "col" }, "What to do"),
      el("th", { class: "cb-col-min", scope: "col" }, "Minutes"),
      el("th", { class: "cb-col-unit", scope: "col" }, "Unit"),
      el("th", { class: "cb-col-tags", scope: "col" }, "Tags"),
      el("th", { class: "cb-col-tools", scope: "col" }, el("span", { class: "visually-hidden" }, "Row tools")))));
  const tbody = el("tbody");
  course.lessons.forEach((lesson, i) => tbody.append(lessonRow(course, lesson, i)));
  table.append(tbody);
  const wrap = el("div", { class: "cb-table-wrap", tabindex: "0", "aria-label": "Lessons" });
  if (course.lessons.length === 0) {
    wrap.append(lessonChooser(course));
  } else {
    wrap.append(table);
  }
  host.append(wrap);
  if (course.lessons.length) applySearch(course);
  const warning = nameWarningLine();
  if (warning) host.append(warning);
  host.append(el("div", { class: "cb-ws-foot" },
    el("p", { class: "muted small", id: "ws-count", style: { margin: 0 } }, workspaceCountText(course)),
    el("div", { class: "cb-actions", style: { margin: 0 } },
      el("button", { type: "button", class: "btn btn-paper", onclick: () => { addRow(course); } }, "Add a lesson"),
      el("button", { type: "button", class: "btn btn-slate", onclick: () => closeWorkspace({ celebrate: true }) }, "Done"))));
}

/** After a tool adds lessons: the line, a one-time highlight on the new rows, and Done (Marlow's idea 4). */
function noteLessonsAdded(course, firstNewIndex) {
  const rows = course.lessons.slice(firstNewIndex);
  if (!rows.length) return;
  const perWeek = course.scheduleMode === "Loop" ? 0 : course.days.length;
  state.ui.workspace.added = { text: H.lessonsAddedLine(rows, { perWeek }), from: firstNewIndex };
  state.ui.search = "";
  renderWorkspace();
  $$("#workspace tbody tr").forEach((tr) => { if (Number(tr.dataset.index) >= firstNewIndex) tr.classList.add("cb-new"); });
}

function addRow(course, fields = {}) {
  H.newLesson(course, { uuid, ...fields });
  touch();
  state.ui.workspace.openRow = course.lessons.length - 1;
  renderWorkspace();
  const rows = $$("#workspace tbody tr");
  $(".cb-col-title input", rows[rows.length - 1])?.focus();
}

function lessonRow(course, lesson, i) {
  const ws = state.ui.workspace;
  const open = state.ui.openRow === i;
  const tr = el("tr", { dataset: { index: i }, class: `${lesson.include === false ? "excluded" : ""}${ws.selectedRow === i ? " is-selected-row" : ""}${open ? " is-open" : ""}` });
  const select = (field) => { ws.selectedRow = i; ws.selectedField = field; $$("#workspace tbody tr").forEach((row) => row.classList.toggle("is-selected-row", Number(row.dataset.index) === i)); updateCopyDownLabel(); };
  const rid = (k) => `row-${i}-${k}`;

  // On a phone each row starts folded: number, title, minutes and the tags as words (Marlow's idea 8).
  // Tapping it opens every field; opening another row folds this one. Desktop shows every field always.
  const tagWords = (lesson.tags ?? []).map((t) => TAG_LABELS[t] ?? t).join(", ");
  const summary = el("button", { type: "button", class: "cb-row-open", "aria-expanded": String(open), "aria-controls": rid("fields"),
    onclick: () => { state.ui.openRow = open ? null : i; renderWorkspace(); if (!open) $(`#workspace tr[data-index="${i}"] .cb-col-title input`)?.focus(); } },
    el("span", { class: "cb-row-num" }, String(i + 1)),
    el("span", { class: "cb-row-title" }, lesson.title?.trim() || "Untitled lesson"),
    el("span", { class: "cb-row-meta" }, [lesson.minutes != null ? `${lesson.minutes} min` : `${course.minutes} min`, tagWords, lesson.include === false ? "Not added in the app" : ""].filter(Boolean).join(" \u00b7 ")));
  tr.append(el("td", { class: "cb-col-summary" }, summary));
  tr.append(el("td", { class: "cb-col-tick" }, el("label", { class: "cb-tick", "aria-label": `Include lesson ${i + 1}` }, el("input", { type: "checkbox", id: rid("tick"), checked: lesson.include !== false, "aria-label": `Include lesson ${i + 1}`, onchange: (e) => { lesson.include = e.target.checked; touch(); const fresh = lessonRow(course, lesson, i); tr.replaceWith(fresh); refreshWorkspaceCount(course); $(`#row-${i}-tick`)?.focus(); } }))));
  const handle = el("button", { type: "button", class: "cb-handle", "aria-label": `Drag to reorder row ${i + 1}` }, el("span"));
  enableRowDrag(handle, course, i);
  tr.append(el("td", { class: "cb-col-handle" }, handle));
  tr.append(el("td", { class: "cb-num" }, String(i + 1)));
  tr.append(el("td", { class: "cb-col-title" }, el("input", { type: "text", id: rid("title"), value: lesson.title, maxlength: H.LIMITS.title, "aria-label": `Title, row ${i + 1}`, placeholder: "Lesson title",
    onfocus: () => select("title"), oninput: (e) => { lesson.title = e.target.value; touch(); } })));
  const detailsArea = el("textarea", { id: rid("details"), maxlength: H.LIMITS.details, "aria-label": `What to do, row ${i + 1}`, placeholder: "What to do",
    onfocus: () => select("details"), oninput: (e) => { lesson.details = e.target.value; touch(); autoGrow(e.target); } }, lesson.details ?? "");
  tr.append(el("td", { class: "cb-col-details" }, detailsArea, isTogether(course) ? notesHelper(course, lesson, detailsArea) : null));
  tr.append(el("td", { class: "cb-col-min" }, el("input", { type: "number", min: H.LIMITS.minutesMin, max: H.LIMITS.minutesMax, step: 5, value: lesson.minutes ?? "", placeholder: String(course.minutes), inputmode: "numeric", "aria-label": `Minutes, row ${i + 1}`,
    onfocus: () => select("minutes"), onchange: (e) => { lesson.minutes = e.target.value === "" ? null : Number(e.target.value); touch(); } }),
    el("span", { class: "hint", style: { display: isNarrow() ? "inline" : "none" } }, "min")));
  const unitInput = el("input", { type: "text", value: lesson.unit ?? "", maxlength: 120, placeholder: "Unit", "aria-label": `Unit, row ${i + 1}`, onfocus: () => select("unit"),
    onchange: (e) => { startUnit(course, i, e.target.value); } });
  tr.append(el("td", { class: "cb-col-unit" }, unitInput, el("div", { class: "cb-rowtools" }, el("button", { type: "button", onclick: () => { const name = window.prompt("Unit name", lesson.unit ?? ""); if (name !== null) startUnit(course, i, name); } }, "Start a unit here"))));
  tr.append(el("td", { class: "cb-col-tags" }, tagChips(course, lesson, i)));
  tr.append(el("td", { class: "cb-col-tools" }, el("div", { class: "cb-rowtools" },
    // An unticked row still travels in the file with include:false; the app just doesn't add it (Marlow, Oct 6).
    lesson.include === false ? el("span", { class: "hint cb-left-out" }, "Won\u2019t be added in the app") : null,
    el("button", { type: "button", "aria-label": `Delete lesson ${i + 1}`, onclick: () => { course.lessons.splice(i, 1); if (ws.selectedRow === i) ws.selectedRow = null; if (state.ui.openRow === i) state.ui.openRow = null; touch(); renderWorkspace(); } }, "Delete"))));
  return tr;
}

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(220, textarea.scrollHeight)}px`;
}

const TAG_LABELS = { quiz: "Quiz", test: "Test", lab: "Lab", review: "Review", graded: "Counts toward grade" };

function tagChips(course, lesson, i) {
  lesson.tags ??= [];
  const box = el("div", { class: "cb-tags", role: "group", "aria-label": `Tags, row ${i + 1}` });
  for (const tag of H.TAGS) {
    const on = lesson.tags.includes(tag);
    box.append(el("button", { type: "button", class: "cb-chip", "aria-pressed": String(on), onclick: () => {
      if (on) {
        lesson.tags = lesson.tags.filter((t) => t !== tag);
        if (tag === "graded") lesson.pointsPossible = null;
      } else {
        lesson.tags = [...lesson.tags, tag];
        if (tag === "graded" && !(lesson.pointsPossible > 0)) lesson.pointsPossible = 100;
      }
      touch();
      box.replaceWith(tagChips(course, lesson, i));
      if (tag === "graded" && !on) $(`#row-${i}-points`)?.focus();
    } }, TAG_LABELS[tag]));
  }
  if (lesson.tags.includes("graded")) {
    box.append(el("label", { class: "cb-points-label", for: `row-${i}-points` }, "Out of"),
      el("input", { type: "number", id: `row-${i}-points`, class: "cb-points", min: 1, step: 1, value: lesson.pointsPossible ?? 100, inputmode: "numeric",
        onchange: (e) => { const v = Number(e.target.value); lesson.pointsPossible = v > 0 ? v : null; touch(); } }),
      el("span", { class: "cb-points-label" }, "points"));
  }
  return box;
}

/** "Start a unit here": the rows after this one carry the unit until the next unit starts; the unit is written into the title the way the app's import does ("Lesson 31 · Fractions"). */
function startUnit(course, index, name) {
  const unit = name.trim() || null;
  const old = course.lessons[index]?.unit ?? null;
  const undo = [];
  let last = index;
  for (let j = index; j < course.lessons.length; j += 1) {
    const row = course.lessons[j];
    if (j > index && (row.unit ?? null) !== old) break;
    undo.push({ index: j, unit: row.unit ?? null, title: row.title });
    row.unit = unit;
    row.title = H.retitleForUnit(row.title, old, unit);
    last = j;
  }
  // Say what happened and where it stopped, with one Undo (2.0 #6: bulk changes show their scope).
  state.ui.workspace.lastBulk = { text: unit ? `Unit \u201c${unit}\u201d applied to rows ${index + 1} through ${last + 1}.` : `Unit cleared on rows ${index + 1} through ${last + 1}.`,
    undo: () => { for (const u of undo) { course.lessons[u.index].unit = u.unit; course.lessons[u.index].title = u.title; } } };
  touch();
  renderWorkspace();
}

function retitle(title, oldUnit, newUnit) {
  let base = title ?? "";
  if (oldUnit && base.endsWith(` · ${oldUnit}`)) base = base.slice(0, -(` · ${oldUnit}`.length));
  if (!newUnit || !base.trim()) return base;
  if (base.includes(` · ${newUnit}`)) return base;
  return `${base} · ${newUnit}`;
}

// Row reorder by dragging the handle.
function enableRowDrag(handle, course, fromIndex) {
  let target = null;
  let before = true;
  const clear = () => $$("#workspace tbody tr").forEach((row) => row.classList.remove("is-drop-before", "is-drop-after"));
  pointerDrag(handle, {
    onStart: () => { handle.closest("tr")?.classList.add("is-selected-row"); },
    onMove: (ev) => {
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("#workspace tbody tr");
      clear();
      if (!row) { target = null; return; }
      const rect = row.getBoundingClientRect();
      before = ev.clientY < rect.top + rect.height / 2;
      target = Number(row.dataset.index);
      row.classList.add(before ? "is-drop-before" : "is-drop-after");
    },
    onEnd: (ev) => {
      clear();
      if (!ev || target === null) return;
      let to = before ? target : target + 1;
      if (to > fromIndex) to -= 1;
      if (to === fromIndex) return;
      const [moved] = course.lessons.splice(fromIndex, 1);
      course.lessons.splice(to, 0, moved);
      state.ui.workspace.selectedRow = to;
      touch();
      renderWorkspace();
    },
  });
}

// Pattern fill ("the book does the math")
function patternFillTool(course) {
  const details = el("details", { class: "cb-tool", dataset: { tool: "pattern" } });
  details.append(el("summary", { class: "btn btn-paper" }, "Number or divide pages"));
  const body = el("div", { class: "cb-tool-body" });
  const form = { titlePattern: state.titlePatterns[course.courseId] ?? "Lesson {n}", mode: "count", count: "", pages: "", pagesPerLesson: "", startPage: "1", every: "", everyKind: "Quiz", unit: "",
    graded: course.gradingMode === "Points", points: "100" };
  const sentence = el("p", { class: "cb-sentence", "aria-live": "polite" });
  const addButton = el("button", { type: "button", class: "btn btn-slate" }, "Add lessons");
  const replaceId = "pf-replace";
  const replaceBox = el("input", { type: "checkbox", id: replaceId, onchange: (e) => { state.ui.workspace.replace = e.target.checked; } });

  const compute = () => {
    const titlePattern = form.unit.trim() && !form.titlePattern.includes("{unit}") ? `${form.titlePattern} · {unit}` : form.titlePattern;
    const opts = { titlePattern, unit: form.unit, every: form.every, everyKind: form.everyKind, graded: form.graded, points: form.points };
    if (form.mode === "pages") Object.assign(opts, { pages: form.pages, pagesPerLesson: form.pagesPerLesson, startPage: form.startPage });
    else opts.count = form.count;
    return H.patternFill(opts);
  };
  const refresh = () => {
    const result = compute();
    refreshEvery();
    refreshGraded();
    sentence.textContent = result.sentence;
    addButton.textContent = result.count ? `Add ${plural(result.count, "lesson")}` : "Add lessons";
    addButton.disabled = result.count === 0;
    pagesFields.hidden = form.mode !== "pages";
    countField.hidden = form.mode !== "count";
  };
  const text = (key, label, extra = {}) => {
    const id = `pf-${key}`;
    return el("div", { class: `cb-field${extra.short ? " short" : ""}` }, el("label", { for: id }, label),
      el("input", { type: extra.number ? "number" : "text", id, value: form[key], min: extra.number ? 1 : null, inputmode: extra.number ? "numeric" : null, placeholder: extra.placeholder ?? null,
        oninput: (e) => { form[key] = e.target.value; refresh(); } }));
  };
  const countField = text("count", "How many lessons", { number: true, short: true });
  const pagesFields = el("div", { class: "cb-row" }, text("pages", "Pages in the book", { number: true, short: true }), text("pagesPerLesson", "Pages a lesson", { number: true, short: true }), text("startPage", "Start on page", { number: true, short: true }));
  const kindSelect = el("select", { id: "pf-kind", onchange: (e) => { form.everyKind = e.target.value; refresh(); } }, H.PATTERN_KINDS.map((k) => el("option", { value: k }, k)));
  // "Every 3rd lesson is a", said properly for whatever number is typed; "__th" read as "thirth".
  const everyLabel = el("label", { for: "pf-every" }, "Every ___ lesson is a");
  // Ticked for a Points course, unticked otherwise (Josh, October 6, 2026); Review and Lab rows are never graded.
  const gradedBox = el("input", { type: "checkbox", id: "pf-graded", checked: form.graded, onchange: (e) => { form.graded = e.target.checked; refresh(); } });
  const pointsInput = el("input", { type: "number", id: "pf-points", min: 1, inputmode: "numeric", value: form.points, style: { width: "5.5rem" }, "aria-label": "Points", oninput: (e) => { form.points = e.target.value; refresh(); } });
  const gradedHint = el("p", { class: "hint", style: { margin: 0 } });
  const refreshGraded = () => {
    const assessment = form.everyKind === "Quiz" || form.everyKind === "Test";
    gradedBox.disabled = !assessment; pointsInput.disabled = !assessment || !form.graded;
    gradedHint.textContent = !assessment ? `A ${form.everyKind.toLowerCase()} row is tagged, not graded. {q} in a title becomes its number.`
      : form.graded ? `Each ${form.everyKind.toLowerCase()} row is tagged and counts toward the grade out of the points above. {q} in a title becomes its number.`
      : `Tagged as a ${form.everyKind.toLowerCase()}. Tick Counts toward grade on a row if it should count. {q} in a title becomes its number.`;
  };
  const refreshEvery = () => { const n = Number(form.every); everyLabel.textContent = n >= 2 ? `Every ${H.ordinal(n)} lesson is a` : "Every ___ lesson is a"; };
  // Three questions in order (Josh, October 6, 2026): what to call them, how many, any quizzes.
  const step = (n, title, ...children) => el("div", { class: "cb-pf-step" }, el("div", { class: "cb-pf-head" }, el("span", { class: "cb-pf-n" }, String(n)), el("b", null, title)), ...children);
  body.append(
    step(1, "What to call each lesson",
      el("div", { class: "cb-row" }, text("titlePattern", "Title", { placeholder: "Lesson {n}" }), text("unit", "Unit (optional)", { placeholder: "Fractions" })),
      el("p", { class: "hint", style: { margin: 0 } }, "Lesson 1, Lesson 2, Lesson 3\u2026 is what \u201cLesson {n}\u201d gives you: {n} becomes the lesson number. If you type a unit it goes on every title.")),
    step(2, "How many",
      el("div", { class: "cb-radio-row" },
        el("label", null, el("input", { type: "radio", name: "pf-mode", value: "count", checked: true, onchange: () => { form.mode = "count"; refresh(); } }), "I know how many lessons"),
        el("label", null, el("input", { type: "radio", name: "pf-mode", value: "pages", onchange: () => { form.mode = "pages"; refresh(); } }), "Work it out from the pages in the book")),
      countField, pagesFields),
    step(3, "Any quizzes or tests?",
      el("div", { class: "cb-row" },
        el("div", { class: "cb-field", style: { flex: "0 1 220px" } }, everyLabel, el("input", { type: "number", id: "pf-every", min: 2, inputmode: "numeric", placeholder: "none", oninput: (e) => { form.every = e.target.value; refresh(); } })),
        el("div", { class: "cb-field short" }, el("label", { for: "pf-kind" }, "Kind"), kindSelect)),
      el("label", { class: "cb-graded-row" }, gradedBox, " These count toward the grade, out of ", pointsInput, " points"),
      gradedHint),
    sentence,
    el("div", { class: "cb-row" }, addButton, course.lessons.length ? el("label", { style: { fontWeight: 500, display: "inline-flex", gap: "0.4rem", alignItems: "center", margin: 0 } }, replaceBox, "Replace the lessons already here") : null));
  addButton.addEventListener("click", () => {
    const result = compute();
    if (!result.count) return;
    if (state.ui.workspace.replace && course.lessons.length && !window.confirm(`Replace the ${plural(course.lessons.length, "lesson")} already here?`)) return;
    if (state.ui.workspace.replace) course.lessons = [];
    const from = course.lessons.length;
    for (const row of result.lessons) H.newLesson(course, { uuid, title: row.title, details: row.details, unit: row.unit, tags: row.tags, pointsPossible: row.pointsPossible });
    state.ui.workspace.replace = false;
    touch();
    noteLessonsAdded(course, from);
  });
  details.append(body);
  refresh();
  return details;
}

// Paste a table of contents
function tocTool(course) {
  const details = el("details", { class: "cb-tool", dataset: { tool: "toc" } });
  details.append(el("summary", { class: "btn btn-paper" }, "Paste titles"));
  const body = el("div", { class: "cb-tool-body" });
  const textarea = el("textarea", { id: "toc-text", rows: 6, placeholder: "Paste a contents page or any list, one title a line. Page numbers come off by themselves.", "aria-label": "Titles to paste" });
  const review = el("div");
  const addRows = (rows) => {
    const from = course.lessons.length;
    for (const row of rows) H.newLesson(course, { uuid, title: row.title, details: row.details ?? "", unit: row.unit ?? null });
    touch();
    noteLessonsAdded(course, from);
  };
  const read = () => {
    review.replaceChildren();
    const text = textarea.value;
    const explained = H.explainContents(text);
    if (explained === null) {
      // A contents page laid out as units with lesson ranges: the rows are the units' lessons.
      const rows = H.parseContents(text);
      if (!rows.length) { review.append(el("p", { class: "hint" }, "Nothing to add yet. Paste a few lines first.")); return; }
      const list = el("ul", { class: "cb-review", "aria-label": "Rows to add" });
      rows.forEach((row, i) => list.append(el("li", null, el("label", null, el("input", { type: "checkbox", checked: true, dataset: { index: i } }),
        el("span", null, row.title, row.unit ? el("span", { class: "cb-unit" }, row.unit) : null)))));
      const add = el("button", { type: "button", class: "btn btn-slate", onclick: () => addRows($$("input:checked", list).map((box) => rows[Number(box.dataset.index)])) }, `Add ${plural(rows.length, "lesson")}`);
      list.addEventListener("change", () => { add.textContent = `Add ${plural($$("input:checked", list).length, "lesson")}`; });
      review.append(el("p", { class: "hint" }, `${plural(rows.length, "lesson")} found. Untick any you don't want.`), list, el("div", { class: "cb-row" }, add));
      return;
    }
    if (!explained.length) { review.append(el("p", { class: "hint" }, "Nothing to add yet. Paste a few lines first.")); return; }
    // Every source line, in order. Left-out lines are unticked with the reason; changed lines show
    // the original with "Keep my wording" (Quarry's fix 3, October 6, 2026).
    const found = explained.filter((e) => e.status !== "left out").length;
    const leftOut = explained.length - found;
    const changed = explained.filter((e) => e.status === "changed").length;
    const list = el("ul", { class: "cb-review", "aria-label": "Lines from the contents page" });
    const keepAll = el("input", { type: "checkbox", id: "toc-keep-all" });
    explained.forEach((entry, i) => {
      const tick = el("input", { type: "checkbox", checked: entry.status !== "left out", dataset: { index: i } });
      const keep = entry.status === "changed" ? el("input", { type: "checkbox", class: "cb-keep", dataset: { index: i } }) : null;
      const item = el("li", { class: entry.status === "left out" ? "left-out" : "" },
        el("label", null, tick, el("span", null, entry.status === "left out" ? entry.literal : entry.title)),
        entry.status === "left out" ? el("span", { class: "cb-line-note" }, `Left out (${entry.reason}). Tick to add it as written.`) : null,
        entry.status === "changed" ? el("label", { class: "cb-line-note" }, keep, ` Keep my wording: \u201c${entry.literal}\u201d`) : null);
      list.append(item);
    });
    const add = el("button", { type: "button", class: "btn btn-slate" }, "Add lessons");
    const refreshAdd = () => { add.textContent = `Add ${plural($$("input:not(.cb-keep):checked", list).length, "lesson")}`; };
    refreshAdd();
    keepAll.addEventListener("change", () => { $$(".cb-keep", list).forEach((box) => { box.checked = keepAll.checked; }); });
    list.addEventListener("change", refreshAdd);
    add.addEventListener("click", () => {
      const rows = $$("input:not(.cb-keep):checked", list).map((box) => {
        const entry = explained[Number(box.dataset.index)];
        const keep = $(`.cb-keep[data-index="${box.dataset.index}"]`, list)?.checked;
        return { title: entry.status === "left out" || keep ? entry.literal : entry.title, unit: null, details: "" };
      });
      addRows(rows);
    });
    review.append(
      el("p", { class: "hint" }, `${plural(found, "lesson")} found${leftOut ? `, ${plural(leftOut, "line")} left out` : ""}. Untick any you don't want; tick a left-out line to add it as written.`),
      changed ? el("label", { class: "cb-keep-all" }, keepAll, ` Keep my wording on all ${plural(changed, "changed line")}`) : null,
      list, el("div", { class: "cb-row" }, add));
  };
  body.append(el("div", { class: "cb-field" }, el("label", { for: "toc-text" }, "Titles, one a line"), textarea),
    el("div", { class: "cb-row" }, el("button", { type: "button", class: "btn btn-paper", onclick: read }, "Read it")),
    el("p", { class: "hint", style: { margin: 0 } }, "Numbered lessons are kept and \u201cLesson 3:\u201d, page numbers and headings come off. Every line you pasted is listed, so nothing goes missing without a word."),
    review);
  details.append(body);
  return details;
}

// 2.0 #6: Edit rows: one field, a range, a preview of what changes, Apply, Undo
function bulkEditTool(course) {
  const details = el("details", { class: "cb-tool", dataset: { tool: "bulk" } });
  details.append(el("summary", { class: "btn btn-paper" }, "Change several rows"));
  const form = { field: "minutes", from: "1", to: String(course.lessons.length), value: "" };
  const fieldSelect = el("select", { id: "be-field", onchange: (e) => { form.field = e.target.value; refresh(); } },
    el("option", { value: "minutes" }, "Minutes"), el("option", { value: "unit" }, "Unit"), el("option", { value: "title" }, "Title"), el("option", { value: "details" }, "What to do"));
  const fromInput = el("input", { type: "number", id: "be-from", min: 1, max: course.lessons.length, value: form.from, inputmode: "numeric", oninput: (e) => { form.from = e.target.value; refresh(); } });
  const toInput = el("input", { type: "number", id: "be-to", min: 1, max: course.lessons.length, value: form.to, inputmode: "numeric", oninput: (e) => { form.to = e.target.value; refresh(); } });
  const valueInput = el("input", { type: "text", id: "be-value", placeholder: "25", oninput: (e) => { form.value = e.target.value; refresh(); } });
  const sentence = el("p", { class: "cb-sentence", "aria-live": "polite" });
  const preview = el("ul", { class: "cb-replace-preview" });
  const apply = el("button", { type: "button", class: "btn btn-slate" }, "Apply");
  const compute = () => {
    try { return H.bulkEditPreview(course, form); } catch { return { field: form.field, from: 1, to: 0, changes: [] }; }
  };
  const refresh = () => {
    valueInput.placeholder = form.field === "minutes" ? "25" : form.field === "unit" ? "Fractions" : form.field === "title" ? "Day {n}: {title}" : "Read pages {n}.";
    const p = compute();
    const n = p.changes.length;
    sentence.textContent = n ? `Replaces ${plural(n, "value")} in rows ${p.from} through ${p.to}.` : "Nothing would change yet.";
    preview.replaceChildren(...p.changes.slice(0, 5).map((c) => el("li", null, `Row ${c.index + 1}: `, el("s", null, String(c.before ?? "blank")), " \u2192 ", el("b", null, String(c.after ?? "blank")),
      c.titleAfter != null ? el("span", { class: "hint" }, ` (title becomes \u201c${c.titleAfter}\u201d)`) : null)));
    apply.disabled = n === 0;
    apply.textContent = n ? `Apply to ${plural(n, "row")}` : "Apply";
  };
  apply.addEventListener("click", () => {
    const p = compute();
    if (!p.changes.length) return;
    const undo = H.applyBulkEdit(course, p);
    state.ui.workspace.lastBulk = { text: `${fieldSelect.selectedOptions[0].textContent} changed on ${plural(p.changes.length, "row")}, rows ${p.from} through ${p.to}.`, undo: () => H.undoBulkEdit(course, undo) };
    touch();
    renderWorkspace();
  });
  details.append(el("div", { class: "cb-tool-body" },
    el("div", { class: "cb-row" },
      el("div", { class: "cb-field short" }, el("label", { for: "be-field" }, "Field"), fieldSelect),
      el("div", { class: "cb-field short" }, el("label", { for: "be-from" }, "From row"), fromInput),
      el("div", { class: "cb-field short" }, el("label", { for: "be-to" }, "To row"), toInput),
      el("div", { class: "cb-field" }, el("label", { for: "be-value" }, "New value"), valueInput)),
    el("p", { class: "hint", style: { margin: 0 } }, "For a title or What to do, {n} is the row number and {title} the row\u2019s current title. A blank unit or minutes clears them."),
    sentence, preview, el("div", { class: "cb-row" }, apply)));
  refresh();
  return details;
}

/** The note under the toolbar after a bulk change, with its Undo. */
function lastBulkNote() {
  const last = state.ui.workspace.lastBulk;
  if (!last) return null;
  return el("p", { class: "cb-bulk-note" }, last.text, " ", el("button", { type: "button", class: "cb-link-btn", onclick: () => { last.undo(); state.ui.workspace.lastBulk = null; touch(); renderWorkspace(); } }, "Undo"));
}

// Copy down (the spreadsheet move)
let copyDownLabelNode = null;
function updateCopyDownLabel() {
  if (!copyDownLabelNode) return;
  const ws = state.ui.workspace;
  copyDownLabelNode.textContent = ws.selectedRow == null ? "Click a title or What to do cell first." : `From row ${ws.selectedRow + 1}, the ${ws.selectedField === "details" ? "What to do" : ws.selectedField} cell. {n} and page numbers keep counting.`;
}
function copyDownTool(course) {
  const details = el("details", { class: "cb-tool", dataset: { tool: "copy" } });
  details.append(el("summary", { class: "btn btn-paper" }, "Copy down"));
  copyDownLabelNode = el("p", { class: "hint", style: { margin: 0 } });
  updateCopyDownLabel();
  const toRow = el("input", { type: "number", id: "cd-to", min: 1, inputmode: "numeric", placeholder: String(course.lessons.length) });
  const apply = (toIndex) => {
    const ws = state.ui.workspace;
    if (ws.selectedRow == null) return;
    const field = ["title", "details", "unit", "minutes"].includes(ws.selectedField) ? ws.selectedField : "title";
    course.lessons = H.copyDown(course.lessons, ws.selectedRow, toIndex, field);
    touch();
    renderWorkspace();
  };
  details.append(el("div", { class: "cb-tool-body" },
    el("p", { class: "hint", style: { margin: 0 } }, "Like a spreadsheet: copies one cell into the rows below it, and numbers and page ranges keep counting up."),
    copyDownLabelNode,
    el("div", { class: "cb-row" },
      el("button", { type: "button", class: "btn btn-paper", onclick: () => apply(course.lessons.length - 1) }, "Copy down to the end"),
      el("div", { class: "cb-field short" }, el("label", { for: "cd-to" }, "To row"), toRow),
      el("button", { type: "button", class: "btn btn-paper", onclick: () => { const n = Number(toRow.value); if (n >= 1) apply(n - 1); } }, "Copy down to that row"))));
  return details;
}

// MARK: - Screen 5: preview a day

function renderPreview() {
  const host = $("#preview");
  host.replaceChildren();
  const p = state.ui.preview;
  if (!lanes().length) { host.append(el("p", null, "Add a child first.")); return; }
  if (!laneById(p.laneId)) p.laneId = lanes()[0].laneId;
  if (!shownDays().includes(p.day)) p.day = shownDays()[0];
  p.startOn ??= H.nextMonday(new Date());
  const lane = laneById(p.laneId);

  const laneSelect = el("select", { id: "pv-lane", onchange: (e) => { p.laneId = e.target.value; renderPreview(); } }, lanes().map((l) => el("option", { value: l.laneId, selected: l.laneId === p.laneId }, laneAndGrade(l))));
  const daySelect = el("select", { id: "pv-day", onchange: (e) => { p.day = e.target.value; renderPreview(); } }, shownDays().map((d) => el("option", { value: d, selected: d === p.day }, H.dayName(d))));
  const startInput = el("input", { type: "date", id: "pv-start", value: p.startOn, onchange: (e) => { if (e.target.value) { p.startOn = e.target.value; renderPreview(); } } });
  host.append(el("div", { class: "cb-preview-controls" },
    el("div", { class: "cb-field" }, el("label", { for: "pv-lane" }, "Lane"), laneSelect),
    el("div", { class: "cb-field" }, el("label", { for: "pv-day" }, "Day"), daySelect),
    el("div", { class: "cb-field" }, el("span", { class: "cb-label-text", style: { fontWeight: 600, fontSize: "0.95rem" } }, "Week"),
      el("div", { class: "cb-stepper", role: "group", "aria-label": "Week" },
        el("button", { type: "button", "aria-label": "Earlier week", disabled: p.weekIndex === 0, onclick: () => { p.weekIndex = Math.max(0, p.weekIndex - 1); renderPreview(); } }, "−"),
        el("span", { "aria-live": "polite" }, `Week ${p.weekIndex + 1}`),
        el("button", { type: "button", "aria-label": "Later week", onclick: () => { p.weekIndex += 1; renderPreview(); } }, "+"),
        el("input", { type: "number", min: 1, max: 60, value: p.weekIndex + 1, inputmode: "numeric", "aria-label": "Go to week", class: "cb-week-input",
          onchange: (e) => { p.weekIndex = Math.max(0, (Number(e.target.value) || 1) - 1); renderPreview(); } }))),
    el("div", { class: "cb-field" }, el("label", { for: "pv-start" }, "Start on"), startInput)));

  const monday = mondayOf(p.startOn);
  const day = H.previewDay(week(), lane.laneId, p.day, { weekIndex: p.weekIndex, startOn: monday });
  const card = el("div", { class: "cb-today", style: { "--lane": laneHex(lane) } },
    el("h3", null, el("span", { class: "cb-dot", style: { background: laneHex(lane) }, "aria-hidden": "true" }), laneTitle(lane)));
  if (day.away) {
    card.append(el("div", { class: "cb-away" }, el("strong", null, "Away day: no lessons here"), day.away.label ? `${day.away.label}. ` : "", "The app uses your own school days and away days."));
  } else if (day.rows.length === 0) {
    // A course can land on the day and still have nothing to show: no lesson rows yet, or the
    // week stepper is past its last row. Say that, rather than "no course lands here".
    const landing = day.landing.filter((name) => !day.together.some((row) => row.courseName === name));
    const finished = day.finishedDetails.filter((f) => !day.together.some((row) => row.courseName === f.courseName));
    const parts = [];
    for (const f of finished) parts.push(`${f.courseName} is finished: its last lesson (${f.lessonNumber}) was ${f.date ? H.longDate(f.date) : H.dayName(f.day)}.`);
    if (landing.length) parts.push(`${joinNames(landing)} ${landing.length === 1 ? "lands" : "land"} on this day but ${landing.length === 1 ? "has" : "have"} no lesson for it yet.`);
    const why = parts.length ? parts.join(" ") : "No course lands on this day for this lane.";
    card.append(el("div", { class: "cb-away" }, el("strong", null, finished.length && !landing.length ? "Course complete" : "Nothing planned"), why));
  } else {
    card.append(el("ul", null, day.rows.map((row) => previewRow(row, lane))));
    card.append(el("div", { class: "cb-total" }, el("span", null, "Total"), el("span", null, hoursMinutes(day.rows.reduce((t, r) => t + (Number(r.minutes) || 0), 0)))));
  }
  // Drawn inside a phone so she sees what she is building (Josh, October 6, 2026); the note
  // under it says it is a rendering, not the app.
  const screen = el("div", { class: "cb-phone-screen" },
    el("div", { class: "cb-phone-top" }, el("span", null, "Today"), el("span", { class: "cb-phone-date" }, day.date ? H.longDate(day.date).replace(/, \d{4}$/, "") : H.dayName(p.day))),
    card);
  const column = el("div", null, el("div", { class: "cb-phone" }, el("div", { class: "cb-phone-notch" }), screen),
    el("p", { class: "hint cb-phone-note" }, "* Conceptual rendering of the phone layout. The app uses your own school days and away days."));
  if (day.together.length) {
    const t = el("div", { class: "cb-today together", style: { "--lane": laneHex(lane) } },
      el("h3", null, "Together"), el("p", { class: "cb-date" }, day.together[0].colors.join(" and ")),
      el("ul", null, day.together.map((row) => previewRow(row, lane))),
      el("div", { class: "cb-total" }, el("span", null, "Together"), el("span", null, hoursMinutes(day.together.reduce((s, r) => s + (Number(r.minutes) || 0), 0)))));
    screen.append(t);
  }

  const finish = el("div", { class: "cb-finish" }, el("h3", null, "Estimated finish"));
  const mine = courses().filter((c) => c.laneIds.includes(lane.laneId));
  if (!mine.length) finish.append(el("p", { class: "muted small" }, "No courses on this lane yet."));
  for (const course of mine) {
    const est = H.estimatedFinish(course, { startOn: course.startDate ?? monday, week: week() });
    let note = null;
    if (course.scheduleMode !== "Loop" && !course.spreadOverYear && est.date) note = "Breaks you've set in the app will push this a little later.";
    finish.append(el("div", { class: "cb-fin", style: { "--lane": laneHex(courseLanes(course)[0]) } }, el("b", null, course.name || "Untitled", isTogether(course) ? " · Together" : ""), el("span", null, est.text), note ? el("p", { class: "hint" }, note) : null));
  }
  host.append(el("div", { class: "cb-preview-layout" }, column, finish));
}

function previewRow(row, lane) {
  const details = el("p", { class: "cb-details" }, row.details);
  const more = row.details && row.details.length > 90 ? el("button", { type: "button", class: "cb-more", "aria-expanded": "false", onclick: (e) => { const open = details.classList.toggle("open"); e.currentTarget.setAttribute("aria-expanded", String(open)); e.currentTarget.textContent = open ? "Less" : "More"; } }, "More") : null;
  return el("li", { style: { "--lane": laneHex(lane) } }, icon(row.subject),
    el("div", null, el("div", { class: "cb-course" }, row.courseName, row.nextUp ? el("span", { class: "cb-nextup" }, "Next up") : null), el("div", { class: "cb-ltitle" }, row.title), row.details ? details : null, more),
    el("span", { class: "cb-mins" }, `${row.minutes} min`));
}

function hoursMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The Monday of the week holding a "YYYY-MM-DD" date (the preview counts weeks from a Monday). */
function mondayOf(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const back = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

// MARK: - Screen 6: Review your plan (2.0 #2), then the checks and the download

function renderReview() {
  const host = $("#review");
  host.replaceChildren();
  $("#share-box").hidden = true;
  $("#addonly-line").textContent = H.COPY.addOnly;
  const saved = $("#review-saved");
  if (state.ui.downloaded && !state.ui.changedSinceDownload) $("#download-name").textContent = `Downloaded ${H.fileName(week())}. It\u2019s in your Downloads folder.`;
  else $("#download-name").textContent = `The file will be called ${H.fileName(week())}.`;
  if (state.ui.privateSession) saved.textContent = "Private session: nothing is saved on this device. Download the file to keep it. Nothing is sent to us.";
  else if (state.ui.lastSavedAt) saved.textContent = `Saved on this device at ${new Date(state.ui.lastSavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Nothing is sent to us.`;
  else saved.textContent = "Not saved on this device yet. Nothing is sent to us.";
  if (!lanes().length) { host.append(el("p", { class: "cb-empty" }, "Add a child first.")); return; }
  const days = shownDays();

  // The family's week in color lanes.
  const grid = el("table", { class: "cb-rv-week", "aria-label": "The week" });
  grid.append(el("thead", null, el("tr", null, el("th", { scope: "col" }, ""), ...days.map((d) => el("th", { scope: "col", class: isDayOn(d) ? "" : "off" }, H.shortDayName(d))))));
  const body = el("tbody");
  for (const lane of lanes()) {
    const tr = el("tr", { style: { "--lane": laneHex(lane) } });
    tr.append(el("th", { scope: "row" }, el("span", { class: "cb-dot", "aria-hidden": "true" }), laneAndGrade(lane)));
    for (const d of days) {
      const mine = courses().filter((c) => c.laneIds.includes(lane.laneId) && (c.days.includes(d) || (c.scheduleMode === "Loop" && c.days.length === 0 && isDayOn(d))));
      tr.append(el("td", { class: isDayOn(d) ? "" : "off" }, ...mine.map((c) => el("span", { class: `cb-rv-block${isTogether(c) ? " together" : ""}` }, c.name || "Untitled"))));
    }
    body.append(tr);
  }
  grid.append(body);
  host.append(el("h3", { class: "cb-review-h" }, "The week"), el("div", { class: "cb-table-wrap cb-rv-wrap" }, grid));

  // Each child's day: own, together, combined; shared counted once; no parent total.
  const loads = el("div", { class: "cb-rv-loads" });
  for (const lane of lanes()) {
    const card = el("div", { class: "cb-rv-card", style: { "--lane": laneHex(lane) } }, el("h4", null, el("span", { class: "cb-dot", "aria-hidden": "true" }), laneTitle(lane)));
    const list = el("ul");
    for (const d of days) {
      if (!isDayOn(d)) { list.append(el("li", { class: "off" }, el("b", null, H.dayName(d)), " grayed out")); continue; }
      const w = H.dayWorkload(week(), lane.laneId, d);
      const parts = [];
      if (w.own) parts.push(`${w.own} min on their own`);
      if (w.together) parts.push(`${w.together} min together`);
      list.append(el("li", null, el("b", null, H.dayName(d)), w.combined ? ` ${parts.join(" + ")}${parts.length > 1 ? ` = ${w.combined} min` : ""}` : " nothing planned"));
    }
    card.append(list);
    loads.append(card);
  }
  host.append(el("h3", { class: "cb-review-h" }, "Each child\u2019s day"), el("p", { class: "hint", style: { margin: "0 0 0.5rem" } }, "Together time counts once for each child. These are the children\u2019s minutes, not yours: shared and independent work happen at different times."), loads);

  // Every course through its last lesson.
  const list = el("div", { class: "cb-rv-courses" });
  for (const course of courses()) {
    const span = H.courseSpan(course);
    const who = courseLanes(course).map(laneTitle).join(" and ");
    const est = H.estimatedFinish(course, { startOn: course.startDate ?? H.nextMonday(new Date()), week: week() });
    const row = el("div", { class: `cb-rv-course${span.count ? "" : " empty"}`, style: { "--lane": laneHex(courseLanes(course)[0]) } },
      icon(course.subject),
      el("div", null,
        el("b", null, course.name || "Untitled course"), el("span", { class: "muted small" }, ` \u00b7 ${who} \u00b7 ${course.scheduleMode} \u00b7 ${course.days.length ? course.days.map(H.shortDayName).join(", ") : "no days"} \u00b7 ${minutesLabel(course.minutes)}`),
        el("div", { class: "small" }, span.count
          ? `Complete through lesson ${span.count}: \u201c${span.first}\u201d to \u201c${span.last}\u201d. ${course.scheduleMode === "Loop" ? est.text : `Finishes ${est.text}.`}`
          : `No lessons yet. ${H.COPY.todayAsks(course.name || "this course")} and you plan as you go.`)),
      span.count ? el("button", { type: "button", class: "btn btn-paper small", onclick: () => openWorkspace(course.courseId) }, "Lessons") : el("button", { type: "button", class: "btn btn-slate small", onclick: () => openWorkspace(course.courseId) }, "Add lessons"));
    list.append(row);
  }
  host.append(el("h3", { class: "cb-review-h" }, "Every course"), list);

  // A week jump into the preview: one action to week 36.
  const weekInput = el("input", { type: "number", id: "rv-week", min: 1, max: 60, value: state.ui.preview.weekIndex + 1, inputmode: "numeric", style: { width: "5.5rem" }, "aria-label": "Week number" });
  const jump = () => { const n = Math.max(1, Number(weekInput.value) || 1); state.ui.preview.weekIndex = n - 1; go(5); };
  weekInput.addEventListener("keydown", (e) => { if (e.key === "Enter") jump(); });
  host.append(el("div", { class: "cb-row cb-rv-jump" }, el("label", { for: "rv-week" }, "See a week in the preview"), weekInput, el("button", { type: "button", class: "btn btn-paper small", onclick: jump }, "Go")));
}

/**
 * 2.0 #7, the notes helper for a Teach-together lesson: one tap writes "Together: ", "Blue: " or
 * "Green: " on its own line in What to do, keeping what is there and the 4,000-character limit.
 * Color words, never names, so nothing new reaches the file and the name check still applies.
 */
function notesHelper(course, lesson, textarea) {
  const labels = ["Together", ...courseLanes(course).map((lane) => H.laneLabel(lane))];
  const insert = (label) => {
    const current = textarea.value;
    const line = `${label}: `;
    if (current.includes(`${label}:`)) { const at = current.indexOf(`${label}:`) + label.length + 1; textarea.focus(); textarea.setSelectionRange(current.length >= at ? Math.min(current.length, at + 1) : at, current.length); return; }
    const next = current.trim() ? `${current.replace(/\s+$/, "")}\n${line}` : line;
    if (next.length > H.LIMITS.details) return;
    textarea.value = next;
    lesson.details = next;
    touch();
    autoGrow(textarea);
    textarea.focus();
    textarea.setSelectionRange(next.length, next.length);
  };
  return el("div", { class: "cb-helper", "aria-label": "Write a line for" },
    el("span", { class: "cb-helper-label" }, "Add a line for"),
    ...labels.map((label) => el("button", { type: "button", class: "cb-chip", onclick: () => insert(label) }, label)));
}

/** 2.0 #4: the lesson table jumps to row N or to the first row of a unit. */
function jumpTools(course) {
  const rowInput = el("input", { type: "number", id: "jump-row", min: 1, max: Math.max(1, course.lessons.length), inputmode: "numeric", placeholder: "row", style: { width: "5.5rem" }, "aria-label": "Go to row" });
  const goRow = (index) => {
    if (isNarrow() && course.lessons[index] && state.ui.openRow !== index) { state.ui.openRow = index; renderWorkspace(); }
    const tr = $(`#workspace tr[data-index="${index}"]`);
    if (!tr) return;
    tr.hidden = false;
    // A plain window scroll: scrollIntoView inside the table's own scroll box stopped short on a phone.
    const rect = tr.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, rect.top + window.scrollY - Math.max(80, window.innerHeight / 2 - rect.height / 2)), behavior: "instant" });
    $(".cb-col-title input", tr)?.focus({ preventScroll: true });
  };
  rowInput.addEventListener("keydown", (e) => { if (e.key === "Enter") goRow(Number(rowInput.value) - 1); });
  const units = [...new Set(course.lessons.map((l) => l.unit).filter((u) => typeof u === "string" && u.trim()))];
  const unitSelect = units.length ? el("select", { "aria-label": "Go to unit", onchange: (e) => { const i = course.lessons.findIndex((l) => l.unit === e.target.value); if (i >= 0) goRow(i); e.target.value = ""; } },
    el("option", { value: "" }, "Go to unit\u2026"), ...units.map((u) => el("option", { value: u }, u))) : null;
  return el("div", { class: "cb-jump" }, el("label", { for: "jump-row" }, "Go to"), rowInput, el("button", { type: "button", class: "btn btn-paper small", onclick: () => goRow(Number(rowInput.value) - 1) }, "Row"), unitSelect);
}

/** 2.0 #5: the empty workspace asks how she wants to add lessons; each choice opens the matching tool. */
function lessonChooser(course) {
  const open = (which, mode) => {
    const details = $(`#workspace details.cb-tool[data-tool="${which}"]`);
    if (!details) return;
    details.open = true;
    if (mode) { const radio = $(`input[name="pf-mode"][value="${mode}"]`, details); if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); } }
    details.scrollIntoView({ block: "start", behavior: "auto" });
    $("input, textarea", details)?.focus();
  };
  return el("div", { class: "cb-chooser" },
    el("h3", null, "How would you like to add lessons?"),
    el("div", { class: "cb-chooser-grid" },
      el("button", { type: "button", onclick: () => open("pattern", "count") }, el("b", null, "Number them"), el("span", null, "Lesson 1, Lesson 2, \u2026 and say how many.")),
      el("button", { type: "button", onclick: () => open("pattern", "pages") }, el("b", null, "Divide a book\u2019s pages"), el("span", null, "Pages in the book and pages a lesson; the rows work out.")),
      el("button", { type: "button", onclick: () => open("toc") }, el("b", null, "Paste the titles"), el("span", null, "A table of contents or any list, one line each.")),
      el("button", { type: "button", onclick: () => { addRow(course); } }, el("b", null, "Write them myself"), el("span", null, "One row at a time."))),
    el("p", { class: "hint" }, "Nothing here goes on a date yet. The app puts lessons on your own school days."));
}

// MARK: - 2.0 #9 share link, #10 co-op pack, #8 fridge sheet (all offered on Review your plan)

const pageBase = () => `${location.origin}${location.pathname}`;

async function showShareLink() {
  const box = $("#share-box"), url = $("#share-url"), note = $("#share-note");
  box.hidden = false;
  try {
    url.value = await H.shareLink(week(), pageBase());
    note.textContent = `${url.value.length.toLocaleString("en-US")} characters, all inside the link. Whoever opens it starts from this shape with their own children.`;
  } catch (error) {
    url.value = "";
    note.textContent = error?.message ?? "Too big for a link; download the file instead.";
  }
  box.scrollIntoView({ block: "nearest" });
  url.select();
}

async function copyShareLink() {
  const url = $("#share-url").value;
  if (!url) return;
  try { await navigator.clipboard.writeText(url); $("#share-note").textContent = "Copied."; }
  catch { $("#share-url").select(); $("#share-note").textContent = "Select the link and copy it."; }
}

function openCoopDialog() {
  const dialog = $("#coop-dialog");
  if (!dialog?.showModal) return;
  const list = $("#coop-courses");
  list.replaceChildren(...courses().map((course) => el("label", null, el("input", { type: "checkbox", checked: true, value: course.courseId }), `${course.name || "Untitled course"} \u00b7 ${courseLanes(course).map((l) => H.laneLabel(l)).join(", ")}`)));
  $("#coop-note").textContent = `The file will be called ${H.coopFileName(week())}.`;
  const download = $("#coop-download"), cancel = $("#coop-cancel");
  const done = () => { download.onclick = null; cancel.onclick = null; dialog.close(); };
  download.onclick = () => {
    const ids = $$("input:checked", list).map((box) => box.value);
    if (!ids.length) { $("#coop-note").textContent = "Pick at least one course."; return; }
    const pack = H.coopPack(week(), ids);
    const text = H.serialize(pack, { updatedAt: pack.updatedAt });
    const { errors } = H.validate(JSON.parse(text));
    if (errors.length) { $("#coop-note").textContent = `Something doesn\u2019t fit the file format: ${errors[0].path} ${errors[0].message}.`; return; }
    const blob = new Blob([text], { type: H.MIME });
    const href = URL.createObjectURL(blob);
    const a = el("a", { href, download: H.coopFileName(pack) });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    done();
  };
  cancel.onclick = done;
  dialog.showModal();
}

/** 2.0 #8: one printed page of the week in color lanes; colors, not names; no boxes, dates or tracking. */
function printFridgeSheet() {
  const host = $("#fridge");
  const days = shownDays().filter((d) => isDayOn(d));
  const table = el("table", null,
    el("thead", null, el("tr", null, el("th", null, ""), ...days.map((d) => el("th", null, H.dayName(d))))),
    el("tbody", null, ...lanes().map((lane) => el("tr", null,
      el("th", { style: { "--lane": laneHex(lane) } }, el("span", { class: "cb-print-dot" }), `${H.laneLabel(lane)}${lane.grade == null ? "" : ` \u00b7 ${gradeText(lane.grade)}`}`),
      ...days.map((d) => el("td", null, ...courses().filter((c) => c.laneIds.includes(lane.laneId) && (c.days.includes(d) || (c.scheduleMode === "Loop" && c.days.length === 0)))
        .map((c) => el("div", { class: "cb-print-block", style: { "--lane": laneHex(lane) } }, `${c.name || "Untitled"} \u00b7 ${c.minutes} min`))))))));
  host.replaceChildren(el("h1", null, `Our week ${week().schoolYear?.label ?? ""}`), table,
    el("p", null, "Made with the HomeSchool Scribe Course Builder. The app keeps the records; this is just the week on the fridge."));
  document.body.classList.add("cb-printing");
  const cleanup = () => { document.body.classList.remove("cb-printing"); window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  window.print();
}

/** A share link's starter in the URL fragment opens the builder with that shape (2.0 #9). */
async function openStarterFromHash() {
  const starter = H.starterFromHash(location.hash);
  if (!starter) return false;
  try {
    const opened = await H.fromStarter(starter, { uuid });
    state.week = opened;
    state.names = {};
    state.titlePatterns = {};
    state.ui.reopened = false;
    history.replaceState(null, "", pageBase());
    const note = $("#open-note");
    note.hidden = false; note.dataset.tone = "";
    note.textContent = `Opened a shared week (${H.draftSummary(opened)}). Add your children\u2019s names on the next screen; the lessons are yours to write.`;
    touch();
    go(1);
    return true;
  } catch (error) {
    const note = $("#open-note");
    note.hidden = false; note.dataset.tone = "warn"; note.textContent = error?.message ?? "This link is not a Course Builder starter week.";
    return false;
  }
}

// MARK: - The checks and the download

function renderChecks() {
  const list = $("#checks-list");
  const summary = $("#checks-summary");
  const items = H.readyChecks(week(), { names: state.names, courseDefaults: state.courseDefaults, allow: state.ui.allowedNames, suggestedCredits: state.suggestedCredits });
  const red = items.filter((i) => i.severity === "red").length;
  const nameItems = items.filter((i) => i.code === 8);
  // A typed name in the file blocks the download until it is changed or she says it isn't a name
  // (Quarry's default, BUG-20261006-4; Josh went with it, October 6, 2026).
  const blocking = red;
  const yellow = items.length - red;
  list.replaceChildren();
  if (!courses().length) {
    list.append(el("li", { class: "red" }, el("span", { class: "cb-check-text" }, el("b", null, "This week"), "Add at least one course first."),
      el("button", { type: "button", class: "btn btn-paper small", onclick: () => go(2) }, "Go to the week")));
  } else if (!items.length) {
    list.append(el("li", { class: "ok" }, el("span", { class: "cb-check-text" }, "Nothing to fix. Your week is ready for the app.")));
  }
  for (const item of items) {
    const course = courseById(item.courseId);
    const where = course ? (course.name || "Untitled course") : item.laneId ? laneTitle(laneById(item.laneId)) : "This week";
    if (item.code === 8) {
      // One summary per name, three ways out (Quarry's fix 5; download asks once, Josh, October 6).
      const color = colorWordFor(item.name);
      list.append(el("li", { class: "red" },
        el("span", { class: "cb-check-text" }, el("b", null, item.name), item.message.replace(`${item.name} appears`, " appears")),
        el("div", { class: "cb-check-actions" },
          el("button", { type: "button", class: "btn btn-slate small", onclick: () => offerReplace(item, color) }, `Replace with ${color}`),
          el("button", { type: "button", class: "btn btn-paper small", onclick: () => fix(item) }, "Show me"),
          el("button", { type: "button", class: "btn btn-paper small", onclick: () => { state.ui.allowedNames.push(item.name); renderChecks(); } }, "It isn\u2019t a name"))));
      continue;
    }
    list.append(el("li", { class: item.severity },
      el("span", { class: "cb-check-text" }, el("b", null, where), item.message),
      el("button", { type: "button", class: item.code === 10 ? "btn btn-slate small" : "btn btn-paper small", onclick: () => fix(item) }, item.code === 10 ? "Add lessons" : "Fix")));
  }
  if (state.ui.undoReplace) {
    list.append(el("li", { class: "ok" }, el("span", { class: "cb-check-text" }, `Replaced ${plural(state.ui.undoReplace.count, "place")}.`),
      el("button", { type: "button", class: "btn btn-paper small", onclick: undoReplace }, "Undo")));
  }
  if (!courses().length) summary.textContent = "There are no courses yet. The app needs at least one to add anything.";
  else if (blocking) summary.textContent = `${plural(blocking, "thing")} to fix before the download${yellow ? `, and ${plural(yellow, "note")} that won't stop it` : ""}.`;
  else if (yellow) summary.textContent = `${plural(yellow, "note")} to look at. Nothing stops the download.`;
  else summary.textContent = "Everything checks out.";
  const ready = courses().length > 0 && blocking === 0;
  const button = $("#download");
  button.disabled = !ready;
  // The first thing on the screen (Marlow's idea 1): her plan in one line, and "Ready for the app" only when it is.
  const line = $("#ready-line");
  line.replaceChildren(...[
    ready ? el("span", { class: "cb-ready-tick", "aria-hidden": "true" }, "\u2713") : null,
    el("span", null, `${H.planSummary(week())}${ready ? " Ready for the app." : !courses().length ? " Add a course to go on." : ` ${plural(blocking, "thing")} to fix before the download.`}`),
    yellow ? el("span", { class: "cb-ready-notes" }, ` ${plural(yellow, "note")} to look at.`) : null].filter(Boolean));
  if (!(state.ui.downloaded && !state.ui.changedSinceDownload)) $("#download-name").textContent = `The file will be called ${H.fileName(week())}.`;
  $("#open-in-app").hidden = !state.ui.downloaded;
  orderOpenSteps();
}

/** Phone steps first on a phone (Marlow's idea 2): the group that fits the device leads; nothing is removed. */
function orderOpenSteps() {
  const list = $("#open-in-app .tally");
  if (!list) return;
  const phone = isNarrow() || window.matchMedia("(pointer: coarse)").matches;
  const items = $$("li", list);
  const phoneItem = items.find((li) => li.dataset.step === "phone");
  if (!phoneItem) return;
  if (phone) list.prepend(phoneItem);
  else list.append(phoneItem);
}

function fix(item) {
  if (item.fix === "lessons" && item.courseId) {
    state.ui.selectedCourseId = item.courseId;
    openWorkspace(item.courseId, item.lessonIndex ?? null);
    return;
  }
  if (item.fix === "lessons") { go(2); return; }
  if (item.courseId) state.ui.selectedCourseId = item.courseId;
  if (item.laneId) state.ui.activeLaneIndex = Math.max(0, lanes().findIndex((l) => l.laneId === item.laneId));
  go(2);
  if (item.code === 5 && item.fix === "course") { $("#course-minutes")?.focus(); return; }
  if (item.fix === "course") $("#course-panel input[name=name]")?.focus();
  else $(`.cb-block[data-course="${item.courseId}"] .cb-block-main`)?.focus();
}

/** The lane color word for a typed name ("Blue"), for "Replace with Blue". */
function colorWordFor(name) {
  const laneId = Object.keys(state.names).find((id) => (state.names[id] ?? "").trim().toLowerCase() === String(name).trim().toLowerCase());
  const lane = laneId ? laneById(laneId) : null;
  return lane ? H.laneLabel(lane) : "the color";
}

function offerReplace(item, color) {
  const changes = H.nameReplacements(week(), item.name, color);
  const dialog = $("#replace-dialog");
  if (!dialog?.showModal) return;
  $("#replace-text").textContent = `${plural(changes.length, "place")} will change. The first few:`;
  const preview = $("#replace-preview");
  preview.replaceChildren(...changes.slice(0, 5).map((c) => el("li", null, el("s", null, c.before), " \u2192 ", el("b", null, c.after))));
  const confirm = $("#replace-confirm"), cancel = $("#replace-cancel");
  const done = () => { confirm.onclick = null; cancel.onclick = null; dialog.close(); };
  confirm.onclick = () => {
    done();
    state.ui.undoReplace = { courses: JSON.stringify(week().courses), count: changes.length };
    H.applyNameReplacement(week(), item.name, color);
    touch();
    renderChecks();
  };
  cancel.onclick = done;
  dialog.showModal();
}

function undoReplace() {
  if (!state.ui.undoReplace) return;
  week().courses = JSON.parse(state.ui.undoReplace.courses);
  state.ui.undoReplace = null;
  touch();
  renderChecks();
}

/** One line for the Lessons step and the workspace, so she hears about a name before Ready. */
function nameWarningLine() {
  const found = H.readyChecks(week(), { names: state.names, courseDefaults: state.courseDefaults, allow: state.ui.allowedNames, suggestedCredits: state.suggestedCredits }).filter((i) => i.code === 8);
  if (!found.length) return null;
  const total = found.reduce((n, i) => n + i.count, 0);
  return el("p", { class: "hint cb-warn" }, `A name from this page is in ${plural(total, "place")}. Review your plan will offer to change it to the color; the download waits until it is changed or you say it isn\u2019t a name.`);
}

function download() {
  const items = H.readyChecks(week(), { names: state.names, courseDefaults: state.courseDefaults, allow: state.ui.allowedNames, suggestedCredits: state.suggestedCredits });
  if (!courses().length || items.some((i) => i.severity === "red")) { renderChecks(); return; }
  touch();
  const text = H.serialize(week(), { updatedAt: week().updatedAt });
  const { errors } = H.validate(JSON.parse(text));
  if (errors.length) {
    $("#checks-summary").textContent = `Something in this week doesn't fit the file format: ${errors[0].path} ${errors[0].message}.`;
    return;
  }
  const blob = new Blob([text], { type: H.MIME });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: H.fileName(week()) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  state.ui.downloaded = true;
  state.ui.changedSinceDownload = false;
  $("#open-file-label").textContent = H.fileName(week()).replace(/\.hssweek$/, "");
  $("#download-name").textContent = `Downloaded ${H.fileName(week())}. It\u2019s in your Downloads folder.`;
  $("#open-in-app").hidden = false;
  orderOpenSteps();
  $("#open-in-app").scrollIntoView({ block: "nearest", behavior: "auto" });
}

// MARK: - Sample starters (Marlow's idea, Josh's pick, October 6, 2026): a made-up week to look around with

const STARTERS = [
  { file: "one-child-3rd-grade.hssweek", title: "One child, 3rd grade", text: "Four courses on a Monday-to-Friday week, with lessons already numbered." },
  { file: "two-children.hssweek", title: "Two children, 3rd and 9th grade", text: "Six courses, one taught together, one left for planning as you go." },
];

function openSampleDialog() {
  const dialog = $("#sample-dialog");
  if (!dialog?.showModal) return;
  const list = $("#sample-list");
  list.replaceChildren(...STARTERS.map((starter) => el("button", { type: "button", onclick: () => { dialog.close(); loadSample(starter); } }, el("b", null, starter.title), el("span", null, starter.text))));
  $("#sample-cancel").onclick = () => dialog.close();
  dialog.showModal();
}

/** Loads a bundled week from this page's own folder. A saved draft is never replaced without asking. */
async function loadSample(starter) {
  const note = $("#open-note");
  const say = (text, tone = "") => { note.hidden = false; note.textContent = text; note.dataset.tone = tone; };
  const existing = (week() && courses().length) || Boolean(await readDraft());
  if (existing && !window.confirm("Replace the week in progress with this sample?")) return;
  let text;
  try {
    const response = await fetch(`./starters/${starter.file}`, { cache: "no-store" });
    if (!response.ok) throw new Error("missing");
    text = await response.text();
  } catch { say("That sample couldn\u2019t be loaded. Start my week works without it.", "warn"); return; }
  const result = H.parseFile(text, { settleUnknown: true });
  if (!result.ok) { say(result.errors[0]?.message ?? "That sample isn\u2019t a Course Builder week.", "warn"); return; }
  clearTimeout(saveTimer);
  state.week = result.week;
  state.week.fileId = uuid();
  state.names = {};
  state.titlePatterns = {};
  state.suggestedCredits = {};
  state.ui.reopened = false;
  state.ui.lessonsSkipped = false;
  state.ui.previewSeen = false;
  if (state.ui.draftRev === undefined) state.ui.draftRev = 0;
  state.ui.downloaded = false;
  state.ui.changedSinceDownload = false;
  state.ui.allowedNames = [];
  state.ui.undoReplace = null;
  say(`Opened the sample \u201c${starter.title}\u201d (${H.draftSummary(result.week)}). Change anything, or delete what you don\u2019t need. Your own children\u2019s colors and grades come next.`);
  touch();
  go(1);
}

// MARK: - Boot

async function loadDefaults() {
  try {
    const response = await fetch("./format/course-defaults.json", { cache: "no-store" });
    if (response.ok) state.courseDefaults = await response.json();
  } catch {
    state.courseDefaults = null;
  }
  if (!state.courseDefaults) state.courseDefaults = { grades: {} };
}

function wire() {
  mountMarkTally($("#builder"));
  $("#start-week").addEventListener("click", startWeek);
  $("#add-lane").addEventListener("click", addLane);
  $("#lanes-next").addEventListener("click", lanesNext);
  $("#toggle-weekend").addEventListener("click", toggleWeekend);
  $("#download").addEventListener("click", download);
  $$("[data-go]").forEach((button) => button.addEventListener("click", () => {
    const n = Number(button.dataset.go);
    if (n === 0) { go(0); return; }
    if (!week()) { startWeek(); return; }
    if (n >= 2 && lanes().length === 0) { go(1); return; }
    if (n === 5 && state.ui.screen === 3) { askAboutEmptyCourses(() => go(5)); return; }
    go(n);
  }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.ui.placingCourseId) stopPlacing(); });
  // Nothing is kept between visits (by design: nothing personal leaves or stays in the browser),
  // so a refresh or a closed tab after an hour of planning deserves one warning.
  window.addEventListener("beforeunload", (e) => {
    if (week() && courses().length && state.ui.changedSinceDownload && (state.ui.saveFailed || state.ui.saveStale)) { e.preventDefault(); e.returnValue = ""; }
  });
  $("#clear-draft").addEventListener("click", clearDraftFromButton);
  window.addEventListener("storage", async (e) => { if (e.key !== DRAFT_KEY || state.ui.saveStale) return; const newer = await newerDraftElsewhere(); if (newer) goStale(newer); });
  document.addEventListener("visibilitychange", async () => { if (document.visibilityState !== "visible" || state.ui.saveStale || !week()) return; const newer = await newerDraftElsewhere(); if (newer) goStale(newer); });
  // A share link pasted into an open tab only changes the hash; treat it like opening the link.
  window.addEventListener("hashchange", async () => {
    if (!H.starterFromHash(location.hash)) return;
    if (week() && courses().length && !window.confirm("Open the shared week in place of the week in progress?")) { history.replaceState(null, "", pageBase()); return; }
    await openStarterFromHash();
  });
  $("#share-link").addEventListener("click", showShareLink);
  $("#share-copy").addEventListener("click", copyShareLink);
  $("#coop-pack").addEventListener("click", openCoopDialog);
  $("#fridge-sheet").addEventListener("click", printFridgeSheet);
  $("#start-open").addEventListener("click", () => $("#open-file-input").click());
  $("#start-sample").addEventListener("click", openSampleDialog);
  $("#open-file-input").addEventListener("change", (e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) openFile(file); });
  $("#private-session").addEventListener("change", async (e) => {
    state.ui.privateSession = e.target.checked;
    if (state.ui.privateSession) { clearTimeout(saveTimer); await clearDraft(); $("#clear-draft").hidden = true; setSaveStatus("Private session: nothing is saved on this device."); }
    else { setSaveStatus(""); scheduleSave(); }
  });
  let wasNarrow = isNarrow();
  window.addEventListener("resize", () => { const now = isNarrow(); if (now !== wasNarrow) { wasNarrow = now; if (state.ui.screen === 2) renderWeek(); if (state.ui.screen === 4) renderWorkspace(); if (state.ui.screen === 6) orderOpenSteps(); } });
}

async function boot() {
  wire();
  go(0);
  await loadDefaults();
  const linked = H.starterFromHash(location.hash);
  const draft = linked ? await readDraft() : null;
  if (!(await readDraft())) state.ui.draftRev = 0;
  if (linked && !draft?.week?.format) { await openStarterFromHash(); return; }
  const resumed = await offerRestore();
  if (linked && !resumed) await openStarterFromHash();
}

boot();

// For the test harness only, and only when the page is opened with ?test: read-only access to the
// module and the live state. A parent's page sets no global, so the names object stays private.
if (new URLSearchParams(location.search).has("test")) window.__courseBuilder = { H, state };
