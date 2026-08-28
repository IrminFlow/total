import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import desktopProfiles from './build/desktop-build-profiles.json'

const desktopProfileName = process.env.TOTAL_DESKTOP_BUILD_PROFILE ?? 'production'
const desktopProfile = desktopProfiles.profiles[desktopProfileName as keyof typeof desktopProfiles.profiles]
if (!desktopProfile) throw new Error(`Unknown TOTAL_DESKTOP_BUILD_PROFILE: ${desktopProfileName}`)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __TOTAL_DESKTOP_BUILD_PROFILE__: JSON.stringify(desktopProfile)
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    }
  }
})
