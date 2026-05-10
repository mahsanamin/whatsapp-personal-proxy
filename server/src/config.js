const required = ['ADMIN_USER', 'ADMIN_PASS', 'JWT_SECRET', 'PERSONAL_NUMBERS']

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

const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3300'
const cookieSecureExplicit = process.env.COOKIE_SECURE
const cookieSecure = cookieSecureExplicit === undefined || cookieSecureExplicit === ''
  ? publicUrl.startsWith('https://')
  : cookieSecureExplicit === '1' || cookieSecureExplicit === 'true'

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || './data/db/wpp.db',
  waSessionPath: process.env.WA_SESSION_PATH || './data/wa-session',
  mediaPath: process.env.MEDIA_PATH || './data/media',
  adminUser: process.env.ADMIN_USER,
  adminPass: process.env.ADMIN_PASS,
  jwtSecret: process.env.JWT_SECRET,
  personalNumbers: process.env.PERSONAL_NUMBERS.split(',').map(n => n.trim()),
  publicUrl,
  cookieSecure,
  rateLimitLogin: parseInt(process.env.RATE_LIMIT_LOGIN || '10', 10),
  rateLimitSend: parseInt(process.env.RATE_LIMIT_SEND || '60', 10),
}
