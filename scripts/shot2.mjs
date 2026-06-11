import { chromium } from 'playwright'
const token = process.env.BOARD_TOKEN
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.addInitScript((t) => localStorage.setItem('career-board:token', t), token)
await page.goto('https://mangowhoiscloud.github.io/career-board/')
await page.waitForTimeout(3000)
await page.screenshot({ path: '/tmp/eval_main.png' })
// 드로어: 문서 있는 행 클릭
await page.locator('.row:not(.head)').nth(3).locator('.cell-main').click()
await page.waitForTimeout(900)
await page.screenshot({ path: '/tmp/eval_drawer.png' })
await browser.close()
console.log('saved')
