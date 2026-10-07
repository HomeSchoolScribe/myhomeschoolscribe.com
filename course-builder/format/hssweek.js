// hssweek.js
//
// The Course Builder's pure logic: validate, write, parse, pattern fill, checks, preview,
// starter link. The page (../builder.js) and the Node tests (../tests/run.mjs) both import it.
// The spec is grok/hss-staff/COURSE-BUILDER-SPEC.md in the AI Sync repo; the file contract is
// README.md beside this file. Each exported function says which spec section it implements.
//
// No DOM, no network, no globals. Children's names never pass through here: the page keeps them
// in its own object and only hands them to readyChecks, which reads them and writes nothing.

import schema from "./hssweek.schema.json" with { type: "json" };
import { validateSchema, deepEqual } from "./schema-check.js";

// MARK: - Fixed values (spec 5.1, 5.3, 5.4; README "Fixed values")

export const SCHEMA = schema;
export const FORMAT = "homeschoolscribe.week";
export const FORMAT_VERSION = "1.0";
export const TOOL = Object.freeze({ tool: "Course Builder", version: "1.0.0" });
export const MIME = "application/vnd.homeschoolscribe.week+json";
export const FILE_EXTENSION = ".hssweek";

/** sun..sat; the app's weekday number is index + 1 (mon = 2). */
export const DAY_CODES = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The grid's order: Monday first, the weekend at the end. */
const WEEK_ORDER = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const LANE_COLORS = Object.freeze([
  { name: "blue", label: "Blue", hex: "2E6B9E" },
  { name: "green", label: "Green", hex: "3F7A4F" },
  { name: "orange", label: "Orange", hex: "8A5A10" },
  { name: "purple", label: "Purple", hex: "6A3D8F" },
  { name: "red", label: "Red", hex: "B7472A" },
  { name: "teal", label: "Teal", hex: "1E6E63" },
].map(Object.freeze));

const defs = schema.$defs;
export const SUBJECTS = Object.freeze([...defs.subject.enum]);
export const GRADING_MODES = Object.freeze([...defs.gradingMode.enum]);
export const SCHEDULE_MODES = Object.freeze([...defs.scheduleMode.enum]);
export const LEVELS = Object.freeze([...defs.level.enum]);
export const RESOURCE_KINDS = Object.freeze([...defs.resourceKind.enum]);
export const TAGS = Object.freeze([...defs.tag.enum]);
export const CREDITS = Object.freeze([...defs.course.properties.credits.enum]);
export const TARGET_HOURS = Object.freeze([...defs.course.properties.targetHours.enum]);
export const PATTERN_KINDS = Object.freeze(["Quiz", "Test", "Review", "Lab"]);

const CALENDAR = "On the calendar";
const LOOP = "Loop";

export function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** GradeLevel raw values with the short picker label and the app's long label. */
export const GRADES = Object.freeze(
  Array.from({ length: 14 }, (_, i) => {
    const value = i - 1;
    if (value === -1) return Object.freeze({ value, label: "Pre-K", long: "Pre-K" });
    if (value === 0) return Object.freeze({ value, label: "K", long: "Kindergarten" });
    return Object.freeze({ value, label: ordinal(value), long: `${ordinal(value)} grade` });
  }),
);

export const LIMITS = Object.freeze({
  name: 120,
  title: 200,
  details: 4000,
  notes: 4000,
  curriculum: 200,
  resourceTitle: 200,
  minutesMin: 5,
  minutesMax: 240,
  minutesStep: 5,
  lessonsPerCourse: 200,
  lanes: 6,
  fileBytes: 5 * 1024 * 1024,
  starterChars: 2000,
  longDayMinutes: 6 * 60,
  longCourseWeeks: 40,
});

/** The app's own error copy (spec 6.7); each ends with "Nothing was added." */
export const MESSAGES = Object.freeze({
  notAWeek: "This file isn't a Course Builder week, or it didn't finish downloading. Download it again from the Course Builder. Nothing was added.",
  backupFile: "This is a full HomeSchool Scribe backup, not a Course Builder week. To restore a backup, go to Records, then Import a backup. Nothing was added.",
  newerVersion: (major) => `This week was made with a newer Course Builder (format ${major}). Update HomeSchool Scribe from the App Store, then open the file again. Nothing was added.`,
  tooBig: "This file is too big to be a Course Builder week. Nothing was added.",
  starterTooBig: "Too big for a link; download the file instead.",
});

// MARK: - Small helpers

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pad2 = (n) => String(n).padStart(2, "0");
const defaultUUID = () => globalThis.crypto.randomUUID();
const utf8Length = (text) => new TextEncoder().encode(text).length;

/** ISO 8601 with the local offset, the way the file carries createdAt and updatedAt. */
function isoWithOffset(date) {
  if (typeof date === "string") return date;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export const weekdayNumber = (code) => DAY_CODES.indexOf(code) + 1;
export const dayCode = (weekday) => DAY_CODES[weekday - 1];
/** "wed" -> "Wednesday". */
export const dayName = (code) => DAY_NAMES[DAY_CODES.indexOf(code)] ?? code;
/** "wed" -> "Wed". */
export const shortDayName = (code) => SHORT_DAY_NAMES[DAY_CODES.indexOf(code)] ?? code;
/** A lane's color label, "Blue". */
export const laneLabel = (lane) => LANE_COLORS.find((c) => c.name === lane?.color)?.label ?? (lane?.color ? lane.color[0].toUpperCase() + lane.color.slice(1) : "This lane");

const weekOrder = (code) => {
  const index = WEEK_ORDER.indexOf(code);
  return index === -1 ? 99 : index;
};
const sortDays = (codes) => [...codes].sort((a, b) => weekOrder(a) - weekOrder(b));

const isLoop = (course) => course.scheduleMode === LOOP;
const courseDays = (course) => (Array.isArray(course.days) ? course.days : []);
const courseLessons = (course) => (Array.isArray(course.lessons) ? course.lessons : []);
const isIncluded = (lesson) => lesson.include !== false;
const startIndex = (course) => Math.max(1, Number(course.startAtLesson) || 1) - 1;
/** The lessons the app would import: ticked rows from "Start at lesson N" on. */
export const includedLessons = (course) => courseLessons(course).filter(isIncluded).slice(startIndex(course));
const lessonMinutes = (lesson, course) => (lesson.minutes == null ? course.minutes : lesson.minutes);

const dayEntry = (week, code) => (week.week?.days ?? []).find((d) => d.day === code);
const isDayOn = (week, code) => {
  const entry = dayEntry(week, code);
  return Boolean(entry) && entry.on !== false;
};
const shownDays = (week) => (week.week?.days ?? []).map((d) => d.day);
const onDays = (week) => (week.week?.days ?? []).filter((d) => d.on !== false).map((d) => d.day);

/** Whether a course puts a lesson on this day of the grid. */
function landsOn(week, course, code) {
  const days = courseDays(course);
  if (isLoop(course) && days.length === 0) return isDayOn(week, code);
  return days.includes(code);
}

// MARK: - School year and file name (spec 4 screen 1, decision 5, A21)

/** Spec decision 5: July or later = this year to next; January to June = last year to this. */
/** "3 children, 15 courses, 1,944 lessons" for the restore prompt. */
export function draftSummary(week) {
  const kids = (week?.lanes ?? []).length, courseCount = (week?.courses ?? []).length;
  const lessonCount = (week?.courses ?? []).reduce((n, c) => n + courseLessons(c).length, 0);
  return `${plural(kids, "child").replace("childs", "children")}, ${plural(courseCount, "course")}, ${lessonCount.toLocaleString("en-US")} ${lessonCount === 1 ? "lesson" : "lessons"}`;
}

/** Page copy that is pinned by a test because Josh approved the words (October 6, 2026). */
export const COPY = Object.freeze({
  nameHint: "Just for you on this screen. The names you type here are never put in the file.",
  addOnly: "Import adds new courses and lessons. It doesn't update ones already in the app.",
  /** product-facts.md: a subject with no lesson planned shows a line on Today, "What did you do in Math?". */
  todayAsks: (courseName) => `Today will ask \u201cWhat did you do in ${courseName}?\u201d`,
});

/** Review your plan, the first line: "Blue and Green: 2 courses, 36 lessons." (colors, never names; included rows only). */
export function planSummary(week) {
  const colors = (week?.lanes ?? []).map((lane) => laneLabel(lane));
  const who = colors.length <= 1 ? (colors[0] ?? "No one yet") : `${colors.slice(0, -1).join(", ")} and ${colors[colors.length - 1]}`;
  const courseCount = (week?.courses ?? []).length;
  const lessonCount = (week?.courses ?? []).reduce((n, c) => n + includedLessons(c).length, 0);
  return `${who}: ${plural(courseCount, "course")}, ${lessonCount.toLocaleString("en-US")} ${lessonCount === 1 ? "lesson" : "lessons"}.`;
}

/** The lesson table's footer: "No lessons yet.", "36 lessons, all included.", "35 of 36 lessons included." */
export function lessonFooter(course) {
  const rows = courseLessons(course);
  if (rows.length === 0) return "No lessons yet.";
  const included = rows.filter(isIncluded).length;
  if (included === rows.length) return `${plural(rows.length, "lesson")}, all included.`;
  return `${included} of ${rows.length} lessons included.`;
}

/** The moment after a tool adds lessons: "36 lessons added: Lesson 1 to Lesson 36. About 8 teaching weeks at 5 a week." */
export function lessonsAddedLine(rows, { perWeek = 0 } = {}) {
  const n = rows.length;
  if (!n) return "";
  const first = String(rows[0]?.title ?? "").trim() || "Lesson 1";
  const last = String(rows[n - 1]?.title ?? "").trim() || `Lesson ${n}`;
  const span = n === 1 ? `${first}.` : `${first} to ${last}.`;
  const weeks = perWeek > 0 ? Math.ceil(n / perWeek) : 0;
  const pace = weeks ? ` About ${plural(weeks, "teaching week")} at ${perWeek} a week.` : "";
  return `${plural(n, "lesson")} added: ${span}${pace}`;
}

export function schoolYearDefault(date = new Date()) {
  const startYear = date.getMonth() >= 6 ? date.getFullYear() : date.getFullYear() - 1;
  return schoolYear(startYear);
}

/** The screen 1 picker: last, this and next school year around the default. */
export function schoolYearOptions(date = new Date()) {
  const { startYear } = schoolYearDefault(date);
  return [startYear - 1, startYear, startYear + 1].map(schoolYear);
}

function schoolYear(startYear) {
  return { startYear, label: `${startYear}-${pad2((startYear + 1) % 100)}` };
}

/** Spec decision 5: "Our week " + the school-year label + ".hssweek". */
export function fileName(week) {
  const label = week?.schoolYear?.label ?? schoolYearDefault().label;
  return `Our week ${label}${FILE_EXTENSION}`;
}

// MARK: - Building a week in file shape (spec 5.3 to 5.6)

/** A blank week in file shape, Monday to Friday on, no lanes, no courses. */
export function newWeek({ now = new Date(), schoolYear: year, uuid = defaultUUID } = {}) {
  const stamp = isoWithOffset(now);
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    fileId: uuid(),
    createdAt: stamp,
    updatedAt: stamp,
    madeWith: { ...TOOL },
    source: { kind: "blank" },
    schoolYear: year ?? schoolYearDefault(typeof now === "string" ? new Date(now) : now),
    week: { days: ["mon", "tue", "wed", "thu", "fri"].map((day) => ({ day, on: true, label: "" })) },
    lanes: [],
    courses: [],
  };
}

