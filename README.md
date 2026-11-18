# SL Commute Agent — laptop prototype

A local Node.js prototype for one commute profile. It checks SL route notices around your travel window, asks Gemini to assess relevant disruptions and explain what to do, and can create a clearly labeled fake Uber ride when the delay exceeds your buffer. It does not place a real taxi order.

## Run on your laptop

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env` and put your Gemini API key in `GEMINI_API_KEY`.
3. Run `npm install` once.
4. Double-click `start.bat`, or run `npm start`.
5. Keep the server window and dashboard tab open for scheduled checks and browser notifications.

The local server binds only to `127.0.0.1`, so it is not exposed to other devices. Commute details are saved in `commute.json` next to the app; `.gitignore` excludes that file and `.env` from Git. No login or cloud account is required.

## Gemini assessment

The server calls Gemini's `generateContent` REST API with structured JSON output (`responseMimeType` and `responseJsonSchema`). It sends your selected route's stop and line names, travel window, delay buffer, and matching SL notice text to Google. Gemini judges route impact and writes the user-facing headline and notification. The API key stays on the laptop in `.env` and is never sent to the browser. If the key is missing or the API request fails, the app labels the result as rule-based instead of claiming an AI assessment. The default model is `gemini-3.8-flash`; override it with `GEMINI_MODEL` if you prefer another compatible model.

## Local behavior and limits

- Address suggestions, route estimates, and disruption notices use SL's public journey and deviations APIs.
- Route matching considers the selected route, notice scope, published validity, explicit clock ranges, and reported delay text.
- **Alert before** sets when the local process checks your commute. **Delay buffer** sets how many minutes of delay you are willing to accept before a demo Uber ride is shown.
- Browser notifications require the dashboard to remain open and notification permission to be enabled. The laptop must be awake and the Node process running at check time.
- The simulated Uber booking is only a local demo record; no Uber request, driver, charge, or invoice is created.

## Code quality

- `npm run lint` checks JavaScript.
- `npm run format` formats the project.
- `npm run format:check` checks formatting.
