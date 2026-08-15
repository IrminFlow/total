import { _electron as electron } from 'playwright-core'
const app = await electron.launch({
  executablePath: '/Users/irmin/total-t/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  args: ['/Users/irmin/total-t'], timeout: 30000
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1280, height: 900 })
await page.goto('file:///Users/irmin/total-t/site/index.html')
await new Promise((r) => setTimeout(r, 1200))
await page.screenshot({ path: process.env.SHOTS + '/70-landing-light.png', fullPage: true })
await page.emulateMedia({ colorScheme: 'dark' })
await new Promise((r) => setTimeout(r, 500))
await page.screenshot({ path: process.env.SHOTS + '/71-landing-dark.png', fullPage: true })
console.log('done')
await app.close()