/** Adds a color lane (spec 5.4) and returns it. Up to six lanes; the name stays on the page. */
export function newLane(week, { color = "blue", grade = null, uuid = defaultUUID } = {}) {
  const swatch = LANE_COLORS.find((c) => c.name === color);
  if (!swatch) throw new Error(`Unknown lane color ${color}`);
  if (week.lanes.length >= LIMITS.lanes) throw new Error(`Up to ${LIMITS.lanes} lanes.`);
  const lane = { laneId: uuid(), color: swatch.name, colorHex: swatch.hex, grade };
  week.lanes.push(lane);
  return lane;
}

/**
 * YearStarter.weekdays(perWeek:from:): which of the family's school days a subject lands on.
 * Three a week from Mon to Fri is Mon/Wed/Fri, two is Tue/Thu, one is midweek. Takes and returns
 * weekday numbers (1 to 7).
 */
export function pickWeekdays(perWeek, schoolDays) {
  const days = [...new Set(schoolDays)].sort((a, b) => a - b);
  if (days.length === 0) return [];
  const n = Math.min(Math.max(perWeek, 1), days.length);
  if (n === days.length) return days;
  return Array.from({ length: n }, (_, i) => days[Math.trunc((i + 0.5) * days.length / n)]);
}

/** The grade a block's defaults come from: the highest lane grade (null lanes count as 9th, as YearStarter.start does). */
function gradeForDefaults(week, laneIds) {
  const grades = (laneIds ?? []).map((id) => week.lanes.find((l) => l.laneId === id)?.grade).map((g) => (g == null ? 9 : g));
  return grades.length ? Math.max(...grades) : 9;
}

/** Spec 4 screen 2 "Add a course": a block with the grade band's smart defaults, added to the week. */
export function newCourse(week, { laneIds = [], defaults = {}, uuid = defaultUUID } = {}) {
  const grade = gradeForDefaults(week, laneIds);
  const schoolDays = onDays(week).map(weekdayNumber);
  const days = sortDays(pickWeekdays(defaults.perWeek ?? schoolDays.length, schoolDays).map(dayCode));
  const course = {
    courseId: uuid(),
    laneIds: [...laneIds],
    name: defaults.name ?? "",
    subject: SUBJECTS.includes(defaults.subject) ? defaults.subject : "Other",
    colorHex: "",
    scheduleMode: CALENDAR,
    days,
    minutes: defaults.minutes ?? 30,
    startDate: null,
    startAtLesson: 1,
    spreadOverYear: false,
    gradingMode: grade >= 9 ? "Points" : "Narrative, no grade",
    level: "Regular",
    credits: CREDITS.includes(defaults.credits) ? defaults.credits : 1,
    includeOnTranscript: true,
    targetHours: 0,
    curriculum: "",
    notes: "",
    resources: [],
    categories: [],
    lessons: [],
  };
  week.courses.push(course);
  return course;
}

/** Adds a lesson row (spec 5.6) with every default made explicit and returns it. */
export function newLesson(course, { uuid = defaultUUID, ...fields } = {}) {
  const lesson = {
    lessonId: uuid(),
    title: "",
    details: "",
    minutes: null,
    unit: null,
    tags: [],
    pointsPossible: null,
    categoryId: null,
    include: true,
    ...fields,
  };
  if (!Array.isArray(course.lessons)) course.lessons = [];
  course.lessons.push(lesson);
  return lesson;
}

/** The grade band's list from course-defaults.json (a copy of YearStarter.band) for a grade -1..12. */
export function gradeBandDefaults(courseDefaults, grade) {
  const key = String(grade == null ? 9 : Math.min(12, Math.max(-1, grade)));
  return courseDefaults?.grades?.[key] ?? [];
}

// MARK: - Writing the file (spec 5, README "Canonical form", A2)

const TOP_KEYS = ["format", "formatVersion", "fileId", "createdAt", "updatedAt", "madeWith", "source", "schoolYear", "week", "lanes", "courses"];
const NEVER_WRITTEN = new Set(["names"]);
const COURSE_KEYS = ["courseId", "laneIds", "name", "subject", "colorHex", "scheduleMode", "days", "minutes", "startDate", "startAtLesson", "spreadOverYear", "gradingMode", "level", "credits", "includeOnTranscript", "targetHours", "curriculum", "notes", "resources", "categories", "lessons"];
const COURSE_DEFAULTS = { colorHex: "", days: [], startDate: null, startAtLesson: 1, spreadOverYear: false, level: "Regular", credits: 1, includeOnTranscript: true, targetHours: 0, curriculum: "", notes: "", resources: [], categories: [], lessons: [] };
const LESSON_KEYS = ["lessonId", "title", "details", "minutes", "unit", "tags", "pointsPossible", "categoryId", "include"];
const LESSON_DEFAULTS = { details: "", minutes: null, unit: null, tags: [], pointsPossible: null, categoryId: null, include: true };
const RESOURCE_KEYS = ["resourceId", "title", "author", "isbn", "kind", "url", "notes"];
const RESOURCE_DEFAULTS = { author: "", isbn: "", kind: "Book", url: "", notes: "" };

/** Known keys in order with defaults made explicit, then `extensions`, then unknown keys in read order. */
function canonical(source, known, defaults = {}, skip = new Set()) {
  const out = {};
  for (const key of known) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
    else if (key in defaults) out[key] = structuredClone(defaults[key]);
  }
  if (source.extensions !== undefined) out.extensions = source.extensions;
  for (const key of Object.keys(source)) {
    if (!(key in out) && !known.includes(key) && key !== "extensions" && !skip.has(key)) out[key] = source[key];
  }
  return out;
}

const canonicalLesson = (lesson) => canonical(lesson, LESSON_KEYS, LESSON_DEFAULTS);
const canonicalResource = (resource) => canonical(resource, RESOURCE_KEYS, RESOURCE_DEFAULTS);
const canonicalCategory = (category) => canonical(category, ["categoryId", "name", "weight"]);

function canonicalCourse(course) {
  const out = canonical(course, COURSE_KEYS, COURSE_DEFAULTS);
  out.resources = (out.resources ?? []).map(canonicalResource);
  out.categories = (out.categories ?? []).map(canonicalCategory);
  out.lessons = (out.lessons ?? []).map(canonicalLesson);
  return out;
}

/**
 * Spec 5.1 and A2: the canonical file text, `JSON.stringify(week, null, 2) + "\n"`, every known
 * key present with its default made explicit, keys in the README's order, then `extensions`,
 * then any unknown keys in the order they were read. Pass the file's own `updatedAt` to
 * reproduce it byte for byte; otherwise now is written. Names are never part of a week object,
 * and a top-level `names` key is refused here as a last line of defense.
 */
export function serialize(week, { updatedAt } = {}) {
  const top = canonical({ ...week, format: FORMAT, formatVersion: week.formatVersion ?? FORMAT_VERSION, updatedAt: updatedAt ?? isoWithOffset(new Date()) }, TOP_KEYS, {}, NEVER_WRITTEN);
  top.madeWith = canonical(week.madeWith ?? {}, ["tool", "version"], TOOL);
  top.source = canonical(week.source ?? {}, ["kind", "id", "label", "url"], { kind: "blank" });
  top.schoolYear = canonical(week.schoolYear ?? {}, ["startYear", "label"]);
  const weekPart = week.week ?? {};
  top.week = canonical({ ...weekPart, days: (weekPart.days ?? []).map((d) => canonical(d, ["day", "on", "label"], { label: "" })) }, ["days"]);
  top.lanes = (week.lanes ?? []).map((lane) => canonical(lane, ["laneId", "color", "colorHex", "grade"]));
  top.courses = (week.courses ?? []).map(canonicalCourse);
  return `${JSON.stringify(top, null, 2)}\n`;
}

// MARK: - Reading the file (spec 5.2, 6.7, A1, A6 to A10)

function majorVersion(formatVersion) {
  const match = /^(\d+)\./.exec(String(formatVersion ?? ""));
  return match ? Number(match[1]) : NaN;
}

