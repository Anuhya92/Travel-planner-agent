# Commute Agent

A commute reliability tool for staff teams. It checks route-specific SL notices around each employee's travel window, uses Claude to assess disruption severity and recommend whether to continue, leave earlier, check SL, or consider a taxi, then sends a plain-language push alert. The demo Uber record remains simulated and never places a real order.

## Local setup

1. Install Node.js 20 or later.
2. Run `npm install` and set `ANTHROPIC_API_KEY` to enable Claude's live assessment.
3. Optional: configure the Web Push VAPID variables below for alerts when the app is closed.
4. Run `npm start` or double-click `start.bat`, open `http://127.0.0.1:8765`, and create an account.

Each account has its own commute settings, check results, push subscriptions, and simulated ride history. Passwords are stored as salted scrypt hashes. Sessions are held in memory and users sign in again after a server restart. This JSON store is suitable for a small single-instance beta; use a managed database and session store before scaling out.

## AI assessment

The server sends the route's line and stop names, the expected travel window, delay buffer, and matched SL notice text to Anthropic's Claude Messages API. Configure `ANTHROPIC_API_KEY` and optionally `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`). The key remains server-side. If the key is missing or Claude fails, the app marks the result as rule-based and retains the SL and planner evidence rather than presenting it as an AI assessment.

## Web push

Generate application server keys with `npx web-push generate-vapid-keys`. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a contact such as `mailto:team@example.com`) on the server. Users must sign in, allow notifications, and save their commute from an HTTPS PWA-capable browser. Scheduled server checks send push notifications to registered devices. Push delivery depends on browser and operating-system support; the Capacitor shells do not yet integrate native APNs or Firebase Cloud Messaging.

## Deploy to Render

The included `render.yaml` defines a Node web service, health check, persistent disk for account data, and secret environment variable prompts. Push the project branch to GitHub, connect the repository in Render, and create a Blueprint from `render.yaml`. Enter `ANTHROPIC_API_KEY` and the three VAPID values in the Render prompt. Keep the service at one instance while using the JSON file store. The paid web service and persistent disk keep the process scheduler running and retain accounts across deploys.

Render's free or sleeping services are not suitable for reliable scheduled checks. The app checks schedules in the always-on web process using Europe/Stockholm time. Keep scheduled tasks server-side; the user's browser does not need to remain open for Web Push delivery.

## Install on phones

Open the deployed HTTPS URL in Safari on iOS or Chrome on Android and choose **Add to Home Screen**. Capacitor iOS and Android shells can also load the hosted site; iOS app builds require macOS and Xcode, while Android builds need Android Studio. Native push integration and store release signing remain separate mobile release work.

## Team use and privacy

This supports staff punctuality by giving each person private route-aware warnings and a chance to plan a backup ride. It does not share employee route or incident details with an employer dashboard. Claude receives the commute route, stops, travel window, and matching SL notice text when AI assessment is enabled. Provide clear notice and retention controls before using this for a workforce. The current JSON storage has no self-service password reset, account deletion, or administrator controls; add those and move to a managed database before a broad organizational launch.

## Commands

- `npm start` — run the service
- `npm run lint` — check JavaScript
- `npm run format` — format project files
- `npm run format:check` — verify formatting
