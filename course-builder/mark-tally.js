// mark-tally.js
//
// Mark Tally on the Lessons step (Josh, October 6, 2026). Five tally strokes only:
// the frame, baseline, board, and face stay out. Geometry and the happy-hop timings
// come from the motion study (source/index.html and source/motion.js). The diagonal
// is stored top-right to bottom-left so the dash draws that way.
//
// The hop plays once, after the lesson workspace has actually closed. It does not
// save anything, and it does not sit in the page flow. The corner mark is a fixed
// set of Lessons tips, not a chat.

export const GREETING = "Hey, Mark Tally here. How can I help?";

export const LESSON_TIPS = Object.freeze([
  "Use Number or divide pages to make Lesson 1, Lesson 2, \u2026 or split a book by pages.",
  "Paste titles, then review the rows.",
  "Untick a row so it isn\u2019t added when you open the file in the app.",
]);

/** Happy hop, then a short fade. Quiet finish when the device asks for less motion. */
export const DONE_MS = 900;
export const QUIET_MS = 420;

/** The helper's bottom edge stays at least this far above the site footer. */
export const FOOTER_GAP = 12;

/**
 * Preferred room above a lifted mark: 10px between the bubble and the mark,
 * plus 8px clear of the viewport top.
 */
export const BUBBLE_GAP = 10;
export const BUBBLE_TOP_MARGIN = 8;
export const BUBBLE_ROOM_INSET = BUBBLE_GAP + BUBBLE_TOP_MARGIN;
/** Close is 44px, and the card's border takes 2px of the max-height. The gap gives way first. */
export const BUBBLE_CLOSE = 46;

/**
 * Card max-height and the gap under the bubble. Usually the mark's top minus 18px.
 * When the footer lift leaves less than a Close button, the gap shrinks (down to
 * nothing) so the card still holds Close and stays about 8px under the viewport top.
 */
export function bubblePlacement(helperTop) {
  if (!Number.isFinite(helperTop)) return { room: 0, gap: BUBBLE_GAP };
  const preferred = Math.floor(helperTop - BUBBLE_ROOM_INSET);
  if (preferred >= BUBBLE_CLOSE) return { room: Math.max(0, preferred), gap: BUBBLE_GAP };
  const gap = Math.max(0, Math.floor(helperTop - BUBBLE_TOP_MARGIN - BUBBLE_CLOSE));
  const room = Math.max(0, Math.floor(helperTop - gap - BUBBLE_TOP_MARGIN));
  return { room, gap };
}

/** Card max-height, in px, so the open bubble stays on screen above a lifted mark. */
export function bubbleRoom(helperTop) {
  return bubblePlacement(helperTop).room;
}

/**
 * Extra `bottom` in px. CSS `max()` keeps the resting spot and the phone bar;
 * this only grows when the footer would otherwise slide under the mark.
 */
export function footerClearance(viewportHeight, footerTop, gap = FOOTER_GAP) {
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(footerTop)) return 0;
  return Math.max(0, Math.ceil(viewportHeight - footerTop + gap));
}

export const STROKE_STARTS = Object.freeze([0, 58, 116, 174, 266]);
export const STROKE_SPANS = Object.freeze([94, 92, 91, 90, 133]);

export const STROKES = Object.freeze([
  Object.freeze({ x1: 30, y1: 32, x2: 28, y2: 67 }),
  Object.freeze({ x1: 42, y1: 32, x2: 44, y2: 67 }),
  Object.freeze({ x1: 58, y1: 32, x2: 56, y2: 67 }),
  Object.freeze({ x1: 70, y1: 32, x2: 72, y2: 67 }),
  Object.freeze({ x1: 77, y1: 38, x2: 23, y2: 62 }),
]);

const SVG_NS = "http://www.w3.org/2000/svg";

const clamp = (v) => Math.max(0, Math.min(1, v));
const easeOut = (p) => 1 - Math.pow(1 - clamp(p), 3);
const mix = (a, b, p) => a + (b - a) * p;