/**
 * Spec 5.2 and 6.7: JSON first, then `format`, then the major version, then the schema.
 * Returns `{ ok, week, errors: [{ code, path, message }], warnings: [{ code, path, message }] }`.
 * Codes: notAWeek, backupFile, newerVersion, tooBig, schema. An unknown enum value (a subject
 * or tag this version does not list) is a warning, not an error: the app falls back to its
 * default and shows a note (spec 5.2), so the file still opens.
 */
/** What the app does with a value this version does not list (CourseFileImport's decode notes). */
const UNKNOWN_DEFAULTS = Object.freeze({
  subject: { value: "Other", said: "filed under Other" },
  scheduleMode: { value: CALENDAR, said: "put on the calendar" },
  gradingMode: { value: "Points", said: "set to Points" },
  level: { value: "Regular", said: "marked Regular" },
  kind: { value: "Other", said: "filed under Other" },
  color: { value: "blue", said: "shown as Blue" },
});

/** "courses[0].resources[1].kind" → the holder object and the final key (a number for an array slot). */
function holderAtPath(root, path) {
  const parts = String(path).split(".").flatMap((part) => {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) return [part];
    return [m[1], ...Array.from(m[2].matchAll(/\[(\d+)\]/g), (x) => Number(x[1]))];
  });
  let node = root;
  for (const key of parts.slice(0, -1)) { if (node == null || typeof node !== "object") return null; node = node[key]; }
  return node == null || typeof node !== "object" ? null : { holder: node, key: parts[parts.length - 1] };
}

/**
 * An unknown enum value is replaced here the way the app would replace it on import (spec 5.2), so
 * a file from a newer minor version opens, edits and downloads again (Quarry's BUG-20261006-9). A
 * tag or a day code this version does not know is left off. Returns one warning per change.
 */
function settleUnknownValues(data, enumErrors) {
  const warnings = [];
  const dropped = [];
  for (const e of enumErrors) {
    const at = holderAtPath(data, e.path);
    if (!at) continue;
    const { holder, key } = at;
    const was = holder[key];
    if (Array.isArray(holder)) { dropped.push({ holder, key }); warnings.push({ code: "unknownValue", path: e.path, message: `${e.path}: \u201c${was}\u201d isn\u2019t one this version knows, so it was left off, as the app would.` }); continue; }
    const rule = UNKNOWN_DEFAULTS[key];
    if (!rule) continue;
    holder[key] = rule.value;
    warnings.push({ code: "unknownValue", path: e.path, message: `${e.path}: \u201c${was}\u201d isn\u2019t one this version knows, so it was ${rule.said}, as the app would.` });
  }
  // Array slots come out last-first so the earlier indexes stay right.
  for (const { holder, key } of dropped.sort((a, b) => b.key - a.key)) holder.splice(key, 1);
  return warnings;
}

export function parseFile(text, { maxBytes = LIMITS.fileBytes, draft = false, settleUnknown = false } = {}) {
  const refuse = (code, message) => ({ ok: false, week: null, errors: [{ code, path: "", message }], warnings: [] });
  if (typeof text !== "string") return refuse("notAWeek", MESSAGES.notAWeek);
  if (utf8Length(text) > maxBytes) return refuse("tooBig", MESSAGES.tooBig);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return refuse("notAWeek", MESSAGES.notAWeek);
  }
  if (!isObject(data)) return refuse("notAWeek", MESSAGES.notAWeek);
  if (data.format !== FORMAT) {
    if ("version" in data && "students" in data) return refuse("backupFile", MESSAGES.backupFile);
    return refuse("notAWeek", MESSAGES.notAWeek);
  }
  const major = majorVersion(data.formatVersion);
  if (major > 1) return refuse("newerVersion", MESSAGES.newerVersion(major));
  const { errors } = validate(data);
  // `draft` is the page's "Open a file I made": a safety copy downloaded mid-plan may hold a calendar
  // course with no days yet (Quarry's BUG-20261006-8). It opens; the readiness check catches it.
  const soft = (e) => e.keyword === "enum" || (draft && e.keyword === "days");
  const hard = errors.filter((e) => !soft(e)).map((e) => ({ code: "schema", path: e.path, message: `${e.path}: ${e.message}`, keyword: e.keyword }));
  if (hard.length) return { ok: false, week: null, errors: hard, warnings: [] };
  // Without `settleUnknown` an unknown value is kept as written (A2: a file round-trips byte for byte,
  // and the app reads it through its own fallback). The page settles on open so the week can be
  // downloaded again.
  const unknown = errors.filter((e) => e.keyword === "enum");
  const warnings = settleUnknown ? settleUnknownValues(data, unknown)
    : unknown.map((e) => ({ code: "unknownValue", path: e.path, message: `${e.path}: ${e.message}. The app will use its default.` }));
  for (const e of errors.filter((e) => draft && e.keyword === "days")) warnings.push({ code: "noDays", path: e.path, message: `${e.path}: ${e.message}` });
  return { ok: true, week: data, errors: [], warnings };
}

/** The rules the schema cannot say: lanes exist, calendar courses have days, graded rows have points, categories exist. */
function semanticErrors(week, errors) {
  const laneIds = new Set((Array.isArray(week.lanes) ? week.lanes : []).map((l) => l?.laneId));
  (Array.isArray(week.courses) ? week.courses : []).forEach((course, ci) => {
    if (!isObject(course)) return;
    const at = `courses[${ci}]`;
    (Array.isArray(course.laneIds) ? course.laneIds : []).forEach((id, li) => {
      if (!laneIds.has(id)) errors.push({ path: `${at}.laneIds[${li}]`, message: "names a lane that is not in this file", keyword: "laneRef" });
    });
    if (course.scheduleMode === CALENDAR && courseDays(course).length === 0) {
      errors.push({ path: `${at}.days`, message: "a calendar course needs at least one day", keyword: "days" });
    }
    const categoryIds = new Set((Array.isArray(course.categories) ? course.categories : []).map((c) => c?.categoryId));
    courseLessons(course).forEach((lesson, li) => {
      if (!isObject(lesson)) return;
      const tags = Array.isArray(lesson.tags) ? lesson.tags : [];
      if (tags.includes("graded") && !(typeof lesson.pointsPossible === "number" && lesson.pointsPossible > 0)) {
        errors.push({ path: `${at}.lessons[${li}].pointsPossible`, message: "a lesson that counts toward the grade needs points", keyword: "graded" });
      }
      if (lesson.categoryId != null && !categoryIds.has(lesson.categoryId)) {
        errors.push({ path: `${at}.lessons[${li}].categoryId`, message: "names a category that is not on this course", keyword: "categoryRef" });
      }
    });
  });
}

/** Spec 3 and A1: the schema through schema-check.js plus the semantic rules. `{ errors: [{ path, message, keyword }] }`. */
export function validate(week, schemaToUse = schema) {
  const errors = validateSchema(schemaToUse, week);
  if (isObject(week)) semanticErrors(week, errors);
  return { errors };
}

// MARK: - "Ready for the app" checks (spec section 8)

const validMinutes = (m) => Number.isInteger(m) && m >= LIMITS.minutesMin && m <= LIMITS.minutesMax;
const over = (text, limit) => typeof text === "string" && Array.from(text).length > limit;

function hoursAndMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive: "Ann" matches "Ann's book" and "ANN", not "Anna" or "Hannah". */
function nameMatcher(name) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu");
}

/** Every change `applyNameReplacement` would make, for a preview: `[{ courseId, field, lessonIndex?, before, after }]`. */
export function nameReplacements(week, name, replacement) {
  const re = new RegExp(nameMatcher(name).source, "giu");
  const swap = (text) => String(text).replace(re, (m, lead) => `${lead ?? ""}${replacement}`);
  const changes = [];
  for (const course of Array.isArray(week.courses) ? week.courses : []) {
    const consider = (field, text, lessonIndex) => {
      if (typeof text !== "string" || !nameMatcher(name).test(text)) return;
      changes.push({ courseId: course.courseId, field, lessonIndex, before: text, after: swap(text) });
    };
    consider("name", course.name); consider("notes", course.notes); consider("curriculum", course.curriculum);
    (Array.isArray(course.resources) ? course.resources : []).forEach((r, ri) => { consider(`resource.${ri}.title`, r?.title); consider(`resource.${ri}.author`, r?.author); consider(`resource.${ri}.notes`, r?.notes); });
    courseLessons(course).forEach((lesson, li) => { consider("title", lesson?.title, li); consider("details", lesson?.details, li); });
  }
  return changes;
}

/** Applies `nameReplacements` to the week in place; returns how many fields changed. The caller keeps an undo copy. */
export function applyNameReplacement(week, name, replacement) {
  const changes = nameReplacements(week, name, replacement);
  const byCourse = new Map((week.courses ?? []).map((c) => [c.courseId, c]));
  for (const change of changes) {
    const course = byCourse.get(change.courseId);
    if (!course) continue;
    if (change.lessonIndex != null) { course.lessons[change.lessonIndex][change.field] = change.after; continue; }
    if (change.field.startsWith("resource.")) { const [, ri, key] = change.field.split("."); course.resources[Number(ri)][key] = change.after; continue; }
    course[change.field] = change.after;
  }
  return changes.length;
}

/** Spec 8 check 8: every place a typed first name could land in the file, with where to say it was found. */
function textsOfCourse(course, label) {
  const spots = [
    { text: course.name, where: `the name of a course`, fix: "course" },
    { text: course.notes, where: `${label}'s notes`, fix: "course" },
    { text: course.curriculum, where: `${label}'s curriculum line`, fix: "course" },
  ];
  (Array.isArray(course.resources) ? course.resources : []).forEach((resource) => {
    for (const text of [resource?.title, resource?.author, resource?.notes]) spots.push({ text, where: `a resource in ${label}`, fix: "course" });
  });
  courseLessons(course).forEach((lesson, li) => {
    spots.push({ text: lesson?.title, where: `row ${li + 1} in ${label}`, fix: "lessons", lessonIndex: li });
    spots.push({ text: lesson?.details, where: `row ${li + 1} in ${label}`, fix: "lessons", lessonIndex: li });
  });
  return spots.filter((spot) => typeof spot.text === "string" && spot.text.length > 0);
}

