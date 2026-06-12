import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('https://toss.im/career/job-detail?job_id=6333084003&sub_position_id=7575603003', { waitUntil: 'networkidle', timeout: 45000 }).catch(()=>{})
await page.waitForTimeout(2000)
const tabs = ['Service','LLM','MLOps','Product','추천','Infra','Platform','OCR']
const seen = new Set()
for (const t of tabs) {
  const els = page.locator(`text="${t}"`)
  const n = await els.count()
  for (let i = 0; i < n; i++) {
    try {
      await els.nth(i).click({ timeout: 1500 })
      await page.waitForTimeout(900)
      const url = page.url()
      const m = url.match(/sub_position_id=(\d+)/)
      const co = decodeURIComponent(url.match(/company=([^&]+)/)?.[1] ?? '')
      const key = `${m?.[1]}`
      if (m && !seen.has(key)) {
        seen.add(key)
        console.log(`${t}\t${m[1]}\t${co}`)
      }
    } catch {}
  }
}
await browser.close()
