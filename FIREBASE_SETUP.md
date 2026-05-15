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
```

`OPENAI_MODEL` controls cost. Keep it set to `gpt-4o-mini` for the cheaper model. If you want a stronger but usually more expensive model later, change only that environment variable.

The app is open to any user who signs in with Google. New accounts are treated as Free accounts by default. Free users get 5 Personal Agent prompts; after that, the UI prompts them to upgrade to Premium. The agent requires the user to be signed in, checks that the question is related to the user's GoalTrack data or practical planning, and stores agent chats with the rest of the user's app state in Firestore.

The creator-only Account profile is also passed into the agent context so responses can become more personalized. Notification preferences are saved now; the Resend/Vercel Cron sender can read `users/{uid}/settings/notifications` when daily briefing delivery is added.

## Daily Snapshot Setup

Add these Vercel Environment Variables:

```text
RESEND_API_KEY=your Resend API key
RESEND_FROM_EMAIL=Goaltrack <onboarding@resend.dev>
RESEND_REPLY_TO=no-reply@yourdomain.com
CRON_SECRET=make up a long random password
CREATOR_EMAIL=tae.suh123@gmail.com
FIREBASE_SERVICE_ACCOUNT_KEY=the full Firebase service account JSON
OPENAI_API_KEY=only needed if the Daily Snapshot Online message switch is on
OPENAI_MODEL=gpt-4o-mini
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

The creator can also send a safer signed-in test from the Account > Notifications tab. That button calls `/api/test-briefing`, verifies the Firebase user is the creator, and builds the email from that specific day's calendar events in the selected timezone.

The Account > Notifications Online switch only controls AI generation for the Daily Snapshot personal message. It does not control the main Agent tab. When Online is on, the Personal message box stores the user's prompt, such as "Bible verse about motivation"; Goaltrack generates the final message right before the test or daily snapshot email is sent. The email subject is `Goaltrack Daily Snapshot`, includes habit signals under today's events, and uses `RESEND_REPLY_TO` so replies route to a no-reply address.
