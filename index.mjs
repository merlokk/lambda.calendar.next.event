import ICAL from "ical.js";
import { findIana } from "windows-iana";

/**
 * ENV:
 *  - ICS_URL (required for production): public .ics URL
 *  - TZ (optional): timezone for "today window", default Europe/Nicosia
 *  - DEFAULT_DURATION_MIN (optional): fallback duration if no DTEND/DURATION, default 60
 *  - CACHE_MS (optional): warm-container cache duration, default 60000
 *  - LOG_LEVEL (optional): DEBUG, INFO, WARN, ERROR; default INFO
 *  - OVERRIDE_NOW (optional): ISO datetime to use as "now" for testing, e.g. "2026-02-09T08:00:00Z"
 *
 * Query Parameters (for testing):
 *  - now (optional): Override NOW timestamp, e.g. "2026-02-09T08:20:00Z"
 *  - tz (optional): Override timezone, e.g. "UTC" or "Europe/Nicosia"
 *
 * Request Body (for testing):
 *  - Base64-encoded ICS file content (set isBase64Encoded: true)
 *  - When provided, ICS_URL is not required and caching is disabled
 */
const ICS_URL = process.env.ICS_URL;
const TZ = process.env.TZ || "Europe/Nicosia";
const DEFAULT_DURATION_MIN = Number(process.env.DEFAULT_DURATION_MIN || "60");
const CACHE_MS = Number(process.env.CACHE_MS || "60000");
const LOG_LEVEL = process.env.LOG_LEVEL || "INFO";
const OVERRIDE_NOW = process.env.OVERRIDE_NOW || null;

// warm-container cache (best effort)
let cache = { at: 0, body: null };

// Structured logging
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.INFO;

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] >= currentLogLevel) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta
    }));
  }
}

export const handler = async (event) => {
  try {
    // Check if ICS is provided in request body (for testing)
    const hasInlineIcs = event.body && event.isBase64Encoded;
    const icsUrl = hasInlineIcs ? null : ICS_URL;

    if (!hasInlineIcs && !icsUrl) {
      log("ERROR", "ICS_URL env var is missing");
      return json(500, { error: "ICS_URL env var is missing" });
    }

    // Parse query params for NOW override and timezone
    const params = event.queryStringParameters || {};
    const nowOverride = params.now || OVERRIDE_NOW;
    const tz = params.tz || TZ;

    if (!isValidTimeZone(tz)) {
      log("WARN", "Invalid timezone", { tz });
      return json(400, { error: `Invalid timezone: ${tz}` });
    }

    // Use overridden NOW for testing, otherwise real time
    const nowMs = nowOverride ? Date.parse(nowOverride) : Date.now();

    if (!Number.isFinite(nowMs)) {
      log("WARN", "Invalid NOW override", { override: nowOverride });
      return json(400, { error: `Invalid now override: ${nowOverride}` });
    }

    if (nowOverride) {
      log("INFO", "Using overridden NOW", { override: nowOverride, nowMs: new Date(nowMs).toISOString() });
    }

    // Only use cache for URL-based ICS (not inline test ICS)
    if (!hasInlineIcs && cache.body && (nowMs - cache.at) < CACHE_MS) {
      log("DEBUG", "Cache hit");
      return json(200, cache.body, { "x-cache": "HIT" });
    }

    const { startMs, endMs } = todayWindow(nowMs, tz);
    log("INFO", "Processing calendar window", {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString()
    });

    // Fetch ICS text from URL or decode from request body
    let icsText;
    if (hasInlineIcs) {
      icsText = Buffer.from(event.body, 'base64').toString('utf-8');
      log("DEBUG", "Using inline ICS from request body", { size: icsText.length });
    } else {
      icsText = await fetchText(icsUrl);
      log("DEBUG", "Fetched ICS from URL", { size: icsText.length });
    }

    // Normalize Windows TZID -> IANA before parsing
    const fixedIcs = normalizeIcsTimezones(icsText);

    // Parse with ical.js (better timezone support)
    const jcalData = ICAL.parse(fixedIcs);
    const comp = new ICAL.Component(jcalData);
    const vevents = comp.getAllSubcomponents("vevent");

    log("DEBUG", "Parsed events", { count: vevents.length });

    // Convert to our format
    const allEvents = vevents.map(vevent => parseVEvent(vevent));

    // Separate master events from overrides
    const { masterEvents, overridesByUid, masterUids } = separateMasterAndOverrides(allEvents);

    // Expand occurrences
    const occs = [];

    // Process master events
    for (const ev of masterEvents) {
      const expanded = expandOccurrencesInWindow(ev, startMs, endMs, overridesByUid);

      for (const o of expanded) {
        // Include event if it overlaps with the window [nowMs, endMs)
        // Event overlaps if: starts before window ends AND ends after window starts
        if (o.startMs < endMs && o.endMs > nowMs) occs.push(o);
      }
    }

    // Process orphaned overrides
    for (const [uid, overrideMap] of overridesByUid.entries()) {
      if (!masterUids.has(uid)) {
        for (const [recIdMs, override] of overrideMap.entries()) {
          // Skip cancelled events
          if (override.status === "CANCELLED") continue;
          if (!override.start) continue;

          const occStartMs = override.start.getTime();

          // Orphaned overrides check against window boundaries (not nowMs)
          // because they are standalone events without a master to expand from
          if (occStartMs >= startMs && occStartMs < endMs) {
            const occEndMs = override.end
                ? override.end.getTime()
                : occStartMs + (DEFAULT_DURATION_MIN * 60_000);

            occs.push({
              uid: override.uid,
              title: override.summary || "(No title)",
              location: override.location || null,
              organizer: override.organizer || null,
              startMs: occStartMs,
              endMs: occEndMs
            });

            log("INFO", "Added orphaned override", {
              uid: override.uid,
              title: override.summary,
              start: override.start.toISOString()
            });
          }
        }
      }
    }

    occs.sort((a, b) => a.startMs - b.startMs);
    log("INFO", "Expanded occurrences", { count: occs.length });

    // Compute next/overlapping/non-overlapping
    const triple = computeNextTriple(occs, nowMs, tz);

    // Metrics
    const metrics = computeMetrics(occs, nowMs, triple.next, tz);

    const body = {
      generatedAt: new Date().toISOString(),
      window: {
        start: isoWithTimeZone(startMs, tz),
        end: isoWithTimeZone(endMs, tz),
        tz: tz
      },
      ...metrics,
      ...triple
    };

    // Only cache URL-based results (not inline test ICS)
    if (!hasInlineIcs) {
      cache = { at: nowMs, body };
    }

    return json(200, body, { "x-cache": "MISS" });
  } catch (e) {
    log("ERROR", "Handler error", { error: e.message, stack: e.stack });
    return json(500, { error: String(e?.message ?? e) });
  }
};

