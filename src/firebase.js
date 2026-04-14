// ╔══════════════════════════════════════════════════════════════╗
// ║           ROLLOVER TRACKER — FIREBASE CONFIG                 ║
// ║  Fill in YOUR Firebase project keys below.                   ║
// ║  Follow the setup guide in FIREBASE_SETUP.txt               ║
// ╚══════════════════════════════════════════════════════════════╝

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// ── PASTE YOUR FIREBASE CONFIG HERE ──────────────────────────────
// Get this from: Firebase Console → Project Settings → Your Apps → SDK setup
const firebaseConfig = {
  apiKey: "AIzaSyAKjcRfWG2nRzJ8ZcL-vO30OarycnYX8AI",
  authDomain: "rollover-tracker.firebaseapp.com",
  projectId: "rollover-tracker",
  storageBucket: "rollover-tracker.firebasestorage.app",
  messagingSenderId: "505255862304",
  appId: "1:505255862304:web:a93934476ff9e2ff311c45"
};
// ─────────────────────────────────────────────────────────────────

const app = initializeApp(firebaseConfig);
export const db  = getFirestore(app);
