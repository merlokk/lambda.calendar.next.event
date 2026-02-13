# ICS → "Next Meeting" Lambda

AWS Lambda function that fetches a public `.ics` calendar and returns information about today's events, including current and upcoming meetings.

## Features

- ✅ **Current event detection** - identifies if you're currently in a meeting
- ✅ **Smart "next" event** - returns first event after current one ends (not just after NOW)
- ✅ **Recurring event support** - expands RRULE patterns with proper timezone handling
- ✅ **Override handling** - respects RECURRENCE-ID exceptions and rescheduled events
- ✅ **Timezone aware** - preserves VTIMEZONE definitions, supports Pacific/European/other timezones
- ✅ **Overlap detection** - identifies overlapping and non-overlapping event clusters
- ✅ **Warm container caching** - optional ICS file caching for performance
- ✅ **Test mode** - override NOW and timezone via query parameters

## Output Example

```json
{
  "generatedAt": "2026-02-09T10:20:00.000Z",
  "window": {
    "start": "2026-02-09T00:00:00+02:00",
    "end": "2026-02-10T00:00:00+02:00",
    "tz": "Europe/Nicosia"
  },
  "now": "2026-02-09T10:20:00+02:00",
  "minutesUntilNext": 130,
  "isOverlappingNow": true,
  "current": {
    "uid": "...",
    "title": "Daily stand-up",
    "location": "Microsoft Teams Meeting",
    "organizer": null,
    "start": "2026-02-09T10:15:00+02:00",
    "end": "2026-02-09T10:45:00+02:00"
  },
  "next": {
    "uid": "...",
    "title": "zoom meeting",
    "location": "https://zoom.us/j/...",
    "organizer": null,
    "start": "2026-02-09T12:30:00+02:00",
    "end": "2026-02-09T13:30:00+02:00"
  },
  "nextOverlapping": null,
  "nextNonOverlapping": {
    "uid": "...",
    "title": "Daily stand-up 2",
    "location": "Microsoft Teams Meeting",
    "organizer": null,
    "start": "2026-02-09T15:00:00+02:00",
    "end": "2026-02-09T15:15:00+02:00"
  }
}
```

**Note**: All timestamps include timezone offset (e.g., `+02:00`) showing local time in the configured timezone.

## Requirements

- **Runtime**: Node.js 18.x or 20.x (ESM)
- **Dependencies**:
  - `ical.js` - RFC 5545 compliant ICS parser
  - `windows-iana` - Windows timezone to IANA conversion
- **ICS URL**: Public calendar URL (no authentication)

## Environment Variables

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `ICS_URL` | ✅ | - | Public URL to the `.ics` calendar |
| `TZ` | ❌ | `Europe/Nicosia` | IANA timezone for "today window" |
| `DEFAULT_DURATION_MIN` | ❌ | `60` | Fallback duration if DTEND/DURATION missing |
| `CACHE_MS` | ❌ | `60000` | Warm-container cache duration (ms) |
| `LOG_LEVEL` | ❌ | `INFO` | Logging level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `OVERRIDE_NOW` | ❌ | - | ISO datetime for testing (e.g., `2026-02-09T10:00:00Z`) |

**Timezone Examples:**
- `TZ=UTC`
- `TZ=Europe/Nicosia`
- `TZ=America/Los_Angeles`
- `TZ=Asia/Tokyo`

## Query Parameters (Test Mode)

For testing without deploying new code:

- `?now=2026-02-09T10:20:00Z` - Override current time
- `?tz=UTC` - Override timezone
- Both can be combined: `?now=2026-02-09T10:20:00Z&tz=Europe/Berlin`

**Example**: `https://your-lambda-url.lambda-url.region.on.aws/?now=2026-02-09T08:00:00Z&tz=UTC`

## Request Body (Advanced Testing)

For testing with inline ICS content instead of fetching from URL:

```bash
# Base64 encode your ICS file
ICS_BASE64=$(cat test.ics | base64 -w 0)

# POST to Lambda
curl -X POST https://your-lambda-url/ \
  -H "Content-Type: application/json" \
  -d "{\"body\": \"$ICS_BASE64\", \"isBase64Encoded\": true, \"queryStringParameters\": {\"now\": \"2026-02-09T10:00:00Z\", \"tz\": \"UTC\"}}"
```

When request body is provided:
- `ICS_URL` environment variable is not required
- Caching is automatically disabled
- Useful for integration testing

## Deploy to AWS Lambda

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Deployment Package

```bash
zip -r lambda.zip index.mjs node_modules/ package.json
```

### 3. Upload to Lambda

**AWS Console → Lambda → Your Function → Code → Upload from → .zip file**

- Runtime: `Node.js 20.x`
- Architecture: `x86_64` or `arm64`
- Handler: `index.handler`

### 4. Configure Environment Variables

**Lambda → Configuration → Environment Variables:**

```
ICS_URL=https://example.com/calendar.ics
TZ=Europe/Nicosia
LOG_LEVEL=INFO
```

### 5. Create Function URL

**Lambda → Configuration → Function URL:**

- Auth type: `NONE` (public) or AWS_IAM
- CORS: Configure if needed for web apps
- Copy the Function URL for your client

### 6. Set Timeout

