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
