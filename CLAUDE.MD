# ICS Calendar Handler - Development Guide

## Overview
Lambda function that processes ICS calendars and returns current/next events with timezone-aware handling and recurring event expansion.

## Architecture

### Stack
- **Runtime**: Node.js 20.x ESM
- **Parser**: ical.js (RFC 5545 compliant)
- **Timezone**: windows-iana (Windows→IANA conversion)
- **Storage**: Optional warm-container caching

### Key Components
```
handler(event) → fetchICS() → normalizeTimezones() → parseEvents() 
  → expandRecurring() → applyOverrides() → computeCurrent/Next() → response
```

## Critical Bugs Fixed

### 1. Recurring Event Duration Bug
**Problem**: Used master event's end time for all occurrences
```javascript
// ❌ Wrong
endMs = masterEvent.end  // Nov 20, 2025 for Feb 9, 2026 occurrence

// ✅ Correct  
duration = masterEvent.end - masterEvent.start
endMs = occurrenceStart + duration
```

### 2. Next Event Logic Bug
**Problem**: Next = first after NOW, not after current event ends
```javascript
// ❌ Wrong
next = events.find(e => e.start > NOW)

// ✅ Correct
current = findCurrentEvent(NOW)
searchFrom = current ? current.end : NOW
next = events.find(e => e.start >= searchFrom)
```

### 3. VTIMEZONE Preservation Bug
**Problem**: Replaced timezone names but kept old VTIMEZONE blocks
```javascript
// ❌ Wrong - breaks timezone lookup
icsText.replace('TZID=Pacific Standard Time', 'TZID=America/Los_Angeles')
// But VTIMEZONE still says "Pacific Standard Time"

// ✅ Correct - preserve if VTIMEZONE exists
if (vtimezones.has(tzid)) return match  // Keep original
```

### 4. Window Expansion Parameter Bug
**Problem**: Expanded from NOW instead of day start
```javascript
// ❌ Wrong - misses morning events
expandEvents(event, nowMs, windowEnd)

// ✅ Correct - expand full day window
expandEvents(event, windowStart, windowEnd)
// Then filter: keep if end > NOW
```

### 5. Central Europe Timezone Bug
**Problem**: No VTIMEZONE for "Central Europe Standard Time"
```javascript
// ✅ Solution - auto-inject VTIMEZONE
if (!vtimezones.has("Central Europe Standard Time")) {
  const cetVTZ = createCETTimezone()  // UTC+1 winter, UTC+2 summer
  icsText = icsText.replace('BEGIN:VEVENT', cetVTZ + 'BEGIN:VEVENT')
}
```

### 6. Outlook Encoding Issues
**Problem**: Line folding and quoted-printable not handled
```javascript
// ✅ Solution
// 1. Unfold lines: CRLF + space/tab = continuation
icsText = icsText.replace(/\r?\n[ \t]/g, '')

// 2. Decode quoted-printable: =20 → space, =3D → =
icsText = icsText.replace(/(TZID=)([^:;\r\n]+)/g, (m, p, tzid) => {
  return p + tzid.replace(/=20/g, ' ').replace(/=3D/g, '=')
})
```

## Best Practices

### Timezone Handling
1. **Always preserve VTIMEZONE blocks** - don't replace if exists in file
2. **Check for missing VTIMEZONEs** - inject common ones (CET, PST) if needed
3. **Use IANA names** - convert Windows names only when no VTIMEZONE
4. **Test DST boundaries** - winter/summer offset changes

### Recurring Events
1. **Calculate duration once** - `duration = end - start`
2. **Apply per occurrence** - `occEnd = occStart + duration`
3. **Preserve component** - keep original VEVENT for iterator
4. **Handle overrides first** - check RECURRENCE-ID before master

### Window Logic
1. **Expand full day** - `[midnight, midnight+24h)` in user timezone
2. **Filter by NOW** - include if `event.end > NOW`
3. **Use overlap detection** - `start < windowEnd && end > windowStart`
4. **Account for current event** - next = first after current.end

