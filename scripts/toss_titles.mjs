import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage()
for (const [sub, co] of [['7575603003','증권'],['7575566003','증권'],['6618971003','뱅크'],['6118760003','뱅크']]) {
  await page.goto(`https://toss.im/career/job-detail?job_id=6333084003&sub_position_id=${sub}&company=${encodeURIComponent('토스'+co)}`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(()=>{})
  await page.waitForTimeout(3000)
  const title = await page.title()
  const og = await page.evaluate(() => document.querySelector('meta[property="og:title"]')?.content ?? '')
  // 선택된 탭(aria-selected) 라벨
  const selected = await page.evaluate(() => [...document.querySelectorAll('[aria-selected="true"], [class*="active"]')].map(e => e.textContent?.trim()).filter(t => t && t.length < 20).slice(0, 6))
  console.log(`${sub} (${co}) | title: ${title} | og: ${og} | selected: ${JSON.stringify(selected)}`)
}
await browser.close()
