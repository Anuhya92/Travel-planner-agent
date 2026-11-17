const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let settings = {};
let knownResultAt = null;
let locations = { home: null, office: null };
let searchTimers = {};
let formTouched = new Set();
const sessionStartedAt = Date.now();
const $ = (id) => document.getElementById(id);

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
function safeUrl(value) {
  try {
    const url = new URL(value || 'https://sl.se');
    return url.protocol === 'https:' ? url.href : 'https://sl.se';
  } catch {
    return 'https://sl.se';
  }
}
function locationTitle(item) {
  return item.disassembledName || item.name || item.id || 'Location';
}
function locationSubtitle(item) {
  const parts = [item.type, item.parent?.name].filter(Boolean);
  return parts.join(' · ');
}
function selectedName(loc) {
  return loc ? locationTitle(loc) : '';
}
function showSelectedSummary() {
  const home = selectedName(locations.home),
    office = selectedName(locations.office);
  $('selectedSummary').textContent =
    home && office ? `${home}  →  ${office}` : 'Choose a suggestion for both addresses.';
}

function renderSuggestions(side, matches) {
  const box = $(`${side}Suggestions`);
  box.replaceChildren();
  if (!matches.length) {
    box.innerHTML =
      '<button class="suggestion" type="button" disabled><strong>No matching addresses or stops</strong><small>Try adding a district or nearby station</small></button>';
    box.classList.remove('hidden');
    return;
  }
  for (const match of matches.slice(0, 8)) {
    const button = document.createElement('button');
    button.className = 'suggestion';
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.innerHTML = `<strong>${escapeHtml(locationTitle(match))}</strong><small>${escapeHtml(locationSubtitle(match))}</small>`;
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      locations[side] = match;
      $(`${side}Input`).value = locationTitle(match);
      box.classList.add('hidden');
      showSelectedSummary();
      updateUberLink();
    });
    box.append(button);
  }
  box.classList.remove('hidden');
}

async function searchLocations(side, query) {
  if (query.trim().length < 3) {
    $(`${side}Suggestions`).classList.add('hidden');
    return;
  }
  try {
    const result = await request(`/api/lookup?q=${encodeURIComponent(query.trim())}`);
    if ($(`${side}Input`).value.trim() === query.trim())
      renderSuggestions(side, result.locations || []);
  } catch (error) {
    const box = $(`${side}Suggestions`);
    box.innerHTML = `<button class="suggestion" type="button" disabled><strong>Could not search right now</strong><small>${escapeHtml(error.message)}</small></button>`;
    box.classList.remove('hidden');
  }
}

