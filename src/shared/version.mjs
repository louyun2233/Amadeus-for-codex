import fs from 'node:fs'

const packageFile = new URL('../../package.json', import.meta.url)
export const APP_VERSION = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version