/** The credits the grade-band suggestion gave a course of this name, so a suggestion's own 0.5 does not read as "she changed it". */
function suggestedCredits(course, courseLanes, courseDefaults) {
  for (const lane of courseLanes) {
    const match = gradeBandDefaults(courseDefaults, lane.grade).find((item) => item.name === course.name);
    if (match && match.credits != null) return match.credits;
  }
  return 1;
}

function transcriptTouched(course, defaultCredits = 1) {
  return (course.level != null && course.level !== "Regular") ||
    (course.credits != null && course.credits !== defaultCredits) ||
    course.includeOnTranscript === false ||
    (course.targetHours != null && course.targetHours !== 0);
}

/**
 * Spec section 8. Returns `[{ severity: "red" | "yellow", code: 1..15, courseId?, courseName?,
 * laneId?, lessonIndex?, message, fix }]`, red first. `fix` names where the Fix button jumps:
 * "course" (the course panel), "lessons" (the lesson workspace, with lessonIndex), "week" (the
 * grid) or "lane". `names` is the page's own `{ [laneId]: firstName }` object; it is read here
 * and never written anywhere. `courseDefaults` is accepted for symmetry with the page and unused.
 */
export function readyChecks(week, { names = {}, courseDefaults, allow = [], suggestedCredits: suggested = {} } = {}) {
  void courseDefaults;
  const items = [];
  const lanes = Array.isArray(week.lanes) ? week.lanes : [];
  const laneById = new Map(lanes.map((lane) => [lane.laneId, lane]));
  const allowed = new Set((Array.isArray(allow) ? allow : []).map((n) => String(n).trim().toLowerCase()));
  const typedNames = Object.values(names ?? {}).map((n) => (typeof n === "string" ? n.trim() : "")).filter((n) => n.length >= 2 && !allowed.has(n.toLowerCase()));
  const matchers = typedNames.map((n) => ({ name: n, re: nameMatcher(n) }));
  // Check 8 is gathered here across every course and pushed once per name at the end.
  const nameHits = new Map();
  const offDays = (week.week?.days ?? []).filter((d) => d.on === false);

  (Array.isArray(week.courses) ? week.courses : []).forEach((course) => {
    const name = typeof course.name === "string" ? course.name.trim() : "";
    const label = name || "this block";
    const base = { courseId: course.courseId, courseName: name };
    const add = (severity, code, message, extra = {}) => items.push({ severity, code, ...base, message, fix: "course", ...extra });
    const courseLanes = (Array.isArray(course.laneIds) ? course.laneIds : []).map((id) => laneById.get(id)).filter(Boolean);
    const lessons = courseLessons(course);
    const included = includedLessons(course);
    const days = courseDays(course);

    if (!name) add("red", 1, "Give this block a name.");
    if (courseLanes.length === 0) add("red", 2, "Put this course on a child's color.", { fix: "week" });
    if (!isLoop(course) && days.length === 0) add("red", 3, `Drag ${label} onto a day, or tap Every day.`, { fix: "week" });
    lessons.forEach((lesson, li) => {
      if (isIncluded(lesson) && !(typeof lesson.title === "string" && lesson.title.trim())) {
        add("red", 4, `Row ${li + 1} in ${label} has no title. Add one or delete the row.`, { fix: "lessons", lessonIndex: li });
      }
    });
    if (!validMinutes(course.minutes) || course.minutes % LIMITS.minutesStep !== 0) {
      const m = Number(course.minutes);
      const offStep = validMinutes(course.minutes) && m % LIMITS.minutesStep !== 0;
      add("red", 5, offStep ? `Minutes go from 5 to 240, in steps of 5 (${m} isn't one). Try ${m - (m % 5)} or ${m - (m % 5) + 5}.` : "Minutes go from 5 to 240, in steps of 5.");
    }
    lessons.forEach((lesson, li) => {
      if (lesson.minutes != null && !validMinutes(lesson.minutes)) add("red", 5, "Minutes go from 5 to 240.", { fix: "lessons", lessonIndex: li });
    });
    lessons.forEach((lesson, li) => {
      const tags = Array.isArray(lesson.tags) ? lesson.tags : [];
      if (isIncluded(lesson) && tags.includes("graded") && !(typeof lesson.pointsPossible === "number" && lesson.pointsPossible > 0)) {
        add("red", 6, `${lesson.title?.trim() || `Row ${li + 1}`} counts toward the grade. How many points is it out of?`, { fix: "lessons", lessonIndex: li });
      }
    });
    if (lessons.length > LIMITS.lessonsPerCourse) add("red", 7, "Split this into two courses or remove some rows.", { fix: "lessons" });
    if (matchers.length) {
      // One summary per typed name for the whole week ("Ivy appears 150 times: 150 lesson rows in
      // Math, 1 note in Art"), not one item per row: a name copied into hundreds of generated
      // titles is one problem with one fix. Rows count once even when both cells carry the name.
      for (const spot of textsOfCourse(course, label)) {
        const hit = matchers.find((m) => m.re.test(spot.text));
        if (!hit) continue;
        const entry = nameHits.get(hit.name) ?? { name: hit.name, total: 0, places: [] };
        const kind = spot.fix === "lessons" ? "lesson rows" : spot.where.startsWith("the name") ? "the name" : spot.where.includes("notes") ? "notes" : spot.where.includes("curriculum") ? "the curriculum line" : "resources";
        let place = entry.places.find((p) => p.courseId === course.courseId && p.kind === kind);
        if (!place) { place = { courseId: course.courseId, courseName: label, kind, count: 0, rows: new Set(), firstLessonIndex: spot.lessonIndex ?? null, fix: spot.fix }; entry.places.push(place); }
        if (spot.fix === "lessons") { if (place.rows.has(spot.lessonIndex)) continue; place.rows.add(spot.lessonIndex); }
        place.count += 1;
        entry.total += 1;
        nameHits.set(hit.name, entry);
      }
    }
    if (over(course.name, LIMITS.name)) add("red", 9, `${label}'s name is over ${LIMITS.name} characters.`);
    if (over(course.notes, LIMITS.notes)) add("red", 9, `${label}'s notes are over ${LIMITS.notes.toLocaleString("en-US")} characters.`);
    if (over(course.curriculum, LIMITS.curriculum)) add("red", 9, `${label}'s curriculum line is over ${LIMITS.curriculum} characters.`);
    lessons.forEach((lesson, li) => {
      if (over(lesson.title, LIMITS.title)) add("red", 9, `Row ${li + 1} in ${label} has a title over ${LIMITS.title} characters.`, { fix: "lessons", lessonIndex: li });
      if (over(lesson.details, LIMITS.details)) add("red", 9, `Row ${li + 1} in ${label} has a What to do box over ${LIMITS.details.toLocaleString("en-US")} characters.`, { fix: "lessons", lessonIndex: li });
    });

    if (included.length === 0) add("yellow", 10, `${label} has no lessons. That's fine for planning as you go: ${COPY.todayAsks(label)}`, { fix: "lessons" });
    for (const off of offDays) {
      if (days.includes(off.day)) {
        const tag = off.label ? ` (${off.label})` : "";
        add("yellow", 11, `${dayName(off.day)} is grayed out${tag} but ${label} is on it.`, { fix: "week" });
      }
    }
    if (!isLoop(course) && days.length > 0 && included.length > 0) {
      const weeks = Math.ceil(included.length / days.length);
      if (weeks > LIMITS.longCourseWeeks) add("yellow", 14, `${included.length} lessons at ${days.length} a week is about ${weeks} weeks.`);
    }
    // Fix 11 (Reed, Oct 6): the credits a suggestion came with are remembered by courseId on the page
    // (`suggestedCredits` option), so renaming the course never turns its own 0.5 into "she changed it".
    if (courseLanes.some((lane) => lane.grade != null && lane.grade < 9) && transcriptTouched(course, suggested[course.courseId] ?? suggestedCredits(course, courseLanes, courseDefaults))) {
      add("yellow", 15, "Saved, but the app only shows transcript fields from 9th grade.");
    }
  });
  for (const entry of nameHits.values()) {
    const where = entry.places.map((p) => p.kind === "lesson rows" ? `${p.count} ${p.count === 1 ? "lesson row" : "lesson rows"} in ${p.courseName}`
      : p.kind === "resources" ? `a resource in ${p.courseName}` : `${p.kind} of ${p.courseName}`).join(", ");
    const first = entry.places[0];
    items.push({ severity: "red", code: 8, courseId: first.courseId, courseName: first.courseName, name: entry.name, count: entry.total,
      places: entry.places.map((p) => ({ courseId: p.courseId, courseName: p.courseName, kind: p.kind, count: p.count, firstLessonIndex: p.firstLessonIndex })),
      message: `${entry.name} appears ${entry.total === 1 ? "once" : `${entry.total} times`}: ${where}. Change it to the color, or say it isn't a name.`,
      fix: first.fix, lessonIndex: first.firstLessonIndex ?? undefined });
  }

  for (const lane of lanes) {
    const label = laneLabel(lane);
    for (const code of onDays(week)) {
      const total = dayMinutes(week, lane.laneId, code);
      if (total > LIMITS.longDayMinutes) {
        items.push({ severity: "yellow", code: 12, laneId: lane.laneId, message: `${label}'s ${dayName(code)} adds up to ${hoursAndMinutes(total)}.`, fix: "week" });
      }
    }
    const byName = new Map();
    for (const course of week.courses ?? []) {
      if (!(course.laneIds ?? []).includes(lane.laneId)) continue;
      const key = (course.name ?? "").trim().toLowerCase();
      if (!key) continue;
      byName.set(key, [...(byName.get(key) ?? []), course]);
    }
    for (const same of byName.values()) {
      if (same.length < 2) continue;
      const count = same.length === 2 ? "two" : String(same.length);
      items.push({ severity: "yellow", code: 13, laneId: lane.laneId, courseId: same[0].courseId, courseName: same[0].name, message: `${label} has ${count} courses called ${same[0].name.trim()}.`, fix: "course" });
    }
  }

  if (utf8Length(serialize(week, { updatedAt: week.updatedAt })) > LIMITS.fileBytes) {
    items.push({ severity: "red", code: 9, message: "This week would be over 5 MB. Shorten some notes or What to do boxes, or split it into two files.", fix: "lessons" });
  }

  return items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
}

