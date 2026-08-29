import https from 'https';
import config from '../config.json';

// Suppress duplicate notifications for the same reason within this window to avoid
// flooding the channel while an outage or rate-limit block is ongoing.
const NOTIFY_THROTTLE_MS = 30 * 60 * 1000;

// Last notification time per throttle key
const lastNotified = new Map<string, number>();

/**
 * Sends a message to the Slack channel configured via the "slack-webhook-url" incoming
 * webhook in config.json. Notifications with the same `throttleKey` are sent at most
 * once per throttle window. Never throws: a failed or unconfigured notification only
 * logs a warning, so alerting can never break request handling.
 */
export function notifySlack(throttleKey: string, message: string): void {
  const webhookUrl: string = config['slack-webhook-url'];
  if (!webhookUrl) return;

  const now = Date.now();
  const last = lastNotified.get(throttleKey);
  if (last !== undefined && now - last < NOTIFY_THROTTLE_MS) return;
  lastNotified.set(throttleKey, now);

  const payload = JSON.stringify({ text: message });
  const request = https.request(
    webhookUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000
    },
    (res) => {
      res.resume();
      if (res.statusCode !== 200) {
        console.warn(`[slack] Webhook responded with HTTP ${res.statusCode}`);
      }
    }
  );
  request.on('error', (err) => {
    console.warn(`[slack] Failed to send notification: ${err.message}`);
  });
  request.on('timeout', () => request.destroy(new Error('Slack request timed out')));
  request.end(payload);
}
