# SL Commute Agent — laptop prototype

A local Node.js prototype with separate accounts and commute profiles. It checks SL route notices around each signed-in user's travel window, asks Gemini to assess relevant disruptions and explain what to do, and can create a clearly labeled fake Uber ride when the delay exceeds the user's buffer. It does not place a real taxi order.

## G-pass business challenge

**Challenge:** SL disruptions can make employees late when they learn about a problem only after starting their commute. **Outcome:** help commuters make an informed decision before departure and improve the chance of arriving at work on time. The agent uses the chosen route, travel window, live SL journey estimate, and matching notices to produce a route-specific status; when a delay exceeds the commuter's buffer, it prepares a simulated taxi option for review. This is a functional laptop prototype of that workflow, not a measured claim that lateness has already been reduced.

## Run on your laptop

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env` and put your Gemini API key in `GEMINI_API_KEY`.
3. Run `npm install` once.
4. Double-click `start.bat`, or run `npm start`.
5. Open the dashboard, choose **Create an account**, and set a username and password. Sign in on later visits with those credentials.
6. Keep the server window and dashboard tab open for scheduled checks and browser notifications.

The local server binds only to `127.0.0.1`, so accounts are available on this laptop only. Commute details and salted scrypt password hashes are saved in `commute.json`; `.gitignore` excludes that file and `.env` from Git. Sessions are held in memory and expire when the server restarts, so sign in again after a restart. If you already had a saved commute before adding accounts, the first account created adopts that profile; later accounts get their own separate settings.

## Gemini assessment

The server calls Gemini's `generateContent` REST API with structured JSON output (`responseMimeType` and `responseJsonSchema`). It sends your selected route's stop and line names, travel window, delay buffer, and matching SL notice text to Google. Gemini judges route impact and writes the user-facing headline and notification. The API key stays on the laptop in `.env` and is never sent to the browser. The model defaults to `gemini-3.8-flash`; set `GEMINI_MODEL` to use another compatible model. If Gemini returns a 503, the agent automatically tries an alternate Flash model: `gemini-3.1-flash-lite` when the primary is `gemini-3.5-flash-lite`, otherwise `gemini-3.5-flash-lite`. Set `GEMINI_FALLBACK_MODEL` to choose another compatible fallback. If both models fail or the key is missing, the app labels the result as AI-unavailable and shows the SL/journey result without claiming an AI assessment.

## Local behavior and limits

- Address suggestions, route estimates, and disruption notices use SL's public journey and deviations APIs.
- Route matching considers the selected route, notice scope, published validity, explicit clock ranges, and reported delay text.
- **Alert before** sets when the local process checks your commute. **Delay buffer** sets how many minutes of delay you are willing to accept before a demo Uber ride is shown.
- Browser notifications require the dashboard to remain open and notification permission to be enabled. The laptop must be awake and the Node process running at check time.
- The simulated Uber booking is only a local demo record; no Uber request, driver, charge, or invoice is created.
- Accounts demonstrate credential-based access and per-user data separation on the laptop; they do not make this local prototype reachable to remote users.

## Code quality

- `npm run lint` checks JavaScript.
- `npm run format` formats the project.
- `npm run format:check` checks formatting.
