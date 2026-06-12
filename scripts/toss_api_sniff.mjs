import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage()
const hits = []
page.on('response', async (res) => {
  try {
    const ct = res.headers()['content-type'] ?? ''
    if (!ct.includes('json')) return
    const text = await res.text()
    if (text.includes('6118760003') || text.includes('sub_position')) hits.push({ url: res.url(), text: text.slice(0, 8000) })
  } catch {}
})
await page.goto('https://toss.im/career/job-detail?job_id=6333084003&sub_position_id=6118760003&company=%ED%86%A0%EC%8A%A4%EB%B1%85%ED%81%AC', { waitUntil: 'networkidle', timeout: 45000 }).catch(()=>{})
await page.waitForTimeout(2500)
for (const h of hits) {
  console.log('===', h.url.slice(0, 120))
  console.log(h.text.slice(0, 3000))
}
if (!hits.length) {
  // __NEXT_DATA__ 폴백
  const nd = await page.evaluate(() => document.getElementById('__NEXT_DATA__')?.textContent?.slice(0, 6000) ?? 'none')
  console.log('NEXT_DATA:', nd.slice(0, 3000))
}
await browser.close()
