import ICAL from "ical.js";
import { findIana } from "windows-iana";

/**
 * ENV:
 *  - ICS_URL (required): public .ics URL
 *  - TZ (optional): timezone for "today window", default Europe/Nicosia
 *  - DEFAULT_DURATION_MIN (optional): fallback duration if no DTEND/DURATION, default 60
 *  - CACHE_MS (optional): warm-container cache duration, default 60000
 *  - LOG_LEVEL (optional): DEBUG, INFO, WARN, ERROR; default INFO
 *  - OVERRIDE_NOW (optional): ISO datetime to use as "now" for testing, e.g. "2026-02-09T08:00:00Z"
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
    if (!ICS_URL) {
      log("ERROR", "ICS_URL env var is missing");
      return json(500, { error: "ICS_URL env var is missing" });
    }

    // Use OVERRIDE_NOW for testing, otherwise real time
    const nowMs = OVERRIDE_NOW ? new Date(OVERRIDE_NOW).getTime() : Date.now();

    if (OVERRIDE_NOW) {
      log("INFO", "Using overridden NOW", { override: OVERRIDE_NOW, nowMs: new Date(nowMs).toISOString() });
    }

    // cache
    if (cache.body && (nowMs - cache.at) < CACHE_MS) {
      log("DEBUG", "Cache hit");
      return json(200, cache.body, { "x-cache": "HIT" });
    }

    const { startMs, endMs } = todayWindow(nowMs, TZ);
    log("INFO", "Processing calendar window", {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString()
    });

    // Fetch ICS text
    const icsText = await fetchText(ICS_URL);
    log("DEBUG", "Fetched ICS", { size: icsText.length });

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
    log("DEBUG", "Separated events", {
      masters: masterEvents.length,
      overridesCount: overridesByUid.size
    });

    // Expand occurrences
    const occs = [];

    log("DEBUG", "Filter settings", {
      filterFrom: new Date(nowMs).toISOString()
    });

    // Process master events
    for (const ev of masterEvents) {
      const expanded = expandOccurrencesInWindow(ev, nowMs, endMs, overridesByUid);
      for (const o of expanded) {
        if (o.startMs >= nowMs && o.startMs < endMs) occs.push(o);
      }
    }

    // Process orphaned overrides
    for (const [uid, overrideMap] of overridesByUid.entries()) {
      if (!masterUids.has(uid)) {
        for (const [recIdMs, override] of overrideMap.entries()) {
          // Skip cancelled events
          if (override.status === "CANCELLED") continue;
          if (!override.start) continue;

          const startMs = override.start.getTime();

          if (startMs >= nowMs && startMs < endMs) {
            const endMs = override.end
                ? override.end.getTime()
                : startMs + (DEFAULT_DURATION_MIN * 60_000);

            occs.push({
              uid: override.uid,
              title: override.summary || "(No title)",
              location: override.location || null,
              organizer: override.organizer || null,
              startMs,
              endMs
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
    const triple = computeNextTriple(occs, nowMs);

    // Metrics
    const metrics = computeMetrics(occs, nowMs, triple.next);

    const body = {
      generatedAt: new Date().toISOString(),
      window: {
        start: isoWithTimeZone(startMs, TZ),
        end: isoWithTimeZone(endMs, TZ),
        tz: TZ
      },
      ...metrics,
      ...triple
    };

    cache = { at: nowMs, body };

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
    datetype: event.startDate && event.startDate.isDate ? "date" : "date-time"
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
  return icsText.replaceAll(
      /TZID=([^:;\r\n]+)/g,
      (match, winTz) => {
        const list = findIana(winTz);

        if (!list || list.length === 0) {
          log("DEBUG", "Unknown timezone", { winTz });
          return match;
        }

        // special-case for FLE Standard Time
        if (winTz === "FLE Standard Time") {
          return "TZID=Europe/Nicosia";
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

function computeNextTriple(occs, nowMs) {
  const nextIdx = occs.findIndex((o) => o.startMs > nowMs);
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
    next: toDto(next),
    nextOverlapping: toDto(nextOverlapping),
    nextNonOverlapping: toDto(nextNonOverlapping)
  };
}

function computeMetrics(occs, nowMs, nextDto) {
  const isOverlappingNow = occs.some((o) => nowMs >= o.startMs && nowMs < o.endMs);

  // Find current event if any
  const currentEvent = occs.find((o) => nowMs >= o.startMs && nowMs < o.endMs);

  if (!nextDto) {
    return {
      now: isoWithTimeZone(nowMs, TZ),
      minutesUntilNext: null,
      minutesUntilSmallAlarm: null,
      isOverlappingNow,
      current: currentEvent ? toDto(currentEvent) : null
    };
  }

  const nextStartMs = Date.parse(nextDto.start);
  const minutesUntilNext = Math.max(0, Math.round((nextStartMs - nowMs) / 60_000));
  const minutesUntilSmallAlarm = Math.max(0, minutesUntilNext - 15);

  return {
    now: isoWithTimeZone(nowMs, TZ),
    minutesUntilNext,
    minutesUntilSmallAlarm,
    isOverlappingNow,
    current: currentEvent ? toDto(currentEvent) : null
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

function expandOccurrencesInWindow(ev, windowStartMs, windowEndMs, overridesByUid) {
  const uid = ev.uid || "";
  const baseTitle = ev.summary || "(No title)";
  const uidOverrides = overridesByUid?.get(uid);

  // Skip all-day events
  if (ev.datetype === "date") {
    log("DEBUG", "Skipping all-day event", { uid, title: baseTitle });
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
    if (startMs >= windowStartMs && startMs < windowEndMs) {
      const occ = mkOcc(ev.start, null);
      // Skip cancelled events
      if (occ.status === "CANCELLED" || occ.title.startsWith("Canceled:")) {
        log("DEBUG", "Skipping cancelled event", { uid, title: occ.title, status: occ.status });
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
  let next;

  while ((next = iterator.next())) {
    const occDate = next.toJSDate();
    const occMs = occDate.getTime();

    // Stop if past window
    if (occMs >= windowEndMs) break;

    // Skip if before window
    if (occMs < windowStartMs) continue;

    // Check EXDATE
    if (isExcluded(occDate, ev.exdate)) {
      log("DEBUG", "Instance excluded by EXDATE", { uid, instance: occDate.toISOString() });
      continue;
    }

    // Check override
    const override = uidOverrides?.get(occMs) || null;

    if (override?.status === "CANCELLED") {
      log("DEBUG", "Instance cancelled", { uid, instance: occDate.toISOString() });
      continue;
    }

    const startDate = override?.start || occDate;
    const startMs = startDate.getTime();

    if (override) {
      log("DEBUG", "Override applied", {
        uid,
        originalInstance: occDate.toISOString(),
        newStart: override.start?.toISOString() || "same",
        status: override.status
      });
    }

    if (startMs >= windowStartMs && startMs < windowEndMs) {
      const occ = mkOcc(startDate, override);

      // Skip cancelled events
      if (occ.status === "CANCELLED" || occ.title.startsWith("Canceled:")) {
        log("DEBUG", "Skipping cancelled recurring event", {
          uid,
          title: occ.title,
          status: occ.status,
          instance: occDate.toISOString()
        });
        continue;
      }

      occs.push(occ);
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
  const endMs = startMs + 24 * 60 * 60 * 1000;

  return { startMs, endMs };
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
  const localDate = new Date(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`);
  const utcDate = new Date(ms);
  const offsetMinutes = Math.round((localDate.getTime() - utcDate.getTime()) / 60000);

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
