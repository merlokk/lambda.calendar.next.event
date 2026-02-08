# ICS → “Next Meeting” Lambda
NodeJS lambda to getting a calendar from .ics link and returning events

This AWS Lambda fetches a public `.ics` calendar, expands recurring events (RRULE), and returns:

- `next` — the next upcoming event today
- `nextOverlapping` — the next event that overlaps `next`
- `nextNonOverlapping` — the next event that starts after the merged overlap cluster

It also returns useful metrics for a client (e.g., minutes until next, whether you’re currently in a meeting).

## Output (example)

```json
{
  "generatedAt": "2026-02-08T10:12:00Z",
  "window": { "start": "2026-02-08T00:00:00", "end": "2026-02-09T00:00:00", "tz": "Europe/Nicosia" },
  "now": "2026-02-08T10:05:00",
  "minutesUntilNext": 55,
  "minutesUntilSmallAlarm": 40,
  "isOverlappingNow": false,
  "next": { "uid": "...", "title": "Standup", "location": "Teams", "organizer": "mailto:x@y", "start": "2026-02-08T09:00:00.000Z", "end": "2026-02-08T09:30:00.000Z" },
  "nextOverlapping": null,
  "nextNonOverlapping": { "...": "..." }
}
```
Note: next.start/end are returned in UTC ISO (toISOString()), while window.* and now are returned in local time for the configured timezone.

### Requirements

- AWS Lambda runtime: Node.js 18.x or 20.x
- Public ICS URL (no auth)
- Packages:
  - node-ical
  - rrule

### Files

Recommended structure:

```
lambda-ics/
├── index.mjs
├── package.json
├── package-lock.json
└── node_modules/
```

### Environment variables
|Name|Required|Default|Description|
|--------------------|--|---------|------------------------------------|
|ICS_URL|✅|—|Public URL to the .ics calendar|
|TZ|❌|	Europe/Nicosia|IANA timezone for defining “today window”|
|DEFAULT_DURATION_MIN|❌|30|Fallback duration if event has no DTEND/DURATION|
|CACHE_MS|❌|60000|Warm-container cache duration in ms|

**TZ Examples**

TZ=UTC

TZ=Europe/Nicosia

TZ=Europe/Berlin

### Deploy (ZIP upload)
1. Install dependencies locally

go to the code directory

npm install

2) Create ZIP with dependencies

zip -r lambda.zip

3) Upload to Lambda

AWS Console → Lambda → your function → Code: Upload from → .zip file

Choose lambda.zip

**configuration:**

Runtime: Node.js 18.x/20.x

Handler: index.handler

4) Configure env vars

**Lambda → Configuration → Environment variables:**

```
ICS_URL = https://example.com/calendar.ics
TZ = Europe/Nicosia
```

5) Create Function URL

**Lambda → Configuration → Function URL:**

Auth type: NONE (public) or your preferred auth

Copy the Function URL for your client app

### Local run (quick)
**Create .env file:**

```
ICS_URL=https://example.com/calendar.ics
TZ=Europe/Nicosia
CACHE_MS=60000
DEFAULT_DURATION_MIN=30
```

**Run:**

`node --env-file=.env local-run.mjs`

### CloudFront in front of the calendar (recommended)
If the original calendar host is slow (e.g., 50 seconds), put CloudFront in front of it and point ICS_URL to the CloudFront URL.

**Suggested CloudFront cache TTL:**

Min: 300

Default: 300

Max: 600

This makes calendar fetches fast and stable for Lambda and clients.


### Notes / Known limitations
The function expands recurring events only within the current day window.

Overrides via RECURRENCE-ID are handled on a best-effort basis, as provided by node-ical.

All-day events are skipped (datetype === "date").

If DTEND/DURATION is missing, DEFAULT_DURATION_MIN is used. (60 min by default)


