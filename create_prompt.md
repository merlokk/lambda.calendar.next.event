# Prompt: ICS Calendar Event Handler

## Overview
Create a serverless function that processes ICS (iCalendar) files and returns information about calendar events for a specific day, including current and next events.

## Core Requirements

### Input
- ICS file content (can be fetched from URL or provided inline as base64)
- NOW timestamp (current time, can be overridden for testing)
- Timezone (e.g., "Europe/Nicosia", "UTC")
- Optional query parameters for testing (now, tz)

### Output JSON Structure
```json
{
  "generatedAt": "ISO timestamp",
  "window": {
    "start": "ISO with timezone",
    "end": "ISO with timezone", 
    "tz": "timezone name"
  },
  "now": "ISO with timezone",
  "minutesUntilNext": number or null,
  "isOverlappingNow": boolean,
  "current": {
    "uid": "string",
    "title": "string",
    "location": "string or null",
    "organizer": "string or null",
    "start": "ISO with timezone",
    "end": "ISO with timezone"
  } or null,
  "next": { /* same structure */ } or null,
  "nextOverlapping": { /* same structure */ } or null,
  "nextNonOverlapping": { /* same structure */ } or null
}
```

## Critical Implementation Details

### 1. Window Calculation
- Calculate "today's window" in the user's timezone
- Window = [midnight today, midnight tomorrow) in specified timezone
- Convert to UTC milliseconds for internal processing
- **CRITICAL**: When expanding recurring events, use window START (midnight), NOT current NOW time
    - Wrong: `expandEvents(event, nowMs, windowEnd)`
    - Correct: `expandEvents(event, windowStart, windowEnd)`
    - This ensures events earlier in the day are found

### 2. Timezone Handling
**CRITICAL**: Preserve VTIMEZONE definitions from ICS files

When normalizing timezone names:
1. First scan the ICS file for all VTIMEZONE blocks and extract their TZID values
2. DO NOT replace timezone names that have VTIMEZONE definitions in the file
3. Only convert Windows timezone names to IANA equivalents if NO VTIMEZONE exists
4. Example problem: Converting "Pacific Standard Time" to "America/Los_Angeles" breaks if VTIMEZONE for "Pacific Standard Time" exists in file

**Why this matters**: ICS files often contain VTIMEZONE blocks with UTC offset rules. If you replace the TZID reference but keep the old VTIMEZONE block, the parser cannot find the matching timezone definition and uses wrong offsets.

### 3. Recurring Event Processing

#### Duration Calculation
**CRITICAL BUG TO AVOID**: For recurring events, calculate duration from master event and apply to each occurrence

Wrong approach:
```
occurrence.endMs = masterEvent.end  // Uses first occurrence's end time!
```

Correct approach:
```
duration = masterEvent.end - masterEvent.start
occurrence.endMs = occurrence.start + duration
```

**Why this fails**: If master event is Nov 20, 2025 11:00-11:15, and you're checking Feb 9, 2026:
- Wrong: endMs = Nov 20, 2025 11:15 → Result: startMs > endMs ❌
- Correct: endMs = Feb 9, 2026 11:15 ✅

#### Component Preservation
When parsing VEVENT objects, preserve the original component/object for recurring event expansion. The iterator needs access to timezone information, RRULE details, and EXDATE properties that may not be extracted into simple fields.

### 4. Current vs Next Event Logic

**CRITICAL**: "Next" event must be first event AFTER current event ENDS, not after NOW

Wrong logic:
```
next = events.find(e => e.start > NOW)
```

Correct logic:
```
current = events.find(e => e.start <= NOW && e.end > NOW)
searchFrom = current ? current.end : NOW
next = events.find(e => e.start >= searchFrom)
```

**Why this matters**:
- NOW: 10:20
- Current: 10:15-10:45 (Daily stand-up)
- Events: 12:30 (PayPal), 15:00 (Afternoon)
- Wrong: next = PayPal (first after NOW)
- Correct: next = PayPal (first after current ends at 10:45)

### 5. Overlap Detection

Events should be included if they overlap with the relevant time window. Use standard interval overlap logic:

```
Event overlaps window if:
  event.start < window.end AND event.end > window.start
```

**Apply this in two places:**

1. **Main filter** (after expansion): Include event if overlaps [NOW, window.end)
   ```
   event.start < windowEnd AND event.end > NOW
   ```

2. **Recurring event expansion**: Check if each occurrence overlaps the day window
    - Calculate proper endMs for the occurrence (start + duration)
    - Check overlap before adding to results

### 6. Override Handling

ICS files can have:
- Master events with RRULE (recurring pattern)
- Override events with RECURRENCE-ID (exceptions to the pattern)

**Three scenarios:**

1. **Used overrides**: Override has matching master event
    - Apply override to that specific occurrence
    - Master handles the recurring pattern

2. **Unused overrides**: Override exists but no master event found (orphaned)
    - Could be from deleted master or future series
    - Check against WINDOW boundaries (not NOW) since they're standalone
    - Include if: `override.start >= windowStart AND override.start < windowEnd`

3. **Unused overrides within recurring series**: Master stopped but overrides continue
    - During expansion, track which overrides were used
    - After iteration, add unused overrides as standalone events
    - Use overlap detection: `override.start < windowEnd AND override.end > windowStart`

### 7. Edge Cases to Handle

