import http from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import webpush from 'web-push';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.APP_DATA_FILE || path.join(ROOT, 'app-data.json');
const TZ = 'Europe/Stockholm';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8765);
const SL_API = 'https://deviations.integration.sl.se/v1/messages';
const PLANNER = 'https://journeyplanner.integration.sl.se/v2';
const FILTER_VERSION = 5;
const DEFAULTS = {
  home: '',
  office: '',
  home_location: null,
  office_location: null,
  departure_time: '08:00',
  alert_before_minutes: 20,
  delay_buffer_minutes: 20,
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  line_ids: '',
  route_lines: [],
  route_stops: [],
  demo_uber_bookings: {},
  last_check: null,
  last_result: null,
};
const checking = new Set();
const sessions = new Map();
const scrypt = promisify(scryptCallback);
let vapidConfigured = false;

async function readStore() {
  try {
    return JSON.parse(await readFile(DATA, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { users: {} };
    throw error;
  }
}

async function writeStore(store) {
  await mkdir(path.dirname(DATA), { recursive: true });
  await writeFile(DATA, JSON.stringify(store, null, 2), 'utf8');
}

async function readSettings(userId) {
  const store = await readStore();
  const user = store.users[userId];
  if (!user) throw new Error('Account not found.');
  const settings = { ...DEFAULTS, ...(user.settings || {}) };
  if (settings.last_result && settings.last_result.filter_version !== FILTER_VERSION) {
    settings.last_result = null;
    settings.last_check = null;
  }
  return settings;
}

async function writeSettings(userId, value) {
  const store = await readStore();
  const user = store.users[userId];
  if (!user) throw new Error('Account not found.');
  const safe = { ...DEFAULTS, ...value };
  user.settings = safe;
  await writeStore(store);
  return safe;
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join('='))]),
  );
}

function authenticatedUser(request) {
  const token = parseCookies(request).commute_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return { id: session.userId, username: session.username };
}

