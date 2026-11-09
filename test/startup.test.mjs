import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {extname, join, normalize} from 'node:path';
import {createGzip} from 'node:zlib';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const ARTIFACTS = process.env.ARTIFACTS || '/opt/cursor/artifacts';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
};

function nyParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  return Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
}
function nyDate(date) {
  const p = nyParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function forecastBody() {
  const today = nyDate(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const dailyTime = [];
  for (let i = 0; i < 10; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i, 16));
    dailyTime.push(nyDate(dt));
  }
  const hours = [];
  for (let i = 0; i < 10; i++) for (let h = 0; h < 24; h++) hours.push(`${dailyTime[i]}T${String(h).padStart(2, '0')}:00`);
  const n = hours.length;
  const fill = v => Array(n).fill(v);
  const hourly = {
    time: hours,
    temperature_2m: fill(71),
    precipitation_probability: fill(20),
    precipitation: fill(0),
    weather_code: fill(1),
    is_day: hours.map(t => { const h = +t.slice(11, 13); return h >= 7 && h < 19 ? 1 : 0; }),
    uv_index: fill(3),
    visibility: fill(20000),
    pressure_msl: fill(1016),
    apparent_temperature: fill(74),
    dew_point_2m: fill(62),
    wet_bulb_temperature_2m: fill(66),
    shortwave_radiation_instant: hours.map(t => { const h = +t.slice(11, 13); return h >= 8 && h <= 16 ? 400 : 0; }),
    wind_speed_10m: fill(8),
    wind_gusts_10m: fill(12),
    wind_direction_10m: fill(180)
  };
  const daily = {
    time: dailyTime,
    weather_code: Array(10).fill(2),
    temperature_2m_max: Array(10).fill(82),
    temperature_2m_min: Array(10).fill(68),
    precipitation_probability_max: Array(10).fill(40),
    precipitation_sum: Array(10).fill(0.1),
    sunrise: dailyTime.map(day => `${day}T07:05`),
    sunset: dailyTime.map(day => `${day}T17:42`),
    uv_index_max: Array(10).fill(6),
    wind_speed_10m_max: Array(10).fill(12),
    wind_gusts_10m_max: Array(10).fill(18),
    daylight_duration: Array(10).fill(38000)
  };
  const current = {
    temperature_2m: 71, apparent_temperature: 74, relative_humidity_2m: 58, dew_point_2m: 62,
    is_day: 1, precipitation: 0, weather_code: 1, cloud_cover: 20, pressure_msl: 1016,
    wind_speed_10m: 8, wind_direction_10m: 180, wind_gusts_10m: 12, visibility: 20000, uv_index: 3,
    time: hours[0]
  };
  return JSON.stringify({current, hourly, daily});
}

const AIR = JSON.stringify({
  current: {
    us_aqi: 42, us_aqi_pm2_5: 40, us_aqi_pm10: 18, us_aqi_ozone: 30,
    us_aqi_nitrogen_dioxide: 8, us_aqi_sulphur_dioxide: 2, us_aqi_carbon_monoxide: 4, pm2_5: 9.5
  }
});
const PRESSURE = JSON.stringify({
  hourly: {pressure_msl: [1014, 1014.5, 1015, 1015.2, 1015.4, 1015.8, 1016, 1016.1]}
});

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(normalize(ROOT))) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      const type = TYPES[extname(file)] || 'application/octet-stream';
      const headers = {'Content-Type': type, 'Cache-Control': 'max-age=600', ETag: `"${body.length.toString(16)}"`};
      if ((req.headers['accept-encoding'] || '').includes('gzip') && !type.includes('png')) {
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
        res.writeHead(200, headers);
        Readable.from(body).pipe(createGzip()).pipe(res);
        return;
      }
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('source keeps forecast, pollen, and secrets in the right places', async () => {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
  const pollen = await readFile(join(ROOT, 'pollen.json'));
  assert.match(html, /forecast_days=10/);
  assert.equal(html.includes('pollen.json?_='), false);
  assert.equal(html.includes('GOOGLE_POLLEN_API_KEY'), false);
  assert.equal(sw.includes('GOOGLE_POLLEN_API_KEY'), false);
  assert.match(html, /sw\.js\?v=20261109a/);
  assert.match(sw, /wx-shell-20261109a/);
  assert.match(sw, /pollen\.json/);
  assert.equal(sw.includes("SHELL_FILES=['./','./index.html','./manifest.json','./icon-192.png','./icon-512.png']"), true);
  assert.match(html, /% 💧/);
  assert.match(html, /class="i"/);
  assert.match(html, /class="c"/);
  assert.match(html, /class="p"/);
  assert.match(html, /class="hl"/);
  assert.equal(createHash('sha256').update(pollen).digest('hex').length, 64);
});