### Performance
1. **Cache ICS fetches** - 60 second TTL for warm containers
2. **Skip all-day events** - filter early (`datetype === "date"`)
3. **Limit expansion** - stop iterator at `windowEnd`
4. **Batch overrides** - Map by UID for O(1) lookup

### Error Handling
1. **Validate inputs** - check NOW, TZ, ICS_URL
2. **Graceful degradation** - skip unparseable events
3. **Log appropriately** - DEBUG for normal, WARN for issues, ERROR for failures
4. **Never expose internals** - sanitize UIDs, error messages

### Testing Strategy
1. **Edge cases first** - boundaries, overlaps, timezones
2. **Isolated unit tests** - each bug gets own test
3. **Use inline ICS** - avoid external dependencies
4. **Test both modes** - URL fetch + body upload
5. **Timezone combinations** - UTC, Pacific, CET, local

## Common Pitfalls

### ❌ Don't
- Use master event's end for recurring occurrences
- Calculate next from NOW when current event exists
- Replace timezone names without checking VTIMEZONE
- Expand events from NOW instead of window start
- Parse raw ICS text before unfolding lines
- Assume timezone = UTC if not specified
- Filter events before expansion completes
- Hard-code timezone offsets

### ✅ Do
- Calculate duration and apply to each occurrence
- Find next event after current event ends
- Preserve VTIMEZONE blocks from ICS file
- Expand from day start, filter by NOW after
- Unfold + decode before regex processing
- Use library's timezone handling (ical.js)
- Expand first, then apply all filters
- Use IANA timezone database

## Testing Checklist

- [ ] Currently happening event (start ≤ NOW < end)
- [ ] Event starting exactly at NOW
- [ ] Event ending exactly at NOW (excluded)
- [ ] Next event after current ends
- [ ] Recurring event duration per occurrence
- [ ] Pacific timezone (UTC-8 winter, UTC-7 summer)
- [ ] Central Europe timezone (UTC+1 winter, UTC+2 summer)
- [ ] Window expansion includes morning events
- [ ] Folded lines (space-prefixed continuation)
- [ ] Quoted-printable encoding (=20, =3D)
- [ ] Orphaned overrides (no master)
- [ ] Cancelled events (STATUS:CANCELLED)
- [ ] Missing DTEND (use default duration)
- [ ] Multiple overlapping events

Run: `node test-overlap-detection.js` → Expected: `14/14 passed`

## Debugging

### Event not appearing?
1. Check timezone conversion: `LOG_LEVEL=DEBUG`
2. Verify RRULE UNTIL hasn't expired
3. Test with `?now=<timestamp>&tz=UTC`
4. Confirm window includes event time

### Wrong time displayed?
1. Check VTIMEZONE exists for timezone
2. Verify DST rules (winter vs summer)
3. Test with known timezone (Europe/Warsaw)
4. Check for quoted-printable encoding

### Next event wrong?
1. Confirm current event detected correctly
2. Verify next is after current.end not NOW
3. Check for overlapping events
4. Review nextNonOverlapping logic

## Deployment

```bash
# 1. Install dependencies
npm install

# 2. Run tests
node test-overlap-detection.js

# 3. Package
zip -r lambda.zip index.mjs node_modules/ package.json

# 4. Deploy to Lambda
# Runtime: Node.js 20.x
# Handler: index.handler
# Timeout: 30s
# Memory: 256MB

# 5. Set environment variables
ICS_URL=https://example.com/calendar.ics
TZ=Europe/Nicosia
LOG_LEVEL=INFO

# 6. Test
curl "https://your-lambda-url/?now=2026-02-09T10:00:00Z"
```

## Resources

- RFC 5545: iCalendar specification
- ical.js docs: mozilla-comm.github.io/ical.js
- Test suite: test-overlap-detection.js
- AI prompt: create_prompt.md.md
