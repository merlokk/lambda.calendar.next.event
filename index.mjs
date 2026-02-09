import ical from "node-ical";

/**
 * ENV:
 *  - ICS_URL (required): public .ics URL
 *  - TZ (optional): timezone for "today window", default Europe/Nicosia
 *  - DEFAULT_DURATION_MIN (optional): fallback duration if no DTEND/DURATION, default 30
 *  - CACHE_MS (optional): warm-container cache duration, default 60000
 */
const ICS_URL = process.env.ICS_URL;
const TZ = process.env.TZ || "Europe/Nicosia";
const DEFAULT_DURATION_MIN = Number(process.env.DEFAULT_DURATION_MIN || "60");
const CACHE_MS = Number(process.env.CACHE_MS || "60000");

// warm-container cache (best effort)
let cache = { at: 0, body: null };

export const handler = async (event) => {
  try {
    if (!ICS_URL) return json(500, { error: "ICS_URL env var is missing" });

    const nowMs = Date.now();

    // cache
    if (cache.body && (nowMs - cache.at) < CACHE_MS) {
      return json(200, cache.body, { "x-cache": "HIT" });
    }

    const { startMs, endMs } = todayWindow(nowMs, TZ);

    // Fetch & parse ICS
    const data = await ical.async.fromURL(ICS_URL, { method: "GET" });
    const events = Object.values(data).filter((x) => x && x.type === "VEVENT");

    // build overrides
    const overridesByUid = buildOverridesByUid(events);

    // Expand occurrences in [now..endOfDay) (today only)
    const occs = [];
    for (const ev of events) {
      const expanded = expandOccurrencesInWindow(ev, nowMs, endMs, overridesByUid);
      for (const o of expanded) {
        // keep only events that start today and after now
        if (o.startMs > nowMs && o.startMs < endMs) occs.push(o);
      }
    }
    occs.sort((a, b) => a.startMs - b.startMs);

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
    return json(500, { error: String(e?.message ?? e) });
  }
};

function buildOverridesByUid(events) {
  // Map<uid, Map<recurrenceIdMs, overrideEvent>>
  const map = new Map();

  for (const ev of events) {
    const uid = ev.uid;
    const recId = ev.recurrenceid; // node-ical обычно кладёт Date сюда
    if (!uid || !(recId instanceof Date)) continue;

    let inner = map.get(uid);
    if (!inner) {
      inner = new Map();
      map.set(uid, inner);
    }

    inner.set(recId.getTime(), ev);
  }

  return map;
}

/**
 * Builds 3 values:
 *  - next: first event starting after now
 *  - nextOverlapping: first event that overlaps next (start < next.end)
 *  - nextNonOverlapping: first event that starts after the merged overlap cluster end
 */
