import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

type RuntimeEnv = Record<string, string | undefined>

const origin = z
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
  })
  .transform((value) => new URL(value).origin)

const validation = {
  emptyStringAsUndefined: true,
  onValidationError(issues: readonly { path?: readonly unknown[] }[]): never {
    // Report setting names only; credentials must never appear in logs.
    throw new Error(
      'Invalid environment variables: ' +
        issues.map((issue) => issue.path?.join('.')).join(', ')
    )
  }
}

// Better Auth settings are read at runtime (never during the secret-free
// build). Unknown variables are ignored.
export function readAuthEnv(runtimeEnv: RuntimeEnv = process.env) {
  const env = createEnv({
    server: {
      BETTER_AUTH_URL: origin.optional(),
      BETTER_AUTH_SECRET: z.string().min(32).optional(),
      BREVO_API_KEY: z.string().min(1).optional(),
      AUTH_EMAIL_FROM: z.email().optional(),
      AUTH_EMAIL_DAILY_LIMIT: z.coerce
        .number()
        .int()
        .min(1)
        .max(300)
        .default(40),
      AUTH_ALLOWED_EMAILS: z
        .string()
        .default('')
        .transform((value) =>
          value
            .split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
        )
        .pipe(z.array(z.email())),
      NODE_ENV: z.string().default('development')
    },
    runtimeEnv,
    ...validation
  })
  const production = env.NODE_ENV === 'production'
  // Mail delivery may be left unset only outside production (local checks).
  const required = production
    ? ([
        'BETTER_AUTH_URL',
        'BETTER_AUTH_SECRET',
        'BREVO_API_KEY',
        'AUTH_EMAIL_FROM'
      ] as const)
    : (['BETTER_AUTH_URL', 'BETTER_AUTH_SECRET'] as const)
  const missing: string[] = required.filter((key) => !env[key])
  if (!env.AUTH_ALLOWED_EMAILS.length) missing.push('AUTH_ALLOWED_EMAILS')
  if (Boolean(env.BREVO_API_KEY) !== Boolean(env.AUTH_EMAIL_FROM))
    missing.push(env.BREVO_API_KEY ? 'AUTH_EMAIL_FROM' : 'BREVO_API_KEY')
  if (missing.length)
    throw new Error('Invalid environment variables: ' + missing.join(', '))
  if (production && !env.BETTER_AUTH_URL!.startsWith('https://'))
    throw new Error('Invalid environment variables: BETTER_AUTH_URL')
  return env
}
