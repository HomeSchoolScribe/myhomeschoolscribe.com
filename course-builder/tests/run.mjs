#!/usr/bin/env node
// run.mjs
//
// The Course Builder site tests (spec section 11, the JS half), Node only, zero dependencies.
// From the repo root:
//
//   node website/course-builder/tests/run.mjs
//
// Prints one line per test and exits 1 when any test fails. Tests named A1, A2, A15, A16, A19,
// A20 and A21 are the acceptance tests the spec assigns to the site; the rest are unit tests of
// format/hssweek.js and format/schema-check.js. A14 (browser, no network) and A18 (real devices)
// are not run here.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as H from "../format/hssweek.js";
import { validateSchema } from "../format/schema-check.js";
import {
  BUBBLE_ROOM_INSET, DONE_MS, FOOTER_GAP, GREETING, LESSON_TIPS, QUIET_MS, SCREEN_TIPS, STROKE_SPANS, STROKE_STARTS, STROKES,
  bubblePlacement, bubbleRoom, footerClearance, helpLabel, lessonsDoneShouldPlay, poseAt,
} from "../mark-tally.js";

const here = dirname(fileURLToPath(import.meta.url));
const builderDir = resolve(here, "..");
const formatDir = join(builderDir, "format");
const samplesDir = join(formatDir, "samples");
const fixturesDir = join(formatDir, "toc-fixtures");
const websiteDir = resolve(builderDir, "..");

const read = (path) => readFileSync(path, "utf8");
const sample = (name) => read(join(samplesDir, name));
const schema = JSON.parse(read(join(formatDir, "hssweek.schema.json")));
const courseDefaults = JSON.parse(read(join(formatDir, "course-defaults.json")));
const GOLDEN = "Our week 2026-27.hssweek";
/** A fresh copy of the golden week each time, so a test can edit it freely. */
const golden = () => H.parseFile(sample(GOLDEN)).week;
const BLUE = "c77ee5b2-95ce-4f78-8cc3-e0226df8e434";
const GREEN = "1309f163-0275-4385-86d0-260900609f04";

/** Predictable ids for tests: a counter, never the same twice. */
function uuidCounter() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const byCode = (items, code) => items.filter((item) => item.code === code);
const only = (items, code) => {
  const found = byCode(items, code);
  assert.ok(found.length >= 1, `expected a check with code ${code}, got ${JSON.stringify(items)}`);
  return found[0];
};

// MARK: - A1 schema

test("A1 the golden sample validates with zero errors (schema-check and validate)", () => {
  const week = JSON.parse(sample(GOLDEN));
  assert.deepEqual(validateSchema(schema, week), []);
  assert.deepEqual(H.validate(week).errors, []);
  const parsed = H.parseFile(sample(GOLDEN));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
});

test("A1 older-1.0-minimal (required fields only) validates", () => {
  const parsed = H.parseFile(sample("older-1.0-minimal.hssweek"));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
});

test("A1 newer-minor-1.7 validates apart from unknown enum values, which parseFile reports as warnings", () => {
  const week = JSON.parse(sample("newer-minor-1.7-unknown-fields.hssweek"));
  const errors = H.validate(week).errors;
  assert.ok(errors.length > 0, "the sample carries unknown enum values on purpose");
  assert.ok(errors.every((e) => e.keyword === "enum"), `only enum mismatches are expected: ${JSON.stringify(errors)}`);
  assert.equal(errors.length, 5, "resource kind, lesson tag, subject, grading mode, level");
  const parsed = H.parseFile(sample("newer-minor-1.7-unknown-fields.hssweek"));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.warnings.length, 5);
  assert.deepEqual(parsed.warnings.map((w) => w.code), Array(5).fill("unknownValue"));
  assert.deepEqual(parsed.warnings.map((w) => w.path), ["courses[0].resources[0].kind", "courses[0].lessons[0].tags[0]", "courses[1].subject", "courses[2].gradingMode", "courses[2].level"]);
  assert.ok(parsed.week.theme === "chalk", "unknown fields ride along on the week object");
});

test("A1 newer-major-2.0 is refused with the newer-version message", () => {
  const parsed = H.parseFile(sample("newer-major-2.0.hssweek"));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.week, null);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].code, "newerVersion");
  assert.equal(parsed.errors[0].message, "This week was made with a newer Course Builder (format 2). Update HomeSchool Scribe from the App Store, then open the file again. Nothing was added.");
});

test("A1 wrong-file-backup.json is recognized as a full backup", () => {
  const parsed = H.parseFile(sample("wrong-file-backup.json"));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors[0].code, "backupFile");
  assert.equal(parsed.errors[0].message, "This is a full HomeSchool Scribe backup, not a Course Builder week. To restore a backup, go to Records, then Import a backup. Nothing was added.");
});

test("A1 not-json, truncated and wrong-format are 'not a Course Builder week'", () => {
  for (const name of ["not-json.hssweek", "truncated.hssweek", "wrong-format.json"]) {
    const parsed = H.parseFile(sample(name));
    assert.equal(parsed.ok, false, name);
    assert.equal(parsed.errors[0].code, "notAWeek", name);
    assert.equal(parsed.errors[0].message, "This file isn't a Course Builder week, or it didn't finish downloading. Download it again from the Course Builder. Nothing was added.");
  }
  assert.equal(H.parseFile("[1, 2, 3]").errors[0].code, "notAWeek");
  assert.equal(H.parseFile(undefined).errors[0].code, "notAWeek");
});

test("A1 a file over 5 MB is refused as too big", () => {
  const parsed = H.parseFile("x".repeat(H.LIMITS.fileBytes + 1));
  assert.equal(parsed.errors[0].code, "tooBig");
  assert.equal(parsed.errors[0].message, "This file is too big to be a Course Builder week. Nothing was added.");
});

test("A1 the schema catches a broken week: missing fields, bad minutes, graded without points, unknown lane", () => {
  const week = golden();
  delete week.fileId;
  week.courses[0].minutes = 7;
  week.courses[0].lessons[2].minutes = 3;
  week.courses[0].lessons[3].tags = ["graded"];
  week.courses[1].laneIds.push("ffffffff-0000-4000-8000-000000000000");
  week.courses[2].scheduleMode = "On the calendar";
  week.courses[2].days = [];
  const { errors } = H.validate(week);
  const paths = errors.map((e) => `${e.keyword}@${e.path}`);
  assert.ok(paths.includes("required@fileId"), paths.join("\n"));
  assert.ok(paths.includes("multipleOf@courses[0].minutes"), paths.join("\n"));
  assert.ok(paths.includes("minimum@courses[0].lessons[2].minutes"), "the oneOf reports the integer branch's own complaint");
  assert.ok(paths.includes("graded@courses[0].lessons[3].pointsPossible"));
  assert.ok(paths.includes("laneRef@courses[1].laneIds[2]"));
  assert.ok(paths.includes("days@courses[2].days"));
  const parsed = H.parseFile(JSON.stringify(week));
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.every((e) => e.code === "schema"));
  assert.ok(parsed.errors[0].message.startsWith(`${parsed.errors[0].path}: `));
});

test("schema-check: type lists, const, enum, string and array limits, pattern", () => {
  const s = {
    type: "object",
    required: ["a"],
    properties: {
      a: { type: ["integer", "null"], minimum: -1, maximum: 12 },
      b: { const: "fixed" },
      c: { enum: ["x", "y"] },
      d: { type: "string", minLength: 1, maxLength: 3, pattern: "^[a-z]+$" },
      e: { type: "array", minItems: 1, maxItems: 2, items: { type: "number", exclusiveMinimum: 0 } },
      f: { oneOf: [{ $ref: "#/$defs/hex" }, { type: "null" }] },
    },
    $defs: { hex: { type: "string", pattern: "^[0-9a-f]{2}$" } },
  };
  assert.deepEqual(validateSchema(s, { a: null, b: "fixed", c: "x", d: "ab", e: [1], f: "0f" }), []);
  assert.deepEqual(validateSchema(s, { a: 3, f: null }), []);
  const errors = validateSchema(s, { a: 13, b: "other", c: "z", d: "ABCD", e: [0, 1, 2], f: "zz" });
  assert.deepEqual(errors.map((e) => `${e.keyword}@${e.path}`), ["maximum@a", "const@b", "enum@c", "maxLength@d", "pattern@d", "maxItems@e", "exclusiveMinimum@e[0]", "pattern@f"]);
  assert.deepEqual(validateSchema(s, {}).map((e) => `${e.keyword}@${e.path}`), ["required@a"]);
  assert.deepEqual(validateSchema(s, { a: 2.5 }).map((e) => `${e.keyword}@${e.path}`), ["type@a"]);
});

// MARK: - A2 round trip

for (const name of [GOLDEN, "Our week 2026-27 (2 new lessons).hssweek", "newer-minor-1.7-unknown-fields.hssweek"]) {
  test(`A2 parseFile then serialize reproduces "${name}" byte for byte`, () => {
    const text = sample(name);
    const parsed = H.parseFile(text);
    assert.equal(parsed.ok, true);
    const out = H.serialize(parsed.week, { updatedAt: parsed.week.updatedAt });
    if (out !== text) {
      let i = 0;
      while (out[i] === text[i]) i += 1;
      assert.fail(`differs at offset ${i}: expected ${JSON.stringify(text.slice(i - 30, i + 50))}, got ${JSON.stringify(out.slice(i - 30, i + 50))}`);
    }
    assert.equal(Buffer.byteLength(out, "utf8"), Buffer.byteLength(text, "utf8"));
  });
}

test("A2 serialize writes the canonical form: defaults made explicit, idempotent, updatedAt replaced", () => {
  const minimal = H.parseFile(sample("older-1.0-minimal.hssweek")).week;
  const once = H.serialize(minimal, { updatedAt: minimal.updatedAt });
  const again = H.parseFile(once);
  assert.equal(again.ok, true, JSON.stringify(again.errors));
  assert.equal(H.serialize(again.week, { updatedAt: minimal.updatedAt }), once);
  const course = again.week.courses[0];
  assert.deepEqual(Object.keys(course), ["courseId", "laneIds", "name", "subject", "colorHex", "scheduleMode", "days", "minutes", "startDate", "startAtLesson", "spreadOverYear", "gradingMode", "level", "credits", "includeOnTranscript", "targetHours", "curriculum", "notes", "resources", "categories", "lessons"]);
  assert.equal(course.spreadOverYear, false);
  assert.equal(course.credits, 1);
  assert.deepEqual(course.lessons[0], { lessonId: "cccc1111-2222-4333-8444-555566667777", title: "Lesson 1", details: "", minutes: null, unit: null, tags: [], pointsPossible: null, categoryId: null, include: true });
  assert.deepEqual(again.week.week.days[0], { day: "mon", on: true, label: "" });
  assert.ok(once.endsWith("}\n"));
  const stamped = H.serialize(minimal, { updatedAt: "2026-10-06T07:00:00-04:00" });
  assert.ok(stamped.includes('"updatedAt": "2026-10-06T07:00:00-04:00"'));
  assert.ok(!stamped.includes("1.0,"), "numbers print the JavaScript way");
});

test("A2 serialize never writes a top-level names object, even if the page put one on the week", () => {
  const week = golden();
  week.names = { [BLUE]: "Ann" };
  const out = H.serialize(week, { updatedAt: week.updatedAt });
  assert.equal(out, sample(GOLDEN));
  assert.ok(!out.includes("Ann"));
});

