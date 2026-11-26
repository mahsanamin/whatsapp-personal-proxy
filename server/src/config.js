const required = ['ADMIN_USER', 'ADMIN_PASS', 'JWT_SECRET']

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`)
    process.exit(1)
  }
}

if (process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters')
  process.exit(1)
}

if (process.env.ADMIN_PASS === 'changeme') {
  console.error('ADMIN_PASS is still the default ("changeme"). Refusing to start. Edit .env and set a real password.')
  process.exit(1)
}

if (process.env.JWT_SECRET === 'replace_with_random_secret' || process.env.JWT_SECRET.startsWith('replace_with_random_secret')) {
  console.error('JWT_SECRET is still the placeholder. Refusing to start. Generate one with: openssl rand -hex 32')
  process.exit(1)
}

const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3900'
const cookieSecureExplicit = process.env.COOKIE_SECURE
const cookieSecure = cookieSecureExplicit === undefined || cookieSecureExplicit === ''
  ? publicUrl.startsWith('https://')
  : cookieSecureExplicit === '1' || cookieSecureExplicit === 'true'

export const config = {
  port: parseInt(process.env.PORT || '3901', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || './data/db/wpp.db',
  waSessionPath: process.env.WA_SESSION_PATH || './data/wa-session',
  mediaPath: process.env.MEDIA_PATH || './data/media',
  adminUser: process.env.ADMIN_USER,
  adminPass: process.env.ADMIN_PASS,
  jwtSecret: process.env.JWT_SECRET,
  personalNumbers: (process.env.PERSONAL_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean),
  publicUrl,
  cookieSecure,
  // WhatsApp expires media from its CDN. Fetching only on demand means that by
  // the time anyone asks, the bytes are often already gone and recovery depends
  // on the phone agreeing to re-upload. Archiving on arrival is the only way to
  // reliably keep it.
  mediaAutoDownload: process.env.MEDIA_AUTO_DOWNLOAD === '1' || process.env.MEDIA_AUTO_DOWNLOAD === 'true',
  // How long to wait for the phone to re-upload media WhatsApp has dropped.
  // The phone keeps its own copy, so this usually can succeed — but it has to
  // wake up, re-encrypt and upload, which is slow on a phone that is asleep or
  // on a poor connection.
  // Baileys' own log level. Raise to 'debug' to see the protocol exchange —
  // media retries and history syncs are otherwise silent when they fail.
  waLogLevel: process.env.WA_LOG_LEVEL || 'warn',
  mediaReuploadTimeoutMs: Math.max(5, parseInt(process.env.MEDIA_REUPLOAD_TIMEOUT_S || '120', 10)) * 1000,
  mediaAutoDownloadMaxBytes: Math.max(0, parseInt(process.env.MEDIA_AUTO_DOWNLOAD_MAX_MB || '25', 10)) * 1024 * 1024,
  rateLimitLogin: parseInt(process.env.RATE_LIMIT_LOGIN || '10', 10),
  rateLimitSend: parseInt(process.env.RATE_LIMIT_SEND || '60', 10),
  // Auto-reply floors. A rule set can be stricter, never looser. Together they
  // bound how much two bots answering each other can ever send.
  autoreply: {
    // Defaults to a minute. It may be lowered to 5 seconds, because a menu the
    // contact answers with "1", "2" or "3" is useless if the answer is dropped for
    // arriving too soon. The hourly and daily caps and the flood and loop checks
    // still bound what two bots can send each other.
    minGapSeconds: Math.max(5, parseInt(process.env.AUTOREPLY_MIN_GAP_S || '60', 10) || 60),
    maxPerChatPerHour: Math.max(1, parseInt(process.env.AUTOREPLY_MAX_PER_CHAT_PER_HOUR || '3', 10) || 3),
    maxPerChatPerDay: Math.max(1, parseInt(process.env.AUTOREPLY_MAX_PER_CHAT_PER_DAY || '10', 10) || 10),
    maxPerHour: Math.max(1, parseInt(process.env.AUTOREPLY_MAX_PER_HOUR || '30', 10) || 30),
    // Older than this and a message is history or catch-up, not a live one.
    maxAgeSeconds: Math.min(600, Math.max(30, parseInt(process.env.AUTOREPLY_MAX_AGE_S || '180', 10) || 180)),
  },
  // OpenAI-compatible gateway for auto-reply rules whose reply a model
  // writes. Unset means those rules send their fallback text. The timeout
  // stays under the shortest history cut-off (30 s), because replies queue
  // behind a model call.
  llmGateway: {
    url: (process.env.LLM_GATEWAY_URL || '').trim(),
    apiKey: (process.env.LLM_GATEWAY_API_KEY || '').trim(),
    timeoutMs: Math.min(30, Math.max(3, parseInt(process.env.LLM_GATEWAY_TIMEOUT_S || '15', 10) || 15)) * 1000,
  },
}
