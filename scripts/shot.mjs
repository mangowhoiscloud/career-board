// 토큰 주입 스크린샷: BOARD_TOKEN=$(gh auth token) node scripts/shot.mjs [url] [out]
import { chromium } from 'playwright'
const token = process.env.BOARD_TOKEN
if (!token) throw new Error('BOARD_TOKEN required')
const url = process.argv[2] ?? 'https://mangowhoiscloud.github.io/career-board/'
const out = process.argv[3] ?? '/tmp/board.png'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1380, height: 920 } })
await page.addInitScript((t) => localStorage.setItem('career-board:token', t), token)
await page.goto(url)
await page.waitForTimeout(3000)
await page.screenshot({ path: out })
await browser.close()
console.log('saved', out)
