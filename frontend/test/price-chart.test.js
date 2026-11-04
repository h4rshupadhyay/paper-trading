import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../node_modules/vite/dist/node/index.js'
import { chromium, expect } from '@playwright/test'

// Exercise the real component while controlling only the external history API.
test('history settings remain recoverable and saved history survives unavailable requests', async () => {
  const server = await createServer({ root: new URL('../', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'chart-test', configureServer(server) {
  server.middlewares.use('/chart-test', async (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(await server.transformIndexHtml('/chart-test', `<div id="root"></div><script type="module">
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import PriceChart from '/src/components/PriceChart.jsx';
      import {RegionProvider} from '/src/context/RegionContext.jsx';
      createRoot(document.getElementById('root')).render(React.createElement(RegionProvider,null,React.createElement(PriceChart,{ticker:'AAPL',quoteSnapshot:{price:101,observedAt:'2026-11-03T14:00:00Z'}})));
    </script>`))
  })
  } }] })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/usr/bin/google-chrome', args: ['--no-sandbox'] })
    const page = await browser.newPage()
    page.setDefaultTimeout(3000)
    await page.addInitScript(() => localStorage.setItem('region', 'US'))
    let fail = false
    let delayDay = false
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url())
      let body = { items: [], nextCursor: null }
      if (url.pathname === '/api/instruments') body = { items: [{ id: 'apple', symbol: 'AAPL', name: 'Apple', tradable: true, provider: 'fixture', currency: 'USD' }] }
      if (url.pathname.endsWith('/history')) {
        if (fail) return route.fulfill({ status: 503, json: { error: 'Provider unavailable' } })
        if (delayDay && url.searchParams.get('period') === '1d') return new Promise(resolve => setTimeout(async () => { await route.fulfill({ json: { items: [] } }); resolve() }, 200))
        body = { items: url.searchParams.get('period') === '1mo' ? [{ observedAt: '2026-11-03T14:00:00Z', open:'100', high:'102', low:'99', close:'101', volume:'1000' }] : [] }
      }
      return route.fulfill({ json: body })
    })
    const origin = server.resolvedUrls.local[0]
    await page.goto(origin + 'chart-test')
    await expect(page.locator('.recharts-wrapper')).toBeVisible()
    await page.getByRole('button', { name: '1D', exact: true }).click()
    await expect(page.getByRole('button', { name: '1M', exact: true })).toBeVisible()
    await expect(page.getByRole('status')).toContainText('saved')
    await expect(page.locator('.recharts-wrapper')).toBeVisible()
    await page.getByRole('button', { name: '1M', exact: true }).click()
    await expect(page.getByRole('status')).toHaveCount(0)
    fail = true
    await page.reload()
    await expect(page.getByRole('status')).toContainText('saved')
    await expect(page.locator('.recharts-wrapper')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    fail = false
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('status')).toHaveCount(0)
    delayDay = true
    await page.getByRole('button', { name: '1D', exact: true }).click()
    await page.getByRole('button', { name: '1M', exact: true }).click()
    await expect(page.locator('.recharts-wrapper')).toBeVisible()
    await page.waitForTimeout(300) // Let the older, empty request finish after 1M.
    await expect(page.getByRole('status')).toHaveCount(0)
    await page.evaluate(() => sessionStorage.clear())
    fail = true
    await page.reload()
    await expect(page.getByRole('status')).toContainText('Provider unavailable')
    await expect(page.getByText('Latest saved price:', { exact: false })).toContainText('101')
    await expect(page.getByRole('button', { name: '5D', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    assert.equal(await page.locator('.period-btn.active').first().textContent(), '1M')
  } finally { await browser?.close(); await server.close() }
})