// MARK: - A15 starter shape

const decodeStarter = async (text) => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  const buffer = await new Response(stream.readable).arrayBuffer();
  await written;
  return new TextDecoder().decode(buffer);
};

test("A15 golden -> toStarter -> fromStarter keeps rhythm, colors and course names, carries no lesson text, stays under 2,000 characters", async () => {
  const week = golden();
  const text = await H.toStarter(week);
  assert.ok(text.length < 2000, `${text.length} characters`);
  assert.match(text, /^[A-Za-z0-9_-]+$/, "base64url only");
  const raw = await decodeStarter(text);
  const starter = JSON.parse(raw);
  assert.equal(starter.f, "hss-starter");
  assert.equal(starter.v, 1);
  assert.deepEqual(starter.d, ["mon", "tue", "thu", "fri"]);
  assert.deepEqual(starter.off, [{ d: "wed", l: "Co-op" }]);
  assert.deepEqual(starter.l, [{ c: "blue", g: 3 }, { c: "green", g: 9 }]);
  assert.deepEqual(starter.c[1], { n: "Read-aloud", s: "Language Arts", l: [0, 1], m: 20, k: "loop", d: ["tue", "thu"] });
  for (const phrase of ["Place value", "Read pages", "Listen", "Onion", "Closed book", "Fact practice", "workbook", "Chapter 1", "Quiz", "Second edition", "lessonId", "notes"]) {
    assert.ok(!raw.includes(phrase), `starter must not carry "${phrase}"`);
  }

  const back = await H.fromStarter(text, { uuid: uuidCounter(), now: new Date(2026, 9, 5, 18, 30) });
  assert.deepEqual(H.validate(back).errors, []);
  assert.equal(back.source.kind, "starterLink");
  assert.deepEqual(back.week.days, week.week.days);
  assert.deepEqual(back.lanes.map((l) => [l.color, l.colorHex, l.grade]), week.lanes.map((l) => [l.color, l.colorHex, l.grade]));
  assert.notEqual(back.lanes[0].laneId, week.lanes[0].laneId, "fresh ids");
  assert.notEqual(back.lanes[0].laneId, back.lanes[1].laneId);
  const laneIndexes = (w, course) => course.laneIds.map((id) => w.lanes.findIndex((l) => l.laneId === id));
  assert.deepEqual(back.courses.map((c) => c.name), ["Math", "Read-aloud", "Biology"]);
  assert.deepEqual(back.courses.map((c) => c.subject), week.courses.map((c) => c.subject));
  assert.deepEqual(back.courses.map((c) => laneIndexes(back, c)), week.courses.map((c) => laneIndexes(week, c)));
  assert.deepEqual(back.courses.map((c) => c.minutes), [30, 20, 45]);
  assert.deepEqual(back.courses.map((c) => c.scheduleMode), ["On the calendar", "Loop", "On the calendar"]);
  assert.deepEqual(back.courses.map((c) => c.days), week.courses.map((c) => c.days));
  assert.ok(back.courses.every((c) => c.lessons.length === 0), "no lessons come through a link");
  assert.deepEqual(back.courses.map((c) => c.gradingMode), ["Narrative, no grade", "Points", "Points"]);
  await assert.rejects(() => H.fromStarter("not-a-starter"), /not a Course Builder starter/);
});

test("A15 toStarter refuses a week too big for a link", async () => {
  const week = golden();
  const uuid = uuidCounter();
  // Random names, so deflate cannot squeeze the week under the cap.
  for (let i = 0; i < 150; i += 1) H.newCourse(week, { laneIds: [BLUE], defaults: { name: `Course ${globalThis.crypto.randomUUID()}`, subject: "Other", perWeek: 3, minutes: 30 }, uuid });
  await assert.rejects(() => H.toStarter(week), /Too big for a link; download the file instead\./);
});

// MARK: - A16 shared fixtures

for (const name of readdirSync(fixturesDir).filter((f) => f.endsWith(".txt")).sort()) {
  test(`A16 parseContents matches toc-fixtures/${name.replace(/\.txt$/, ".json")}`, () => {
    const expected = JSON.parse(read(join(fixturesDir, name.replace(/\.txt$/, ".json"))));
    assert.deepEqual(H.parseContents(read(join(fixturesDir, name))), expected);
  });
}

test("A16 course-defaults.json has one list per GradeLevel raw value with the YearStarter fields", () => {
  const keys = Object.keys(courseDefaults.grades).map(Number).sort((a, b) => a - b);
  assert.deepEqual(keys, Array.from({ length: 14 }, (_, i) => i - 1));
  for (const list of Object.values(courseDefaults.grades)) {
    for (const choice of list) {
      assert.deepEqual(Object.keys(choice).sort(), ["credits", "id", "isOn", "minutes", "name", "perWeek", "subject", "titlePattern"]);
      assert.ok(H.SUBJECTS.includes(choice.subject), choice.subject);
      assert.ok(choice.perWeek >= 1 && choice.perWeek <= 5);
    }
  }
  assert.equal(courseDefaults.gradingDefault.belowGrade9, "Narrative, no grade");
  assert.equal(courseDefaults.gradingDefault.grade9AndUp, "Points");
});

// MARK: - A19 no analytics

test("A19 no analytics, session replay or external script under website/course-builder/", () => {
  // Built from pieces so this file does not trip its own scan.
  const needles = [["ampli", "tude"], ["session", "Replay"], ["g", "tag"], ["googletag", "manager"], ["plaus", "ible"], ["cloudflare", "insights"], ["hot", "jar"], ["seg", "ment"], ["fb", "q"]].map((parts) => parts.join("").toLowerCase());
  const externalScript = ["<scr", "ipt src=\"http"].join("").toLowerCase();
  const hits = [];
  for (const path of walk(builderDir)) {
    const text = read(path).toLowerCase();
    for (const needle of [...needles, externalScript]) {
      if (text.includes(needle)) hits.push(`${relative(websiteDir, path)} contains "${needle}"`);
    }
  }
  assert.deepEqual(hits, []);
});

// MARK: - A20 unlisted

test("A20 the page is unlisted: noindex on index.html, no links from the rest of the site", () => {
  const indexPath = join(builderDir, "index.html");
  if (existsSync(indexPath)) {
    assert.ok(read(indexPath).includes('<meta name="robots" content="noindex,nofollow">'), "index.html needs the noindex,nofollow robots meta");
  } else {
    skips.push("A20: website/course-builder/index.html does not exist yet, so the noindex check was skipped");
  }
  const offenders = [];
  for (const name of ["sitemap.xml", "robots.txt"]) {
    const path = join(websiteDir, name);
    if (existsSync(path) && read(path).includes("course-builder")) offenders.push(name);
  }
  for (const path of walk(websiteDir)) {
    if (path.startsWith(builderDir + sep) || !path.endsWith(".html")) continue;
    if (read(path).includes("course-builder")) offenders.push(relative(websiteDir, path));
  }
  assert.deepEqual(offenders, [], "course-builder must not be named outside its own folder");
});

// MARK: - A21 school year

test("A21 school-year default: 2025-26 on June 30, 2026; 2026-27 on July 1 and October 5, 2026", () => {
  assert.deepEqual(H.schoolYearDefault(new Date(2026, 5, 30)), { startYear: 2025, label: "2025-26" });
  assert.deepEqual(H.schoolYearDefault(new Date(2026, 6, 1)), { startYear: 2026, label: "2026-27" });
  assert.deepEqual(H.schoolYearDefault(new Date(2026, 9, 5)), { startYear: 2026, label: "2026-27" });
  assert.deepEqual(H.schoolYearDefault(new Date(2099, 11, 31)), { startYear: 2099, label: "2099-00" });
  assert.deepEqual(H.schoolYearOptions(new Date(2026, 9, 5)).map((y) => y.label), ["2025-26", "2026-27", "2027-28"]);
});

test("A21 the golden is named for its school year", () => {
  const week = golden();
  assert.equal(H.fileName(week), "Our week 2026-27.hssweek");
  assert.equal(week.schoolYear.label, "2026-27");
  assert.equal(H.fileName(H.newWeek({ now: new Date(2026, 5, 30), uuid: uuidCounter() })), "Our week 2025-26.hssweek");
});

// MARK: - Building a week

