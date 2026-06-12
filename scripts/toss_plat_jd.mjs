import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('https://toss.im/career/job-detail?job_id=6333084003&sub_position_id=7575566003&company=%ED%86%A0%EC%8A%A4%EC%A6%9D%EA%B6%8C', { waitUntil: 'networkidle', timeout: 45000 }).catch(()=>{})
await page.waitForTimeout(3000)
console.log('TITLE:', await page.title())
const body = await page.locator('body').innerText()
// 증권 섹션의 Platform JD: 'ML Engineer (Platform)' 또는 증권 영역에서 '합류하게'
let i = body.indexOf('Platform')
i = body.indexOf('합류하게 될', i)
console.log(body.slice(Math.max(0,i-100), i + 2400).replace(/\n{3,}/g, '\n\n'))
await browser.close()