function parseVEvent(vevent) {
  const event = new ICAL.Event(vevent);

  return {
    uid: event.uid,
    summary: event.summary || "",
    location: event.location || null,
    organizer: event.organizer || null,
    start: event.startDate ? event.startDate.toJSDate() : null,
    end: event.endDate ? event.endDate.toJSDate() : null,
    recurrenceId: event.recurrenceId ? event.recurrenceId.toJSDate() : null,
    rrule: event.component.getFirstPropertyValue("rrule"),
    exdate: event.component.getAllProperties("exdate"),
    status: event.component.getFirstPropertyValue("status"),
    datetype: event.startDate && event.startDate.isDate ? "date" : "date-time",
    component: vevent  // Preserve component for proper timezone handling in iterator
  };
}

async function fetchText(url, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    log("DEBUG", "Fetching ICS", { url });
    const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.text();
  } catch (e) {
    log("ERROR", "Fetch failed", { url, error: e.message });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function normalizeIcsTimezones(icsText) {
  // Extract all VTIMEZONE TZIDs from the file
  const vtzRegex = /BEGIN:VTIMEZONE[\s\S]*?TZID:([^\r\n]+)[\s\S]*?END:VTIMEZONE/g;
  const vtimezones = new Set();
  let match;
  while ((match = vtzRegex.exec(icsText)) !== null) {
    vtimezones.add(match[1]);
  }

  return icsText.replaceAll(
      /TZID=([^:;\r\n]+)/g,
      (match, winTz) => {
        // If this timezone has a VTIMEZONE definition, keep it as-is
        if (vtimezones.has(winTz)) {
          return match;
        }

        const list = findIana(winTz);

        if (!list || list.length === 0) {
          log("DEBUG", "Unknown timezone", { winTz });
          return match;
        }

        // special-case for FLE Standard Time
        if (winTz === "FLE Standard Time") {
          return "TZID=Europe/Nicosia";
        }

        // special-case for Pacific Standard Time
        if (winTz === "Pacific Standard Time") {
          return "TZID=America/Los_Angeles";
        }

        log("DEBUG", "Mapped timezone", { from: winTz, to: list[0] });
        return `TZID=${list[0]}`;
      }
  );
}

function separateMasterAndOverrides(events) {
  const masterEvents = [];
  const overridesByUid = new Map();
  const masterUids = new Set();

  // First pass: collect UIDs with master events
  for (const ev of events) {
    const uid = ev.uid;
    if (!uid) continue;

    if (!ev.recurrenceId) {
      masterUids.add(uid);
    }
  }

  // Second pass: separate
  for (const ev of events) {
    const uid = ev.uid;
    if (!uid) {
      log("WARN", "Event without UID", { summary: ev.summary });
      continue;
    }

    if (!ev.recurrenceId) {
      masterEvents.push(ev);
    } else {
      const recIdMs = ev.recurrenceId.getTime();

      let innerMap = overridesByUid.get(uid);
      if (!innerMap) {
        innerMap = new Map();
        overridesByUid.set(uid, innerMap);
      }

      innerMap.set(recIdMs, ev);

      if (!masterUids.has(uid)) {
        log("WARN", "Orphaned override (no master event)", {
          uid,
          recId: ev.recurrenceId.toISOString(),
          summary: ev.summary,
          start: ev.start?.toISOString()
        });
      }
    }
  }

  return { masterEvents, overridesByUid, masterUids };
}

function computeNextTriple(occs, nowMs, tz) {
  // Find current event (if any)
  const currentEvent = occs.find((o) => nowMs >= o.startMs && nowMs < o.endMs);

  // Next event is:
  // - If there's a current event: first event starting after current ends
  // - If no current event: first event starting after NOW
  const searchFromMs = currentEvent ? currentEvent.endMs : nowMs;
  const nextIdx = occs.findIndex((o) => o.startMs >= searchFromMs);
  const next = nextIdx >= 0 ? occs[nextIdx] : null;

  if (!next) {
    return { next: null, nextOverlapping: null, nextNonOverlapping: null };
  }

  let nextOverlapping = null;
  for (let i = nextIdx + 1; i < occs.length; i++) {
    const o = occs[i];
    if (o.startMs >= next.endMs) break;
    if (o.endMs > next.startMs) {
      nextOverlapping = o;
      break;
    }
  }

  let clusterEnd = next.endMs;
  for (let i = nextIdx + 1; i < occs.length; i++) {
    const o = occs[i];
    if (o.startMs >= clusterEnd) break;
    if (o.endMs > clusterEnd) clusterEnd = o.endMs;
  }

  let nextNonOverlapping = null;
  for (let i = nextIdx + 1; i < occs.length; i++) {
    const o = occs[i];
    if (o.startMs >= clusterEnd) {
      nextNonOverlapping = o;
      break;
    }
  }

  return {
    next: toDtoWithTz(next, tz),
    nextOverlapping: toDtoWithTz(nextOverlapping, tz),
    nextNonOverlapping: toDtoWithTz(nextNonOverlapping, tz)
  };
}

function computeMetrics(occs, nowMs, nextDto, tz) {
  const isOverlappingNow = occs.some((o) => nowMs >= o.startMs && nowMs < o.endMs);

  // Find current event if any
  const currentEvent = occs.find((o) => nowMs >= o.startMs && nowMs < o.endMs);

  if (!nextDto) {
    return {
      now: isoWithTimeZone(nowMs, tz),
      minutesUntilNext: null,
      isOverlappingNow,
      current: currentEvent ? toDtoWithTz(currentEvent, tz) : null
    };
  }

  const nextStartMs = Date.parse(nextDto.start);
  const minutesUntilNext = Math.max(0, Math.round((nextStartMs - nowMs) / 60_000));

  return {
    now: isoWithTimeZone(nowMs, tz),
    minutesUntilNext,
    isOverlappingNow,
    current: currentEvent ? toDtoWithTz(currentEvent, tz) : null
  };
}

function toDto(o) {
  if (!o) return null;
  return {
    uid: o.uid,
    title: o.title,
    location: o.location ?? null,
    organizer: o.organizer ?? null,
    start: new Date(o.startMs).toISOString(),
    end: new Date(o.endMs).toISOString()
    // status is internal, don't expose to client
  };
}

function toDtoWithTz(o, tz) {
  if (!o) return null;
  return {
    uid: o.uid,
    title: o.title,
    location: o.location ?? null,
    organizer: o.organizer ?? null,
    start: isoWithTimeZone(o.startMs, tz),
    end: isoWithTimeZone(o.endMs, tz)
  };
}

function expandOccurrencesInWindow(ev, windowStartMs, windowEndMs, overridesByUid) {
  const uid = ev.uid || "";
  const baseTitle = ev.summary || "(No title)";
  const uidOverrides = overridesByUid?.get(uid);

  // Debug for specific missing events
  const isDebugEvent = uid.includes("6sbcikm6oikp3qe52m1576ivu2");

  if (isDebugEvent) {
    log("INFO", "=== DEBUG SARDINE EVENT ===", {
      uid,
      summary: baseTitle,
      hasRrule: !!ev.rrule,
      dtstart: ev.start ? ev.start.toISOString() : null,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString()
    });
  }

  // Skip all-day events
  if (ev.datetype === "date") {
    return [];
  }

  if (!ev.start) {
    log("WARN", "Event without start date", { uid, title: baseTitle });
    return [];
  }

  const baseLocation = ev.location || null;
  const baseOrganizer = ev.organizer;

  const calcDurationMsFromEvent = (e) => {
    if (e?.start && e?.end) {
      const dur = e.end.getTime() - e.start.getTime();
      if (dur > 0 && dur < 7 * 24 * 60 * 60 * 1000) return dur;
    }
    return DEFAULT_DURATION_MIN * 60_000;
  };

  const calcEndMs = (occStartDate, overrideEv) => {
    if (overrideEv?.end) {
      const endMs = overrideEv.end.getTime();
      if (endMs > occStartDate.getTime()) return endMs;
    }
    const durMs = calcDurationMsFromEvent(overrideEv ?? ev);
    return occStartDate.getTime() + durMs;
  };

  const mkOcc = (startDate, overrideEv) => {
    const title = (overrideEv?.summary ?? baseTitle) || "(No title)";
    const location = overrideEv?.location ?? baseLocation ?? null;
    const organizer = overrideEv?.organizer ?? baseOrganizer ?? null;
    const status = overrideEv?.status ?? ev.status;

    const startMs = startDate.getTime();
    const endMs = calcEndMs(startDate, overrideEv);

    return { uid, title, location, organizer, startMs, endMs, status };
  };

  // Non-recurring
  if (!ev.rrule) {
    const startMs = ev.start.getTime();
    const endMs = ev.end ? ev.end.getTime() : startMs + (DEFAULT_DURATION_MIN * 60_000);

    // Check if event overlaps with window (handles currently happening events)
    const overlapsWindow = startMs < windowEndMs && endMs > windowStartMs;

    if (overlapsWindow) {
      const occ = mkOcc(ev.start, null);
      // Skip cancelled events
      if (occ.status === "CANCELLED" || occ.title.startsWith("Canceled:")) {
        return [];
      }
      return [occ];
    }
    return [];
  }

  // Recurring: expand with ical.js
  const icalEvent = new ICAL.Event(ev.component || createComponentFromEvent(ev));
  const iterator = icalEvent.iterator();

  const occs = [];
  const usedOverrides = new Set(); // Track which overrides were used
  let next;
  let instanceCount = 0;

  while ((next = iterator.next())) {
    instanceCount++;
    const occDate = next.toJSDate();
    const occMs = next.toJSDate().getTime();

    if (isDebugEvent && (instanceCount <= 2 || instanceCount >= 57)) {
      log("INFO", "Iterator", {
        instance: occDate.toISOString(),
        num: instanceCount
      });
    }

    // Stop if past window
    if (occMs >= windowEndMs) {
      if (isDebugEvent) {
        log("INFO", "Iterator stopped - past window");
      }
      break;
    }

    // Smart skip: Events that ended before window starts can't overlap
    // Assume max event duration is 24 hours for safety
    const maxEventDuration = 24 * 60 * 60 * 1000; // 24 hours in ms
    if (occMs + maxEventDuration < windowStartMs) {
      continue; // Skip events that ended long before window
    }

    // Check EXDATE
    if (isExcluded(occDate, ev.exdate)) {
      continue;
    }

    // Check override
    const override = uidOverrides?.get(occMs) || null;

    if (override) {
      usedOverrides.add(occMs); // Mark as used
    }

    if (override?.status === "CANCELLED") {
      log("DEBUG", "Instance cancelled", { uid, instance: occDate.toISOString() });
      continue;
    }

    const startDate = override?.start || occDate;
    const startMs = startDate.getTime();

    // Calculate end time using the same logic as mkOcc
    const endMs = calcEndMs(startDate, override);

    // Check if event overlaps with window (handles currently happening events)
    const overlapsWindow = startMs < windowEndMs && endMs > windowStartMs;

    if (overlapsWindow) {
      const occ = mkOcc(startDate, override);

      // Skip cancelled events
      if (occ.status === "CANCELLED" || occ.title.startsWith("Canceled:")) {
        continue;
      }

      occs.push(occ);
    }
  }

  if (isDebugEvent) {
    log("INFO", "=== EXPANSION COMPLETE ===", {
      uid,
      summary: baseTitle,
      totalIterations: instanceCount,
      occurrencesReturned: occs.length,
      firstOcc: occs[0] ? new Date(occs[0].startMs).toISOString() : null,
      iteratorEndedNaturally: !next  // true if iterator.next() returned null
    });
  }

  // Add any unused overrides as standalone events
  // These are overrides that fall outside the RRULE range or were skipped
  if (uidOverrides) {
    for (const [recIdMs, override] of uidOverrides.entries()) {
      const wasUsed = usedOverrides.has(recIdMs);

      if (wasUsed) continue;

      // Skip cancelled
      if (override.status === "CANCELLED") continue;
      if (!override.start) continue;

      const occStartMs = override.start.getTime();
      const occEndMs = override.end
          ? override.end.getTime()
          : occStartMs + (DEFAULT_DURATION_MIN * 60_000);

      // Check if event overlaps with window (handles currently happening events)
      const isInWindow = occStartMs < windowEndMs && occEndMs > windowStartMs;

      if (isInWindow) {
        const title = override.summary || baseTitle || "(No title)";

        // Skip cancelled
        if (title.startsWith("Canceled:")) continue;

        occs.push({
          uid: override.uid,
          title,
          location: override.location || baseLocation || null,
          organizer: override.organizer || baseOrganizer || null,
          startMs: occStartMs,
          endMs: occEndMs
        });

        log("INFO", "Added unused override as standalone event", {
          uid: override.uid,
          title,
          start: override.start.toISOString(),
          recId: new Date(recIdMs).toISOString()
        });
      }
    }
  }

  return occs;
}

function isExcluded(date, exdates) {
  if (!exdates || exdates.length === 0) return false;

  const t = date.getTime();

  for (const exdate of exdates) {
    const values = exdate.getValues();
    for (const val of values) {
      if (val.toJSDate().getTime() === t) return true;
    }
  }

  return false;
}

function createComponentFromEvent(ev) {
  // Fallback if component not available
  const comp = new ICAL.Component("vevent");
  comp.addPropertyWithValue("uid", ev.uid);
  comp.addPropertyWithValue("summary", ev.summary);
  if (ev.start) comp.addPropertyWithValue("dtstart", ICAL.Time.fromJSDate(ev.start));
  if (ev.end) comp.addPropertyWithValue("dtend", ICAL.Time.fromJSDate(ev.end));
  if (ev.rrule) comp.addPropertyWithValue("rrule", ev.rrule);
  return comp;
}

function todayWindow(nowMs, timeZone) {
  const now = new Date(nowMs);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;

  const approxUtcMidnight = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const startMs = shiftUtcToZonedMidnightMs(approxUtcMidnight, timeZone);

  // Next local midnight can be ±1h around DST transitions,
  // so don't assume day length is always 24h.
  const nextDayApproxUtcMidnight = new Date(`${y}-${m}-${d}T00:00:00Z`);
  nextDayApproxUtcMidnight.setUTCDate(nextDayApproxUtcMidnight.getUTCDate() + 1);
  const endMs = shiftUtcToZonedMidnightMs(nextDayApproxUtcMidnight, timeZone);

  return { startMs, endMs };
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function shiftUtcToZonedMidnightMs(utcMidnightDate, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  const parts = dtf.formatToParts(utcMidnightDate);
  const get = (t) => parts.find((p) => p.type === t)?.value;

  const asIfUtc = Date.UTC(
      Number(get("year")),
      Number(get("month")) - 1,
      Number(get("day")),
      Number(get("hour")),
      Number(get("minute")),
      Number(get("second"))
  );

  const offsetMs = asIfUtc - utcMidnightDate.getTime();
  return utcMidnightDate.getTime() - offsetMs;
}

/**
 * ISO string with timezone offset in standard format: YYYY-MM-DDTHH:mm:ss+HH:mm
 */
function isoWithTimeZone(ms, timeZone) {
  const d = new Date(ms);

  // Get the formatted date/time in the target timezone
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(d);

  const get = (t) => parts.find((p) => p.type === t)?.value;

  // Calculate timezone offset
  // Create a date in the target timezone
  const tzDateStr = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

  // Get UTC timestamp for the same "wall clock" time
  const utcForSameWallClock = Date.UTC(
      parseInt(get("year")),
      parseInt(get("month")) - 1,
      parseInt(get("day")),
      parseInt(get("hour")),
      parseInt(get("minute")),
      parseInt(get("second"))
  );

  // Offset is the difference between the actual UTC time and the "wall clock" UTC time
  const offsetMinutes = Math.round((utcForSameWallClock - ms) / 60000);

  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`;

  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

function json(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    },
    body: JSON.stringify(obj)
  };
}