function sessionCookie(token, maxAge = 60 * 60 * 24 * 14) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `commute_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function createSession(user) {
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
  });
  return token;
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

async function verifyPassword(password, user) {
  const derived = await scrypt(password, user.password_salt, 64);
  const stored = Buffer.from(user.password_hash, 'hex');
  return stored.length === derived.length && timingSafeEqual(stored, derived);
}

async function sendPushNotifications(userId, result) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const settings = await readSettings(userId);
  const subscriptions = settings.push_subscriptions || [];
  if (!subscriptions.length) return;
  if (!vapidConfigured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    vapidConfigured = true;
  }
  const payload = JSON.stringify({
    title: result.status === 'delay' ? 'Commute disruption: plan a backup' : 'Commute update',
    body:
      result.ai_assessment?.notification ||
      result.note ||
      (result.status === 'clear'
        ? 'Your SL route looks good for the commute window.'
        : `SL reports a ${result.predicted_delay_minutes || 0}-minute delay affecting the route.`),
    url: '/',
  });
  const expired = new Set();
  await Promise.all(
    subscriptions.map(async (subscription, index) => {
      try {
        await webpush.sendNotification(subscription, payload);
      } catch (error) {
        if ([404, 410].includes(error.statusCode)) expired.add(index);
        else console.error('Push delivery failed:', error.message);
      }
    }),
  );
  if (expired.size) {
    settings.push_subscriptions = subscriptions.filter((_, index) => !expired.has(index));
    await writeSettings(userId, settings);
  }
}

async function fetchJson(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(18000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok)
    throw new Error(data.message || data.error || `Request failed (${response.status})`);
  return data;
}

async function findLocations(query) {
  const url = new URL(`${PLANNER}/stop-finder`);
  url.search = new URLSearchParams({ name_sf: query, type_sf: 'any', any_obj_filter_sf: '46' });
  const data = await fetchJson(url);
  return data.locations || [];
}

async function getRoute(origin, destination, departure = null) {
  const url = new URL(`${PLANNER}/trips`);
  const params = {
    type_origin: 'any',
    name_origin: origin,
    type_destination: 'any',
    name_destination: destination,
    calc_number_of_trips: '3',
    language: 'en',
  };
  if (departure) {
    params.itd_date = departure.date;
    params.itd_time = departure.time;
    params.itd_trip_date_time_dep_arr = 'dep';
  }
  url.search = new URLSearchParams(params);
  return fetchJson(url);
}

function extractLines(routeData) {
  const lines = new Map();
  for (const trip of (routeData.journeys || routeData.trips || []).slice(0, 1)) {
    for (const leg of trip.legs || []) {
      const transport = leg.transportation || {};
      const designation = String(transport.disassembledName || transport.number || '');
      const id = String(transport.id || '');
      const name = String(transport.name || '');
      if (!designation && !id && !name) continue;
      const line = { designation, id, name, mode: String(transport.product?.name || '') };
      lines.set([designation, id, name].join('|'), line);
    }
  }
  return [...lines.values()];
}

function extractStops(journey) {
  const names = new Set();
  for (const leg of journey?.legs || []) {
    for (const place of [leg.origin, leg.destination, ...(leg.stopSequence || [])]) {
      const name =
        place?.parent?.disassembledName ||
        place?.parent?.name ||
        place?.disassembledName ||
        place?.name;
      if (name) names.add(String(name));
    }
  }
  return [...names];
}

function normalizePlace(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/,.*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function plannedTravelWindow(settings, journey, scheduled) {
  const now = stockholmNow();
  const [departHour, departMinute] = String(settings.departure_time || '08:00')
    .split(':')
    .map(Number);
  const currentMinute = Number(now.hour) * 60 + Number(now.minute);
  let minutesUntilDeparture = departHour * 60 + departMinute - currentMinute;
  if (minutesUntilDeparture < 0) minutesUntilDeparture += 24 * 60;
  const start = scheduled ? new Date(Date.now() + minutesUntilDeparture * 60_000) : new Date();
  start.setSeconds(0, 0);
  const durationSeconds =
    journey?.tripRtDuration ||
    journey?.tripDuration ||
    (journey?.legs || []).reduce((total, leg) => total + (Number(leg.duration) || 0), 0) ||
    60 * 60;
  const end = new Date(start.getTime() + durationSeconds * 1000);
  return { start, end };
}

function noticeOverlapsWindow(message, window) {
  const publishedFrom = Date.parse(message.publish?.from || '');
  const publishedUntil = Date.parse(message.publish?.upto || '');
  if (!Number.isFinite(publishedFrom) && !Number.isFinite(publishedUntil)) return false;
  return (
    (!Number.isFinite(publishedFrom) || publishedFrom <= window.end.getTime()) &&
    (!Number.isFinite(publishedUntil) || publishedUntil >= window.start.getTime())
  );
}

function explicitTimeRanges(message) {
  const text = (message.message_variants || [])
    .map(
      (variant) => `${variant.header || ''} ${variant.details || ''} ${variant.scope_alias || ''}`,
    )
    .join(' ');
  const ranges = [];
  const pattern = /\b(?:kl\.?\s*|klockan\s*)(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/giu;
  for (const match of text.matchAll(pattern)) {
    ranges.push({
      start: Number(match[1]) * 60 + Number(match[2]),
      end: Number(match[3]) * 60 + Number(match[4]),
    });
  }
  return ranges;
}

function timeRangeOverlapsWindow(ranges, window) {
  if (!ranges.length) return true;
  const minuteAt = (date) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return Number(values.hour) * 60 + Number(values.minute);
  };
  const start = minuteAt(window.start);
  const end = start + Math.max(1, (window.end.getTime() - window.start.getTime()) / 60_000);
  return ranges.some((range) => {
    let rangeEnd = range.end;
    if (rangeEnd <= range.start) rangeEnd += 24 * 60;
    for (let offset = -24 * 60; offset <= end; offset += 24 * 60) {
      if (range.start + offset < end && rangeEnd + offset > start) return true;
    }
    return false;
  });
}

function reportedDelayMinutes(message) {
  const text = (message.message_variants || [])
    .map((variant) => `${variant.header || ''} ${variant.details || ''}`)
    .join(' ');
  const patterns = [
    /(?:ca\.?|cirka|approximately|about|around)?\s*(\d{1,3})\s*(?:minut(?:er)?|minutes?|mins?)\s*(?:sent|late|försenad|försenat|försenade)/giu,
    /(?:försenad|försenat|försenade|delay(?:ed)?(?:\s+by)?)\s*(?:ca\.?|cirka|approximately|about)?\s*(\d{1,3})\s*(?:minut(?:er)?|minutes?|mins?)/giu,
  ];
  let maxDelay = 0;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      maxDelay = Math.max(maxDelay, Number(match[1]) || 0);
    }
  }
  return maxDelay;
}

async function assessWithClaude({ route, window, notices, predictedDelayMinutes, delayBuffer }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const response = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 500,
      system: [
        'You are a Stockholm public-transport commute disruption analyst.',
        'Use only the supplied SL notices and route data. Do not invent closures, delays, or alternatives.',
        'Assess whether the affected lines and stops overlap the user route and travel window.',
        'Return one JSON object only with keys: severity (low|moderate|high|critical), affected (boolean), recommendation (continue|leave_early|taxi|check_sl), reason (short plain language), notification (one or two plain-language sentences).',
        'Recommend taxi when the reported or live delay exceeds the user delay buffer, or the route is seriously blocked. Recommend leave_early only if an actionable disruption threatens the route. If evidence is insufficient, use check_sl.',
      ].join(' '),
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            route,
            travel_window: window,
            delay_buffer_minutes: delayBuffer,
            planner_delay_minutes: predictedDelayMinutes,
            matching_sl_notices: notices,
          }),
        },
      ],
    },
  });
  const text = response.content?.find((block) => block.type === 'text')?.text || '';
  const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || 'null');
  const severities = new Set(['low', 'moderate', 'high', 'critical']);
  const recommendations = new Set(['continue', 'leave_early', 'taxi', 'check_sl']);
  if (
    typeof parsed?.affected !== 'boolean' ||
    !severities.has(parsed.severity) ||
    !recommendations.has(parsed.recommendation) ||
    typeof parsed.notification !== 'string'
  ) {
    throw new Error('Claude returned an invalid commute assessment.');
  }
  return {
    provider: 'Claude',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    severity: parsed.severity,
    affected: parsed.affected,
    recommendation: parsed.recommendation,
    reason: String(parsed.reason || '').slice(0, 400),
    notification: parsed.notification.slice(0, 500),
  };
}

function stockholmNow() {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  return {
    ...values,
    stamp: `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`,
  };
}

async function checkDisruptions(settings, scheduled) {
  const messages = await fetchJson(`${SL_API}?future=true`);
  const route =
    settings.home_location?.id && settings.office_location?.id
      ? await getRoute(settings.home_location.id, settings.office_location.id)
      : null;
  const journeys = route?.journeys || route?.trips || [];
  const journey = journeys[0] || null;
  const routeLines = journey ? extractLines({ journeys: [journey] }) : settings.route_lines || [];
  const routeStops = journey ? extractStops(journey) : settings.route_stops || [];
  const travelWindow = plannedTravelWindow(settings, journey, scheduled);
  const estimateDelta =
    journey && Number.isFinite(journey.tripDuration) && Number.isFinite(journey.tripRtDuration)
      ? Math.max(0, Math.round((journey.tripRtDuration - journey.tripDuration) / 60))
      : 0;
  const lastLeg = journey?.legs?.at(-1);
  const plannedArrival = lastLeg?.destination?.arrivalTimePlanned;
  const estimatedArrival = lastLeg?.destination?.arrivalTimeEstimated;
  const arrivalDelta =
    plannedArrival && estimatedArrival
      ? Math.max(0, Math.round((Date.parse(estimatedArrival) - Date.parse(plannedArrival)) / 60000))
      : 0;
  let noticeDelayMinutes = 0;
  const customIds = new Set(
    String(settings.line_ids || '')
      .replaceAll(';', ',')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => x.toLowerCase()),
  );
  const matches = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!noticeOverlapsWindow(message, travelWindow)) continue;
    if (!timeRangeOverlapsWindow(explicitTimeRanges(message), travelWindow)) continue;
    const scope = message.scope || {};
    const lines = scope.lines || [];
    const stops = scope.stop_areas || [];
    const variants = message.message_variants || [];
    const routeLineKeys = new Set(
      routeLines
        .flatMap((x) => [x.id, x.designation])
        .filter(Boolean)
        .map((x) => String(x).toLowerCase()),
    );
    for (const id of customIds) routeLineKeys.add(id);
    const actualLineKeys = new Set(
      lines
        .flatMap((x) => [x.id, x.designation])
        .filter(Boolean)
        .map((x) => String(x).toLowerCase()),
    );
    const lineMatch = [...routeLineKeys].some((key) => actualLineKeys.has(key));
    const selectedStops = new Set(routeStops.map(normalizePlace).filter(Boolean));
    const affectedStops = new Set(stops.map((x) => normalizePlace(x.name)).filter(Boolean));
    const stopMatch = [...selectedStops].some((name) => affectedStops.has(name));
    const relevant = lines.length && stops.length ? lineMatch && stopMatch : lineMatch || stopMatch;
    if (!relevant) continue;
    noticeDelayMinutes = Math.max(noticeDelayMinutes, reportedDelayMinutes(message));
    const variant = variants.find((v) => v.language === 'en') || variants[0] || {};
    matches.push({
      header: variant.header || 'SL disruption',
      details: variant.details || '',
      link: variant.weblink || 'https://sl.se',
      lines: lines.map((x) => x.designation || x.name || '').filter(Boolean),
      stops: stops.map((x) => x.name || '').filter(Boolean),
      priority: message.priority?.importance_level,
    });
  }
  const predictedDelayMinutes = Math.max(estimateDelta, arrivalDelta, noticeDelayMinutes);
  const checkedAt = new Date().toISOString();
  const configuredThreshold = settings.delay_buffer_minutes ?? settings.alert_before_minutes;
  const delayThreshold = Number.isFinite(Number(configuredThreshold))
    ? Number(configuredThreshold)
    : 20;
  let aiAssessment = null;
  let aiError = null;
  try {
    aiAssessment = await assessWithClaude({
      route: { home: settings.home, office: settings.office, lines: routeLines, stops: routeStops },
      window: { from: travelWindow.start.toISOString(), until: travelWindow.end.toISOString() },
      notices: matches,
      predictedDelayMinutes,
      delayBuffer: delayThreshold,
    });
  } catch (error) {
    aiError = error.message;
    console.error('Claude commute assessment failed:', error.message);
  }
  const needsUber = Boolean(
    journey &&
    (predictedDelayMinutes > delayThreshold ||
      (aiAssessment?.affected && aiAssessment.recommendation === 'taxi')),
  );
  return {
    filter_version: FILTER_VERSION,
    checked_at: checkedAt,
    status:
      !journey || (!routeLines.length && !routeStops.length)
        ? 'unknown'
        : needsUber
          ? 'delay'
          : matches.length
            ? 'caution'
            : 'clear',
    predicted_delay_minutes: predictedDelayMinutes,
    delay_threshold_minutes: delayThreshold,
    ai_assessment: aiAssessment,
    ai_error: aiError,
    assessment_mode: aiAssessment ? 'ai' : 'rules',
    needs_uber: needsUber,
    travel_window: {
      from: travelWindow.start.toISOString(),
      until: travelWindow.end.toISOString(),
    },
    disruptions: matches,
    source: 'SL Deviations API',
    route_lines: routeLines,
    route_stops: routeStops,
    note: !journey
      ? 'Could not get a route estimate for the saved commute. Check the SL app before leaving.'
      : !routeLines.length && !routeStops.length
        ? 'Could not identify the selected route stops or lines, so no route-specific all-clear is available.'
        : '',
  };
}

function createDemoUberBooking(settings, result) {
  if (!result.needs_uber || !result.travel_window?.from) return null;
  const key = result.travel_window.from;
  const bookings = settings.demo_uber_bookings || {};
  if (bookings[key]) return bookings[key];
  const reference = `SIM-UBER-${key.replace(/[^0-9]/g, '').slice(0, 12)}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const booking = {
    booking_reference: reference,
    status: 'CONFIRMED · SIMULATED',
    product: 'UberX · demo ride',
    pickup: settings.home,
    destination: settings.office,
    pickup_time: key,
    driver: 'Demo driver · simulated',
    vehicle: 'Demo vehicle · simulated',
    eta_minutes: 5,
    note: 'Fake local booking only. No real Uber request, driver, charge, or dispatch.',
  };
  bookings[key] = booking;
  const expiry = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [bookingKey] of Object.entries(bookings)) {
    if (Date.parse(bookingKey) < expiry) delete bookings[bookingKey];
  }
  settings.demo_uber_bookings = bookings;
  return booking;
}