function showStatus(result) {
  if (!result) {
    $('disruptionList').replaceChildren();
    $('bookingNote').classList.add('hidden');
    $('checkedAt').textContent = '';
    if (settings.home_location && settings.office_location) {
      $('statusTitle').textContent = 'Ready to check your route';
      $('statusSummary').textContent =
        'Your commute is saved. Check SL now or wait for the scheduled alert.';
      $('statusIcon').className = 'status-icon';
      $('statusIcon').textContent = '—';
      $('checkedAt').textContent = '';
      const lines = (settings.route_lines || [])
        .map((line) => line.designation || line.name)
        .filter(Boolean);
      $('routeSummary').textContent = lines.length
        ? `Saved route · lines ${lines.join(', ')}`
        : 'Saved route';
    }
    return;
  }
  const icon = $('statusIcon');
  icon.className = 'status-icon';
  $('bookingNote').classList.add('hidden');
  $('disruptionList').replaceChildren();
  $('shareAlert').classList.toggle(
    'hidden',
    !['delay', 'caution', 'unknown'].includes(result.status),
  );

  if (result.status === 'clear') {
    $('statusTitle').textContent = 'Everything good';
    $('statusSummary').textContent = 'Everything good—have a pleasant trip and a wonderful day!';
    icon.textContent = '✓';
    icon.classList.add('good');
    $('uberLink').classList.add('hidden');
  } else if (result.status === 'delay') {
    $('statusTitle').textContent = 'Tough start for the day';
    $('statusSummary').textContent =
      `Tough start for the day, but we try to make it nice with a UBER ride. SL estimates a ${result.predicted_delay_minutes}-minute delay (your alert threshold is ${result.delay_threshold_minutes} minutes).`;
    icon.textContent = '!';
    icon.classList.add('bad');
    $('uberLink').classList.remove('hidden');
    $('uberLink').innerHTML = 'Open a real ride in Uber <span>↗</span>';
    $('bookingNote').classList.remove('hidden');
    const booking = result.fake_uber_booking;
    $('bookingNote').innerHTML = booking
      ? `<strong>Demo Uber ride booked automatically</strong><br>Reference: ${escapeHtml(booking.booking_reference)}<br>${escapeHtml(booking.product)} · pickup ${escapeHtml(new Date(booking.pickup_time).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }))}<br>${escapeHtml(booking.pickup)} → ${escapeHtml(booking.destination)}<br>${escapeHtml(booking.driver)} · ${escapeHtml(booking.vehicle)} · ${escapeHtml(booking.eta_minutes)} min ETA<br><span class="fineprint">${escapeHtml(booking.note)}</span>`
      : 'No demo ride was created: SL has not reported a positive delay above your buffer.';
  } else if (result.status === 'caution') {
    $('statusTitle').textContent = 'SL notice on your route';
    $('statusSummary').textContent =
      `SL reports an active notice, but the planner estimates a ${result.predicted_delay_minutes}-minute delay—below your ${result.delay_threshold_minutes}-minute Uber threshold.`;
    icon.textContent = '!';
    icon.classList.add('unknown');
    $('uberLink').classList.add('hidden');
  } else {
    $('statusTitle').textContent = 'Could not verify';
    $('statusSummary').textContent =
      result.error ||
      result.note ||
      'SL could not provide a reliable journey estimate. Check the SL app before leaving.';
    icon.textContent = '?';
    icon.classList.add('unknown');
    $('uberLink').classList.add('hidden');
  }

  for (const item of result.disruptions || []) {
    const card = document.createElement('div');
    card.className = 'notice';
    const lineText = (item.lines || []).filter(Boolean).join(', ');
    card.innerHTML = `<strong>${escapeHtml(item.header || 'SL disruption')}</strong><p>${escapeHtml(item.details || '')}${lineText ? `<br><b>Lines:</b> ${escapeHtml(lineText)}` : ''}${item.stops?.length ? `<br><b>Stops:</b> ${escapeHtml(item.stops.join(', '))}` : ''}</p><a href="${safeUrl(item.link)}" target="_blank" rel="noopener">Open SL information ↗</a>`;
    $('disruptionList').append(card);
  }
  $('checkedAt').textContent = result.checked_at
    ? `Checked ${new Date(result.checked_at).toLocaleString('en-SE', { dateStyle: 'medium', timeStyle: 'short' })}`
    : '';
  const lineSummary = (result.route_lines || [])
    .map((line) => line.designation || line.name)
    .filter(Boolean);
  const stopSummary = (result.route_stops || []).slice(0, 5);
  const travelWindow = result.travel_window;
  const formatTime = (value) =>
    value
      ? new Date(value).toLocaleTimeString('sv-SE', {
          timeZone: 'Europe/Stockholm',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
  const windowSummary = travelWindow
    ? ` · travel window ${formatTime(travelWindow.from)}–${formatTime(travelWindow.until)}`
    : '';
  $('routeSummary').textContent =
    lineSummary.length || stopSummary.length
      ? `Checking your route${lineSummary.length ? ` · lines ${lineSummary.join(', ')}` : ''}${stopSummary.length ? ` · via ${stopSummary.join(' → ')}` : ''}${windowSummary}`
      : result.note || '';
}

function updateUberLink() {
  const home = locations.home || settings.home_location;
  const office = locations.office || settings.office_location;
  const link = $('uberLink');
  if (!home?.coord || !office?.coord) {
    link.href = '#';
    return;
  }
  const [pickupLat, pickupLon] = home.coord,
    [dropoffLat, dropoffLon] = office.coord;
  link.href = `https://m.uber.com/ul/?action=setPickup&pickup[latitude]=${encodeURIComponent(pickupLat)}&pickup[longitude]=${encodeURIComponent(pickupLon)}&dropoff[latitude]=${encodeURIComponent(dropoffLat)}&dropoff[longitude]=${encodeURIComponent(dropoffLon)}&dropoff[nickname]=Work`;
}

async function saveSettings() {
  const home = locations.home,
    office = locations.office;
  if (!home || !office) return alert('Choose a home and work suggestion first.');
  const preset = $('dayPreset').value;
  const days =
    preset === 'weekdays'
      ? DAYS.slice(0, 5)
      : preset === 'everyday'
        ? DAYS.slice()
        : [...$('daysCustom').querySelectorAll('input:checked')].map((input) => input.value);
  if (!days.length) return alert('Choose at least one day.');
  const alertBefore = Math.max(5, Math.min(120, Number($('alertBefore').value) || 20));
  const delayBuffer = Math.max(0, Math.min(120, Number($('delayBuffer').value) || 0));
  const payload = {
    home: locationTitle(home),
    office: locationTitle(office),
    home_location: home,
    office_location: office,
    departure_time: $('departureTime').value || '08:00',
    alert_before_minutes: alertBefore,
    delay_buffer_minutes: delayBuffer,
    days,
  };
  try {
    const saved = await request('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    settings = saved;
    if (saved.configuration_changed) {
      knownResultAt = null;
      showStatus(null);
    }
    const route = await request(
      `/api/route?origin=${encodeURIComponent(home.id || home.name)}&destination=${encodeURIComponent(office.id || office.name)}`,
    );
    settings = {
      ...settings,
      ...payload,
      route_lines: route.route_lines,
      route_stops: route.route_stops,
    };
    updateUberLink();
    $('serverStatus').textContent = `Alert ${alertBefore} min before · ${delayBuffer} min buffer`;
    $('serverStatus').classList.add('on');
    if ('Notification' in window && Notification.permission === 'default')
      await Notification.requestPermission();
    alert(
      `Commute saved. The SL check is scheduled for ${alertBefore} minutes before departure. Delays up to ${delayBuffer} minutes are okay before the app suggests Uber. ${route.route_lines.length ? `The planner found ${route.route_lines.length} line(s) on your route.` : 'The planner did not return line details; the alert will avoid claiming a clear result if it cannot estimate the route.'}`,
    );
  } catch (error) {
    alert(error.message);
  }
}

async function checkNow() {
  const button = $('checkNow');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    showStatus(await request('/api/check'));
  } catch (error) {
    showStatus({ status: 'unknown', error: error.message });
  } finally {
    button.disabled = false;
    button.textContent = 'Check SL now';
  }
}

async function poll() {
  try {
    const saved = await request('/api/settings');
    settings = saved;
    showStatus(saved.last_result);
    updateUberLink();
    if (saved.last_result?.checked_at && saved.last_result.checked_at !== knownResultAt) {
      const result = saved.last_result;
      if (
        new Date(result.checked_at).getTime() >= sessionStartedAt &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        const title =
          result.status === 'delay'
            ? 'Tough start for the day'
            : result.status === 'clear'
              ? 'Everything good'
              : 'SL commute update';
        const body =
          result.status === 'delay'
            ? `Tough start for the day, but we try to make it nice with a UBER ride. SL estimates ${result.predicted_delay_minutes} minutes. Review and confirm in Uber.`
            : result.status === 'clear'
              ? 'Everything good—have a pleasant trip and a wonderful day!'
              : result.note || 'Open the agent for details.';
        new Notification(title, { body });
      }
      knownResultAt = result.checked_at;
    }
    $('serverStatus').textContent = 'Agent is running';
    $('serverStatus').classList.add('on');
  } catch {
    $('serverStatus').textContent = 'Agent unavailable';
    $('serverStatus').classList.remove('on');
  }
}

async function shareAlert() {
  const result = settings.last_result;
  const notices = (result?.disruptions || [])
    .map((item) => item.header)
    .filter(Boolean)
    .join('; ');
  const text =
    result?.status === 'delay'
      ? `Tough start for the day: SL estimates a ${result.predicted_delay_minutes}-minute delay from ${selectedName(locations.home)} to ${selectedName(locations.office)}.${notices ? ` SL notice: ${notices}.` : ''} A fake demo Uber ride was created locally; open Uber to review and confirm a real ride.`
      : `SL commute update: ${$('statusSummary').textContent}${notices ? ` SL notice: ${notices}.` : ''}`;
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'SL commute alert',
        text,
        url: $('uberLink').href !== '#' ? $('uberLink').href : undefined,
      });
    } catch (error) {
      if (error.name !== 'AbortError') alert(error.message);
    }
  } else {
    try {
      await navigator.clipboard.writeText(text);
      alert('Commute alert copied.');
    } catch {
      alert(text);
    }
  }
}

