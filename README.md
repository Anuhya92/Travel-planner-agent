# SL Commute Agent

The project is packaged as a responsive web app, an installable PWA, and Capacitor shells for Android and iOS. The web service is a single-user beta: commute settings live in `commute.json` on the server. Do not expose it as a public multi-user service until authentication, per-user storage, and protected settings APIs are added.

## Run locally

1. Install Node.js 20 or later.
2. Run `npm start` or double-click `start.bat`.
3. Open `http://127.0.0.1:8765`, choose home and work suggestions, set the departure schedule, and save.

The service binds to `0.0.0.0` and uses `PORT` if supplied by a hosting provider. Persistent storage must be mounted for `commute.json`; the included Dockerfile is a starting point, not a complete production deployment. Configure HTTPS at the hosting layer. Schedule checks run inside the Node process, so a host that sleeps or restarts needs an external scheduler for reliable alerts.

## Install as a web app

Deploy to an HTTPS domain, open it in Safari on iOS or Chrome on Android, then use the browser's **Add to Home Screen / Install app** action. The PWA caches its app shell for quicker loading. The live API and scheduled checks still need an internet connection and a running server.

## iOS and Android native shells

The Capacitor config points at the hosted web app. Set `server.url` in `capacitor.config.json` to the deployed HTTPS domain. Then run:

```sh
npm install
npx cap add ios
npx cap add android
npx cap sync
npx cap open ios
npx cap open android
```

iOS builds require macOS and Xcode. Android builds require Android Studio and its SDK. The generated apps are WebView shells around the hosted service; native push notifications and app-store signing are not configured yet. Browser notifications require the web page to be available, so the current schedule does not guarantee background mobile alerts. Reliable iOS and Android alerts need per-user accounts, device registration, push services, and a hosted scheduler.

## Current behavior

- SL Journey Planner autocomplete and route estimates; SL Deviations route and travel-window matching.
- Explicit SL notice clock ranges are checked against the expected travel window.
- A local simulated Uber ride record is created when the estimated delay exceeds the configured threshold. It never contacts Uber, dispatches a driver, or charges anyone.
- The Uber link opens a prefilled real ride for the user to review and confirm.

## Before a public launch

Implement user sign-in and per-user encrypted settings storage, secure API access, cloud persistence, a scheduled worker, push notification enrollment and delivery, and production monitoring. Add account deletion and data retention controls. Native app releases also need signing credentials and store review.
