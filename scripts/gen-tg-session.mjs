/**
 * One-time script to generate a Telegram session string for Intel Stream.
 *
 * Usage:
 *   node scripts/gen-tg-session.mjs
 *
 * Prerequisites:
 *   1. Get API credentials from https://my.telegram.org/apps
 *   2. Set TG_API_ID and TG_API_HASH in .env
 *   3. Run this script, enter phone number + verification code
 *   4. Copy the session string output into .env as TG_SESSION
 *
 * Use a dedicated Telegram account, not your personal one.
 */

import 'dotenv/config';
import { createInterface } from 'readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = parseInt(process.env.TG_API_ID || '0');
const apiHash = process.env.TG_API_HASH || '';

if (!apiId || !apiHash) {
  console.error('Set TG_API_ID and TG_API_HASH in .env first.');
  console.error('Get them from https://my.telegram.org/apps');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const session = new StringSession('');
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

await client.start({
  phoneNumber: () => ask('Phone number (with country code, e.g. +86...): '),
  password: () => ask('2FA password (if enabled, otherwise press Enter): '),
  phoneCode: () => ask('Verification code from Telegram: '),
  onError: (err) => console.error('Auth error:', err.message),
});

const sessionString = client.session.save();
console.log('\n=== Session String (copy to .env as TG_SESSION) ===');
console.log(sessionString);
console.log('===================================================\n');

await client.disconnect();
rl.close();
process.exit(0);
