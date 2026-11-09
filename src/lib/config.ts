import { createServerFn } from '@tanstack/react-start'

// Sign-in settings are runtime environment on the host, so they are read per
// request rather than baked into the client bundle at build time. Only public
// values leave the server.
export const getAppConfig = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { authConfigured } = await import('../../server/config.ts')
    return { authConfigured }
  }
)
