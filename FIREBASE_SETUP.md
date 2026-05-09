# GoalTrack Firebase Setup

Use the Firebase free Spark plan only.

1. Create a Firebase project on the Spark plan.
2. In Authentication, enable only Google as a sign-in provider.
3. Do not enable Phone authentication.
4. Create a Cloud Firestore database.
5. Publish the rules in `firestore.rules`.
6. Add a Web app in Firebase project settings.
7. Copy the Firebase web app config into `index.html` where `firebaseConfig` has placeholder values.

Goal data is saved at:

```text
users/{firebaseUid}/goals/{goalId}
```

This setup does not use Cloud Functions or any paid Firebase services.