/** Pose at t milliseconds. `reduced` is the still tally: drawn, no hop, no turn. */
export function poseAt(t, reduced = false) {
  const strokes = STROKE_STARTS.map((start, i) => {
    if (reduced) return { offset: 0, opacity: 1 };
    const p = clamp((t - start) / STROKE_SPANS[i]);
    return { offset: 100 * (1 - easeOut(p)), opacity: p > 0 ? 1 : 0 };
  });
  let x = 0;
  let y = 0;
  let rot = 0;
  let sx = 1;
  let sy = 1;
  let alpha = 1;
  if (!reduced) {
    if (t >= 355 && t < 405) {
      const p = easeOut((t - 355) / 50);
      sx = mix(1, 1.09, p);
      sy = mix(1, 0.88, p);
      y = mix(0, 5, p);
      rot = mix(0, -2, p);
    } else if (t >= 405 && t < 482) {
      const p = easeOut((t - 405) / 77);
      sx = mix(1.09, 0.97, p);
      sy = mix(0.88, 1.04, p);
      y = mix(5, -19, p);
      rot = mix(-2, 3, p);
    } else if (t >= 482 && t < 560) {
      const p = clamp((t - 482) / 78);
      const q = p * p;
      sx = mix(0.97, 1.065, q);
      sy = mix(1.04, 0.93, q);
      y = mix(-19, 3, q);
      rot = mix(3, -1, p);
    } else if (t >= 560 && t < 660) {
      const p = easeOut((t - 560) / 100);
      sx = mix(1.065, 1, p);
      sy = mix(0.93, 1, p);
      y = mix(3, 0, p);
      rot = mix(-1, 0, p);
    }
    alpha = 1 - clamp((t - 752) / 148);
  } else {
    alpha = t < QUIET_MS ? 1 : 0;
  }
  return { x, y, rot, sx, sy, alpha, strokes };
}

/** True only when Lessons Done asked for the hop and the workspace actually closed. */
export function lessonsDoneShouldPlay({ screenBefore, screenAfter, celebrate }) {
  return celebrate === true && screenBefore === 4 && screenAfter !== 4;
}

function tallySvg() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "12 18 76 62");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("fill", "none");
  g.setAttribute("stroke", "currentColor");
  g.setAttribute("stroke-width", "7");
  g.setAttribute("stroke-linecap", "round");
  g.setAttribute("stroke-linejoin", "round");
  const lines = STROKES.map((stroke) => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "cb-mark-stroke");
    line.setAttribute("x1", String(stroke.x1));
    line.setAttribute("y1", String(stroke.y1));
    line.setAttribute("x2", String(stroke.x2));
    line.setAttribute("y2", String(stroke.y2));
    g.append(line);
    return line;
  });
  svg.append(g);
  return { svg, lines };
}

let builder = null;
let position = null;
let bubble = null;
let button = null;
let heading = null;
let overlay = null;
let performer = null;
let lines = [];
let frame = 0;
let running = false;
let greeting = null;
let reducedQuery = null;
let teardown = () => {};
let placeFrame = 0;
let footerObserver = null;
let lastClear = -1;
let lastRoom = -1;
let lastGap = -1;

function reducedNow() {
  return Boolean(reducedQuery?.matches);
}

function stopFrame() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  running = false;
}

function applyPose(t, reduced) {
  const pose = poseAt(t, reduced);
  lines.forEach((line, i) => {
    const stroke = pose.strokes[i];
    line.style.strokeDashoffset = String(stroke.offset);
    line.style.opacity = String(stroke.opacity);
  });
  performer.style.transform = `translate(${pose.x}px, ${pose.y}px) rotate(${pose.rot}deg) scale(${pose.sx}, ${pose.sy})`;
  performer.style.opacity = String(pose.alpha);
}

function hideDone() {
  stopFrame();
  if (!overlay) return;
  overlay.hidden = true;
  if (performer) {
    performer.style.transform = "";
    performer.style.opacity = "";
  }
}

function closeHelp(restore) {
  if (!bubble) return;
  const wasOpen = !bubble.hidden;
  bubble.hidden = true;
  button?.setAttribute("aria-expanded", "false");
  if (restore && (wasOpen || document.activeElement === heading)) button?.focus({ preventScroll: true });
}

