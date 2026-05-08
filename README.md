# GoalTrack

GoalTrack is a static, single-file goal tracking app. It runs entirely in the browser and stores goals, calendar events, habits, and progress data in `localStorage`.

## Deploy

Upload the contents of this folder to any static host.

Common options:

- Netlify: drag this folder into Netlify Drop, or connect it as a static site.
- Vercel: import the folder/repo and deploy with no build command.
- GitHub Pages: publish this folder's contents with `index.html` at the root.

## Local Preview

From this folder, run:

```sh
python3 -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

## Data Note

User data is private to each browser/device because it is saved in browser storage. Clearing browser data will clear the app's saved goals and events.