async function runCheck(userId, scheduled = false) {
  if (checking.has(userId)) return (await readSettings(userId)).last_result;
  checking.add(userId);
  try {
    const settings = await readSettings(userId);
    let result;
    try {
      result = await checkDisruptions(settings, scheduled);
    } catch (error) {
      result = {
        filter_version: FILTER_VERSION,
        checked_at: new Date().toISOString(),
        status: 'unknown',
        error: error.message,
        disruptions: [],
        source: 'SL Deviations API',
      };
    }
    const demoBooking = createDemoUberBooking(settings, result);
    if (demoBooking) result.fake_uber_booking = demoBooking;
    await writeSettings(userId, {
      ...settings,
      last_check: result.checked_at,
      last_result: result,
    });
    return result;
  } finally {
    checking.delete(userId);
  }
}

async function scheduleTick() {
  try {
    const now = stockholmNow();
    const { users } = await readStore();
    for (const [userId, user] of Object.entries(users)) {
      const settings = { ...DEFAULTS, ...(user.settings || {}) };
      const [departureHour, departureMinute] = String(settings.departure_time || '08:00')
        .split(':')
        .map(Number);
      const alertMinutes = Number(settings.alert_before_minutes) || 20;
      const checkAt = new Date(Date.UTC(2000, 0, 1, departureHour, departureMinute - alertMinutes));
      const targetTime = `${String(checkAt.getUTCHours()).padStart(2, '0')}:${String(checkAt.getUTCMinutes()).padStart(2, '0')}`;
      const week = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const targetDay =
        departureHour * 60 + departureMinute < alertMinutes
          ? week[(week.indexOf(now.weekday) + 1) % week.length]
          : now.weekday;
      if (
        settings.home &&
        settings.office &&
        (settings.days || []).includes(targetDay) &&
        now.hour + ':' + now.minute === targetTime &&
        settings.last_scheduled_minute !== now.stamp
      ) {
        await writeSettings(userId, { ...settings, last_scheduled_minute: now.stamp });
        const result = await runCheck(userId, true);
        await sendPushNotifications(userId, result);
      }
    }
  } catch (error) {
    console.error('Schedule check failed:', error.message);
  }
}