// MARK: - Pattern fill (spec 4 screen 4, "the book does the math")

const MAX_PATTERN_ROWS = 1000;
const positiveInt = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 1 ? Math.floor(Number(value)) : fallback);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function fillTokens(pattern, tokens) {
  return String(pattern ?? "").replace(/\{(n|q|from|to|unit)\}/g, (_, key) => (tokens[key] == null ? "" : String(tokens[key])));
}

/**
 * Spec 4 screen 4, pattern fill. `opts`: `{ titlePattern, count?, pages?, pagesPerLesson?,
 * startPage?, every?, everyKind?, unit?, startNumber?, detailsPattern? }`; tokens `{n}` lesson
 * number, `{q}` quiz number, `{from}`-`{to}` pages, `{unit}`.
 *
 * Count mode makes exactly `count` rows; with `every` = k, every k-th row is a "<Kind> {q}" row
 * carrying the matching tag, so 20 rows with every 5th a quiz is 16 reading lessons and 4 quizzes.
 * Pages mode makes ceil(pages / pagesPerLesson) reading lessons that together cover every page
 * from `startPage`, and inserts a quiz row after every k-th reading lesson as an extra row; the
 * page count continues on the next reading lesson. Reading details default to
 * "Read pages {from}-{to}.", quiz details to "<Kind> on pages {from}-{to}." over the pages since
 * the last quiz. `graded` (with `points`, default 100) makes Quiz and Test rows count toward the grade.
 * Returns `{ lessons: [{ title, details, unit, tags, pointsPossible }], sentence, count }`.
 */
export function patternFill(opts = {}) {
  const titlePattern = typeof opts.titlePattern === "string" && opts.titlePattern.trim() ? opts.titlePattern : "Lesson {n}";
  const unit = typeof opts.unit === "string" && opts.unit.trim() ? opts.unit.trim() : null;
  const every = positiveInt(opts.every, 0);
  const kind = PATTERN_KINDS.includes(opts.everyKind) ? opts.everyKind : "Quiz";
  const tag = kind.toLowerCase();
  const kindWord = kind.toLowerCase();
  const gradedNote = () => (kind === "Quiz" || kind === "Test") ? (graded ? `, each out of ${points} points` : ", not graded") : "";
  const countKind = (n) => `${n} ${n === 1 ? kindWord : kind === "Quiz" ? "quizzes" : `${kindWord}s`}${n ? gradedNote() : ""}`;
  const customDetails = typeof opts.detailsPattern === "string" && opts.detailsPattern.trim() ? opts.detailsPattern : null;
  let n = positiveInt(opts.startNumber, 1);
  let q = 1;
  const lessons = [];
  const reading = (tokens, defaultDetails) => lessons.push({ title: fillTokens(titlePattern, tokens), details: fillTokens(customDetails ?? defaultDetails, tokens), unit, tags: [], pointsPossible: null });
  // `graded` (the page's "These count toward the grade" box, ticked for Points courses) makes a
  // generated Quiz or Test count toward the grade out of `points` (100 unless she changes it,
  // spec 5.6). A Review or Lab is only ever tagged.
  const graded = Boolean(opts.graded) && (kind === "Quiz" || kind === "Test");
  const points = positiveInt(opts.points, 100);
  const quiz = (tokens, defaultDetails) => lessons.push({ title: `${kind} ${tokens.q}`, details: fillTokens(customDetails ?? defaultDetails, tokens), unit, tags: graded ? [tag, "graded"] : [tag], pointsPossible: graded ? points : null });

  const pages = positiveInt(opts.pages, 0);
  if (pages > 0) {
    const per = positiveInt(opts.pagesPerLesson, 0);
    if (per === 0) return { lessons: [], sentence: "How many pages make one lesson?", count: 0 };
    const startPage = positiveInt(opts.startPage, 1);
    const lastPage = startPage + pages - 1;
    const readingCount = Math.ceil(pages / per);
    const made = Math.min(readingCount, MAX_PATTERN_ROWS);
    let cursor = startPage;
    let sinceQuiz = startPage;
    for (let r = 1; r <= made; r += 1) {
      const from = cursor;
      const to = Math.min(cursor + per - 1, lastPage);
      reading({ n, q: q - 1, from, to, unit: unit ?? "" }, "Read pages {from}-{to}.");
      n += 1;
      cursor = to + 1;
      if (every && r % every === 0) {
        quiz({ n: n - 1, q, from: sinceQuiz, to, unit: unit ?? "" }, `${kind} on pages {from}-{to}.`);
        q += 1;
        sinceQuiz = to + 1;
      }
    }
    const quizzes = q - 1;
    const firstReading = lessons.find((l) => l.tags.length === 0);
    const secondReading = lessons.filter((l) => l.tags.length === 0)[1];
    let sentence = `${plural(pages, "page")} at ${per} a lesson = ${plural(readingCount, every ? "reading lesson" : "lesson")}.`;
    if (every) sentence += ` Every ${ordinal(every)} lesson is a ${kindWord}: ${countKind(quizzes)}, ${lessons.length} rows in all.`;
    if (firstReading) {
      const lead = every ? "Reading lessons say" : readingCount === 1 ? "It says" : "They say";
      const quote = (details) => (customDetails ? details : details.replace(/\.$/, ""));
      if (!secondReading) sentence += ` ${lead} '${quote(firstReading.details)}'.`;
      else if (customDetails) sentence += ` ${lead} '${firstReading.details}', then '${secondReading.details}', ...`;
      else sentence += ` ${lead} '${quote(firstReading.details)}', then ${startPage + per}-${Math.min(startPage + 2 * per - 1, lastPage)}, ...`;
    }
    if (readingCount > made) sentence += ` Only the first ${made.toLocaleString("en-US")} were made.`;
    return { lessons, sentence, count: lessons.length };
  }

  const count = positiveInt(opts.count, 0);
  if (count === 0) return { lessons: [], sentence: "How many lessons?", count: 0 };
  const made = Math.min(count, MAX_PATTERN_ROWS);
  for (let row = 1; row <= made; row += 1) {
    if (every && row % every === 0) {
      quiz({ n: n - 1, q, from: "", to: "", unit: unit ?? "" }, "");
      q += 1;
    } else {
      reading({ n, q: q - 1, from: "", to: "", unit: unit ?? "" }, "");
      n += 1;
    }
  }
  const quizzes = q - 1;
  const readingRows = lessons.length - quizzes;
  let sentence;
  if (every) {
    sentence = `${plural(lessons.length, "row")}. Every ${ordinal(every)} is a ${kindWord}, so ${plural(readingRows, "reading lesson")} and ${countKind(quizzes)}.`;
  } else {
    sentence = `${plural(lessons.length, "lesson")}, "${lessons[0].title}" to "${lessons[lessons.length - 1].title}".`;
  }
  if (count > made) sentence += ` Only the first ${made.toLocaleString("en-US")} were made.`;
  return { lessons, sentence, count: lessons.length };
}

// MARK: - Table of contents (spec 4 screen 4, A16): a port of CurriculumImport, regex by regex

// Foundation's .whitespaces: Unicode space separators and tab.
const WS = "[\\t\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]";
const WS_NL = "[\\t\\n\\v\\f\\r\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]";
const trimWhitespace = (text) => text.replace(new RegExp(`^${WS}+|${WS}+$`, "g"), "");
const trimWhitespaceAndNewlines = (text) => text.replace(new RegExp(`^${WS_NL}+|${WS_NL}+$`, "g"), "");
/** Swift trimmingCharacters(in: CharacterSet(charactersIn:)): strip those characters from both ends. */
function trimChars(text, chars) {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}
const splitLines = (text) => String(text ?? "").split(/\r\n|[\n\r\u0085\u2028\u2029]/);
const nonEmptyLines = (text) => splitLines(text).map(trimWhitespace).filter((line) => line.length > 0);

const CONTENTS_HEADING = /^(table of )?contents(?:\s*\((?:continued|cont\.?)\)|\s+continued)?$/i;
const isContentsHeading = (line) => CONTENTS_HEADING.test(line);

const PAGE_COLUMN = /[\s.…–—·_-]{2,}(?:\d{1,4}|[ivx]{1,6})\s*$|\t(?:\d{1,4}|[ivx]{1,6})\s*$/i;
const TITLE_ENDS_IN_NUMBER = /(?:^|\s)(?:year|part|war|volume|book|level|grade|lesson|chapter|unit|module|week|day|section)\s+\d{1,4}$/i;
const TRAILING_NUMBER = /\s\d{1,4}$/;

function strippingPageNumber(raw) {
  let line = trimWhitespace(raw);
  if (PAGE_COLUMN.test(line)) {
    line = line.replace(PAGE_COLUMN, "");
  } else if (!TITLE_ENDS_IN_NUMBER.test(line) && TRAILING_NUMBER.test(line)) {
    line = line.replace(TRAILING_NUMBER, "");
  }
  return trimWhitespace(line);
}

