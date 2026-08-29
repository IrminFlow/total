const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  const initialUrl = process.argv.find((value) => /^https?:\/\//.test(value))
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await win.loadURL(initialUrl)
})

app.on('window-all-closed', () => app.quit())