#### Time Boundaries
- Event starting exactly at NOW: Should be current ✅
- Event ending exactly at NOW: Should NOT be current ❌
- Event started 1 minute ago: Should be current ✅

#### All-Day Events
- Skip all-day events (datetype === "date")
- They complicate the "current event" logic

#### Cancelled Events
- Skip events with STATUS:CANCELLED
- Skip events with title starting with "Canceled:"
- Check both master and override status

#### Missing Data
- Events without DTEND: Use default duration (e.g., 60 minutes)
- Events without UID: Log warning and skip
- Events without DTSTART: Log warning and skip

### 8. NextOverlapping and NextNonOverlapping

After finding "next" event:

**NextOverlapping**: First event that overlaps with "next"
```
for each event after next:
  if event.start >= next.end: break  // No more overlaps possible
  if event.end > next.start: return event  // Found overlap
```

**NextNonOverlapping**: First event after the overlapping cluster
```
clusterEnd = next.end
for each event after next:
  if event.start >= clusterEnd: break
  if event.end > clusterEnd: clusterEnd = event.end  // Extend cluster

for each event after next:
  if event.start >= clusterEnd: return event  // First after cluster
```

## Testing Requirements

Create comprehensive tests covering:

1. ✅ Currently happening event detection
2. ✅ Event starting exactly at NOW
3. ✅ Event ending exactly at NOW (excluded)
4. ✅ Future event placement
5. ✅ Unused override currently happening
6. ✅ Multiple events with correct current/next
7. ✅ Event starting just before NOW
8. ✅ Next event after current ends (not after NOW)
9. ✅ Recurring event duration calculation
10. ✅ Pacific timezone with VTIMEZONE blocks
11. ✅ Window expansion includes events before NOW

## Performance Considerations

1. **Caching**: Implement optional caching of fetched ICS files (e.g., 60 second TTL)
2. **Iterator optimization**: For recurring events far in future, use smart skip logic:
   ```
   if occurrence + maxEventDuration < windowStart:
     continue  // Skip events that definitely ended before window
   ```
3. **Date parsing**: Parse RRULE UNTIL correctly - may be in local time or UTC depending on format

## Output Format Details

### ISO with Timezone
Return timestamps in format: `YYYY-MM-DDTHH:mm:ss±HH:mm`

Example: `2026-02-09T10:15:00+02:00` for Europe/Nicosia

**Not**: `2026-02-09T08:15:00Z` (UTC format)

This shows the actual local time in the user's timezone.

### Minutes Until Next
Calculate as: `Math.max(0, Math.round((next.start - NOW) / 60000))`

Return null if no next event exists.

## Common Pitfalls to Avoid

### ❌ Wrong: Using master event's end time for all occurrences
```
for each occurrence:
  endMs = masterEvent.end.getTime()  // WRONG!
```

### ✅ Correct: Calculate duration once, apply to each occurrence
```
duration = masterEvent.end - masterEvent.start
for each occurrence:
  endMs = occurrence.start + duration
```

### ❌ Wrong: Next event after NOW when current exists
```
next = events.find(e => e.start > NOW)
```

### ✅ Correct: Next event after current ends
```
current = findCurrent(events, NOW)
searchFrom = current ? current.end : NOW
next = events.find(e => e.start >= searchFrom)
```

### ❌ Wrong: Replacing all timezone names blindly
```
icsText.replace(/TZID=Pacific Standard Time/g, 'TZID=America/Los_Angeles')
// But VTIMEZONE block still says TZID:Pacific Standard Time!
```

### ✅ Correct: Preserve timezones with VTIMEZONE definitions
```
vtimezones = extractVTIMEZONEIds(icsText)
if vtimezones.has(tzid):
  keep original name
else:
  convert to IANA
```

### ❌ Wrong: Window expansion from NOW
```
expandEvents(event, NOW, windowEnd)
// Misses events earlier in the day
```

### ✅ Correct: Window expansion from day start
```
expandEvents(event, windowStart, windowEnd)
// Then filter: keep if end > NOW
```

## Success Criteria

The implementation is correct when:

1. ✅ All 11 test cases pass
2. ✅ Events in Pacific timezone show correct times (09:00 PST = 17:00 UTC)
3. ✅ Currently happening events are detected (overlap detection works)
4. ✅ Next event is correctly identified even when current event is happening
5. ✅ Recurring events on Feb 9, 2026 show correct end times (not Nov 2025 times)
6. ✅ Events earlier in the day than NOW are still found
7. ✅ Orphaned overrides are processed correctly
8. ✅ VTIMEZONE blocks are preserved and used correctly

## Implementation Notes

- Use a well-tested ICS parsing library (do not write parser from scratch)
- Support both ES modules and CommonJS if needed for serverless environments
- Implement structured logging with levels (DEBUG, INFO, WARN, ERROR)
- Handle malformed ICS files gracefully with error messages
- Return cache status in headers (HIT/MISS) for debugging

## Security Considerations

- Validate ICS_URL before fetching (prevent SSRF)
- Limit ICS file size (e.g., 10MB max)
- Set timeout on HTTP requests (e.g., 30 seconds)
- Sanitize event titles/descriptions in output (prevent XSS if rendered in web)

---

**Remember**: The most critical bugs are:
1. Timezone handling (preserve VTIMEZONE blocks)
2. Recurring event duration (calculate per occurrence)
3. Next event logic (after current ends, not after NOW)
4. Window expansion (use day start, not NOW)

Get these right and everything else falls into place.