function init() {
  for (const side of ['home', 'office']) {
    $(`${side}Input`).addEventListener('input', (event) => {
      formTouched.add(side);
      locations[side] = null;
      showSelectedSummary();
      clearTimeout(searchTimers[side]);
      const query = event.target.value;
      searchTimers[side] = setTimeout(() => searchLocations(side, query), 300);
    });
    $(`${side}Input`).addEventListener('focus', (event) => {
      if (event.target.value.trim().length >= 3) searchLocations(side, event.target.value);
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest(`#${side}Input`) && !event.target.closest(`#${side}Suggestions`))
        $(`${side}Suggestions`).classList.add('hidden');
    });
  }
  $('checkNow').addEventListener('click', checkNow);
  $('saveSettings').addEventListener('click', saveSettings);
  $('shareAlert').addEventListener('click', shareAlert);
  for (const id of ['departureTime', 'alertBefore', 'delayBuffer', 'dayPreset'])
    $(id).addEventListener('input', () => formTouched.add('schedule'));
  $('dayPreset').addEventListener('change', () =>
    $('daysCustom').classList.toggle('hidden', $('dayPreset').value !== 'custom'),
  );

  request('/api/settings')
    .then((saved) => {
      settings = saved;
      for (const side of ['home', 'office']) {
        const location = saved[`${side}_location`];
        if (!formTouched.has(side)) {
          if (location) {
            locations[side] = location;
            $(`${side}Input`).value = locationTitle(location);
          } else if (saved[side]) $(`${side}Input`).value = saved[side];
        }
      }
      if (!formTouched.has('schedule')) {
        $('departureTime').value =
          saved.departure_time || (saved.check_time ? saved.check_time : '08:00');
        $('alertBefore').value = saved.alert_before_minutes || 20;
        $('delayBuffer').value = saved.delay_buffer_minutes ?? saved.alert_before_minutes ?? 20;
      }
      const selectedDays = saved.days || DAYS.slice(0, 5);
      if (selectedDays.length === 7) $('dayPreset').value = 'everyday';
      else if (selectedDays.join(',') === DAYS.slice(0, 5).join(','))
        $('dayPreset').value = 'weekdays';
      else {
        $('dayPreset').value = 'custom';
        $('daysCustom').classList.remove('hidden');
        $('daysCustom')
          .querySelectorAll('input')
          .forEach((input) => {
            input.checked = selectedDays.includes(input.value);
          });
      }
      showSelectedSummary();
      showStatus(saved.last_result);
      knownResultAt = saved.last_check || null;
      updateUberLink();
    })
    .catch(() => {});
  poll();
  setInterval(poll, 5000);
}
init();
