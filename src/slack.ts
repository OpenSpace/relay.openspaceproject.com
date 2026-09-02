import https from 'https';
import config from '../config.json';

// Suppress duplicate notifications for the same reason within this window to avoid
// flooding the channel while an outage or rate-limit block is ongoing.
const NOTIFY_THROTTLE_MS = 30 * 60 * 1000;

// Last notification time per throttle key
const lastNotified = new Map<string, number>();

// Upper bound for a single context value so a long user-supplied header cannot bloat
// the notification
const MAX_CONTEXT_VALUE_LENGTH = 300;

/**
 * Additional key/value details appended to a notification, such as the request URL that
 * triggered the error. Undefined values are omitted.
 */
export type SlackContext = Record<string, string | undefined>;

/**
 * Renders a context value safely for Slack: values originate from client-controlled data
 * (URLs, headers), so control characters and backticks are stripped to prevent them from
 * breaking out of the code span or forging extra message lines.
 */
function formatContextValue(value: string): string {
  const sanitized = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/`/g, "'")
    .trim();
  return sanitized.length > MAX_CONTEXT_VALUE_LENGTH
    ? sanitized.slice(0, MAX_CONTEXT_VALUE_LENGTH) + '...'
    : sanitized;
}

/**
 * Sends a message to the Slack channel configured via the "slack-webhook-url" incoming
 * webhook in config.json. Notifications with the same `throttleKey` are sent at most
 * once per throttle window. Never throws: a failed or unconfigured notification only
 * logs a warning, so alerting can never break request handling.
 */
export function notifySlack(
  throttleKey: string,
  message: string,
  context?: SlackContext
): void {
  const webhookUrl: string = config['slack-webhook-url'];
  if (!webhookUrl) return;

  const now = Date.now();
  const last = lastNotified.get(throttleKey);
  if (last !== undefined && now - last < NOTIFY_THROTTLE_MS) return;
  lastNotified.set(throttleKey, now);

  let text = message;
  if (context) {
    const lines = Object.entries(context)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `• *${k}:* \`${formatContextValue(v!)}\``);
    if (lines.length > 0) text += '\n' + lines.join('\n');
  }

  const payload = JSON.stringify({ text });
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