function send(response, status, payload, type = 'application/json; charset=utf-8', headers = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': type.includes('json') ? 'no-store' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    ...headers,
  });
  response.end(data);
}

async function readBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('Request too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1:8765');
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      });
      return response.end();
    }
    if (request.method === 'GET' && url.pathname === '/health')
      return send(response, 200, { ok: true });
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      const user = authenticatedUser(request);
      return send(response, 200, { user: user ? { username: user.username } : null });
    }
    if (
      request.method === 'POST' &&
      ['/api/auth/register', '/api/auth/login'].includes(url.pathname)
    ) {
      const body = await readBody(request);
      const username = String(body.username || '')
        .trim()
        .toLowerCase();
      const password = String(body.password || '');
      if (!/^[a-z0-9._-]{3,32}$/u.test(username))
        return send(response, 400, {
          error: 'Username must be 3–32 characters: letters, numbers, dot, dash, or underscore.',
        });
      if (password.length < 10 || password.length > 200)
        return send(response, 400, { error: 'Password must be at least 10 characters.' });
      const store = await readStore();
      let user = Object.values(store.users).find((entry) => entry.username === username);
      if (url.pathname.endsWith('/register')) {
        if (user) return send(response, 409, { error: 'That username is already in use.' });
        const passwordData = await hashPassword(password);
        user = {
          id: randomUUID(),
          username,
          password_salt: passwordData.salt,
          password_hash: passwordData.hash,
          settings: { ...DEFAULTS },
        };
        store.users[user.id] = user;
        await writeStore(store);
      } else if (!user || !(await verifyPassword(password, user))) {
        return send(response, 401, { error: 'Username or password is incorrect.' });
      }
      const token = createSession(user);
      return send(
        response,
        200,
        { user: { username: user.username } },
        'application/json; charset=utf-8',
        { 'Set-Cookie': sessionCookie(token) },
      );
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = parseCookies(request).commute_session;
      if (token) sessions.delete(token);
      return send(response, 200, { ok: true }, 'application/json; charset=utf-8', {
        'Set-Cookie': sessionCookie('', 0),
      });
    }
    const user = authenticatedUser(request);
    if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') && !user)
      return send(response, 401, { error: 'Sign in to continue.' });
    if (request.method === 'GET' && url.pathname === '/api/push/key')
      return send(response, 200, { publicKey: process.env.VAPID_PUBLIC_KEY || null });
    if (request.method === 'POST' && url.pathname === '/api/push/subscribe') {
      const subscription = await readBody(request);
      if (
        !String(subscription.endpoint || '').startsWith('https://') ||
        !subscription.keys?.p256dh ||
        !subscription.keys?.auth
      )
        return send(response, 400, { error: 'Invalid push subscription.' });
      const settings = await readSettings(user.id);
      const subscriptions = settings.push_subscriptions || [];
      settings.push_subscriptions = [
        ...subscriptions.filter((entry) => entry.endpoint !== subscription.endpoint),
        subscription,
      ];
      await writeSettings(user.id, settings);
      return send(response, 200, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/settings')
      return send(response, 200, await readSettings(user.id));
    if (request.method === 'GET' && url.pathname === '/api/lookup') {
      const query = url.searchParams.get('q')?.trim();
      if (!query) return send(response, 400, { error: 'Enter an address or stop.' });
      return send(response, 200, { locations: (await findLocations(query)).slice(0, 10) });
    }
    if (request.method === 'GET' && url.pathname === '/api/route') {
      const origin = url.searchParams.get('origin');
      const destination = url.searchParams.get('destination');
      if (!origin || !destination) return send(response, 400, { error: 'Enter both locations.' });
      const route = await getRoute(origin, destination);
      const journey = (route.journeys || route.trips || [])[0];
      const routeLines = extractLines(route);
      const routeStops = extractStops(journey);
      const settings = await readSettings(user.id);
      await writeSettings(user.id, {
        ...settings,
        route_lines: routeLines,
        route_stops: routeStops,
      });
      return send(response, 200, {
        route_lines: routeLines,
        route_stops: routeStops,
        trip_count: (route.journeys || route.trips || []).length,
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/check')
      return send(response, 200, await runCheck(user.id));
    if (request.method === 'POST') {
      const body = await readBody(request);
      if (url.pathname === '/api/settings') {
        const current = await readSettings(user.id);
        const updated = { ...current, ...body };
        const configFields = [
          'home_location',
          'office_location',
          'departure_time',
          'alert_before_minutes',
          'delay_buffer_minutes',
          'days',
        ];
        const configurationChanged = configFields.some(
          (field) =>
            JSON.stringify(current[field] ?? null) !== JSON.stringify(updated[field] ?? null),
        );
        if (configurationChanged) {
          updated.last_result = null;
          updated.last_check = null;
          updated.last_scheduled_minute = null;
        }
        const saved = await writeSettings(user.id, updated);
        return send(response, 200, { ...saved, configuration_changed: configurationChanged });
      }
    }

    if (
      request.method === 'GET' &&
      (url.pathname === '/' ||
        ['/app.js', '/style.css', '/manifest.webmanifest', '/sw.js', '/icon.svg'].includes(
          url.pathname,
        ))
    ) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const type = name.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : name.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : name.endsWith('.webmanifest')
            ? 'application/manifest+json'
            : name.endsWith('.svg')
              ? 'image/svg+xml'
              : name === 'sw.js'
                ? 'text/javascript; charset=utf-8'
                : 'text/html; charset=utf-8';
      return send(response, 200, await readFile(path.join(ROOT, name)), type);
    }
    return send(response, 404, { error: 'Not found.' });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 502;
    return send(response, status, { error: error.message || 'Request failed.' });
  }
}

const server = http.createServer((request, response) => {
  void handle(request, response);
});
server.listen(PORT, HOST, () => {
  const address = `http://127.0.0.1:${PORT}`;
  console.log(
    `SL Commute Agent is running at ${address}. Keep this window open for scheduled checks.`,
  );
  if (process.env.SL_AGENT_NO_BROWSER !== '1')
    import('node:child_process').then(({ exec }) => exec(`start "" "${address}"`));
});
setInterval(() => {
  void scheduleTick();
}, 15_000);

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