test('dashboard startup, cache age, layouts, and offline shell', async () => {
  const pollenBefore = createHash('sha256').update(await readFile(join(ROOT, 'pollen.json'))).digest('hex');
  const forecastJSON = forecastBody();
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const errors = [];
  const pollenURLs = [];
  const forecastURLs = [];
  let forecastMode = 'ok';
  let releaseForecast = null;

  function json(body, status = 200) {
    return {
      status,
      contentType: 'application/json',
      headers: {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*'},
      body
    };
  }

  async function attach(page) {
    page.on('pageerror', err => errors.push(String(err)));
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (u.startsWith(origin)) {
        if (u.includes('pollen.json')) pollenURLs.push(u);
        return req.continue();
      }
      if (u.includes('api.open-meteo.com/v1/forecast')) {
        forecastURLs.push(u);
        if (u.includes('past_hours')) return req.respond(json(PRESSURE));
        if (!u.includes('forecast_days=10')) return req.respond(json('{"error":"days"}', 500));
        if (forecastMode === 'fail') return req.respond(json('no', 503));
        if (forecastMode === 'delay') {
          releaseForecast = () => req.respond(json(forecastJSON));
          return;
        }
        return req.respond(json(forecastJSON));
      }
      if (u.includes('air-quality-api.open-meteo.com')) return req.respond(json(AIR));
      if (u.includes('api.weather.gov/alerts')) return req.respond(json('{"features":[]}'));
      if (u.includes('api.weather.gov/points')) {
        return req.respond(json(JSON.stringify({
          properties: {radarStation: 'KOKX', observationStations: 'https://api.weather.gov/gridpoints/OKX/stations', relativeLocation: {properties: {city: 'New York', state: 'NY'}}}
        })));
      }
      if (u.includes('n0q_0.json')) return req.respond(json(JSON.stringify({meta: {valid: new Date().toISOString()}})));
      if (u.includes('openstreetmap.org') || u.includes('mesonet.agron.iastate.edu')) {
        return req.respond({status: 200, contentType: 'image/png', headers: {'Access-Control-Allow-Origin': '*'}, body: PNG});
      }
      return req.abort('blockedbyclient');
    });
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true});
    await attach(page);
    await page.goto(origin, {waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForFunction(() => document.body.dataset.fresh === '1' && document.querySelectorAll('#days .d').length === 10, {timeout: 20000});
    await page.waitForFunction(() => document.querySelector('#sky24 svg') && document.querySelectorAll('#t-pol .pring').length === 3 && document.querySelector('#radar img, #radar .rmap'), {timeout: 10000});

    const first = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#days .d')];
      const align = rows[0] ? {
        day: getComputedStyle(rows[0].querySelector('b')).textAlign,
        icon: getComputedStyle(rows[0].querySelector('.i')).textAlign,
        cond: getComputedStyle(rows[0].querySelector('.c')).textAlign,
        rain: getComputedStyle(rows[0].querySelector('.p')).textAlign,
        nums: getComputedStyle(rows[0].querySelector('.hl')).textAlign,
        cols: getComputedStyle(rows[0]).gridTemplateColumns
      } : null;
      return {
        upd: document.getElementById('upd').textContent,
        temp: document.querySelector('#now .big').textContent,
        rows: rows.map(r => ({
          day: r.querySelector('b').textContent,
          icon: r.querySelector('.i').textContent,
          cond: r.querySelector('.c').textContent,
          rain: r.querySelector('.p').textContent,
          hl: r.querySelector('.hl').textContent
        })),
        align,
        size: document.getElementById('szb').textContent,
        cls: document.documentElement.className,
        pollen: document.querySelectorAll('#t-pol .pring').length,
        fit: rows.every(r => r.scrollWidth <= r.clientWidth + 2)
      };
    });
    assert.equal(first.rows.length, 10);
    assert.equal(first.rows[0].day, 'Today');
    assert.ok(first.rows.every(r => r.icon && r.cond && r.rain.includes('%') && r.rain.includes('💧') && r.hl.includes('/')));
    assert.equal(first.align.day, 'right');
    assert.equal(first.align.cond, 'left');
    assert.equal(first.align.rain, 'right');
    assert.equal(first.align.nums, 'right');
    const cols = first.align.cols.split(' ').map(parseFloat);
    assert.equal(cols.length, 5);
    assert.ok(cols[1] < cols[0] * 0.6, first.align.cols);
    assert.ok(cols[3] > cols[1] && cols[4] > cols[3] * 0.9, first.align.cols);
    assert.equal(first.temp.includes('71'), true);
    assert.equal(first.upd.includes('as of'), false);
    assert.equal(first.size, 'SMALL');
    assert.match(first.cls, /size-current/);
    assert.equal(first.pollen, 3);
    assert.equal(first.fit, true);
    assert.ok(forecastURLs.some(u => u.includes('forecast_days=10') && u.includes('latitude=27.96')));
    assert.ok(pollenURLs.length >= 1);
    assert.ok(pollenURLs.every(u => !u.includes('_=')));

    await mkdir(ARTIFACTS, {recursive: true});
    await page.screenshot({path: join(ARTIFACTS, 'small-mobile.png'), fullPage: true});

    await page.click('#szb');
    await page.waitForFunction(() => document.documentElement.classList.contains('size-big') && document.getElementById('szb').textContent === 'BIG');
    await page.waitForFunction(() => document.querySelectorAll('#days .d').length === 10);
    const big = await page.evaluate(() => ({
      rows: document.querySelectorAll('#days .d').length,
      fit: [...document.querySelectorAll('#days .d')].every(r => r.scrollWidth <= r.clientWidth + 2),
      temp: document.querySelector('#now .big').textContent,
      pollen: document.querySelectorAll('#t-pol .pring').length,
      chart: !!document.querySelector('#sky24 svg')
    }));
    assert.equal(big.rows, 10);
    assert.equal(big.fit, true);
    assert.equal(big.temp.includes('71'), true);
    assert.equal(big.pollen, 3);
    assert.equal(big.chart, true);
    await page.screenshot({path: join(ARTIFACTS, 'big-mobile.png'), fullPage: true});
    await page.click('#szb');
    await page.waitForFunction(() => document.documentElement.classList.contains('size-current'));

    const savedAt = Date.now() - 2 * 60 * 60 * 1000;
    await page.evaluate(at => {
      const pack = JSON.parse(localStorage.getItem('wxView:v1'));
      pack.at = at;
      localStorage.setItem('wxView:v1', JSON.stringify(pack));
    }, savedAt);
    forecastMode = 'delay';
    await page.goto(origin, {waitUntil: 'domcontentloaded', timeout: 30000});
    const cached = await page.evaluate(() => ({
      upd: document.getElementById('upd').textContent,
      asof: document.body.dataset.asof,
      temp: document.querySelector('#now .big').textContent,
      cacheDom: window.__wxCacheDom || 0,
      app: window.__wxAppStart || 0,
      fresh: document.body.dataset.fresh || ''
    }));
    assert.match(cached.upd, /as of/);
    assert.match(cached.upd, /2h ago/);
    assert.equal(cached.upd.includes('update failed'), false);
    assert.equal(Number(cached.asof), savedAt);
    assert.equal(cached.temp.includes('71'), true);
    assert.notEqual(cached.fresh, '1');
    await page.waitForFunction(() => (window.__wxAppStart || 0) > 0, {timeout: 5000});
    const order = await page.evaluate(() => ({
      cacheDom: window.__wxCacheDom,
      app: window.__wxAppStart,
      fcp: (performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint') || {}).startTime || 0
    }));
    assert.ok(order.cacheDom > 0 && order.cacheDom < order.app, JSON.stringify(order));
    await page.screenshot({path: join(ARTIFACTS, 'cached-as-of-small.png')});
    assert.equal(typeof releaseForecast, 'function');
    releaseForecast();
    await page.waitForFunction(() => document.body.dataset.fresh === '1' && !document.getElementById('upd').textContent.includes('as of'), {timeout: 10000});

    forecastMode = 'fail';
    await page.reload({waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForFunction(() => document.body.dataset.loaded === '1', {timeout: 15000});
    const failed = await page.evaluate(() => ({
      upd: document.getElementById('upd').textContent,
      temp: document.querySelector('#now .big') && document.querySelector('#now .big').textContent,
      rows: document.querySelectorAll('#days .d').length,
      cached: document.body.dataset.cached,
      update: document.body.dataset.update || ''
    }));
    assert.equal(failed.temp.includes('71'), true);
    assert.equal(failed.rows, 10);
    assert.match(failed.upd, /as of/);
    assert.match(failed.upd, /update failed/);
    assert.equal(failed.cached, '1');

    await page.waitForFunction(async () => {
      const keys = await caches.keys();
      for (const k of keys) {
        const cache = await caches.open(k);
        if (await cache.match('./index.html')) return true;
      }
      return false;
    }, {timeout: 10000});
    await page.setOfflineMode(true);
    forecastMode = 'fail';
    await page.reload({waitUntil: 'domcontentloaded', timeout: 20000});
    await page.waitForFunction(() => document.querySelector('#now .big') && /as of/.test(document.getElementById('upd').textContent), {timeout: 10000});
    const offline = await page.evaluate(() => ({
      upd: document.getElementById('upd').textContent,
      temp: document.querySelector('#now .big').textContent,
      rows: document.querySelectorAll('#days .d').length
    }));
    assert.equal(offline.temp.includes('71'), true);
    assert.equal(offline.rows, 10);
    assert.match(offline.upd, /as of/);
    await page.setOfflineMode(false);

    const here = await browser.newPage();
    await here.setViewport({width: 390, height: 844, deviceScaleFactor: 1, isMobile: true});
    const hereCtx = browser.defaultBrowserContext();
    await hereCtx.overridePermissions(origin, ['geolocation']);
    await here.setGeolocation({latitude: 40.71, longitude: -74.01});
    forecastMode = 'ok';
    forecastURLs.length = 0;
    await here.evaluateOnNewDocument(() => {
      localStorage.setItem('wxMode', 'here');
      localStorage.setItem('wxView:v1', JSON.stringify({
        v: 1, at: Date.now() - 3600e3, mode: 'home', place: '📍 Clearwater, FL',
        now: '<div class="big">99°</div>', days: '<div class="d"><b>Nope</b></div>', sky: '', alerts: '', tiles: {}
      }));
    });
    await attach(here);
    await here.goto(origin, {waitUntil: 'domcontentloaded'});
    await here.waitForFunction(() => document.body.dataset.loaded === '1', {timeout: 15000});
    const hereView = await here.evaluate(() => ({
      temp: document.querySelector('#now .big') && document.querySelector('#now .big').textContent,
      mode: document.getElementById('mode').textContent,
      showedHome: document.body.innerText.includes('99°')
    }));
    assert.equal(hereView.showedHome, false);
    assert.match(hereView.mode, /Here/);
    assert.equal(hereView.temp.includes('71'), true);
    assert.ok(forecastURLs.some(u => u.includes('latitude=40.71')));
    await here.close();

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
  const pollenAfter = createHash('sha256').update(await readFile(join(ROOT, 'pollen.json'))).digest('hex');
  assert.equal(pollenAfter, pollenBefore);
});
