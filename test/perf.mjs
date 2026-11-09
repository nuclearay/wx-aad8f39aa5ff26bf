// Reproducible startup measurements for the weather PWA.
// Usage: node test/perf.mjs --root /path/to/app --out results.json [--live] [--shots dir]
//
// Mobile: 390x844, 4x CPU, 150ms RTT, 1.6Mbps down / 750Kbps up (Lighthouse-style Slow 4G).
// Desktop: 1280x800, no CPU throttle, 40ms RTT, 10Mbps down.
// Cold: empty profile, HTTP cache disabled. Warm: second navigation after the first load
// and service worker activation, HTTP cache enabled.
//
// Localhost note: Chrome's network emulation throttles throughput to 127.0.0.1 but, in this
// environment, does not add RTT. The local server therefore waits out the profile RTT before
// the first byte when a calibration request shows TTFB far below the requested latency.
// External APIs (Open-Meteo, NWS, radar) still receive Chrome's latency and bandwidth caps.
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';
import {createGzip} from 'node:zlib';
import {Readable} from 'node:stream';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) opt[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '1';
}
const ROOT = opt.root || new URL('..', import.meta.url).pathname;
const OUT = opt.out || '';
const SHOTS = opt.shots || '';
const LABEL = opt.label || 'run';
const LIVE = opt.live === '1' || opt.url;
const LIVE_URL = opt.url || 'https://nuclearay.github.io/wx-aad8f39aa5ff26bf/';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer(delayRef) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(normalize(ROOT))) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      const delay = delayRef.ms || 0;
      if (delay) await sleep(delay);
      const type = TYPES[extname(file)] || 'application/octet-stream';
      const headers = {
        'Content-Type': type,
        'Cache-Control': 'max-age=600',
        ETag: `"${body.length.toString(16)}"`
      };
      const enc = req.headers['accept-encoding'] || '';
      if (enc.includes('gzip') && (type.startsWith('text/') || type.includes('javascript') || type.includes('json'))) {
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
        res.writeHead(200, headers);
        Readable.from(body).pipe(createGzip()).pipe(res);
        return;
      }
      res.writeHead(200, headers);
      res.end(body);
    } catch (e) {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const PROFILES = {
  mobile: {
    viewport: {width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true},
    cpu: 4,
    latency: 150,
    down: 1.6 * 1024 * 1024 / 8,
    up: 750 * 1024 / 8,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  },
  desktop: {
    viewport: {width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false},
    cpu: 1,
    latency: 40,
    down: 10 * 1024 * 1024 / 8,
    up: 2 * 1024 * 1024 / 8,
    ua: ''
  }
};

async function arm(page, profile, cacheDisabled) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', {cacheDisabled: !!cacheDisabled});
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latency,
    downloadThroughput: profile.down,
    uploadThroughput: profile.up
  });
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: profile.cpu});
  await page.setViewport(profile.viewport);
  if (profile.ua) await page.setUserAgent(profile.ua);
  await page.evaluateOnNewDocument(() => {
    window.__perf = {useful: 0, days: 0, sky: 0, pol: 0, loaded: 0, fcp: 0, lcp: 0, long: []};
    const p = window.__perf;
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) p.long.push([Math.round(e.startTime), Math.round(e.duration)]);
      }).observe({type: 'longtask', buffered: true});
    } catch (e) {}
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') p.fcp = e.startTime;
      }).observe({type: 'paint', buffered: true});
    } catch (e) {}
    try {
      new PerformanceObserver(list => {
        const e = list.getEntries().at(-1); if (e) p.lcp = e.startTime;
      }).observe({type: 'largest-contentful-paint', buffered: true});
    } catch (e) {}
    const tick = () => {
      const t = performance.now();
      if (!p.useful && document.querySelector('#now .big')) p.useful = t;
      if (!p.days && document.querySelectorAll('#days .d').length >= 10) p.days = t;
      if (!p.sky && document.querySelector('#sky24 svg')) p.sky = t;
      if (!p.pol && document.querySelector('#t-pol .pring')) p.pol = t;
      if (!p.loaded && document.body && document.body.dataset.loaded === '1') p.loaded = t;
      if (!(p.useful && p.days && p.sky && p.pol && p.loaded)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return cdp;
}

async function readMetrics(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource').map(r => ({
      name: r.name.slice(0, 140),
      start: Math.round(r.startTime),
      dur: Math.round(r.duration),
      ttfb: Math.round(r.responseStart - r.startTime),
      size: r.transferSize
    }));
    const pick = re => res.filter(r => re.test(r.name));
    const marks = Object.fromEntries(performance.getEntriesByType('mark').map(m => [m.name, Math.round(m.startTime)]));
    return {
      perf: window.__perf,
      marks,
      cacheDom: window.__wxCacheDom || 0,
      appStart: window.__wxAppStart || 0,
      freshDom: window.__wxFreshDom || 0,
      cached: document.body.dataset.cached || '',
      fresh: document.body.dataset.fresh || '',
      asof: document.body.dataset.asof || '',
      upd: document.getElementById('upd')?.textContent || '',
      nav: nav && {
        ttfb: Math.round(nav.responseStart),
        htmlEnd: Math.round(nav.responseEnd),
        dcl: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
        transfer: nav.transferSize
      },
      forecast: pick(/open-meteo\.com\/v1\/forecast/),
      air: pick(/air-quality/),
      pollen: pick(/pollen\.json/),
      alerts: pick(/weather\.gov\/alerts/),
      radar: pick(/mesonet|openstreetmap/)
    };
  });
}