const SKIP_LINES = ["index", "glossary", "lessons", "chapters", "something to do", "science concepts", "special features", "chapter checkup"];
const ROMAN_PAGE = /^(?:x{0,2})(?:ix|iv|v?i{0,3})$/i;
const LEADING = [
  /^[•\-*–—]\s*/i,
  /^\d{1,3}(?:\.\d{1,3})+[.):]?\s+/i,
  /^\(?\d{1,3}[.):]\s*/i,
  /^\d{1,3}\s+[\-–—:]\s*/i,
  /^(lesson|chapter|unit|module|week|day|section|part)\s+\d{1,3}[.):\-–—]?\s*/i,
];
const HAS_LETTER = /\p{L}/u;

/**
 * CurriculumImport.cleanLine: one pasted line to a title, or null when nothing is left. Strips
 * page numbers, bullets, numbering and "Lesson 3:" labels; drops contents headings, "Index",
 * "Glossary" and front-matter roman numerals.
 */
export function cleanLine(raw) {
  let line = strippingPageNumber(String(raw ?? ""));
  if (line.length === 0) return null;
  const lowered = line.toLowerCase();
  if (isContentsHeading(line) || SKIP_LINES.includes(lowered)) return null;
  if (ROMAN_PAGE.test(line)) return null;
  for (const pattern of LEADING) line = line.replace(pattern, "");
  line = trimChars(trimWhitespaceAndNewlines(line), ".:-–—");
  line = trimWhitespace(line);
  if (line.length === 0 || !HAS_LETTER.test(line)) return null;
  return line;
}

const RUNNING_HEADER_EXEMPT = /^([0-9]|lesson\s|chapter\s|unit\s|[•*-])/i;

/** CurriculumImport.titles(from:): one title per line, running headers above a Contents heading dropped. */
function contentsTitles(text) {
  const lines = nonEmptyLines(text);
  const headers = new Set();
  lines.forEach((line, index) => {
    if (index === 0 || !isContentsHeading(strippingPageNumber(line))) return;
    const previous = strippingPageNumber(lines[index - 1]);
    if (!RUNNING_HEADER_EXEMPT.test(previous)) headers.add(previous.toLowerCase());
  });
  return lines.filter((line) => !headers.has(strippingPageNumber(line).toLowerCase())).map(cleanLine).filter((title) => title !== null);
}

const NUMBERED_LESSON = /^(?:(?:lesson|chapter|section|module|week|day)\s+\d{1,3}(?:[.):\-–—])?\s+|\d{1,3}(?:\.\d{1,3})+[.):]?\s+|\(?\d{1,3}[.):]\s+|\d{1,3}\s+[\-–—:]\s+)/i;
const isNumberedLesson = (line) => NUMBERED_LESSON.test(line);

/** A short line with no bullet and Title Case is a heading; a topic reads like a phrase. */
function looksLikeHeading(line) {
  const words = line.split(" ").filter((w) => w.length > 0);
  if (words.length > 4 || line.startsWith("•") || line.startsWith("-")) return false;
  return words.every((word) => {
    const first = word[0];
    return first !== undefined && first !== first.toLowerCase() && first === first.toUpperCase();
  });
}

const LESSON_RANGE = /lessons?\s+(\d{1,3})\s*[\-–—]\s*(\d{1,3})/i;
const LESSON_RANGE_ALL = new RegExp(LESSON_RANGE.source, "gi");
const PAGE_RANGE_ALL = /\(?pages?\s+\d{1,4}\s*[\-–—]\s*\d{1,4}\)?/gi;
const UNIT_TRIM = ".:-–—,|";

function lessonRange(line) {
  const match = LESSON_RANGE.exec(line);
  if (!match) return null;
  const lo = Number(match[1]);
  const hi = Number(match[2]);
  if (!(lo <= hi && hi - lo < 400)) return null;
  return [lo, hi];
}

/**
 * CurriculumImport.parse: a pasted table of contents to lesson rows `[{ title, unit, details }]`.
 * When any line carries a lesson range ("Lessons 27-69"), every unit expands into numbered
 * lessons titled "Lesson 31 · Fractions" with the unit's topics on its first lesson. Otherwise
 * numbered chapters and sections are the lessons, and a plain list stays one title per line.
 * Passes every file in toc-fixtures (A16).
 */
/** Every non-blank line as written, page numbers off the end, nothing else dropped or reworded. */
export function literalLines(text) {
  return nonEmptyLines(text).map((line) => trimChars(trimWhitespaceAndNewlines(strippingPageNumber(line)), ".:-\u2013\u2014 ")).filter((line) => line.length > 0)
    .map((title) => ({ title, unit: null, details: "" }));
}

/**
 * Every non-blank source line of a pasted contents page, in order, with what the tidy reading
 * (`parseContents`) did to it: `{ line, literal, status: "added" | "changed" | "left out", title?, reason? }`.
 * "changed" means the row was added with different wording (a leading "Lesson 3:" or "Week 1:" came off);
 * `literal` is the line as written with only the page number off the end, for "keep my wording".
 * Contents pages laid out as units with lesson ranges are not explained line by line (they map to units).
 */
export function explainContents(text) {
  const rawLines = nonEmptyLines(text);
  if (rawLines.some((line) => lessonRange(line) !== null)) return null;
  const rows = parseContents(text);
  const numberedMode = rawLines.some(isNumberedLesson);
  let k = 0;
  return rawLines.map((line) => {
    const literal = trimChars(trimWhitespaceAndNewlines(strippingPageNumber(line)), ".:-\u2013\u2014 ");
    const cleaned = cleanLine(line);
    if (cleaned !== null && rows[k] && rows[k].title === cleaned) {
      k += 1;
      return { line, literal, status: literal === cleaned ? "added" : "changed", title: cleaned };
    }
    let reason = "not a lesson line";
    const stripped = strippingPageNumber(line);
    if (isContentsHeading(stripped)) reason = "contents heading";
    else if (ROMAN_PAGE.test(stripped) || !HAS_LETTER.test(stripped)) reason = "page number";
    else if (numberedMode && !isNumberedLesson(line)) reason = "not numbered";
    else if (cleaned === null) reason = "heading or sidebar";
    return { line, literal, status: "left out", reason };
  });
}

export function parseContents(text) {
  const rawLines = nonEmptyLines(text);
  if (!rawLines.some((line) => lessonRange(line) !== null)) {
    const numbered = rawLines.filter(isNumberedLesson);
    const names = numbered.length === 0 ? contentsTitles(text) : numbered.map(cleanLine).filter((t) => t !== null);
    return names.map((title) => ({ title, unit: null, details: "" }));
  }

  const units = [];
  let pendingName = null;
  const skip = ["contents", "additional skills", "table of contents"];
  for (const line of rawLines) {
    const stripped = line.replace(PAGE_RANGE_ALL, "");
    const range = lessonRange(stripped);
    if (range) {
      let name = trimChars(trimWhitespaceAndNewlines(stripped.replace(LESSON_RANGE_ALL, "")), UNIT_TRIM);
      if (name.length === 0) name = pendingName ?? `Unit ${units.length + 1}`;
      name = cleanLine(name) ?? name;
      units.push({ name, lessons: range, topics: [] });
      pendingName = null;
      continue;
    }
    const cleaned = trimChars(trimWhitespaceAndNewlines(stripped), UNIT_TRIM);
    if (cleaned.length === 0 || skip.includes(cleaned.toLowerCase())) continue;
    const topic = cleanLine(cleaned);
    if (topic !== null && units.length > 0 && !looksLikeHeading(cleaned)) {
      units[units.length - 1].topics.push(topic);
    } else {
      pendingName = cleanLine(cleaned) ?? cleaned;
    }
  }

  const items = [];
  for (const unit of units) {
    for (let n = unit.lessons[0], offset = 0; n <= unit.lessons[1]; n += 1, offset += 1) {
      const details = offset === 0 && unit.topics.length > 0 ? `${unit.name}: ${unit.topics.join("; ")}` : "";
      items.push({ title: `Lesson ${n} · ${unit.name}`, unit: unit.name, details });
    }
  }
  return items;
}

// MARK: - Copy down (spec 4 screen 4)

const PAGE_RANGE = /(\d+)(\s*[-–—]\s*)(\d+)/g;
/** "page 16" or "pp. 4", but not the first number of a range, which PAGE_RANGE already moved. */
const PAGE_REF = /(pages?|pp?\.)(\s+)(\d+)(?!\d|\s*[-\u2013\u2014]\s*\d)/gi;

/** Advance the numbers in a copied cell by `step` rows: ranges by their span, "page N" by the span, a bare first number by one. */
function advanceText(text, step, rowNumber, useRowNumber) {
  if (typeof text !== "string") return text;
  if (/\{n\}/.test(text)) return text.replace(/\{n\}/g, String(rowNumber));
  let span = null;
  let out = text.replace(PAGE_RANGE, (_, a, dash, b) => {
    const from = Number(a);
    const to = Number(b);
    if (to < from) return `${a}${dash}${b}`;
    const width = to - from + 1;
    span = span ?? width;
    return `${from + width * step}${dash}${to + width * step}`;
  });
  const shift = (span ?? 1) * step;
  let shifted = span !== null;
  out = out.replace(PAGE_REF, (_, word, space, n) => {
    shifted = true;
    return `${word}${space}${Number(n) + shift}`;
  });
  if (!shifted && useRowNumber) out = out.replace(/\d+/, (n) => String(Number(n) + step));
  return out;
}

/**
 * Spec 4 screen 4, "Copy down to the end" or "to row N": copies the source row's text cells
 * down the rows after it, with `{n}` and page numbers counting on ("Lesson 5" then "Lesson 6";
 * "Read pages 1-16. Do page 16." then "Read pages 17-32. Do page 32."). `field` limits the copy
 * to one cell ("title", "details", "unit", "minutes", "tags"); without it the title and What to
 * do cells are copied. Returns a new array; the rows passed in are not changed.
 */