function openHelp() {
  bubble.hidden = false;
  button.setAttribute("aria-expanded", "true");
  heading.focus({ preventScroll: true });
}

function toggleHelp() {
  if (bubble.hidden) openHelp();
  else closeHelp(false);
}

function greet() {
  if (reducedNow() || greeting?.playState === "running") return;
  const svg = button?.querySelector("svg");
  if (!svg?.animate) return;
  greeting = svg.animate([
    { transform: "translateY(0) rotate(0deg)", offset: 0 },
    { transform: "translateY(1px) rotate(-4deg)", offset: 0.23 },
    { transform: "translateY(-4px) rotate(3deg)", offset: 0.57 },
    { transform: "translateY(0) rotate(0deg)", offset: 1 },
  ], { duration: 360, easing: "ease-out", iterations: 1 });
}

function onMotionChange() {
  greeting?.cancel();
  if (!running) return;
  // Stop the hop that is already on screen. A device that just asked for less
  // motion gets the still tally instead of the rest of the hop.
  const reduced = reducedNow();
  stopFrame();
  if (reduced) playLessonsDone();
  else hideDone();
}

function placeHelper() {
  placeFrame = 0;
  if (!position || !button) return;
  const footer = document.querySelector(".site-footer");
  const footerTop = footer ? footer.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
  const clear = footerClearance(window.innerHeight, footerTop);
  if (clear !== lastClear) {
    lastClear = clear;
    position.style.setProperty("--cb-mark-clear", `${clear}px`);
  }
  // Hidden, the mark has no box, so a room of 0 would collapse the bubble on the next show.
  if (position.hidden) return;
  const place = bubblePlacement(button.getBoundingClientRect().top);
  if (place.room === lastRoom && place.gap === lastGap) return;
  lastRoom = place.room;
  lastGap = place.gap;
  position.style.setProperty("--cb-mark-room", `${place.room}px`);
  position.style.setProperty("--cb-mark-gap", `${place.gap}px`);
}

function schedulePlace() {
  if (!position || placeFrame) return;
  placeFrame = requestAnimationFrame(placeHelper);
}

/** Shows or hides the corner mark. Lessons tips only exist for the Lessons step and its workspace. */
export function syncMarkTally(screen) {
  if (!position || !builder) return;
  const on = screen === 3 || screen === 4;
  position.hidden = !on;
  builder.classList.toggle("cb-mark-on", on);
  if (!on) closeHelp(false);
  schedulePlace();
}

/** One happy hop. Cancels a hop that is already running. No-op until mounted. */
export function playLessonsDone() {
  if (!overlay || !performer) return;
  stopFrame();
  const reduced = reducedNow();
  const total = reduced ? QUIET_MS : DONE_MS;
  overlay.hidden = false;
  running = true;
  const start = performance.now();
  const tick = (now) => {
    if (!running) return;
    const t = Math.min(total, now - start);
    applyPose(t, reduced);
    if (t < total) frame = requestAnimationFrame(tick);
    else {
      running = false;
      frame = 0;
      overlay.hidden = true;
    }
  };
  frame = requestAnimationFrame(tick);
}