async function gotoMeasured(page, url) {
  const t0 = Date.now();
  await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000});
  await page.waitForFunction(() => document.body && document.body.dataset.loaded === '1', {timeout: 45000}).catch(() => {});
  // Let the in-page rAF observer record paint-adjacent marks after the last mutation.
  await sleep(300);
  const m = await readMetrics(page);
  m.wallMs = Date.now() - t0;
  return m;
}

function median(nums) {
  const a = nums.filter(n => n > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor((a.length - 1) / 2)];
}

async function runPair(browser, url, profileName, runs, shots) {
  const profile = PROFILES[profileName];
  const cold = [], warm = [];
  for (let i = 0; i < runs; i++) {
    const coldCtx = await browser.createBrowserContext();
    const page = await coldCtx.newPage();
    await arm(page, profile, true);
    const c = await gotoMeasured(page, url);
    cold.push(c);
    if (shots && i === runs - 1 && profileName === 'mobile') {
      await page.screenshot({path: join(shots, `${LABEL}-${profileName}-cold.png`), fullPage: true}).catch(() => {});
    }
    await coldCtx.close();

    const warmCtx = await browser.createBrowserContext();
    const pageW = await warmCtx.newPage();
    await arm(pageW, profile, false);
    await gotoMeasured(pageW, url);
    await pageW.waitForFunction(async () => {
      if (!('caches' in window)) return false;
      const keys = await caches.keys();
      for (const k of keys) {
        const cache = await caches.open(k);
        if (await cache.match('./index.html')) return true;
      }
      return false;
    }, {timeout: 8000}).catch(() => {});
    const w = await gotoMeasured(pageW, url);
    warm.push(w);
    if (shots && i === runs - 1 && profileName === 'mobile') {
      await pageW.screenshot({path: join(shots, `${LABEL}-${profileName}-warm.png`), fullPage: true}).catch(() => {});
    }
    await warmCtx.close();
  }
  const summarize = rows => ({
    n: rows.length,
    usefulMs: median(rows.map(r => r.perf.useful)),
    daysMs: median(rows.map(r => r.perf.days)),
    skyMs: median(rows.map(r => r.perf.sky)),
    pollenMs: median(rows.map(r => r.perf.pol)),
    loadedMs: median(rows.map(r => r.perf.loaded)),
    fcpMs: median(rows.map(r => r.perf.fcp)),
    lcpMs: median(rows.map(r => r.perf.lcp)),
    htmlEndMs: median(rows.map(r => r.nav && r.nav.htmlEnd)),
    htmlTtfbMs: median(rows.map(r => r.nav && r.nav.ttfb)),
    forecastStartMs: median(rows.map(r => (r.forecast[0] && r.forecast[0].start) || 0)),
    forecastEndMs: median(rows.map(r => r.forecast[0] ? r.forecast[0].start + r.forecast[0].dur : 0)),
    samples: rows
  });
  return {cold: summarize(cold), warm: summarize(warm)};
}

async function calibrate(browser, origin, delayRef) {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 200, downloadThroughput: 5 * 1024 * 1024 / 8, uploadThroughput: 1 * 1024 * 1024 / 8
  });
  await page.goto(origin + 'robots.txt', {waitUntil: 'load', timeout: 20000});
  const ttfb = await page.evaluate(() => performance.getEntriesByType('navigation')[0].responseStart);
  await page.close();
  const applied = ttfb >= 120;
  delayRef.ms = applied ? 0 : 150;
  return {ttfb: Math.round(ttfb), chromeAppliesLocalLatency: applied, serverDelayMs: delayRef.ms};
}

async function main() {
  const delayRef = {ms: 0};
  let server, origin;
  if (!LIVE) {
    server = await startServer(delayRef);
    origin = `http://127.0.0.1:${server.address().port}/`;
  } else origin = LIVE_URL;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  let calibration = null;
  if (!LIVE) calibration = await calibrate(browser, origin, delayRef);
  if (SHOTS) await mkdir(SHOTS, {recursive: true});
  const mobileRuns = Number(opt.mobile || (LIVE ? 2 : 3));
  const desktopRuns = Number(opt.desktop || (LIVE ? 0 : 2));
  const result = {
    at: new Date().toISOString(),
    url: origin,
    live: !!LIVE,
    root: LIVE ? null : ROOT,
    calibration,
    note: 'Times are medians of in-page performance.now() when that UI first existed (rAF), not wall clock. useful = temperature number visible in the DOM. loaded = refresh finished.',
    mobile: await runPair(browser, origin, 'mobile', mobileRuns, SHOTS)
  };
  if (desktopRuns > 0) result.desktop = await runPair(browser, origin, 'desktop', desktopRuns, SHOTS);
  await browser.close();
  if (server) await new Promise(r => server.close(r));
  const json = JSON.stringify(result, null, 2);
  if (OUT) await writeFile(OUT, json);
  const brief = {
    calibration,
    mobileColdUseful: result.mobile.cold.usefulMs,
    mobileWarmUseful: result.mobile.warm.usefulMs,
    mobileColdLoaded: result.mobile.cold.loadedMs,
    mobileWarmLoaded: result.mobile.warm.loadedMs,
    mobileColdFcp: result.mobile.cold.fcpMs,
    mobileWarmFcp: result.mobile.warm.fcpMs,
    mobileColdForecastStart: result.mobile.cold.forecastStartMs,
    mobileColdHtmlEnd: result.mobile.cold.htmlEndMs,
    desktopColdUseful: result.desktop && result.desktop.cold.usefulMs,
    desktopWarmUseful: result.desktop && result.desktop.warm.usefulMs
  };
  console.log(JSON.stringify(brief, null, 2));
  if (!OUT) console.log(json);
}

main().catch(e => { console.error(e); process.exit(1); });