function computeNextTriple(occs, nowMs) {
  const nextIdx = occs.findIndex((o) => o.startMs > nowMs);
  const next = nextIdx >= 0 ? occs[nextIdx] : null;

  if (!next) {
    return { next: null, nextOverlapping: null, nextNonOverlapping: null };
  }

  // first overlapping with `next`
  let nextOverlapping = null;
  for (let i = nextIdx + 1; i < occs.length; i++) {
    const o = occs[i];
    if (o.startMs >= next.endMs) break; // no longer overlaps `next`
    if (o.endMs > next.startMs) {
      nextOverlapping = o;
      break;
    }
  }

  // merge chain of overlaps starting from `next`
  let clusterEnd = next.endMs;
  for (let i = nextIdx + 1; i < occs.length; i++) {
    const o = occs[i];
    if (o.startMs >= clusterEnd) break;
    if (o.endMs > clusterEnd) clusterEnd = o.endMs;
  }

  // first non-overlapping after cluster
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

/**
 * Extra metrics useful for the watch app.
 * - minutesUntilNext: minutes until next start (rounded)
 * - minutesUntilSmallAlarm: minutes until (next - 15min)
 * - isOverlappingNow: whether "now" is inside ANY event interval (today occurrences only)
 */
function computeMetrics(occs, nowMs, nextDto) {
  const isOverlappingNow = occs.some((o) => nowMs >= o.startMs && nowMs < o.endMs);

  if (!nextDto) {
    return {
      now: isoWithTimeZone(nowMs, TZ),
      minutesUntilNext: null,
      minutesUntilSmallAlarm: null,
      isOverlappingNow
    };
  }

  const nextStartMs = Date.parse(nextDto.start);
  const minutesUntilNext = Math.max(0, Math.round((nextStartMs - nowMs) / 60_000));
  const minutesUntilSmallAlarm = Math.max(0, minutesUntilNext - 15);

  return {
    now: isoWithTimeZone(nowMs, TZ),
    minutesUntilNext,
    minutesUntilSmallAlarm,
    isOverlappingNow
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
  };
}

/**
 * Expand occurrences in [windowStartMs .. windowEndMs] for one VEVENT.
 * Supports:
 *  - non-recurring events
 *  - RRULE expansion via ev.rrule.between()
 *  - EXDATE exclusion via ev.exdate
 *  - RECURRENCE-ID overrides via ev.recurrences (best effort)
 */
function expandOccurrencesInWindow(ev, windowStartMs, windowEndMs, overridesByUid) {
  const uid = ev.uid || "";
  const baseTitle = ev.summary || "(No title)";
  const uidOverrides = overridesByUid?.get(uid); // Map<recIdMs, overrideEvent> | undefined

  // Skip all-day events (node-ical often sets datetype === 'date')
  if (ev.datetype === "date") return [];

  if (!(ev.start instanceof Date)) return [];

  const baseLocation = ev.location || null;
  const baseOrganizer = organizerToString(ev.organizer);

  const calcDurationMsFromEvent = (e) => {
    // Prefer explicit DTEND (as duration vs DTSTART), otherwise DURATION, otherwise fallback.
    if (e?.start instanceof Date && e?.end instanceof Date) {
      const dur = e.end.getTime() - e.start.getTime();
      // Protect against invalid negative/zero durations
      if (dur > 0 && dur < 7 * 24 * 60 * 60 * 1000) return dur;
    }

    // node-ical may provide duration in different shapes; support numeric ms if present
    if (typeof e?.duration === "number" && e.duration > 0) return e.duration;

    return DEFAULT_DURATION_MIN * 60_000;
  };

  const calcEndMs = (occStartDate, overrideEv) => {
    // If this specific instance (override) defines its own DTEND, use it as absolute.
    if (overrideEv?.end instanceof Date) {
      const endMs = overrideEv.end.getTime();
      if (endMs > occStartDate.getTime()) return endMs;
    }

    // Otherwise: use duration from override (if any), else from master event.
    const durMs = calcDurationMsFromEvent(overrideEv ?? ev);
    return occStartDate.getTime() + durMs;
  };

  const mkOcc = (startDate, overrideEv) => {
    const title = (overrideEv?.summary ?? baseTitle) || "(No title)";
    const location = overrideEv?.location ?? baseLocation ?? null;
    const organizer = organizerToString(overrideEv?.organizer) ?? baseOrganizer ?? null;

    const startMs = startDate.getTime();
    const endMs = calcEndMs(startDate, overrideEv);

    return { uid, title, location, organizer, startMs, endMs };
  };

  // Non-recurring
  if (!ev.rrule) {
    const startMs = ev.start.getTime();
    if (startMs >= windowStartMs && startMs < windowEndMs) {
      return [mkOcc(ev.start, null)];
    }
    return [];
  }

  // Recurring: expand between window
  const between = ev.rrule.between(new Date(windowStartMs), new Date(windowEndMs), true) || [];

  const isExcluded = (d) => {
    if (!ev.exdate) return false;
    const t = d.getTime();
    return Object.values(ev.exdate).some((x) => x instanceof Date && x.getTime() === t);
  };

  const occs = [];

  for (const d of between) {
    if (!(d instanceof Date)) continue;
    if (isExcluded(d)) continue;

    // Overrides via RECURRENCE-ID stored in ev.recurrences.
    // Key formats vary; try a couple best-effort keys.
    //let override = null;

    // Override is matched by RECURRENCE-ID (original instance start), not by new DTSTART.
    const override = uidOverrides?.get(d.getTime()) || null;

    // If the override cancels the instance (STATUS:CANCELLED) — skip it
    if (override?.status === "CANCELLED") continue;

    //if (ev.recurrences) {
    //  const k1 = d.toISOString(); // 2026-02-08T09:00:00.000Z
    //  const k2 = k1.replace(".000Z", "Z"); // 2026-02-08T09:00:00Z
    //  override = ev.recurrences[k2] || ev.recurrences[k1] || null;
    //}

    const startDate = (override?.start instanceof Date) ? override.start : d;
    const startMs = startDate.getTime();

    if (override) {
      console.log("OVERRIDE HIT", uid, "recId=", new Date(d.getTime()).toISOString(),
          "newStart=", override.start?.toISOString?.());
    }

    if (startMs >= windowStartMs && startMs < windowEndMs) {
      occs.push(mkOcc(startDate, override));
    }
  }

  return occs;
}

function organizerToString(org) {
  if (!org) return null;

  // node-ical organizer can be a string or an object; normalize conservatively
  if (typeof org === "string") return org;

  // common shapes:
  // - { val: 'mailto:someone@x.com', params: {...} }
  // - { value: 'mailto:..' }
  const v = org.val || org.value || org.mailto || null;
  return v ? String(v) : null;
}

/**
 * Compute today's window [startOfDay, endOfDay) for a given IANA TZ.
 * Uses Intl.DateTimeFormat; no extra deps.
 */
function todayWindow(nowMs, timeZone) {
  const now = new Date(nowMs);

  // "YYYY-MM-DD" of today in that TZ
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;

  // Approx midnight UTC for that date, then shift to zoned midnight
  const approxUtcMidnight = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const startMs = shiftUtcToZonedMidnightMs(approxUtcMidnight, timeZone);
  const endMs = startMs + 24 * 60 * 60 * 1000; // 24h

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

  // Interpret formatted zoned time as if it were UTC (Date.UTC),
  // then compute offset relative to the real utcMidnightDate.
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
 * ISO string "as seen in TZ" (for UI/debug). It’s not a perfect RFC3339 with offset
 * because JS doesn’t easily give the numeric offset without extra libs, but this is
 * stable for displaying time in the watch app.
 */
function isoWithTimeZone(ms, timeZone) {
  const d = new Date(ms);

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

  // "YYYY-MM-DDTHH:mm:ss" (без смещения)
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
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
