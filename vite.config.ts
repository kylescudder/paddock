import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Server code runs on Bun (Bun.SQL for PostgreSQL), and sharp/fontkit are native or heavy.
const serverOnly = ['bun', 'sharp', 'fontkit']

export default defineConfig({
  server: { port: 3000, allowedHosts: true },
  // `@/` resolves to src/, as in the copied Better Auth UI components.
  resolve: { tsconfigPaths: true },
  ssr: { external: serverOnly },
  environments: {
    ssr: { build: { rolldownOptions: { external: serverOnly } } }
  },
  // tanstackStart must come before the React plugin. Tailwind only compiles
  // the Better Auth UI stylesheet (src/auth.css); Paddock's CSS is plain.
  plugins: [tailwindcss(), tanstackStart(), viteReact()]
})
