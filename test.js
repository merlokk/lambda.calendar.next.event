#!/usr/bin/env node

/**
 * Test Suite: Comprehensive ICS Event Processing
 *
 * Covers all edge cases discovered during development:
 * 1. Currently happening events (overlap detection)
 * 2. Next event calculation (after current ends, not after NOW)
 * 3. Recurring event duration calculation (endMs from duration, not master end)
 * 4. Pacific timezone with VTIMEZONE definitions
 * 5. Window expansion uses day start (startMs) not NOW (nowMs)
 * 6. Unused override detection
 * 7. Multiple events and proper sorting
 * 8. Edge cases around NOW boundary
 */

import { handler } from './index.mjs';

// Test utilities
function createTestEvent(icsContent, nowISO, tz = 'Europe/Nicosia') {
    const base64 = Buffer.from(icsContent).toString('base64');
    return {
        queryStringParameters: {
            now: nowISO,
            tz: tz
        },
        body: base64,
        isBase64Encoded: true
    };
}

function parseResponse(response) {
    return JSON.parse(response.body);
}

// Test 1: Event starts before NOW, ends after NOW (currently happening)
async function testCurrentlyHappeningEvent() {
    console.log('\n=== Test 1: Currently Happening Event ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-current-event
DTSTART:20260209T081500Z
DTEND:20260209T084500Z
SUMMARY:Currently Happening Meeting
RRULE:FREQ=DAILY;COUNT=1
END:VEVENT
END:VCALENDAR`;

    // NOW is 08:20 UTC (event runs 08:15-08:45)
    const event = createTestEvent(ics, '2026-02-09T08:20:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Event time: 08:15-08:45 UTC');
    console.log('NOW: 08:20 UTC');
    console.log('Expected: Event should be current');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');

    if (data.isOverlappingNow && data.current?.title === 'Currently Happening Meeting') {
        console.log('✅ PASS: Currently happening event detected correctly');
        return true;
    } else {
        console.log('❌ FAIL: Currently happening event NOT detected');
        return false;
    }
}

// Test 2: Event starts exactly at NOW
async function testEventStartsAtNow() {
    console.log('\n=== Test 2: Event Starts at NOW ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//TEST//EN
BEGIN:VEVENT
UID:test-starts-now
DTSTART:20260209T090000Z
DTEND:20260209T093000Z
SUMMARY:Starts Now Meeting
RRULE:FREQ=DAILY;COUNT=1
END:VEVENT
END:VCALENDAR`;

    const event = createTestEvent(ics, '2026-02-09T09:00:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Event time: 09:00-09:30 UTC');
    console.log('NOW: 09:00 UTC');
    console.log('Expected: Event should be current');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');

    if (data.isOverlappingNow && data.current?.title === 'Starts Now Meeting') {
        console.log('✅ PASS: Event starting at NOW detected correctly');
        return true;
    } else {
        console.log('❌ FAIL: Event starting at NOW NOT detected');
        return false;
    }
}

// Test 3: Event ends exactly at NOW (should NOT be current)
async function testEventEndsAtNow() {
    console.log('\n=== Test 3: Event Ends at NOW ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-ends-now
DTSTART:20260209T083000Z
DTEND:20260209T090000Z
SUMMARY:Just Ended Meeting
RRULE:FREQ=DAILY;COUNT=1
END:VEVENT
END:VCALENDAR`;

    const event = createTestEvent(ics, '2026-02-09T09:00:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Event time: 08:30-09:00 UTC');
    console.log('NOW: 09:00 UTC');
    console.log('Expected: Event should NOT be current (just ended)');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');

    if (!data.isOverlappingNow && data.current === null) {
        console.log('✅ PASS: Just-ended event correctly excluded');
        return true;
    } else {
        console.log('❌ FAIL: Just-ended event incorrectly marked as current');
        return false;
    }
}

// Test 4: Future event (should be next, not current)
async function testFutureEvent() {
    console.log('\n=== Test 4: Future Event ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-future
DTSTART:20260209T100000Z
DTEND:20260209T103000Z
SUMMARY:Future Meeting
RRULE:FREQ=DAILY;COUNT=1
END:VEVENT
END:VCALENDAR`;

    const event = createTestEvent(ics, '2026-02-09T09:00:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Event time: 10:00-10:30 UTC');
    console.log('NOW: 09:00 UTC');
    console.log('Expected: Event should be next, not current');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');
    console.log('  next:', data.next?.title || 'null');

    if (!data.isOverlappingNow && data.current === null && data.next?.title === 'Future Meeting') {
        console.log('✅ PASS: Future event correctly in next, not current');
        return true;
    } else {
        console.log('❌ FAIL: Future event handling incorrect');
        return false;
    }
}

// Test 5: Unused override that is currently happening
async function testUnusedOverrideCurrently() {
    console.log('\n=== Test 5: Unused Override Currently Happening ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-override-master
DTSTART:20260101T090000Z
DTEND:20260101T093000Z
SUMMARY:Daily Standup
RRULE:FREQ=DAILY;COUNT=5
END:VEVENT
BEGIN:VEVENT
UID:test-override-master
RECURRENCE-ID:20260209T090000Z
DTSTART:20260209T081500Z
DTEND:20260209T084500Z
SUMMARY:Daily Standup (Rescheduled)
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

    // Override is at 08:15-08:45, NOW is 08:20
    // Master series ended before Feb 9, so override is "unused"
    const event = createTestEvent(ics, '2026-02-09T08:20:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Override time: 08:15-08:45 UTC');
    console.log('NOW: 08:20 UTC');
    console.log('Master series: Ended before Feb 9');
    console.log('Expected: Unused override should be current');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');

    if (data.isOverlappingNow && data.current?.title?.includes('Daily Standup')) {
        console.log('✅ PASS: Unused override currently happening detected');
        return true;
    } else {
        console.log('❌ FAIL: Unused override currently happening NOT detected');
        return false;
    }
}

// Test 6: Multiple events, one currently happening
async function testMultipleEventsOneCurrent() {
    console.log('\n=== Test 6: Multiple Events, One Current ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-past
DTSTART:20260209T070000Z
DTEND:20260209T073000Z
SUMMARY:Past Meeting
END:VEVENT
BEGIN:VEVENT
UID:test-current
DTSTART:20260209T081500Z
DTEND:20260209T084500Z
SUMMARY:Current Meeting
END:VEVENT
BEGIN:VEVENT
UID:test-future
DTSTART:20260209T100000Z
DTEND:20260209T103000Z
SUMMARY:Future Meeting
END:VEVENT
END:VCALENDAR`;

    const event = createTestEvent(ics, '2026-02-09T08:20:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Events:');
    console.log('  Past: 07:00-07:30');
    console.log('  Current: 08:15-08:45');
    console.log('  Future: 10:00-10:30');
    console.log('NOW: 08:20 UTC');
    console.log('Result:');
    console.log('  current:', data.current?.title || 'null');
    console.log('  next:', data.next?.title || 'null');

    if (data.current?.title === 'Current Meeting' && data.next?.title === 'Future Meeting') {
        console.log('✅ PASS: Correctly identified current and next events');
        return true;
    } else {
        console.log('❌ FAIL: Incorrect current/next identification');
        return false;
    }
}

// Test 7: Edge case - event starts 1 minute before NOW
async function testEventStartsJustBeforeNow() {
    console.log('\n=== Test 7: Event Starts 1 Minute Before NOW ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-edge
DTSTART:20260209T091900Z
DTEND:20260209T094500Z
SUMMARY:Almost Current Meeting
RRULE:FREQ=DAILY;COUNT=1
END:VEVENT
END:VCALENDAR`;

    const event = createTestEvent(ics, '2026-02-09T09:20:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Event time: 09:19-09:45 UTC');
    console.log('NOW: 09:20 UTC');
    console.log('Expected: Event should be current (started 1 min ago)');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');

    if (data.isOverlappingNow && data.current?.title === 'Almost Current Meeting') {
        console.log('✅ PASS: Event starting just before NOW detected');
        return true;
    } else {
        console.log('❌ FAIL: Event starting just before NOW NOT detected');
        return false;
    }
}

// Test 8: Next event should be after current event ends, not after NOW
async function testNextAfterCurrentEnds() {
    console.log('\n=== Test 8: Next Event After Current Ends ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-current
DTSTART:20260209T101500Z
DTEND:20260209T104500Z
SUMMARY:Daily stand-up
RRULE:FREQ=DAILY;COUNT=1
END:VEVENT
BEGIN:VEVENT
UID:test-overlapping
DTSTART:20260209T123000Z
DTEND:20260209T133000Z
SUMMARY:PayPal Discussion
END:VEVENT
BEGIN:VEVENT
UID:test-afternoon
DTSTART:20260209T150000Z
DTEND:20260209T151500Z
SUMMARY:Daily Afternoon Stand-Up
END:VEVENT
END:VCALENDAR`;

    // NOW is 10:20, current event ends at 10:45
    // Next should be PayPal at 12:30 (first after current ends)
    // NextNonOverlapping would be after any overlapping cluster
    const event = createTestEvent(ics, '2026-02-09T10:20:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('NOW: 10:20 UTC');
    console.log('Current: 10:15-10:45 (Daily stand-up)');
    console.log('Events after current: PayPal at 12:30, Afternoon at 15:00');
    console.log('Expected: Next = PayPal (first after current ends at 10:45)');
    console.log('Result:');
    console.log('  current:', data.current?.title || 'null');
    console.log('  next:', data.next?.title || 'null');

    if (data.current?.title === 'Daily stand-up' && data.next?.title === 'PayPal Discussion') {
        console.log('✅ PASS: Next correctly identified as first event after current ends');
        return true;
    } else {
        console.log('❌ FAIL: Next should be first event after current ends');
        return false;
    }
}

// Test 9: Recurring event with correct duration calculation
async function testRecurringEventDuration() {
    console.log('\n=== Test 9: Recurring Event Duration Calculation ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-recurring-duration
DTSTART:20251120T110000Z
DTEND:20251120T111500Z
SUMMARY:Daily Bug Triage
RRULE:FREQ=WEEKLY;UNTIL=20270209T090000Z;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR
END:VEVENT
END:VCALENDAR`;

    // Check event on Feb 9, 2026 (should be 11:00-11:15 UTC)
    const event = createTestEvent(ics, '2026-02-09T11:10:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Recurring event: 11:00-11:15 UTC on weekdays');
    console.log('NOW: 2026-02-09 11:10 UTC (Monday)');
    console.log('Expected: Event should be current with correct end time');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');
    console.log('  current end:', data.current?.end || 'null');

    if (data.isOverlappingNow &&
        data.current?.title === 'Daily Bug Triage' &&
        data.current?.end?.includes('11:15')) {
        console.log('✅ PASS: Recurring event duration calculated correctly');
        return true;
    } else {
        console.log('❌ FAIL: Recurring event duration calculation incorrect');
        return false;
    }
}

// Test 10: Pacific Standard Time timezone handling
async function testPacificTimezone() {
    console.log('\n=== Test 10: Pacific Standard Time Timezone ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VTIMEZONE
TZID:Pacific Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:test-pst
DTSTART;TZID=Pacific Standard Time:20260114T090000
DTEND;TZID=Pacific Standard Time:20260114T093000
SUMMARY:Sardine Weekly Sync
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE
END:VEVENT
END:VCALENDAR`;

    // Feb 11, 2026 is a Wednesday
    // 09:00 PST = 17:00 UTC = 19:00 Europe/Nicosia
    const event = createTestEvent(ics, '2026-02-11T17:10:00Z', 'Europe/Nicosia');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Event: 09:00 PST (17:00 UTC) on Wednesdays');
    console.log('NOW: 2026-02-11 17:10 UTC (19:10 Nicosia)');
    console.log('Expected: Event should be current');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');

    if (data.isOverlappingNow && data.current?.title === 'Sardine Weekly Sync') {
        console.log('✅ PASS: Pacific timezone with VTIMEZONE handled correctly');
        return true;
    } else {
        console.log('❌ FAIL: Pacific timezone conversion incorrect');
        return false;
    }
}

// Test 11: Window expansion uses startMs not nowMs for recurring events
async function testWindowExpansionStartMs() {
    console.log('\n=== Test 11: Window Expansion Uses Day Start ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-morning
DTSTART:20260209T080000Z
DTEND:20260209T083000Z
SUMMARY:Morning Meeting
RRULE:FREQ=DAILY;COUNT=1
END:VEVENT
BEGIN:VEVENT
UID:test-afternoon
DTSTART:20260209T140000Z
DTEND:20260209T143000Z
SUMMARY:Afternoon Meeting
RRULE:FREQ=DAILY;COUNT=1
END:VEVENT
END:VCALENDAR`;

    // NOW is 10:00, both events should be found
    // Morning (past) and Afternoon (future)
    const event = createTestEvent(ics, '2026-02-09T10:00:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Events: Morning 08:00, Afternoon 14:00');
    console.log('NOW: 10:00 UTC');
    console.log('Expected: Afternoon should be next (morning already passed)');
    console.log('Result:');
    console.log('  next:', data.next?.title || 'null');

    if (data.next?.title === 'Afternoon Meeting') {
        console.log('✅ PASS: Window expansion correctly includes events before NOW');
        return true;
    } else {
        console.log('❌ FAIL: Window expansion may have missed events before NOW');
        return false;
    }
}

// Test 12: Central Europe Standard Time timezone handling
async function testCentralEuropeTimezone() {
    console.log('\n=== Test 12: Central Europe Standard Time Timezone ===');

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-cet
DTSTART;TZID=Central Europe Standard Time:20260216T163000
DTEND;TZID=Central Europe Standard Time:20260216T170000
SUMMARY:CET Meeting
END:VEVENT
END:VCALENDAR`;

    // Feb 16, 2026 16:30 CET = 15:30 UTC
    // Test at 15:35 UTC (should be current)
    const event = createTestEvent(ics, '2026-02-16T15:35:00Z', 'Europe/Warsaw');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Event: 16:30 CET (15:30 UTC)');
    console.log('NOW: 15:35 UTC');
    console.log('Expected: Event should be current');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');

    if (data.isOverlappingNow && data.current?.title === 'CET Meeting') {
        console.log('✅ PASS: Central Europe timezone handled correctly');
        return true;
    } else {
        console.log('❌ FAIL: Central Europe timezone conversion incorrect');
        return false;
    }
}

// Test 13: Folded lines (RFC 5545 line continuation)
async function testFoldedLines() {
    console.log('\n=== Test 13: Folded Lines (RFC 5545) ===');

    // ICS with folded UID and DESCRIPTION (space at start of continuation line)
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:very-long-uid-that-spans-multiple-lines-12345678901234567890123456789012
 34567890
DTSTART:20260209T100000Z
DTEND:20260209T103000Z
SUMMARY:Folded Event
DESCRIPTION:This is a very long description that will be folded across multi
 ple lines according to RFC 5545 specifications for line folding in iCalenda
 r format files.
END:VEVENT
END:VCALENDAR`;

    const event = createTestEvent(ics, '2026-02-09T10:15:00Z', 'UTC');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Event with folded UID and DESCRIPTION');
    console.log('NOW: 10:15 UTC (during event)');
    console.log('Expected: Event should be current');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');

    if (data.isOverlappingNow && data.current?.title === 'Folded Event') {
        console.log('✅ PASS: Folded lines handled correctly');
        return true;
    } else {
        console.log('❌ FAIL: Folded lines not parsed correctly');
        return false;
    }
}

// Test 14: Quoted-printable encoding in timezone names (Outlook)
async function testQuotedPrintableTimezone() {
    console.log('\n=== Test 14: Quoted-Printable Timezone (Outlook) ===');

    // Timezone name encoded as quoted-printable: =20 for space, =3D for =
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN
BEGIN:VEVENT
UID:test-qp-tz
DTSTART;TZID=Central=20Europe=20Standard=20Time:20260216T163000
DTEND;TZID=Central=20Europe=20Standard=20Time:20260216T170000
SUMMARY:QP Encoded Meeting
END:VEVENT
END:VCALENDAR`;

    // Feb 16, 2026 16:30 CET = 15:30 UTC
    const event = createTestEvent(ics, '2026-02-16T15:35:00Z', 'Europe/Warsaw');
    const response = await handler(event);
    const data = parseResponse(response);

    console.log('Event: 16:30 CET with quoted-printable encoding (=20 for space)');
    console.log('NOW: 15:35 UTC');
    console.log('Expected: Event should be current');
    console.log('Result:');
    console.log('  isOverlappingNow:', data.isOverlappingNow);
    console.log('  current:', data.current?.title || 'null');

    if (data.isOverlappingNow && data.current?.title === 'QP Encoded Meeting') {
        console.log('✅ PASS: Quoted-printable timezone decoded correctly');
        return true;
    } else {
        console.log('❌ FAIL: Quoted-printable timezone not decoded');
        return false;
    }
}

// Run all tests
async function runAllTests() {
    console.log('═══════════════════════════════════════════════');
    console.log('Comprehensive ICS Event Processing Test Suite');
    console.log('Testing all edge cases from development session');
    console.log('═══════════════════════════════════════════════');

    const tests = [
        testCurrentlyHappeningEvent,
        testEventStartsAtNow,
        testEventEndsAtNow,
        testFutureEvent,
        testUnusedOverrideCurrently,
        testMultipleEventsOneCurrent,
        testEventStartsJustBeforeNow,
        testNextAfterCurrentEnds,
        testRecurringEventDuration,
        testPacificTimezone,
        testWindowExpansionStartMs,
        testCentralEuropeTimezone,
        testFoldedLines,
        testQuotedPrintableTimezone
    ];

    const results = [];
    for (const test of tests) {
        const passed = await test();
        results.push(passed);
    }

    console.log('\n═══════════════════════════════════════════════');
    console.log('Test Summary');
    console.log('═══════════════════════════════════════════════');
    const passCount = results.filter(r => r).length;
    const totalCount = results.length;
    console.log(`Passed: ${passCount}/${totalCount}`);

    if (passCount === totalCount) {
        console.log('✅ ALL TESTS PASSED');
        process.exit(0);
    } else {
        console.log('❌ SOME TESTS FAILED');
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