/**
 * 2.0 #3: a separate copy of a course for other children: fresh ids for the course, every lesson,
 * resource and category (lesson categoryIds remapped), so editing one never changes the other.
 * Returns the copy (already added to the week). `laneIds` default to the original's.
 */
export function duplicateCourse(week, courseId, { laneIds, uuid = defaultUUID } = {}) {
  const source = (week.courses ?? []).find((c) => c.courseId === courseId);
  if (!source) throw new Error("No such course.");
  const copy = JSON.parse(JSON.stringify(source));
  copy.courseId = uuid();
  copy.laneIds = Array.isArray(laneIds) && laneIds.length ? [...laneIds] : [...source.laneIds];
  const categoryMap = new Map();
  for (const category of Array.isArray(copy.categories) ? copy.categories : []) { const id = uuid(); categoryMap.set(category.categoryId, id); category.categoryId = id; }
  for (const resource of Array.isArray(copy.resources) ? copy.resources : []) resource.resourceId = uuid();
  for (const lesson of Array.isArray(copy.lessons) ? copy.lessons : []) {
    lesson.lessonId = uuid();
    if (lesson.categoryId != null) lesson.categoryId = categoryMap.get(lesson.categoryId) ?? null;
  }
  week.courses.push(copy);
  return copy;
}

const BULK_FIELDS = ["title", "details", "minutes", "unit"];

/**
 * 2.0 #6: what a bulk edit would do before it does it. `opts`: `{ field, from, to, value }` with
 * 1-based inclusive rows; `value` for title and details may use `{n}` (the row number) and `{title}`
 * (the row's current title); minutes must be 5 to 240 or blank (null); unit may be blank (null).
 * Returns `{ field, from, to, changes: [{ index, before, after }] }`; rows already equal are left out.
 */
export function bulkEditPreview(course, { field, from, to, value } = {}) {
  if (!BULK_FIELDS.includes(field)) throw new Error("Pick a field.");
  const rows = courseLessons(course);
  const first = Math.max(1, Math.floor(Number(from) || 1));
  const last = Math.min(rows.length, Math.floor(Number(to) || rows.length));
  const changes = [];
  for (let i = first - 1; i < last; i += 1) {
    const row = rows[i];
    let after;
    if (field === "minutes") after = value === "" || value == null ? null : Number(value);
    else if (field === "unit") after = typeof value === "string" && value.trim() ? value.trim() : null;
    else after = String(value ?? "").replace(/\{n\}/g, String(i + 1)).replace(/\{title\}/g, row.title ?? "");
    const before = row[field] ?? null;
    if ((before ?? null) === (after ?? null)) continue;
    const change = { index: i, before, after };
    // A unit lives in the title too ("Lesson 41 · Decimals"), so changing it moves the title along,
    // the way "Start a unit here" does (Quarry's BUG-20261006-14).
    if (field === "unit") {
      const title = retitleForUnit(row.title, before, after);
      if (title !== (row.title ?? "")) { change.titleBefore = row.title ?? ""; change.titleAfter = title; }
    }
    changes.push(change);
  }
  return { field, from: first, to: last, changes };
}

/** Applies a `bulkEditPreview` result to the course in place; returns an undo record for `undoBulkEdit`. */
export function applyBulkEdit(course, preview) {
  const rows = courseLessons(course);
  const undo = { field: preview.field, values: preview.changes.map((c) => ({ index: c.index, before: c.before, titleBefore: c.titleBefore })) };
  for (const change of preview.changes) {
    const row = rows[change.index];
    if (!row) continue;
    row[preview.field] = change.after;
    if (change.titleAfter != null) row.title = change.titleAfter;
  }
  return undo;
}

export function undoBulkEdit(course, undo) {
  const rows = courseLessons(course);
  for (const { index, before, titleBefore } of undo.values) {
    if (!rows[index]) continue;
    rows[index][undo.field] = before;
    if (titleBefore != null) rows[index].title = titleBefore;
  }
  return undo.values.length;
}

/** Spec 4 screen 4: the unit goes on the title the way the app's import writes it, once; applying it again never doubles it. */
export function retitleForUnit(title, oldUnit, newUnit) {
  let base = String(title ?? "");
  if (oldUnit && base.endsWith(` \u00b7 ${oldUnit}`)) base = base.slice(0, -(` \u00b7 ${oldUnit}`.length));
  if (newUnit && base.endsWith(` \u00b7 ${newUnit}`)) return base;
  if (!newUnit || !base.trim()) return base;
  return `${base} \u00b7 ${newUnit}`;
}

export function copyDown(rows, fromIndex, toIndex = rows.length - 1, field) {
  const source = rows[fromIndex];
  if (!source) return rows.slice();
  const end = Math.min(toIndex, rows.length - 1);
  const fields = field ? [field] : ["title", "details"];
  return rows.map((row, i) => {
    if (i <= fromIndex || i > end) return row;
    const step = i - fromIndex;
    const copy = { ...row };
    for (const key of fields) {
      if (key === "title") copy.title = advanceText(source.title, step, i + 1, true);
      else if (key === "details") copy.details = advanceText(source.details, step, i + 1, false);
      else copy[key] = structuredClone(source[key]);
    }
    return copy;
  });
}

// MARK: - Today preview (spec section 9)

/** Spec 9.6 and check 12: the minutes a lane carries on a day, one lesson per course block (course minutes). */
/**
 * 2.0 #2, Review your plan: a child's minutes on a day as the app counts them. `own` is the
 * minutes of courses only this child takes that land on the day, `together` the minutes of
 * shared courses (counted once for the child), `combined` their sum. No parent total: shared
 * and independent work happen at different times, so summing children would be wrong.
 */
export function dayWorkload(week, laneId, code) {
  let own = 0, together = 0;
  for (const course of week.courses ?? []) {
    const ids = Array.isArray(course.laneIds) ? course.laneIds : [];
    if (!ids.includes(laneId) || !landsOn(week, course, code)) continue;
    const minutes = Number(course.minutes) || 0;
    if (ids.length >= 2) together += minutes; else own += minutes;
  }
  return { own, together, combined: own + together };
}

/** 2.0 #2: how far a course's lessons reach: the count, the first and last ticked titles. */
export function courseSpan(course) {
  const lessons = includedLessons(course);
  return { count: lessons.length, first: lessons[0]?.title ?? null, last: lessons[lessons.length - 1]?.title ?? null };
}

/** 2.0 #5: plain arithmetic for the course panel: "144 lessons at 4 a week is about 36 teaching weeks." */
export function pacingSentence(course, week = null) {
  const count = includedLessons(course).length;
  const chosen = courseDays(course);
  const days = week ? chosen.filter((d) => isDayOn(week, d)) : chosen;
  if (!count) return "";
  if (course.spreadOverYear && !isLoop(course)) return `${plural(count, "lesson")}, spread over the school year by the app.`;
  if (!days.length) return `${plural(count, "lesson")}. Put it on a day to see how many weeks that is.`;
  const weeks = Math.ceil(count / days.length);
  return `${plural(count, "lesson")} at ${plural(days.length, "day")} a week is about ${plural(weeks, "teaching week")}.`;
}

/**
 * 2.0 #10, the co-op pack: a file holding only the chosen courses, with the lanes they use and
 * every lane grade set to null (the family picks the child on import), `source.kind` "coop".
 * Ids are kept, so a family that opens the pack twice adds nothing twice (6.5). Nothing else
 * travels: no names (never in a week anyway), no other courses.
 */
export function coopPack(week, courseIds, { now = new Date() } = {}) {
  const chosen = (week.courses ?? []).filter((c) => courseIds.includes(c.courseId));
  if (!chosen.length) throw new Error("Pick at least one course for the pack.");
  const laneIds = new Set(chosen.flatMap((c) => c.laneIds ?? []));
  const pack = JSON.parse(JSON.stringify({
    ...week,
    fileId: week.fileId,
    createdAt: isoWithOffset(now),
    updatedAt: isoWithOffset(now),
    source: { kind: "coop", label: "Co-op courses" },
    lanes: (week.lanes ?? []).filter((l) => laneIds.has(l.laneId)).map((l) => ({ ...l, grade: null })),
    courses: chosen,
  }));
  return pack;
}

/** The co-op pack's file name. N6 in the spec is open with Josh; this pattern stands until he picks. */
export function coopFileName(week) {
  const label = week?.schoolYear?.label ?? schoolYearDefault().label;
  return `Co-op courses ${label}${FILE_EXTENSION}`;
}

/** 2.0 #9: the share link for a week, built on `base` (the page's own URL, no query): `/course-builder/#s=...`. */
export async function shareLink(week, base) {
  const starter = await toStarter(week);
  return `${base}#s=${starter}`;
}

/** The starter text carried by a share link's fragment, or null when the fragment holds none. */
export function starterFromHash(hash) {
  const match = /^#s=([A-Za-z0-9_-]+)$/.exec(String(hash ?? ""));
  return match ? match[1] : null;
}

export function dayMinutes(week, laneId, code) {
  return (week.courses ?? [])
    .filter((course) => (course.laneIds ?? []).includes(laneId) && landsOn(week, course, code))
    .reduce((total, course) => total + (Number(course.minutes) || 0), 0);
}

/** How many of a calendar course's days come before `code` within one grid week, counting only days that are not grayed out. */
function activeCourseDays(week, course) {
  return sortDays(courseDays(course).filter((day) => isDayOn(week, day)));
}

function rowFor(course, lesson, nextUp) {
  return {
    courseId: course.courseId,
    courseName: course.name,
    subject: course.subject,
    title: lesson.title,
    details: lesson.details ?? "",
    minutes: lessonMinutes(lesson, course),
    nextUp,
  };
}

