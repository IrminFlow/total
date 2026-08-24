// Rasterise build/icon.svg to the PNG electron-builder wants.
//
// No image toolchain is assumed: this renders the SVG in a hidden Electron window and captures
// it, the same way services/pdf.ts renders HTML. That keeps the icon a checked-in vector that
// anyone can edit, with one command to regenerate the raster — rather than a binary blob nobody
// can change.
//
//   npm run icon
//
// electron-builder derives .icns, .ico and every Linux size from a single 1024×1024 PNG, so one
// output is all that is needed.
// CommonJS: Electron's main-process module has no ESM named exports.
const { app, BrowserWindow, nativeImage } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { dirname, join } = require('node:path')

const root = join(__dirname, '..')
const SIZE = 1024

async function main() {
  await app.whenReady()

  const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8')
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { sandbox: true }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  // One frame to settle the gradients before the capture.
  await new Promise((r) => setTimeout(r, 400))

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build/icon.png'), image.toPNG())

  // A 512 copy for the in-app about box and the site, where 1024 is wasteful.
  const half = nativeImage.createFromBuffer(image.toPNG()).resize({ width: 512, height: 512 })
  writeFileSync(join(root, 'build/icon-512.png'), half.toPNG())

  // A contact sheet at the sizes the icon is actually seen at. An icon is judged in a dock and a
  // title bar far more often than at full size, and this is the only honest way to check it.
  const strip = [16, 32, 64, 128]
  const pad = 24
  const width = strip.reduce((w, s) => w + s + pad, pad)
  const height = Math.max(...strip) + pad * 2
  const b64 = image.toPNG().toString('base64')
  const sheet = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;background:#8b8f99;width:${width}px;height:${height}px}
    .r{display:flex;align-items:center;justify-content:flex-start;gap:${pad}px;padding:${pad}px;
       box-sizing:border-box;height:${height}px;width:${width}px}
    img{image-rendering:auto;display:block}</style>
    <div class="r">${strip.map((s) => `<img width="${s}" height="${s}" src="data:image/png;base64,${b64}">`).join('')}</div>`
  const sheetWin = new BrowserWindow({ width, height, show: false, webPreferences: { sandbox: true } })
  await sheetWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(sheet))
  await new Promise((r) => setTimeout(r, 250))
  const sheetImage = await sheetWin.webContents.capturePage({ x: 0, y: 0, width, height })
  writeFileSync(join(root, 'build/icon-sizes.png'), sheetImage.toPNG())

  console.log(`icon: build/icon.png (${SIZE}x${SIZE}), build/icon-512.png, build/icon-sizes.png`)
  app.exit(0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
