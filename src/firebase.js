// firebase-admin init from the service account JSON in env.
//
// Runs server-side with full access, so Firestore security rules should deny all
// client access (see README). Never log the service account or any token.

import admin from 'firebase-admin';
import { config } from './config.js';

let db = null;

function parseServiceAccount(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service account key as a single-line JSON string.',
    );
  }
  // Railway and some shells escape the private key newlines; restore them.
  if (parsed.private_key && parsed.private_key.includes('\\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

export function initFirebase() {
  if (db) return db;

  const serviceAccount = parseServiceAccount(config.firebaseServiceAccount);

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

export function getDb() {
  if (!db) {
    throw new Error('Firestore not initialised. Call initFirebase() first.');
  }
  return db;
}

// Re-export the server timestamp + field-value helpers so callers don't import admin directly.
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;
export function serverTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}
