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

The agent requires the user to be signed in with Google, checks that the question is related to the user's GoalTrack data, and stores agent chats with the rest of the user's app state in Firestore.