test("newWeek, newLane, newCourse and newLesson make a valid week with the grade band's defaults", () => {
  const uuid = uuidCounter();
  const week = H.newWeek({ now: new Date(2026, 9, 5, 18, 30, 0), uuid });
  assert.equal(week.format, "homeschoolscribe.week");
  assert.equal(week.formatVersion, "1.0");
  assert.deepEqual(week.madeWith, { tool: "Course Builder", version: "1.0.0" });
  assert.deepEqual(week.source, { kind: "blank" });
  assert.deepEqual(week.schoolYear, { startYear: 2026, label: "2026-27" });
  assert.deepEqual(week.week.days.map((d) => d.day), ["mon", "tue", "wed", "thu", "fri"]);
  assert.match(week.createdAt, /^2026-10-05T18:30:00[+-]\d\d:\d\d$/);

  const blue = H.newLane(week, { color: "blue", grade: 3, uuid });
  const green = H.newLane(week, { color: "green", grade: 9, uuid });
  assert.equal(blue.colorHex, "2E6B9E");
  assert.equal(green.colorHex, "3F7A4F");
  assert.throws(() => H.newLane(week, { color: "pink", uuid }));

  const band = H.gradeBandDefaults(courseDefaults, 3);
  const math = H.newCourse(week, { laneIds: [blue.laneId], defaults: band.find((c) => c.id === "math"), uuid });
  assert.equal(math.name, "Math");
  assert.equal(math.minutes, 30);
  assert.deepEqual(math.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(math.gradingMode, "Narrative, no grade");
  assert.equal(math.scheduleMode, "On the calendar");
  assert.deepEqual([math.level, math.credits, math.includeOnTranscript, math.targetHours], ["Regular", 1, true, 0]);

  const science = H.newCourse(week, { laneIds: [blue.laneId], defaults: band.find((c) => c.id === "science"), uuid });
  assert.deepEqual(science.days, ["mon", "wed", "fri"], "three a week from Mon to Fri is Mon/Wed/Fri");
  const art = H.newCourse(week, { laneIds: [blue.laneId], defaults: band.find((c) => c.id === "art"), uuid });
  assert.deepEqual(art.days, ["wed"], "one a week is midweek");
  assert.equal(art.credits, 0.5);

  const bio = H.newCourse(week, { laneIds: [green.laneId], defaults: H.gradeBandDefaults(courseDefaults, 9).find((c) => c.id === "science"), uuid });
  assert.equal(bio.name, "Biology");
  assert.equal(bio.gradingMode, "Points");
  assert.deepEqual(bio.days, ["mon", "tue", "thu", "fri"], "four a week from Mon to Fri");
  const together = H.newCourse(week, { laneIds: [blue.laneId, green.laneId], defaults: { name: "Read-aloud", subject: "Language Arts", perWeek: 2, minutes: 20 }, uuid });
  assert.equal(together.gradingMode, "Points", "the highest lane grade decides");
  assert.deepEqual(together.days, ["tue", "thu"]);

  const lesson = H.newLesson(math, { uuid, title: "Lesson 1" });
  assert.deepEqual(lesson, { lessonId: lesson.lessonId, title: "Lesson 1", details: "", minutes: null, unit: null, tags: [], pointsPossible: null, categoryId: null, include: true });
  assert.deepEqual(H.validate(week).errors, []);
  assert.equal(H.parseFile(H.serialize(week, { updatedAt: week.updatedAt })).ok, true);

  week.week.days[2].on = false; // gray out Wednesday
  const history = H.newCourse(week, { laneIds: [blue.laneId], defaults: { name: "History", subject: "Social Studies", perWeek: 3, minutes: 30 }, uuid });
  assert.deepEqual(history.days, ["mon", "thu", "fri"], "three from Mon/Tue/Thu/Fri skips the grayed day");
});

test("pickWeekdays follows YearStarter.weekdays(perWeek:from:)", () => {
  const monToFri = [2, 3, 4, 5, 6];
  assert.deepEqual(H.pickWeekdays(5, monToFri), [2, 3, 4, 5, 6]);
  assert.deepEqual(H.pickWeekdays(4, monToFri), [2, 3, 5, 6]);
  assert.deepEqual(H.pickWeekdays(3, monToFri), [2, 4, 6]);
  assert.deepEqual(H.pickWeekdays(2, monToFri), [3, 5]);
  assert.deepEqual(H.pickWeekdays(1, monToFri), [4]);
  assert.deepEqual(H.pickWeekdays(0, monToFri), [4]);
  assert.deepEqual(H.pickWeekdays(9, monToFri), [2, 3, 4, 5, 6]);
  assert.deepEqual(H.pickWeekdays(2, [3, 5, 6]), [3, 6]);
  assert.deepEqual(H.pickWeekdays(3, []), []);
});

test("gradeBandDefaults reads course-defaults.json by GradeLevel raw value", () => {
  assert.equal(H.gradeBandDefaults(courseDefaults, -1)[0].name, "Read-alouds");
  assert.equal(H.gradeBandDefaults(courseDefaults, 0)[0].minutes, 20);
  assert.equal(H.gradeBandDefaults(courseDefaults, 12)[0].name, "Pre-Calculus");
  assert.equal(H.gradeBandDefaults(courseDefaults, null)[0].name, "Algebra I");
  assert.deepEqual(H.gradeBandDefaults(courseDefaults, 20), H.gradeBandDefaults(courseDefaults, 12));
  assert.deepEqual(H.gradeBandDefaults({}, 3), []);
});

test("constants match the app's enum raw values and labels", () => {
  assert.deepEqual([...H.SUBJECTS], ["Language Arts", "Math", "Science", "Social Studies", "Foreign Language", "Fine Arts", "PE & Health", "Bible & Religion", "Technology", "Life Skills", "Elective", "Other"]);
  assert.deepEqual([...H.GRADING_MODES], ["Points", "Grade I enter", "Pass/fail", "Narrative, no grade"]);
  assert.deepEqual([...H.SCHEDULE_MODES], ["On the calendar", "Loop"]);
  assert.deepEqual([...H.LEVELS], ["Regular", "Honors", "AP", "Dual enrollment"]);
  assert.deepEqual([...H.RESOURCE_KINDS], ["Book", "Curriculum", "Website", "Video", "Kit or supplies", "Other"]);
  assert.deepEqual([...H.TAGS], ["quiz", "test", "lab", "review", "graded"]);
  assert.deepEqual([...H.CREDITS], [0.25, 0.5, 1, 1.5, 2]);
  assert.deepEqual([...H.TARGET_HOURS], [0, 120, 150, 180]);
  assert.deepEqual([...H.DAY_CODES], ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.equal(H.weekdayNumber("mon"), 2);
  assert.equal(H.GRADES.length, 14);
  assert.deepEqual(H.GRADES[0], { value: -1, label: "Pre-K", long: "Pre-K" });
  assert.deepEqual(H.GRADES[1], { value: 0, label: "K", long: "Kindergarten" });
  assert.deepEqual(H.GRADES[2], { value: 1, label: "1st", long: "1st grade" });
  assert.deepEqual(H.GRADES[3], { value: 2, label: "2nd", long: "2nd grade" });
  assert.deepEqual(H.GRADES[4], { value: 3, label: "3rd", long: "3rd grade" });
  assert.deepEqual(H.GRADES[12], { value: 11, label: "11th", long: "11th grade" });
  assert.deepEqual(H.GRADES[13], { value: 12, label: "12th", long: "12th grade" });
  assert.deepEqual(H.LANE_COLORS.map((c) => `${c.name} ${c.label} ${c.hex}`), ["blue Blue 2E6B9E", "green Green 3F7A4F", "orange Orange 8A5A10", "purple Purple 6A3D8F", "red Red B7472A", "teal Teal 1E6E63"]);
  assert.equal(H.MIME, "application/vnd.homeschoolscribe.week+json");
  assert.equal(H.LIMITS.lessonsPerCourse, 200);
  assert.equal(H.LIMITS.starterChars, 2000);
});

// MARK: - Pattern fill

test("patternFill count mode: 20 rows with every 5th a quiz = 16 reading lessons and 4 quizzes", () => {
  const { lessons, sentence, count } = H.patternFill({ titlePattern: "Lesson {n}", count: 20, every: 5, everyKind: "Quiz" });
  assert.equal(count, 20);
  assert.equal(lessons.length, 20);
  const quizzes = lessons.filter((l) => l.tags.includes("quiz"));
  assert.equal(quizzes.length, 4);
  assert.deepEqual(quizzes.map((l) => l.title), ["Quiz 1", "Quiz 2", "Quiz 3", "Quiz 4"]);
  assert.deepEqual([4, 9, 14, 19].map((i) => lessons[i].title), ["Quiz 1", "Quiz 2", "Quiz 3", "Quiz 4"]);
  const reading = lessons.filter((l) => l.tags.length === 0);
  assert.equal(reading.length, 16);
  assert.deepEqual(reading.map((l) => l.title), Array.from({ length: 16 }, (_, i) => `Lesson ${i + 1}`));
  assert.equal(sentence, "20 rows. Every 5th is a quiz, so 16 reading lessons and 4 quizzes, not graded.");
  // Without the page's "count toward the grade" box, a quiz is only tagged (spec 5.6 keeps graded separate).
  assert.ok(lessons.every((l) => l.pointsPossible === null && !l.tags.includes("graded")), "graded only when asked");
  const gradedRun = H.patternFill({ titlePattern: "Lesson {n}", count: 20, every: 5, everyKind: "Quiz", graded: true, points: 20 });
  assert.ok(gradedRun.lessons.filter((l) => l.tags.includes("quiz")).every((l) => l.pointsPossible === 20 && l.tags.includes("graded")), "ticked: graded out of the points given");
  assert.equal(gradedRun.sentence, "20 rows. Every 5th is a quiz, so 16 reading lessons and 4 quizzes, each out of 20 points.");
  assert.equal(H.patternFill({ titlePattern: "Lesson {n}", count: 20, every: 5, everyKind: "Quiz" }).sentence, "20 rows. Every 5th is a quiz, so 16 reading lessons and 4 quizzes, not graded.");
  assert.ok(H.patternFill({ titlePattern: "L {n}", count: 4, every: 2, everyKind: "Review", graded: true }).lessons.every((l) => !l.tags.includes("graded")), "a review is never graded");
  assert.ok(lessons.every((l) => l.unit === null && l.details === ""));
});

test("patternFill count mode without quizzes, with a unit, start number and custom details", () => {
  const { lessons, sentence } = H.patternFill({ titlePattern: "Lesson {n} · {unit}", count: 3, unit: "Fractions", startNumber: 27, detailsPattern: "Workbook lesson {n}." });
  assert.deepEqual(lessons.map((l) => l.title), ["Lesson 27 · Fractions", "Lesson 28 · Fractions", "Lesson 29 · Fractions"]);
  assert.deepEqual(lessons.map((l) => l.details), ["Workbook lesson 27.", "Workbook lesson 28.", "Workbook lesson 29."]);
  assert.ok(lessons.every((l) => l.unit === "Fractions"));
  assert.equal(sentence, '3 lessons, "Lesson 27 · Fractions" to "Lesson 29 · Fractions".');
  assert.deepEqual(H.patternFill({ titlePattern: "Lesson {n}" }), { lessons: [], sentence: "How many lessons?", count: 0 });
  assert.equal(H.patternFill({ count: 2 }).lessons[1].title, "Lesson 2", "title pattern defaults to Lesson {n}");
});

test("patternFill pages mode: 320 pages at 16 a lesson, every 5th a quiz = 20 reading lessons + 4 quizzes = 24 rows covering every page", () => {
  const { lessons, sentence, count } = H.patternFill({ titlePattern: "Lesson {n}", pages: 320, pagesPerLesson: 16, every: 5, everyKind: "Quiz" });
  assert.equal(count, 24);
  const reading = lessons.filter((l) => l.tags.length === 0);
  const quizzes = lessons.filter((l) => l.tags.includes("quiz"));
  assert.equal(reading.length, 20);
  assert.equal(quizzes.length, 4);
  assert.deepEqual(lessons.slice(0, 7).map((l) => `${l.title} / ${l.details}`), [
    "Lesson 1 / Read pages 1-16.",
    "Lesson 2 / Read pages 17-32.",
    "Lesson 3 / Read pages 33-48.",
    "Lesson 4 / Read pages 49-64.",
    "Lesson 5 / Read pages 65-80.",
    "Quiz 1 / Quiz on pages 1-80.",
    "Lesson 6 / Read pages 81-96.",
  ]);
  assert.equal(reading[19].details, "Read pages 305-320.", "the whole book is planned");
  assert.equal(quizzes[3].details, "Quiz on pages 241-320.");
  assert.equal(lessons[lessons.length - 1].title, "Quiz 4");
  assert.equal(sentence, "320 pages at 16 a lesson = 20 reading lessons. Every 5th lesson is a quiz: 4 quizzes, not graded, 24 rows in all. Reading lessons say 'Read pages 1-16', then 17-32, ...");
});

test("patternFill pages mode: a short last lesson, a start page, other kinds, custom details with {from}-{to}", () => {
  const short = H.patternFill({ titlePattern: "Lesson {n}", pages: 20, pagesPerLesson: 16 });
  assert.deepEqual(short.lessons.map((l) => l.details), ["Read pages 1-16.", "Read pages 17-20."]);
  assert.equal(short.sentence, "20 pages at 16 a lesson = 2 lessons. They say 'Read pages 1-16', then 17-20, ...");
  const one = H.patternFill({ titlePattern: "Lesson {n}", pages: 10, pagesPerLesson: 16 });
  assert.equal(one.sentence, "10 pages at 16 a lesson = 1 lesson. It says 'Read pages 1-16'.".replace("1-16", "1-10"));
  const tests = H.patternFill({ titlePattern: "Chapter {n}", pages: 60, pagesPerLesson: 10, startPage: 101, every: 3, everyKind: "Test", detailsPattern: "Pages {from} to {to}, {unit}." , unit: "Light" });
  assert.deepEqual(tests.lessons.map((l) => `${l.title} / ${l.details} / ${l.tags.join(",")}`), [
    "Chapter 1 / Pages 101 to 110, Light. / ",
    "Chapter 2 / Pages 111 to 120, Light. / ",
    "Chapter 3 / Pages 121 to 130, Light. / ",
    "Test 1 / Pages 101 to 130, Light. / test",
    "Chapter 4 / Pages 131 to 140, Light. / ",
    "Chapter 5 / Pages 141 to 150, Light. / ",
    "Chapter 6 / Pages 151 to 160, Light. / ",
    "Test 2 / Pages 131 to 160, Light. / test",
  ]);
  assert.equal(tests.sentence, "60 pages at 10 a lesson = 6 reading lessons. Every 3rd lesson is a test: 2 tests, not graded, 8 rows in all. Reading lessons say 'Pages 101 to 110, Light.', then 'Pages 111 to 120, Light.', ...");
  assert.equal(H.patternFill({ pages: 50 }).count, 0);
  assert.equal(H.patternFill({ pages: 50 }).sentence, "How many pages make one lesson?");
  const lab = H.patternFill({ pages: 4, pagesPerLesson: 2, every: 2, everyKind: "Lab" });
  assert.deepEqual(lab.lessons.map((l) => l.title), ["Lesson 1", "Lesson 2", "Lab 1"]);
  assert.equal(lab.lessons[2].details, "Lab on pages 1-4.");
  assert.deepEqual(lab.lessons[2].tags, ["lab"], "a lab is only tagged");
  assert.equal(lab.lessons[2].pointsPossible, null);
});

// MARK: - Ready checks

const names = { [BLUE]: "Ann" };

test("readyChecks: the golden has no red items", () => {
  const items = H.readyChecks(golden(), { names, courseDefaults });
  assert.deepEqual(items.filter((i) => i.severity === "red"), []);
  assert.deepEqual(items.map((i) => i.code), [15], "Read-aloud sits on a 3rd grade lane with Show on transcript off");
});

test("readyChecks 1: a course with no name", () => {
  const week = golden();
  week.courses[0].name = "  ";
  const item = only(H.readyChecks(week), 1);
  assert.equal(item.severity, "red");
  assert.equal(item.message, "Give this block a name.");
  assert.equal(item.courseId, week.courses[0].courseId);
  assert.equal(item.fix, "course");
});

test("readyChecks 2: a course on no lane", () => {
  const week = golden();
  week.courses[2].laneIds = [];
  const item = only(H.readyChecks(week), 2);
  assert.equal(item.severity, "red");
  assert.equal(item.message, "Put this course on a child's color.");
  assert.equal(item.fix, "week");
});

test("readyChecks 3: a calendar course with no days", () => {
  const week = golden();
  week.courses[0].days = [];
  const item = only(H.readyChecks(week), 3);
  assert.equal(item.severity, "red");
  assert.equal(item.message, "Drag Math onto a day, or tap Every day.");
  week.courses[0].scheduleMode = "Loop";
  assert.deepEqual(byCode(H.readyChecks(week), 3), [], "a loop course with no days runs on every school day");
});

test("readyChecks 4: a lesson row with no title", () => {
  const week = golden();
  week.courses[0].lessons[1].title = "";
  const item = only(H.readyChecks(week), 4);
  assert.equal(item.severity, "red");
  assert.equal(item.message, "Row 2 in Math has no title. Add one or delete the row.");
  assert.equal(item.lessonIndex, 1);
  assert.equal(item.fix, "lessons");
  week.courses[0].lessons[1].include = false;
  assert.deepEqual(byCode(H.readyChecks(week), 4), [], "an unticked row is left out");
});

test("readyChecks 5: minutes outside 5 to 240, on the course or a row", () => {
  const week = golden();
  week.courses[0].minutes = 245;
  week.courses[2].lessons[1].minutes = 3;
  const items = byCode(H.readyChecks(week), 5);
  assert.equal(items.length, 2);
  assert.equal(items[0].message, "Minutes go from 5 to 240, in steps of 5.");
  assert.equal(items[1].message, "Minutes go from 5 to 240.");
  week.courses[0].minutes = 7;
  assert.equal(byCode(H.readyChecks(week), 5)[0].message, "Minutes go from 5 to 240, in steps of 5 (7 isn't one). Try 5 or 10.");
  week.courses[0].minutes = 245;
  assert.equal(items[1].lessonIndex, 1);
  week.courses[0].minutes = 32;
  assert.equal(byCode(H.readyChecks(week), 5).length, 2, "course minutes step by 5");
});

test("readyChecks 6: a graded lesson with no points", () => {
  const week = golden();
  week.courses[2].lessons[2].pointsPossible = null;
  const item = only(H.readyChecks(week), 6);
  assert.equal(item.severity, "red");
  assert.equal(item.message, "Quiz 1 · Cells counts toward the grade. How many points is it out of?");
  assert.equal(item.lessonIndex, 2);
});

test("readyChecks 7: more than 200 lessons in one course", () => {
  const week = golden();
  const uuid = uuidCounter();
  while (week.courses[0].lessons.length < 201) H.newLesson(week.courses[0], { uuid, title: `Lesson ${week.courses[0].lessons.length + 1}` });
  const item = only(H.readyChecks(week), 7);
  assert.equal(item.severity, "red");
  assert.equal(item.message, "Split this into two courses or remove some rows.");
  week.courses[0].lessons.pop();
  assert.deepEqual(byCode(H.readyChecks(week), 7), []);
});

test("readyChecks 8: a typed first name in a lesson's What to do box, a course's notes or name; whole words only", () => {
  const week = golden();
  week.courses[0].lessons[1].details = "Ann reads pages 17-32 aloud.";
  const item = only(H.readyChecks(week, { names }), 8);
  assert.equal(item.severity, "red");
  assert.equal(item.message, "Ann appears once: 1 lesson row in Math. Change it to the color, or say it isn't a name.");
  assert.equal(item.name, "Ann");
  assert.equal(item.count, 1);
  assert.equal(item.lessonIndex, 1);
  assert.equal(item.fix, "lessons");

  const notes = golden();
  notes.courses[2].notes = "Check with ANN's co-op teacher.";
  assert.equal(only(H.readyChecks(notes, { names }), 8).message, "Ann appears once: notes of Biology. Change it to the color, or say it isn't a name.");

  const named = golden();
  named.courses[1].name = "Ann and Ben read";
  assert.ok(only(H.readyChecks(named, { names: { [BLUE]: "Ann", [GREEN]: "Ben" } }), 8).message.match(/^(Ann|Ben) appears once: the name of .*\. Change it to the color, or say it isn't a name\.$/));

  const near = golden();
  near.courses[0].lessons[0].title = "Anna reads; Hannah draws; planning";
  near.courses[0].notes = "ann.";
  const items = byCode(H.readyChecks(near, { names }), 8);
  assert.equal(items.length, 1, "Anna and Hannah are not Ann; 'ann.' is");
  assert.deepEqual(byCode(H.readyChecks(golden(), { names: { [BLUE]: "" } }), 8), []);
  assert.deepEqual(byCode(H.readyChecks(golden()), 8), []);
});

test("readyChecks 9: text over its limit and a file over 5 MB", () => {
  const week = golden();
  week.courses[0].lessons[0].title = "x".repeat(201);
  week.courses[0].notes = "y".repeat(4001);
  week.courses[2].lessons[0].details = "z".repeat(4001);
  const items = byCode(H.readyChecks(week), 9);
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.severity === "red"));
  assert.equal(items[0].message, "Math's notes are over 4,000 characters.");
  assert.equal(items[1].message, "Row 1 in Math has a title over 200 characters.");
  assert.equal(items[1].lessonIndex, 0);
  assert.equal(items[2].message, "Row 1 in Biology has a What to do box over 4,000 characters.");

  const huge = golden();
  const uuid = uuidCounter();
  for (let c = 0; c < 7; c += 1) {
    const course = H.newCourse(huge, { laneIds: [BLUE], defaults: { name: `Reading ${c + 1}`, subject: "Language Arts", perWeek: 5, minutes: 30 }, uuid });
    for (let i = 0; i < 200; i += 1) H.newLesson(course, { uuid, title: `Lesson ${i + 1}`, details: "w".repeat(4000) });
  }
  const big = byCode(H.readyChecks(huge), 9);
  assert.equal(big.length, 1);
  assert.equal(big[0].severity, "red");
  assert.match(big[0].message, /over 5 MB/);
});

test("readyChecks 10: a course with no lessons", () => {
  const week = golden();
  week.courses[1].lessons = [];
  const item = only(H.readyChecks(week), 10);
  assert.equal(item.severity, "yellow");
  assert.equal(item.message, "Read-aloud has no lessons. That's fine for planning as you go: Today will ask \u201cWhat did you do in Read-aloud?\u201d");
  const unticked = golden();
  unticked.courses[1].lessons.forEach((l) => { l.include = false; });
  assert.equal(only(H.readyChecks(unticked), 10).code, 10, "every row unticked is the same as none");
});

// MARK: - Quarry's batch for PR #2 (October 6, 2026)

test("parseFile with draft: a safety copy whose calendar course has no days still opens (BUG-20261006-8)", () => {
  const week = golden();
  week.courses[0].days = [];
  const text = H.serialize(week, { updatedAt: week.updatedAt });
  const plain = H.parseFile(text);
  assert.equal(plain.ok, false, "a finished file still needs days");
  assert.equal(plain.errors[0].keyword, "days");
  const draft = H.parseFile(text, { draft: true });
  assert.equal(draft.ok, true);
  assert.equal(draft.warnings.filter((w) => w.code === "noDays").length, 1);
  assert.equal(draft.week.courses[0].days.length, 0, "the file is opened as it is; check 3 catches the missing day");
  assert.equal(only(H.readyChecks(draft.week), 3).severity, "red");
});

test("parseFile settles unknown values to the app's defaults, so a newer-minor file downloads again (BUG-20261006-9)", () => {
  const text = sample("newer-minor-1.7-unknown-fields.hssweek");
  const kept = H.parseFile(text);
  assert.equal(kept.ok, true);
  assert.ok(kept.warnings.length >= 1, "without the option the unknown values stay as written (A2)");
  const result = H.parseFile(text, { settleUnknown: true });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, kept.warnings.length, "each settled value is said");
  for (const w of result.warnings) assert.match(w.message, /as the app would\.$/);
  const again = H.serialize(result.week, { updatedAt: result.week.updatedAt });
  assert.deepEqual(H.validate(JSON.parse(again)).errors, [], "the settled week passes the format check");
  const out = JSON.parse(again);
  assert.ok(out.courses.every((c) => H.SUBJECTS.includes(c.subject)));
  assert.ok(out.courses.every((c) => c.resources.every((r) => H.RESOURCE_KINDS.includes(r.kind))));
  assert.ok(out.courses.every((c) => c.lessons.every((l) => l.tags.every((t) => H.TAGS.includes(t)))));
});

test("bulkEditPreview on the unit moves the title along, with one undo (BUG-20261006-14)", () => {
  const week = golden();
  const course = week.courses[0];
  course.lessons.forEach((l, i) => { l.unit = "Decimals"; l.title = `Lesson ${i + 41} \u00b7 Decimals`; });
  const before = course.lessons.map((l) => l.title);
  const preview = H.bulkEditPreview(course, { field: "unit", from: 1, to: course.lessons.length, value: "Rates" });
  assert.equal(preview.changes.length, course.lessons.length);
  assert.equal(preview.changes[0].titleAfter, "Lesson 41 \u00b7 Rates");
  const undo = H.applyBulkEdit(course, preview);
  assert.ok(course.lessons.every((l) => l.unit === "Rates" && l.title.endsWith(" \u00b7 Rates") && !l.title.includes("Decimals")));
  H.undoBulkEdit(course, undo);
  assert.deepEqual(course.lessons.map((l) => l.title), before);
  assert.ok(course.lessons.every((l) => l.unit === "Decimals"));
  const cleared = H.bulkEditPreview(course, { field: "unit", from: 1, to: 2, value: "" });
  assert.equal(cleared.changes[0].titleAfter, "Lesson 41", "a blank unit takes the suffix off");
});

test("planSummary, lessonFooter and lessonsAddedLine: the words Review, the table footer and the added moment use", () => {
  const week = golden();
  assert.match(H.planSummary(week), /^Blue and Green: 3 courses, \d+ lessons\.$/);
  const one = H.newWeek({ uuid: uuidCounter() });
  assert.equal(H.planSummary(one), "No one yet: 0 courses, 0 lessons.");
  const course = week.courses[0];
  const n = course.lessons.length;
  assert.equal(H.lessonFooter({ lessons: [] }), "No lessons yet.");
  assert.equal(H.lessonFooter(course), `${n} lessons, all included.`);
  course.lessons[0].include = false;
  assert.equal(H.lessonFooter(course), `${n - 1} of ${n} lessons included.`);
  assert.doesNotMatch(H.lessonFooter(course), /rows|ticked/);
  const rows = Array.from({ length: 36 }, (_, i) => ({ title: `Lesson ${i + 1}` }));
  assert.equal(H.lessonsAddedLine(rows, { perWeek: 5 }), "36 lessons added: Lesson 1 to Lesson 36. About 8 teaching weeks at 5 a week.");
  assert.equal(H.lessonsAddedLine([{ title: "Fractions" }, { title: "Decimals" }, { title: "Percents" }, { title: "Ratios" }], { perWeek: 0 }), "4 lessons added: Fractions to Ratios.");
  assert.equal(H.lessonsAddedLine([{ title: "Only one" }], { perWeek: 3 }), "1 lesson added: Only one. About 1 teaching week at 3 a week.");
});

test("COPY.todayAsks is the product-facts line, with the course's own name", () => {
  assert.equal(H.COPY.todayAsks("Language Arts"), "Today will ask \u201cWhat did you do in Language Arts?\u201d");
});

test("the sample starters are valid weeks of kind sample, with colors for lanes and no claims, names or exclamations", () => {
  const startersDir = join(builderDir, "starters");
  const files = readdirSync(startersDir).filter((f) => f.endsWith(".hssweek"));
  assert.ok(files.length >= 2);
  for (const file of files) {
    const text = read(join(startersDir, file));
    const result = H.parseFile(text);
    assert.equal(result.ok, true, `${file} parses`);
    assert.deepEqual(result.warnings, [], `${file} has nothing unknown`);
    assert.equal(result.week.source.kind, "sample", `${file} says it is a sample`);
    const again = H.serialize(result.week, { updatedAt: result.week.updatedAt });
    assert.equal(JSON.parse(again).source.kind, "sample", "download keeps the kind");
    assert.deepEqual(H.validate(JSON.parse(again)).errors, []);
    assert.doesNotMatch(text, /!|free trial|\p{Extended_Pictographic}/u, `${file} has no exclamation, trial talk or emoji`);
    assert.doesNotMatch(text, /Slate/, `${file} never says Slate`);
    const names = H.readyChecks(result.week, { names: { x: "Ada", y: "Ben", z: "Ivy" } }).filter((i) => i.code === 8);
    assert.deepEqual(names, [], `${file} passes the name check`);
    assert.ok(result.week.lanes.every((l) => H.LANE_COLORS.some((c) => c.name === l.color)));
  }
});

test("readyChecks 11: a block on a grayed-out day", () => {
  const week = golden();
  week.courses[2].days = ["mon", "wed", "fri"];
  const item = only(H.readyChecks(week), 11);
  assert.equal(item.severity, "yellow");
  assert.equal(item.message, "Wednesday is grayed out (Co-op) but Biology is on it.");
  week.week.days[2].label = "";
  assert.equal(only(H.readyChecks(week), 11).message, "Wednesday is grayed out but Biology is on it.");
});

test("readyChecks 12: a lane's day over 6 hours", () => {
  const week = golden();
  week.courses[0].minutes = 240;
  H.newCourse(week, { laneIds: [BLUE], defaults: { name: "Science", subject: "Science", perWeek: 5, minutes: 240 }, uuid: uuidCounter() });
  const items = byCode(H.readyChecks(week), 12);
  assert.deepEqual(items.map((i) => i.message), ["Blue's Monday adds up to 8 h.", "Blue's Tuesday adds up to 8 h 20 m.", "Blue's Thursday adds up to 8 h 20 m.", "Blue's Friday adds up to 8 h."]);
  assert.ok(items.every((i) => i.severity === "yellow" && i.laneId === BLUE && i.fix === "week"));
  assert.deepEqual(byCode(H.readyChecks(golden()), 12), []);
});

test("readyChecks 13: two courses with the same name in one lane", () => {
  const week = golden();
  H.newCourse(week, { laneIds: [BLUE], defaults: { name: "math", subject: "Math", perWeek: 2, minutes: 20 }, uuid: uuidCounter() });
  const item = only(H.readyChecks(week), 13);
  assert.equal(item.severity, "yellow");
  assert.equal(item.message, "Blue has two courses called Math.");
  assert.equal(item.laneId, BLUE);
});

test("readyChecks 14: a calendar course that runs long", () => {
  const week = golden();
  const uuid = uuidCounter();
  const history = H.newCourse(week, { laneIds: [GREEN], defaults: { name: "History", subject: "Social Studies", perWeek: 3, minutes: 40 }, uuid });
  for (let i = 0; i < 180; i += 1) H.newLesson(history, { uuid, title: `Chapter ${i + 1}` });
  const item = only(H.readyChecks(week), 14);
  assert.equal(item.severity, "yellow");
  assert.equal(item.message, "180 lessons at 3 a week is about 60 weeks.");
  history.lessons.length = 120;
  assert.deepEqual(byCode(H.readyChecks(week), 14), [], "40 weeks is a school year");
});

test("readyChecks 15: transcript fields set on a lane below 9th grade", () => {
  const week = golden();
  week.courses[0].level = "Honors";
  const item = byCode(H.readyChecks(week), 15).find((i) => i.courseName === "Math");
  assert.ok(item);
  assert.equal(item.severity, "yellow");
  assert.equal(item.message, "Saved, but the app only shows transcript fields from 9th grade.");
  const biology = golden().courses[2];
  biology.level = "Honors";
  const high = golden();
  high.courses[2] = biology;
  assert.ok(!byCode(H.readyChecks(high), 15).some((i) => i.courseName === "Biology"), "a 9th grade lane shows them");
});

test("readyChecks lists red items before yellow ones", () => {
  const week = golden();
  week.courses[1].lessons = [];
  week.courses[2].name = "";
  const items = H.readyChecks(week);
  const firstYellow = items.findIndex((i) => i.severity === "yellow");
  assert.ok(firstYellow > 0);
  assert.ok(items.slice(firstYellow).every((i) => i.severity === "yellow"));
});

// MARK: - Preview

test("previewDay: a course that lands on the day with no lesson for it is reported as landing", () => {
  const week = golden();
  const math = week.courses.find((c) => c.name === "Math");
  math.lessons = [];
  const mon = H.previewDay(week, BLUE, "mon");
  assert.equal(mon.rows.length, 0);
  assert.deepEqual(mon.landing, ["Math"], "no rows, so Math lands but has nothing to show");
  const far = H.previewDay(golden(), BLUE, "mon", { weekIndex: 40 });
  assert.deepEqual(far.landing, [], "past the last row is not a gap");
  assert.deepEqual(far.finished, ["Math"], "past the last row the course is finished");
  const farDated = H.previewDay(golden(), BLUE, "mon", { weekIndex: 40, startOn: "2026-10-12" });
  assert.deepEqual(farDated.finishedDetails, [{ courseName: "Math", lessonNumber: 4, date: "2026-10-16", day: "fri" }], "golden Math: 4 rows on Mon/Tue/Thu/Fri from October 12 end Friday the 16th");
  assert.deepEqual(H.previewDay(golden(), BLUE, "mon").landing, [], "a lesson on the day is a row, not a landing note");
});

test("previewDay: a calendar lesson on its day, a Together card, totals (golden, Blue, week 1)", () => {
  const week = golden();
  const tue = H.previewDay(week, BLUE, "tue");
  assert.equal(tue.away, null);
  assert.equal(tue.rows.length, 1);
  assert.deepEqual(tue.rows[0], { courseId: week.courses[0].courseId, courseName: "Math", subject: "Math", title: "Lesson 2 · Place value", details: "Read pages 17-32. Do the odd problems on page 32.", minutes: 30, nextUp: false });
  assert.equal(tue.together.length, 1);
  assert.deepEqual(tue.together[0], { courseId: week.courses[1].courseId, courseName: "Read-aloud", subject: "Language Arts", title: "Chapter 1", details: "Listen, then tell back the chapter in your own words.", minutes: 20, nextUp: true, colors: ["Blue", "Green"] });
  assert.equal(tue.totalMinutes, 50);

  assert.equal(H.previewDay(week, BLUE, "mon").rows[0].title, "Lesson 1 · Place value");
  const thu = H.previewDay(week, BLUE, "thu");
  assert.equal(thu.rows[0].title, "Lesson 3 · Place value");
  assert.equal(thu.rows[0].minutes, 35, "a row's own minutes win");
  assert.equal(thu.totalMinutes, 55);
  assert.equal(H.previewDay(week, BLUE, "fri").rows[0].title, "Quiz 1");
  assert.deepEqual(H.previewDay(week, BLUE, "mon").together, [], "Read-aloud is Tue/Thu");

  const green = H.previewDay(week, GREEN, "mon");
  assert.deepEqual(green.rows.map((r) => r.title), ["Module 1 · Cells"]);
  assert.equal(green.totalMinutes, 45);
  assert.equal(H.previewDay(week, GREEN, "thu").rows[0].title, "Lab 1 · Onion cells");
  assert.equal(H.previewDay(week, GREEN, "thu").totalMinutes, 80);
  assert.equal(H.previewDay(week, GREEN, "tue").rows.length, 0, "Biology is Mon/Thu/Fri");
  assert.equal(H.previewDay(week, GREEN, "tue").together[0].title, "Chapter 1");
});

test("previewDay: week 2 counts on, only the course's days, from Start at lesson, ticked rows only", () => {
  const week = golden();
  const uuid = uuidCounter();
  for (let i = 5; i <= 12; i += 1) H.newLesson(week.courses[0], { uuid, title: `Lesson ${i}` });
  assert.equal(H.previewDay(week, BLUE, "mon", { weekIndex: 1 }).rows[0].title, "Lesson 5");
  assert.equal(H.previewDay(week, BLUE, "fri", { weekIndex: 1 }).rows[0].title, "Lesson 8");
  assert.equal(H.previewDay(week, BLUE, "mon", { weekIndex: 2 }).rows[0].title, "Lesson 9");
  assert.equal(H.previewDay(week, BLUE, "mon", { weekIndex: 3 }).rows.length, 0, "the course is finished");
  assert.equal(H.previewDay(golden(), BLUE, "mon", { weekIndex: 1 }).rows.length, 0);

  week.courses[0].startAtLesson = 3;
  assert.equal(H.previewDay(week, BLUE, "mon").rows[0].title, "Lesson 3 · Place value");
  week.courses[0].lessons[3].include = false; // Quiz 1 unticked
  assert.equal(H.previewDay(week, BLUE, "tue").rows[0].title, "Lesson 5");

  const dated = H.previewDay(week, BLUE, "thu", { weekIndex: 1, startOn: "2026-10-12" });
  assert.equal(dated.date, "2026-10-22");
});

test("previewDay: a loop course shows its next lesson on its days, or on every shown day when it has none", () => {
  const week = golden();
  assert.equal(H.previewDay(week, GREEN, "thu").together[0].nextUp, true);
  assert.equal(H.previewDay(week, GREEN, "thu", { weekIndex: 7 }).together[0].title, "Chapter 1", "the preview cannot know what was checked off");
  week.courses[1].days = [];
  assert.equal(H.previewDay(week, GREEN, "mon").together[0].title, "Chapter 1");
  assert.equal(H.previewDay(week, GREEN, "wed").together.length, 0, "Wednesday is grayed out");
  week.courses[1].laneIds = [GREEN];
  const solo = H.previewDay(week, GREEN, "mon");
  assert.deepEqual(solo.together, []);
  assert.deepEqual(solo.rows.map((r) => `${r.courseName}:${r.nextUp}`), ["Read-aloud:true", "Biology:false"], "course order (Read-aloud is the second course), then lesson order");
  week.courses[1].lessons = [];
  assert.deepEqual(H.previewDay(week, GREEN, "mon").rows.map((r) => r.courseName), ["Biology"], "a loop with nothing left shows nothing");
});

test("previewDay: a grayed-out day is an away day with its label and no rows", () => {
  const week = golden();
  week.courses[0].days.push("wed");
  assert.deepEqual(H.previewDay(week, BLUE, "wed"), { away: { label: "Co-op" }, rows: [], together: [], totalMinutes: 0, landing: [], finished: [], finishedDetails: [] });
  assert.deepEqual(H.previewDay(week, BLUE, "sat"), { away: null, rows: [], together: [], totalMinutes: 0, landing: [], finished: [], finishedDetails: [] }, "a day not on the grid");
  assert.equal(H.previewDay(week, BLUE, "thu").rows[0].title, "Lesson 3 · Place value", "a grayed day does not take a lesson");
});

test("dayMinutes adds up every block a lane carries on a day", () => {
  const week = golden();
  assert.equal(H.dayMinutes(week, BLUE, "mon"), 30);
  assert.equal(H.dayMinutes(week, BLUE, "tue"), 50);
  assert.equal(H.dayMinutes(week, BLUE, "wed"), 0);
  assert.equal(H.dayMinutes(week, GREEN, "mon"), 45);
  assert.equal(H.dayMinutes(week, GREEN, "tue"), 20);
  assert.equal(H.dayMinutes(week, GREEN, "thu"), 65);
  week.courses[1].days = [];
  assert.equal(H.dayMinutes(week, GREEN, "mon"), 65, "a loop with no days is on every school day");
  assert.equal(H.dayMinutes(week, GREEN, "wed"), 0, "but not a grayed one");
});

// MARK: - Estimated finish

test("estimatedFinish: calendar course from its start date, counting only its days", () => {
  const week = golden();
  assert.deepEqual(H.estimatedFinish(week.courses[0]), { date: "2026-10-16", text: "about Friday, October 16, 2026" });
  assert.deepEqual(H.estimatedFinish(week.courses[2], { startOn: "2026-10-12" }), { date: "2026-10-16", text: "about Friday, October 16, 2026" });
  const uuid = uuidCounter();
  const history = H.newCourse(week, { laneIds: [GREEN], defaults: { name: "History", subject: "Social Studies", perWeek: 3, minutes: 40 }, uuid });
  assert.deepEqual(history.days, ["mon", "thu", "fri"], "three a week from the golden's Mon/Tue/Thu/Fri");
  history.days = ["mon", "wed", "fri"];
  for (let i = 0; i < 36; i += 1) H.newLesson(history, { uuid, title: `Chapter ${i + 1}` });
  assert.deepEqual(H.estimatedFinish(history, { startOn: "2026-10-12" }), { date: "2027-01-01", text: "about Friday, January 1, 2027" });
  history.startAtLesson = 34;
  assert.deepEqual(H.estimatedFinish(history, { startOn: "2026-10-12" }), { date: "2026-10-16", text: "about Friday, October 16, 2026" });
  history.startAtLesson = 1;
  assert.deepEqual(H.estimatedFinish(history, { startOn: "2026-10-13" }), { date: "2027-01-04", text: "about Monday, January 4, 2027" }, "a Tuesday start waits for Wednesday");
});

test("estimatedFinish: default start is the next Monday after today", () => {
  const math = golden().courses[0];
  math.startDate = null;
  assert.deepEqual(H.estimatedFinish(math, { today: new Date(2026, 9, 5) }), { date: "2026-10-16", text: "about Friday, October 16, 2026" }, "Monday October 5 starts next Monday");
  assert.deepEqual(H.estimatedFinish(math, { today: new Date(2026, 9, 4) }), { date: "2026-10-09", text: "about Friday, October 9, 2026" }, "Sunday October 4 starts tomorrow");
  assert.equal(H.nextMonday(new Date(2026, 9, 7)), "2026-10-12");
  assert.equal(H.nextMonday("2026-10-11"), "2026-10-12");
  assert.equal(H.longDate("2027-02-26"), "Friday, February 26, 2027");
});

test("estimatedFinish: spread over the year and loop courses have no date", () => {
  const week = golden();
  week.courses[0].spreadOverYear = true;
  assert.deepEqual(H.estimatedFinish(week.courses[0]), { date: null, text: "Spread to fit your school year (the app works out the days)." });
  assert.deepEqual(H.estimatedFinish(week.courses[1]), { date: null, text: "No finish date. About 1 week at 2 days a week." });
  const uuid = uuidCounter();
  for (let i = 3; i <= 24; i += 1) H.newLesson(week.courses[1], { uuid, title: `Chapter ${i}` });
  assert.deepEqual(H.estimatedFinish(week.courses[1]), { date: null, text: "No finish date. About 12 weeks at 2 days a week." });
  week.courses[1].days = [];
  assert.deepEqual(H.estimatedFinish(week.courses[1]), { date: null, text: "No finish date. About 5 weeks at 5 days a week." });
  week.courses[2].days = [];
  assert.equal(H.estimatedFinish(week.courses[2]).date, null);
  week.courses[2].days = ["mon"];
  week.courses[2].lessons = [];
  assert.equal(H.estimatedFinish(week.courses[2]).date, null);
});

// MARK: - Copy down

test("copyDown: {n} and page numbers keep counting; the source rows are untouched", () => {
  const week = golden();
  const rows = week.courses[0].lessons;
  const before = JSON.stringify(rows);
  const out = H.copyDown(rows, 0, 2);
  assert.equal(JSON.stringify(rows), before, "pure");
  assert.equal(out[0], rows[0]);
  assert.equal(out[3], rows[3]);
  assert.equal(out[1].title, "Lesson 2 · Place value");
  assert.equal(out[1].details, "Read pages 17-32. Do the odd problems on page 32.", "matches the golden's own second lesson");
  assert.equal(out[2].title, "Lesson 3 · Place value");
  assert.equal(out[2].details, "Read pages 33-48. Do the odd problems on page 48.");
  assert.equal(out[1].lessonId, rows[1].lessonId, "ids stay");
  assert.equal(out[2].minutes, 35, "other cells stay");

  const tokens = [{ title: "Lesson {n}", details: "Page {n}." }, { title: "a", details: "b" }, { title: "c", details: "d" }];
  assert.deepEqual(H.copyDown(tokens, 0).map((r) => `${r.title} / ${r.details}`), ["Lesson {n} / Page {n}.", "Lesson 2 / Page 2.", "Lesson 3 / Page 3."]);

  const dash = [{ title: "Chapter 3 · Cells", details: "Read pp. 40–47 and section 2.1." }, { title: "", details: "" }];
  assert.deepEqual(H.copyDown(dash, 0, 1)[1], { title: "Chapter 4 · Cells", details: "Read pp. 48–55 and section 2.1." });

  const minutes = [{ title: "A", minutes: 45, tags: ["lab"] }, { title: "B", minutes: null, tags: [] }];
  const onlyMinutes = H.copyDown(minutes, 0, 1, "minutes");
  assert.deepEqual(onlyMinutes[1], { title: "B", minutes: 45, tags: [] });
  const onlyTags = H.copyDown(minutes, 0, 1, "tags");
  assert.deepEqual(onlyTags[1].tags, ["lab"]);
  assert.notEqual(onlyTags[1].tags, minutes[0].tags, "copied, not shared");
  assert.deepEqual(H.copyDown(minutes, 5, 9), minutes);
});

// MARK: - Table of contents edge cases (SlateTests tableOfContentsLinesBecomeTitles)

test("cleanLine matches CurriculumImport.cleanLine on the Swift test's cases", () => {
  assert.equal(H.cleanLine("Contents"), null);
  assert.equal(H.cleanLine("Table of Contents"), null);
  assert.equal(H.cleanLine("Contents (continued)"), null);
  assert.equal(H.cleanLine("   "), null);
  assert.equal(H.cleanLine("Lesson 7: Fractions, part 2"), "Fractions, part 2");
  assert.equal(H.cleanLine("Module 3"), null, "nothing left once the label is stripped");
  assert.equal(H.cleanLine("Year 1066"), "Year 1066", "a real title that ends in a number stays");
  assert.equal(H.cleanLine("1. The Nile River ........ 3"), "The Nile River");
  assert.equal(H.cleanLine("2) Sumer and the First Cities 11"), "Sumer and the First Cities");
  assert.equal(H.cleanLine("Chapter 3: Old Kingdom Egypt — 19"), "Old Kingdom Egypt");
  assert.equal(H.cleanLine("• Nomads of the Steppe"), "Nomads of the Steppe");
  assert.equal(H.cleanLine("- The First Writing\t27"), "The First Writing");
  assert.equal(H.cleanLine("Lesson 12 The Hebrews"), "The Hebrews");
  assert.equal(H.cleanLine("14"), null);
  assert.equal(H.cleanLine("iv"), null);
  assert.equal(H.cleanLine("xii"), null);
  assert.equal(H.cleanLine("Unit 2. India and China 40"), "India and China");
  assert.equal(H.cleanLine("Glossary ..... 72"), null);
  assert.equal(H.cleanLine("Index"), null);
  assert.equal(H.cleanLine("Something to Do"), null);
  assert.equal(H.cleanLine("4.1 Birds in Your Backyard 74"), "Birds in Your Backyard");
  assert.equal(H.cleanLine("Contents  iv"), null);
  assert.equal(H.cleanLine("Fractions –"), "Fractions");
  assert.equal(H.cleanLine("3 - 4"), null, "no letters left");
  assert.equal(H.cleanLine(null), null);
});

test("readyChecks 8 groups a name in many rows into one item with a count", () => {
  const week = golden();
  const names = { [BLUE]: "Ann" };
  const math = week.courses.find((c) => c.name === "Math");
  for (const lesson of math.lessons) lesson.title = `Ann does ${lesson.title}`;
  const items = H.readyChecks(week, { names }).filter((i) => i.code === 8);
  assert.equal(items.length, 1, "one item for the name, not one per row");
  assert.equal(items[0].count, math.lessons.length);
  assert.equal(items[0].lessonIndex, 0);
  assert.ok(items[0].message.startsWith(`Ann appears ${math.lessons.length} times: ${math.lessons.length} lesson rows in Math.`), items[0].message);
  assert.deepEqual(H.readyChecks(week, { names, allow: ["ann"] }).filter((i) => i.code === 8), [], "allowed names are not reported");
  const changes = H.nameReplacements(week, "Ann", "Blue");
  assert.equal(changes.length, math.lessons.length);
  assert.equal(changes[0].after, `Blue does ${golden().courses.find((c) => c.name === "Math").lessons[0].title}`);
  assert.equal(H.applyNameReplacement(week, "Ann", "Blue"), math.lessons.length);
  assert.deepEqual(H.readyChecks(week, { names }).filter((i) => i.code === 8), [], "after the replacement nothing is left");
});

test("estimatedFinish with the week: grayed-out days do not count, and a course with none left says so", () => {
  const week = golden();
  const history = week.courses.find((c) => c.name === "Math");
  history.days = ["wed"];
  assert.deepEqual(H.estimatedFinish(history, { startOn: "2026-10-12", week }), { date: null, text: "No day to run on: Wednesday is grayed out." });
  history.days = ["mon", "wed"];
  const withWeek = H.estimatedFinish(history, { startOn: "2026-10-12", week });
  const without = H.estimatedFinish(history, { startOn: "2026-10-12" });
  assert.ok(withWeek.date > without.date, "losing Wednesday pushes the finish later");
});

test("literalLines keeps every line as written, page numbers off the end", () => {
  const rows = H.literalLines("Lesson 1: Fractions .... 4\nHands-on practice .... 9\nLesson 2: Measurement .... 12\nFinal project .... 20\n\n1. Week 1: Read and narrate");
  assert.deepEqual(rows.map((r) => r.title), ["Lesson 1: Fractions", "Hands-on practice", "Lesson 2: Measurement", "Final project", "1. Week 1: Read and narrate"]);
  assert.deepEqual(H.parseContents("Lesson 1: Fractions .... 4\nHands-on practice .... 9").map((r) => r.title), ["Fractions"], "the tidy reading still keeps only numbered lessons");
});

test("explainContents says what happened to every pasted line", () => {
  const four = H.explainContents("Lesson 1: Fractions .... 4\nHands-on practice .... 9\nLesson 2: Measurement .... 12\nFinal project .... 20");
  assert.deepEqual(four.map((e) => [e.status, e.title ?? e.reason, e.literal]), [
    ["changed", "Fractions", "Lesson 1: Fractions"],
    ["left out", "not numbered", "Hands-on practice"],
    ["changed", "Measurement", "Lesson 2: Measurement"],
    ["left out", "not numbered", "Final project"],
  ]);
  const weeks = H.explainContents("1. Week 1: Read and narrate\n6. Week 2: Read and narrate");
  assert.deepEqual(weeks.map((e) => [e.status, e.title, e.literal]), [["changed", "Read and narrate", "1. Week 1: Read and narrate"], ["changed", "Read and narrate", "6. Week 2: Read and narrate"]]);
  assert.deepEqual(H.explainContents("Apples\nPears").map((e) => e.status), ["added", "added"], "plain lines are added as they are");
  assert.equal(H.explainContents("Unit 1: Lessons 1-5\nTopic A"), null, "unit layouts are not explained line by line");
});

test("dayWorkload: own, together and combined minutes for a child on a day, shared counted once", () => {
  const week = golden();
  // Blue on Tuesday: Math is Mon/Tue/Thu/Fri (30, own); Read-aloud Tue/Thu is shared with Green (20, together).
  assert.deepEqual(H.dayWorkload(week, BLUE, "tue"), { own: 30, together: 20, combined: 50 });
  assert.deepEqual(H.dayWorkload(week, GREEN, "tue"), { own: 0, together: 20, combined: 20 }, "Biology is Mon/Thu/Fri");
  assert.deepEqual(H.dayWorkload(week, BLUE, "wed"), { own: 0, together: 0, combined: 0 });
});

test("courseSpan and pacingSentence", () => {
  const week = golden();
  const math = week.courses.find((c) => c.name === "Math");
  assert.deepEqual(H.courseSpan(math), { count: 4, first: "Lesson 1 · Place value", last: "Quiz 1" });
  assert.equal(H.pacingSentence(math), "4 lessons at 4 days a week is about 1 teaching week.");
  math.lessons = Array.from({ length: 144 }, (_, i) => ({ ...math.lessons[0], lessonId: `l${i}`, title: `L${i + 1}` }));
  assert.equal(H.pacingSentence(math), "144 lessons at 4 days a week is about 36 teaching weeks.");
  week.week.days.find((d) => d.day === "mon").on = false;
  assert.equal(H.pacingSentence(math, week), "144 lessons at 3 days a week is about 48 teaching weeks.", "grayed days do not count");
  math.days = [];
  assert.equal(H.pacingSentence(math), "144 lessons. Put it on a day to see how many weeks that is.");
  assert.equal(H.pacingSentence({ ...math, lessons: [] }), "");
  assert.equal(H.COPY.addOnly, "Import adds new courses and lessons. It doesn't update ones already in the app.");
});

test("duplicateCourse: fresh ids everywhere, categories remapped, the original untouched", () => {
  const week = golden();
  const bio = week.courses.find((c) => c.name === "Biology");
  const catId = "0f5a5c3e-1b2d-4c6e-8f90-1234567890ab";
  bio.categories = [{ categoryId: catId, name: "Quizzes", weight: 40 }];
  bio.lessons[2].categoryId = catId;
  const before = JSON.stringify(bio);
  const uuid = () => crypto.randomUUID();
  const copy = H.duplicateCourse(week, bio.courseId, { laneIds: [BLUE], uuid });
  assert.equal(JSON.stringify(bio), before, "the original is unchanged");
  assert.notEqual(copy.courseId, bio.courseId);
  assert.deepEqual(copy.laneIds, [BLUE]);
  assert.ok(copy.lessons.every((l, i) => l.lessonId !== bio.lessons[i].lessonId));
  assert.ok(copy.resources.every((r, i) => r.resourceId !== bio.resources[i].resourceId));
  assert.equal(copy.categories[0].categoryId, copy.lessons[2].categoryId, "the lesson points at the copied category");
  assert.notEqual(copy.categories[0].categoryId, catId);
  assert.equal(week.courses.length, 4);
  copy.lessons[0].title = "Changed";
  assert.notEqual(bio.lessons[0].title, "Changed");
  const { errors } = H.validate(JSON.parse(H.serialize(week)));
  assert.deepEqual(errors, [], "the week with its copy still validates");
});

test("bulk edit: preview shows the range and count, apply changes only those rows, undo restores exact values", () => {
  const week = golden();
  const math = week.courses.find((c) => c.name === "Math");
  math.lessons = Array.from({ length: 40 }, (_, i) => ({ ...math.lessons[0], lessonId: `l${i}`, title: `Lesson ${i + 1}`, minutes: null, unit: null }));
  const preview = H.bulkEditPreview(math, { field: "minutes", from: 21, to: 40, value: 25 });
  assert.deepEqual([preview.from, preview.to, preview.changes.length], [21, 40, 20]);
  const undo = H.applyBulkEdit(math, preview);
  assert.equal(math.lessons[19].minutes, null, "row 20 untouched");
  assert.equal(math.lessons[20].minutes, 25);
  assert.equal(math.lessons[39].minutes, 25);
  assert.equal(H.undoBulkEdit(math, undo), 20);
  assert.ok(math.lessons.every((l) => l.minutes === null), "undo restores the exact old values");
  const titles = H.bulkEditPreview(math, { field: "title", from: 1, to: 3, value: "Day {n}: {title}" });
  assert.deepEqual(titles.changes.map((c) => c.after), ["Day 1: Lesson 1", "Day 2: Lesson 2", "Day 3: Lesson 3"]);
  const unit = H.bulkEditPreview(math, { field: "unit", from: 5, to: 8, value: "Fractions" });
  assert.equal(unit.changes.length, 4);
  H.applyBulkEdit(math, unit);
  assert.equal(math.lessons[8].unit, null, "stops where told");
  assert.equal(H.bulkEditPreview(math, { field: "unit", from: 5, to: 8, value: "Fractions" }).changes.length, 0, "already equal rows are not changes");
  assert.throws(() => H.bulkEditPreview(math, { field: "tags", from: 1, to: 2, value: "x" }));
});

test("retitleForUnit never doubles the unit", () => {
  assert.equal(H.retitleForUnit("Lesson 3", null, "Fractions"), "Lesson 3 · Fractions");
  assert.equal(H.retitleForUnit("Lesson 3 · Fractions", null, "Fractions"), "Lesson 3 · Fractions");
  assert.equal(H.retitleForUnit("Lesson 3 · Fractions", "Fractions", "Decimals"), "Lesson 3 · Decimals");
  assert.equal(H.retitleForUnit("Lesson 3 · Fractions", "Fractions", null), "Lesson 3");
});

test("coopPack: only the chosen courses, their lanes with null grades, source coop; validates; ids kept", () => {
  const week = golden();
  const bio = week.courses.find((c) => c.name === "Biology");
  const read = week.courses.find((c) => c.name === "Read-aloud");
  const pack = H.coopPack(week, [bio.courseId, read.courseId], { now: new Date("2026-10-06T15:00:00-04:00") });
  assert.equal(pack.source.kind, "coop");
  assert.deepEqual(pack.courses.map((c) => c.name), ["Read-aloud", "Biology"], "file order kept");
  assert.ok(pack.lanes.every((l) => l.grade === null));
  assert.equal(pack.lanes.length, 2, "both lanes are used by Read-aloud");
  assert.equal(pack.courses[1].courseId, bio.courseId, "ids are kept so a second open adds nothing");
  assert.equal(pack.courses[1].lessons[0].lessonId, bio.lessons[0].lessonId);
  const { errors } = H.validate(JSON.parse(H.serialize(pack)));
  assert.deepEqual(errors, []);
  assert.equal(H.coopFileName(pack), "Co-op courses 2026-27.hssweek");
  assert.ok(!JSON.stringify(pack).includes("Math"), "a course not chosen is not in the pack");
  assert.throws(() => H.coopPack(week, []));
  const onlyBio = H.coopPack(week, [bio.courseId]);
  assert.equal(onlyBio.lanes.length, 1, "only the lanes the chosen courses use");
});

test("shareLink and starterFromHash: the starter rides in the fragment and round-trips", async () => {
  const week = golden();
  const link = await H.shareLink(week, "https://myhomeschoolscribe.com/course-builder/");
  assert.ok(link.startsWith("https://myhomeschoolscribe.com/course-builder/#s="));
  const starter = H.starterFromHash(new URL(link).hash);
  assert.ok(starter && starter.length < 2000);
  const back = await H.fromStarter(starter, { uuid: () => crypto.randomUUID() });
  assert.deepEqual(back.courses.map((c) => c.name), week.courses.map((c) => c.name));
  assert.ok(back.courses.every((c) => c.lessons.length === 0), "no lesson text in a link");
  assert.equal(H.starterFromHash("#other"), null);
  assert.equal(H.starterFromHash(""), null);
});

test("readyChecks 15 (fix 11): a renamed grade-band suggestion keeps its own credits without the transcript note", () => {
  const week = golden();
  const math = week.courses.find((c) => c.name === "Math");
  math.credits = 0.5;
  math.name = "Spanish";
  const notes = (opts) => H.readyChecks(week, opts).filter((i) => i.code === 15 && i.courseId === math.courseId);
  assert.deepEqual(notes({ suggestedCredits: { [math.courseId]: 0.5 } }), [], "the page remembers the suggestion's 0.5 by courseId, so a rename is not a change");
  assert.equal(notes({}).length, 1, "without the memory the name-based rule fires; the page always passes the memory");
  math.credits = 1;
  assert.equal(notes({ suggestedCredits: { [math.courseId]: 0.5 } }).length, 1, "a credit she did change still gets the note");
});

test("draftSummary and the approved name hint", () => {
  assert.equal(H.draftSummary(golden()), "2 children, 3 courses, 9 lessons");
  assert.equal(H.COPY.nameHint, "Just for you on this screen. The names you type here are never put in the file.");
});

test("parseContents on the Swift test's pasted contents keeps the numbered rows", () => {
  const pasted = "Table of Contents\n1. The Nile River ........ 3\n2) Sumer and the First Cities 11\nChapter 3: Old Kingdom Egypt — 19\n• Nomads of the Steppe\n- The First Writing\t27\n\nLesson 12 The Hebrews\n14\nUnit 2. India and China 40\n";
  assert.deepEqual(H.parseContents(pasted).map((r) => r.title), ["The Nile River", "Sumer and the First Cities", "Old Kingdom Egypt", "The Hebrews"]);
  assert.deepEqual(H.parseContents("Exploring Our World\nContents\nRead together\nDraw the river\n").map((r) => r.title), ["Read together", "Draw the river"], "a running header above Contents is dropped");
  assert.deepEqual(H.parseContents(""), []);
  assert.deepEqual(H.parseContents("Contents\nIndex\n"), []);
  assert.deepEqual(H.parseContents("Lessons 1–3\n• Counting\n"), [
    { title: "Lesson 1 · Unit 1", unit: "Unit 1", details: "Unit 1: Counting" },
    { title: "Lesson 2 · Unit 1", unit: "Unit 1", details: "" },
    { title: "Lesson 3 · Unit 1", unit: "Unit 1", details: "" },
  ], "a range with no name becomes Unit 1");
});

// MARK: - Mark Tally (Lessons Done only)

test("Mark Tally greeting and Lessons tips are the brand-voice lines", () => {
  assert.equal(GREETING, "Hey, Mark Tally here. How can I help?");
  assert.deepEqual(LESSON_TIPS, [
    "Use Number or divide pages to make Lesson 1, Lesson 2, \u2026 or split a book by pages.",
    "Paste titles, then review the rows.",
    "Untick a row so it isn\u2019t added when you open the file in the app.",
  ]);
  const joined = LESSON_TIPS.join("\n");
  assert.ok(LESSON_TIPS[0].includes("Number or divide pages"), "tip 1 uses the toolbar's exact name");
  assert.ok(LESSON_TIPS[1].includes("Paste titles"), "tip 2 uses the toolbar's exact name");
  const page = read(join(builderDir, "builder.js"));
  assert.match(page, /"Number or divide pages"/);
  assert.match(page, /"Paste titles"/);
  assert.doesNotMatch(joined, /Pattern fill/i);
  assert.doesNotMatch(joined, /leave it out/i);
});

test("Mark Tally draws four upright strokes, then the slash from top right to bottom left", () => {
  assert.equal(STROKES.length, 5);
  for (const stroke of STROKES.slice(0, 4)) {
    assert.ok(Math.abs(stroke.x1 - stroke.x2) < 5, "an upright stroke stays nearly vertical");
    assert.ok(stroke.y2 > stroke.y1, "upright strokes draw downward");
  }
  const slash = STROKES[4];
  assert.ok(slash.x1 > slash.x2 && slash.y1 < slash.y2, "the slash starts at the top right and ends at the bottom left");
  assert.deepEqual(STROKE_STARTS, [0, 58, 116, 174, 266]);
  assert.deepEqual(STROKE_SPANS, [94, 92, 91, 90, 133]);
  assert.equal(STROKE_STARTS[4] + STROKE_SPANS[4], 399);
  assert.equal(DONE_MS, 900);
  assert.equal(QUIET_MS, 420);
});

test("Mark Tally happy hop peaks at 482 ms and fades out by 900", () => {
  const before = poseAt(354);
  assert.equal(before.y, 0);
  assert.equal(before.rot, 0);
  assert.equal(before.sx, 1);
  const drawn = poseAt(265);
  assert.ok(drawn.strokes.slice(0, 4).every((stroke) => stroke.offset === 0 && stroke.opacity === 1));
  assert.equal(drawn.strokes[4].opacity, 0);
  const peak = poseAt(482);
  assert.equal(peak.y, -19);
  assert.equal(peak.rot, 3);
  assert.equal(peak.alpha, 1);
  const settled = poseAt(700);
  assert.equal(settled.y, 0);
  assert.equal(settled.rot, 0);
  assert.equal(settled.sx, 1);
  assert.equal(settled.sy, 1);
  assert.equal(settled.alpha, 1);
  assert.equal(poseAt(900).alpha, 0);
});

test("Mark Tally reduced motion is a still tally with no hop or turn", () => {
  const mid = poseAt(200, true);
  assert.equal(mid.y, 0);
  assert.equal(mid.rot, 0);
  assert.equal(mid.sx, 1);
  assert.equal(mid.sy, 1);
  assert.equal(mid.alpha, 1);
  assert.ok(mid.strokes.every((stroke) => stroke.offset === 0 && stroke.opacity === 1));
  assert.equal(poseAt(420, true).alpha, 0);
  assert.equal(poseAt(420, true).rot, 0);
});

test("the hop is asked for only after Lessons Done actually leaves the workspace", () => {
  assert.equal(lessonsDoneShouldPlay({ screenBefore: 4, screenAfter: 3, celebrate: true }), true);
  assert.equal(lessonsDoneShouldPlay({ screenBefore: 4, screenAfter: 2, celebrate: true }), true);
  assert.equal(lessonsDoneShouldPlay({ screenBefore: 4, screenAfter: 4, celebrate: true }), false, "still on the workspace means it did not close");
  assert.equal(lessonsDoneShouldPlay({ screenBefore: 4, screenAfter: 3, celebrate: false }), false, "Back uses the same exit");
  assert.equal(lessonsDoneShouldPlay({ screenBefore: 2, screenAfter: 3, celebrate: true }), false);
  const js = read(join(builderDir, "builder.js"));
  assert.equal((js.match(/closeWorkspace\(\{ celebrate: true \}\)/g) ?? []).length, 1);
  const css = read(join(builderDir, "builder.css"));
  const markCss = css.slice(css.indexOf("/* Mark Tally"));
  assert.ok(markCss.length > 0);
  assert.match(markCss, /\.cb-mark-done\s*\{[^}]*pointer-events:\s*none/);
  assert.match(markCss, /\.cb-mark-bubble \.eyebrow\s*\{[^}]*color:\s*var\(--ink-2\)/);
  assert.match(markCss, /var\(--cb-mark-clear,\s*0px\)/);
  assert.doesNotMatch(markCss, /site-footer/);
  const shipped = read(join(builderDir, "mark-tally.js")) + "\n" + markCss;
  assert.equal(helpLabel("workspace"), "Help from Mark Tally: lesson tips");
  void shipped;
  assert.doesNotMatch(shipped, /Pattern fill|leave it out|playhead|Slow motion|little bounce|Meet your little helper/i);
});

test("Mark Tally has a tip set for every Course Builder screen, in Marlow's words (Oct 6 tips file)", () => {
  const keys = ["start", "who", "week", "course", "lessons", "workspace", "preview", "review"];
  assert.deepEqual(Object.keys(SCREEN_TIPS), keys);
  for (const key of keys) {
    const { name, tips } = SCREEN_TIPS[key];
    assert.equal(tips.length, 3, `${key}: three tips`);
    for (const tip of tips) {
      assert.doesNotMatch(tip, /[*`_]|\u2014|!|free trial|Pattern fill|Fill down|Left out/i, `${key}: plain text, house style, current names: ${tip}`);
      assert.ok(tip.length <= 140, `${key}: short: ${tip}`);
    }
    assert.equal(helpLabel(key), `Help from Mark Tally: ${name.toLowerCase()} tips`);
    assert.match(helpLabel(key), /^Help /, "the visible word Help stays in the accessible name");
  }
  assert.deepEqual(SCREEN_TIPS.workspace.tips, LESSON_TIPS, "the workspace keeps the set Quarry passed at 608ba08");
  assert.equal(SCREEN_TIPS.start.tips[0], "Tap Start my week to plan here in the browser. Nothing is sent to us.");
  assert.equal(SCREEN_TIPS.who.tips[1], "A first name here is just for this screen. Names never go in the file.");
  assert.equal(SCREEN_TIPS.week.tips[2], "Tap a block to set name, schedule, and minutes. The number on a block is its minutes.", "one-height pills: the minutes are the capsule, not the height");
  assert.equal(SCREEN_TIPS.review.tips[1], "Download my week makes one .hssweek file. The app only adds; it never replaces what you already have.");
  assert.equal(GREETING, "Hey, Mark Tally here. How can I help?");
  const js = read(join(builderDir, "builder.js"));
  assert.equal((js.match(/closeWorkspace\(\{ celebrate: true \}\)/g) ?? []).length, 1, "the hop still has one trigger");
  assert.match(js, /syncMarkTally\(markScreenKey\(\)\)/);
  assert.match(js, /syncMarkTally\(course \? "course" : "week"\)/);
});

test("Mark Tally lifts above the site footer and stays put while the footer is below", () => {
  assert.equal(FOOTER_GAP, 12);
  assert.equal(footerClearance(800, 1200), 0, "a footer still below the viewport does not lift the mark");
  assert.equal(footerClearance(800, 700), 112, "800 - 700 + 12");
  assert.equal(footerClearance(844, 500), 356);
  assert.equal(footerClearance(390, Number.NaN), 0);
  assert.equal(footerClearance(800, 788.2), 24, "a fractional footer top still clears by at least 12");
  assert.equal(BUBBLE_ROOM_INSET, 18);
  assert.deepEqual(bubblePlacement(200), { room: 182, gap: 10 }, "helper top minus the 10px gap and the 8px viewport margin");
  assert.equal(bubbleRoom(200), 182);
  assert.deepEqual(bubblePlacement(56), { room: 46, gap: 2 }, "a short landscape screen keeps Close by giving up gap");
  assert.equal(bubbleRoom(10), 2);
  const markCss = read(join(builderDir, "builder.css"));
  assert.match(markCss, /max-height:[^;]*var\(--cb-mark-room,\s*100dvh\)/);
  assert.match(markCss, /var\(--cb-mark-gap,\s*10px\)/);
});

// MARK: - Runner

const skips = [];
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n      ")}`);
  }
}
for (const skip of skips) console.log(`SKIP  ${skip}`);
console.log(`\n${tests.length - failed} passed, ${failed} failed, ${skips.length} skipped`);
process.exit(failed === 0 ? 0 : 1);
