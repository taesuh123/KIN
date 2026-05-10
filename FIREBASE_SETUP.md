# GoalTrack Firebase Login Setup

This setup is intended for the Firebase free Spark plan.

1. Create a Firebase project on the Spark plan.
2. Add a Web app in Firebase project settings.
3. Copy the Firebase web app config into `firebaseConfig` in `index.html`.
4. In Firebase Authentication, enable Google as the only sign-in provider.
5. Create a Cloud Firestore database.
6. Publish the rules in `firestore.rules`.

GoalTrack saves app data at:

```text
users/{firebaseUid}/appState/main
users/{firebaseUid}/settings/profile
users/{firebaseUid}/settings/notifications
```

This implementation uses Firebase Authentication with Google Sign-In and Cloud Firestore only. Do not enable Phone authentication, Cloud Functions, or paid Firebase services for this setup.

## Personal Agent Setup

The Personal Agent uses a Vercel serverless API route so the OpenAI key is never placed in `index.html`.

In Vercel, add these Environment Variables:

```text
OPENAI_API_KEY=your OpenAI API key
OPENAI_MODEL=gpt-4o-mini
FIREBASE_PROJECT_ID=goaltrack-15e35
AGENT_TESTER_EMAIL=taesuh123@gmail.com
```

`OPENAI_MODEL` controls cost. Keep it set to `gpt-4o-mini` for the cheaper model. If you want a stronger but usually more expensive model later, change only that environment variable.

The agent requires the user to be signed in with Google, checks that the question is related to the user's GoalTrack data, and stores agent chats with the rest of the user's app state in Firestore.

The creator-only Account profile is also passed into the agent context so responses can become more personalized. Notification preferences are saved now; the Resend/Vercel Cron sender can read `users/{uid}/settings/notifications` when daily briefing delivery is added.

## Daily Email Briefing Setup

Add these Vercel Environment Variables:

```text
RESEND_API_KEY=your Resend API key
RESEND_FROM_EMAIL=GoalTrack <onboarding@resend.dev>
CRON_SECRET=make up a long random password
CREATOR_EMAIL=tae.suh123@gmail.com
FIREBASE_SERVICE_ACCOUNT_KEY=the full Firebase service account JSON
```

For `FIREBASE_SERVICE_ACCOUNT_KEY`, create a Firebase service account key in Firebase Project Settings > Service accounts. Copy the full JSON into Vercel as the value. This is server-only and must never be placed in `index.html`.

The Vercel Cron schedule is in `vercel.json` and runs once per day at `13:00 UTC`, which is morning in Eastern time. The endpoint is:

```text
/api/daily-briefing
```

To send a creator test email after deploying, open:

```text
https://your-vercel-domain.vercel.app/api/daily-briefing?test=creator&secret=YOUR_CRON_SECRET
```
