import { createFileRoute } from '@tanstack/react-router'
import { profileHandler } from '../../../../server/auth.ts'

// The signed-in owner's own profile photo.
export const Route = createFileRoute('/api/profile/avatar')({
  server: {
    handlers: {
      GET: ({ request }) => profileHandler(request),
      PUT: ({ request }) => profileHandler(request),
      DELETE: ({ request }) => profileHandler(request)
    }
  }
})
