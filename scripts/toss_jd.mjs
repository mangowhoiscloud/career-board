import { chromium } from 'playwright'
const ids = [['7575566003','증권'], ['6618971003','뱅크'], ['6118760003','뱅크']]
const browser = await chromium.launch()
const page = await browser.newPage()
for (const [sub, co] of ids) {
  await page.goto(`https://toss.im/career/job-detail?job_id=6333084003&sub_position_id=${sub}`, { waitUntil: 'networkidle', timeout: 45000 }).catch(()=>{})
  await page.waitForTimeout(2500)
  const title = await page.locator('h1, h2').first().textContent().catch(()=>'?')
  const body = await page.locator('body').innerText()
  const i = body.indexOf('합류하게 될')
  console.log(`===== ${sub} (${co}) :: ${title?.trim()} =====`)
  console.log(body.slice(Math.max(0,i-200), i+500).replace(/\n{2,}/g, '\n'))
  console.log()
}
await browser.close()