**Lambda → Configuration → General configuration:**

- Timeout: `60 seconds` (recommended for slow ICS sources)
- Memory: `256 MB` (sufficient for most calendars)

## CloudFront (Recommended)

If your calendar source is slow (>5 seconds), put CloudFront in front:

1. Create CloudFront distribution pointing to your ICS URL
2. Set cache TTL: Min `300`, Default `300`, Max `600`
3. Update Lambda environment: `ICS_URL=https://your-cloudfront-url.cloudfront.net/calendar.ics`

**Benefits:**
- Faster response times (cached at edge)
- Reduced load on the calendar source
- Better Lambda cold start performance

## Local Development

### Quick Run

```bash
# Create .env file
cat > .env << EOF
ICS_URL=https://example.com/calendar.ics
TZ=Europe/Nicosia
LOG_LEVEL=DEBUG
EOF

# Run with .env
node --env-file=.env local-run.mjs
```

### Run Tests

```bash
node test.js
```

Expected output:
```
═══════════════════════════════════════════════
Comprehensive ICS Event Processing Test Suite
Testing all edge cases from development session
═══════════════════════════════════════════════

=== Test 1: Currently Happening Event ===
✅ PASS: Currently happening event detected correctly

[... 10 more tests ...]

═══════════════════════════════════════════════
Test Summary
═══════════════════════════════════════════════
Passed: 11/11
✅ ALL TESTS PASSED
```

## How It Works

### Event Processing Logic

1. **Fetch ICS** - Download calendar from `ICS_URL` or use provided body
2. **Parse events** - Extract all VEVENT components with timezone info
3. **Separate masters and overrides** - Identify recurring patterns vs exceptions
4. **Expand recurring events** - Generate occurrences for today's window
5. **Apply overrides** - Replace/modify specific occurrences via RECURRENCE-ID
6. **Find current event** - Event where `start <= NOW < end`
7. **Find next event** - First event starting after current event ends (or after NOW if no current)
8. **Calculate overlaps** - Identify overlapping and non-overlapping clusters
9. **Return JSON** - Formatted response with all event details

### Key Behaviors

**"Next" Event Logic:**
- If currently in a meeting → Next is first event after current meeting ends
- If not in a meeting → Next is first event after NOW
- This prevents showing events you're already attending as "next"

**Overlap Detection:**
- Events are "currently happening" if: `event.start <= NOW < event.end`
- Uses interval overlap: `event.start < window.end AND event.end > window.start`
- Handles events that started before today but end today

**Timezone Handling:**
- Preserves VTIMEZONE blocks from ICS files (doesn't replace them)
- Converts Windows timezone names to IANA only when no VTIMEZONE exists
- Returns all timestamps with timezone offset (e.g., `+02:00`)

## Edge Cases Handled

✅ Event starting exactly at NOW (included as current)  
✅ Event ending exactly at NOW (excluded)  
✅ Event started before today, ends today (included)  
✅ Recurring events with moved instances (RECURRENCE-ID)  
✅ Orphaned overrides (override without master)  
✅ Cancelled events (STATUS:CANCELLED or "Canceled:" prefix)  
✅ All-day events (skipped)  
✅ Missing DTEND (uses DEFAULT_DURATION_MIN)  
✅ Pacific/European/other timezones with DST transitions  
✅ Multiple overlapping events

## Troubleshooting

### No events returned

**Check:**
1. Is `ICS_URL` accessible and returning valid ICS?
2. Are there events in today's window for the configured timezone?
3. Try `?now=<timestamp>&tz=UTC` to test different times
4. Set `LOG_LEVEL=DEBUG` to see detailed parsing logs

### Wrong timezone

**Check:**
1. `TZ` environment variable matches your calendar's timezone
2. Calendar contains VTIMEZONE definitions or uses standard IANA names
3. Windows timezone names are being converted (check logs)

### Recurring events missing

**Check:**
1. RRULE is valid and not expired (check UNTIL date)
2. Event is not excluded by EXDATE
3. Event is not cancelled by an override with STATUS:CANCELLED

### Slow response times

**Solutions:**
1. Enable CloudFront in front of ICS_URL
2. Increase Lambda memory (faster CPU)
3. Reduce `CACHE_MS` if calendar updates frequently
4. Check if calendar source is slow (use CloudWatch logs)

## Performance Notes

- **Cold start**: ~500ms with ical.js library
- **Warm execution**: ~50-200ms (with cache hit)
- **Cache hit**: No ICS fetch, instant response
- **Cache miss**: Depends on ICS source speed
- **Memory usage**: ~50-100MB for typical calendars

## Known Limitations

- Only expands events within today's window (not multi-day)
- All-day events are skipped
- Requires public ICS URL (no authentication support)
- No support for VTODO, VJOURNAL (only VEVENT)
- Maximum file size limited by Lambda (6MB request/response)

## Security Considerations

- ICS_URL is validated before fetching
- Request timeout: 30 seconds
- No support for authenticated calendars (prevents credential exposure)
- Query parameters are sanitized
- Event titles/descriptions are not sanitized (ensure proper handling in client)

## License

MIT

## Support

For issues or questions, please refer to:
- Test suite: `test.js`
- AI generation prompt: `create_prompt.md`