/** Builds the corner mark and the done overlay. Calling again removes the previous listeners. */
export function mountMarkTally(root) {
  teardown();
  builder = root;
  reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  position = document.createElement("div");
  position.className = "cb-mark-position";
  position.hidden = true;

  bubble = document.createElement("aside");
  bubble.className = "cb-mark-bubble";
  bubble.id = "cb-mark-bubble";
  bubble.hidden = true;
  bubble.setAttribute("aria-labelledby", "cb-mark-heading");

  const card = document.createElement("div");
  card.className = "cb-mark-bubble-card";
  const kicker = document.createElement("p");
  kicker.className = "eyebrow";
  kicker.textContent = "Lessons";
  heading = document.createElement("h2");
  heading.id = "cb-mark-heading";
  heading.tabIndex = -1;
  // The line break is visual. The words stay the approved greeting, space included.
  const breakAt = GREETING.indexOf(" How");
  heading.append(GREETING.slice(0, breakAt + 1), document.createElement("br"), GREETING.slice(breakAt + 1));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "cb-mark-close";
  close.setAttribute("aria-label", "Close Mark Tally\u2019s tips");
  close.textContent = "\u00d7";
  const list = document.createElement("ul");
  for (const tip of LESSON_TIPS) {
    const item = document.createElement("li");
    item.textContent = tip;
    list.append(item);
  }
  card.append(kicker, heading, close, list);
  bubble.append(card);

  button = document.createElement("button");
  button.type = "button";
  button.className = "cb-mark-help";
  button.id = "cb-mark-help";
  button.setAttribute("aria-label", "Help from Mark Tally: lesson tips");
  button.setAttribute("aria-controls", "cb-mark-bubble");
  button.setAttribute("aria-expanded", "false");
  const helpMark = tallySvg();
  const label = document.createElement("span");
  label.className = "cb-mark-help-label";
  label.setAttribute("aria-hidden", "true");
  label.textContent = "Help?";
  button.append(helpMark.svg, label);
  position.append(bubble, button);

  overlay = document.createElement("div");
  overlay.className = "cb-mark-done";
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");
  performer = document.createElement("div");
  performer.className = "cb-mark-performer";
  const hero = tallySvg();
  lines = hero.lines;
  for (const line of lines) {
    line.setAttribute("pathLength", "100");
    line.style.strokeDasharray = "100 100";
  }
  performer.append(hero.svg);
  overlay.append(performer);

  root.append(position, overlay);

  const onHelpClick = () => toggleHelp();
  const onCloseClick = () => closeHelp(true);
  const onEnter = () => greet();
  const onFocus = () => greet();
  const onDocClick = (event) => {
    if (bubble.hidden) return;
    if (event.target instanceof Node && position.contains(event.target)) return;
    // A click on another control has already moved focus there (mousedown). If focus is
    // still inside the bubble, a non-focusable click would leave it on a hidden heading.
    const focusInside = bubble.contains(document.activeElement);
    closeHelp(false);
    if (focusInside) button.focus({ preventScroll: true });
  };
  const onKey = (event) => {
    if (event.key !== "Escape" || bubble.hidden) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    closeHelp(true);
  };
  const onHide = () => {
    greeting?.cancel();
    hideDone();
  };

  button.addEventListener("click", onHelpClick);
  button.addEventListener("pointerenter", onEnter);
  button.addEventListener("focus", onFocus);
  close.addEventListener("click", onCloseClick);
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  reducedQuery.addEventListener("change", onMotionChange);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("scroll", schedulePlace, { passive: true });
  window.addEventListener("resize", schedulePlace);
  window.visualViewport?.addEventListener("resize", schedulePlace);
  window.visualViewport?.addEventListener("scroll", schedulePlace);
  const footer = document.querySelector(".site-footer");
  if (footer && typeof ResizeObserver !== "undefined") {
    footerObserver = new ResizeObserver(schedulePlace);
    footerObserver.observe(footer);
  }
  placeHelper();

  teardown = () => {
    greeting?.cancel();
    hideDone();
    closeHelp(false);
    button.removeEventListener("click", onHelpClick);
    button.removeEventListener("pointerenter", onEnter);
    button.removeEventListener("focus", onFocus);
    close.removeEventListener("click", onCloseClick);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    reducedQuery.removeEventListener("change", onMotionChange);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("scroll", schedulePlace);
    window.removeEventListener("resize", schedulePlace);
    window.visualViewport?.removeEventListener("resize", schedulePlace);
    window.visualViewport?.removeEventListener("scroll", schedulePlace);
    footerObserver?.disconnect();
    footerObserver = null;
    if (placeFrame) cancelAnimationFrame(placeFrame);
    placeFrame = 0;
    lastClear = -1;
    lastRoom = -1;
    lastGap = -1;
    position.remove();
    overlay.remove();
    builder.classList.remove("cb-mark-on");
    builder = null;
    position = null;
    bubble = null;
    button = null;
    heading = null;
    overlay = null;
    performer = null;
    lines = [];
    teardown = () => {};
  };
  return teardown;
}