/**
 * Spec section 9: one lane's day the way Today shows it. Calendar courses show on their days;
 * the lesson for (weekIndex, day) is the Nth included lesson from "Start at lesson", counting
 * only the course's days that are not grayed out (the app never dates a lesson on an away day).
 * Loop courses show their next lesson on any of their days (any shown day when `days` is empty)
 * with `nextUp: true`. Teach-together courses (two or more lanes) go in `together`, not `rows`,
 * with the lanes' color labels. A grayed-out day returns `away: { label }` and no rows.
 * Returns `{ away, rows, together, totalMinutes, date? }`; `date` is "YYYY-MM-DD" when
 * `startOn` (the Monday of week 0) is given.
 */
export function previewDay(week, laneId, code, { weekIndex = 0, startOn } = {}) {
  const lanes = week.lanes ?? [];
  // `landing`: courses that land on this day for the lane but have no lesson for it yet (no rows,
  // or not enough rows for this week), so the page can say that instead of "no course lands here".
  const result = { away: null, rows: [], together: [], totalMinutes: 0, landing: [], finished: [], finishedDetails: [] };
  if (startOn) result.date = ymd(addDays(parseYMD(startOn), weekIndex * 7 + ((weekOrder(code) - weekOrder("mon") + 7) % 7)));
  const entry = dayEntry(week, code);
  if (!entry) return result;
  if (entry.on === false) {
    result.away = { label: entry.label ?? "" };
    return result;
  }
  for (const course of week.courses ?? []) {
    if (!(course.laneIds ?? []).includes(laneId) || !landsOn(week, course, code)) continue;
    const lessons = includedLessons(course);
    let row = null;
    if (isLoop(course)) {
      if (lessons[0]) row = rowFor(course, lessons[0], true);
    } else {
      const active = activeCourseDays(week, course);
      const position = active.indexOf(code);
      if (position === -1) continue;
      const index = weekIndex * active.length + position;
      const lesson = lessons[index];
      if (lesson) row = rowFor(course, lesson, false);
      // Past the last row: the course is done by this week, which is good news, not a gap.
      else if (lessons.length > 0 && index >= lessons.length) {
        const last = lessons.length - 1;
        const lastWeek = Math.floor(last / active.length), lastPos = last % active.length;
        const lastDate = startOn ? ymd(addDays(parseYMD(startOn), lastWeek * 7 + ((weekOrder(active[lastPos]) - weekOrder("mon") + 7) % 7))) : null;
        result.finished.push(course.name || "Untitled course");
        result.finishedDetails.push({ courseName: course.name || "Untitled course", lessonNumber: lessons.length, date: lastDate, day: active[lastPos] });
        continue;
      }
    }
    if (!row) { result.landing.push(course.name || "Untitled course"); continue; }
    if ((course.laneIds ?? []).length >= 2) {
      const colors = course.laneIds.map((id) => lanes.find((l) => l.laneId === id)).filter(Boolean).map(laneLabel);
      result.together.push({ ...row, colors });
    } else {
      result.rows.push(row);
    }
    result.totalMinutes += Number(row.minutes) || 0;
  }
  return result;
}

// MARK: - Estimated finish (spec 9.8)

const parseYMD = (text) => {
  const [y, m, d] = String(text).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const ymd = (date) => `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
const addDays = (date, n) => new Date(date.getTime() + n * 86400000);
const localYMD = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** The first Monday after a date, as "YYYY-MM-DD". */
export function nextMonday(today = new Date()) {
  const base = parseYMD(typeof today === "string" ? today : localYMD(today));
  const ahead = (8 - base.getUTCDay()) % 7 || 7;
  return ymd(addDays(base, ahead));
}

/** "Friday, February 26, 2027" from "YYYY-MM-DD". */
export function longDate(text) {
  const date = parseYMD(text);
  return `${DAY_NAMES[date.getUTCDay()]}, ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/**
 * Spec 9.8: a course's estimated finish. Calendar course: from `startOn` (else the course's
 * startDate, else the next Monday after today), counting only the course's days, one lesson a
 * day over the included lessons: `{ date, text: "about Friday, February 26, 2027" }`. With
 * spreadOverYear: "Spread to fit your school year (the app works out the days)." Loop:
 * "No finish date. About 12 weeks at 2 days a week."
 */
export function estimatedFinish(course, { startOn, today = new Date(), week = null } = {}) {
  const lessons = includedLessons(course);
  const chosen = courseDays(course);
  // Days grayed out on the week grid do not count (the preview already skips them).
  const days = week ? chosen.filter((day) => isDayOn(week, day)) : chosen;
  if (chosen.length > 0 && days.length === 0) {
    const grayed = chosen.map(dayName);
    return { date: null, text: `No day to run on: ${grayed.join(" and ")} ${grayed.length === 1 ? "is" : "are"} grayed out.` };
  }
  if (isLoop(course)) {
    const perWeek = days.length || 5;
    const weeks = Math.ceil(lessons.length / perWeek);
    return { date: null, text: `No finish date. About ${plural(weeks, "week")} at ${plural(perWeek, "day")} a week.` };
  }
  if (course.spreadOverYear) return { date: null, text: "Spread to fit your school year (the app works out the days)." };
  if (days.length === 0) return { date: null, text: "Put it on a day first." };
  if (lessons.length === 0) return { date: null, text: "No lessons yet." };
  const weekdays = new Set(days.map(weekdayNumber));
  let cursor = parseYMD(startOn ?? course.startDate ?? nextMonday(today));
  let remaining = lessons.length;
  let last = cursor;
  while (remaining > 0) {
    if (weekdays.has(cursor.getUTCDay() + 1)) {
      remaining -= 1;
      last = cursor;
    }
    if (remaining > 0) cursor = addDays(cursor, 1);
  }
  const date = ymd(last);
  return { date, text: `about ${longDate(date)}` };
}

// MARK: - Starter week (spec 5.8, A15)

const STARTER_FORMAT = "hss-starter";
const STARTER_VERSION = 1;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function pipeThrough(bytes, stream) {
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  const buffer = await new Response(stream.readable).arrayBuffer();
  await written;
  return new Uint8Array(buffer);
}

/** The compact 5.8 object: rhythm, colors, grades and course names only. */
export function starterShape(week) {
  const lanes = week.lanes ?? [];
  const laneIndex = new Map(lanes.map((lane, i) => [lane.laneId, i]));
  return {
    f: STARTER_FORMAT,
    v: STARTER_VERSION,
    d: onDays(week),
    off: (week.week?.days ?? []).filter((d) => d.on === false).map((d) => (d.label ? { d: d.day, l: d.label } : { d: d.day })),
    l: lanes.map((lane) => ({ c: lane.color, g: lane.grade ?? null })),
    c: (week.courses ?? []).map((course) => ({
      n: course.name,
      s: course.subject,
      l: (course.laneIds ?? []).map((id) => laneIndex.get(id)).filter((i) => i !== undefined),
      m: course.minutes,
      k: isLoop(course) ? "loop" : "cal",
      d: courseDays(course),
    })),
  };
}

/**
 * Spec 5.8: the week as a share-link fragment, base64url(deflate-raw(JSON of the starter
 * shape)). Carries no lesson titles, details, notes, resources or names. Throws when the result
 * is over LIMITS.starterChars (the site then says "Too big for a link; download the file instead.").
 */
export async function toStarter(week) {
  const json = JSON.stringify(starterShape(week));
  const packed = await pipeThrough(new TextEncoder().encode(json), new CompressionStream("deflate-raw"));
  const text = bytesToBase64Url(packed);
  if (text.length > LIMITS.starterChars) throw new Error(MESSAGES.starterTooBig);
  return text;
}

/**
 * Spec 5.8: a full week from a starter string, with fresh ids from `uuid()`, `source.kind`
 * "starterLink", and empty lesson lists. Throws when the text is not a starter.
 */
export async function fromStarter(text, { uuid = defaultUUID, now = new Date() } = {}) {
  const notAStarter = new Error("This link is not a Course Builder starter week.");
  let starter;
  try {
    const bytes = await pipeThrough(base64UrlToBytes(String(text).trim()), new DecompressionStream("deflate-raw"));
    starter = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw notAStarter;
  }
  if (!isObject(starter) || starter.f !== STARTER_FORMAT || !(Number(starter.v) <= STARTER_VERSION)) throw notAStarter;
  const week = newWeek({ now, uuid });
  week.source = { kind: "starterLink" };
  const on = new Set(Array.isArray(starter.d) ? starter.d : []);
  const off = new Map((Array.isArray(starter.off) ? starter.off : []).map((o) => [o?.d, typeof o?.l === "string" ? o.l : ""]));
  week.week.days = WEEK_ORDER.filter((day) => on.has(day) || off.has(day)).map((day) => (on.has(day) ? { day, on: true, label: "" } : { day, on: false, label: off.get(day) }));
  const lanes = (Array.isArray(starter.l) ? starter.l : []).slice(0, LIMITS.lanes).map((l) => newLane(week, { color: LANE_COLORS.some((c) => c.name === l?.c) ? l.c : "blue", grade: Number.isInteger(l?.g) ? l.g : null, uuid }));
  for (const c of Array.isArray(starter.c) ? starter.c : []) {
    const laneIds = (Array.isArray(c?.l) ? c.l : []).map((i) => lanes[i]?.laneId).filter(Boolean);
    const course = newCourse(week, { laneIds, defaults: { name: typeof c?.n === "string" ? c.n : "", subject: c?.s, minutes: validMinutes(c?.m) ? c.m : 30 }, uuid });
    course.scheduleMode = c?.k === "loop" ? LOOP : CALENDAR;
    course.days = sortDays((Array.isArray(c?.d) ? c.d : []).filter((d) => DAY_CODES.includes(d)));
  }
  return week;
}

export { deepEqual };
