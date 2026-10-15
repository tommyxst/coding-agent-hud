// Synthetic UI checks only. No real Agent, native interaction or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [modulePath, outputDirectory] = process.argv.slice(2);
assert.ok(modulePath && outputDirectory && path.isAbsolute(modulePath) && path.isAbsolute(outputDirectory), 'Usage: node scripts/verify-m1-ui.cjs <absolute-playwright-module> <absolute-output-directory>');
const { chromium } = require(modulePath);
let browser;
const checks = [];
async function main() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1420');
  await page.locator('.project-name').waitFor();
  await page.screenshot({ path: path.join(outputDirectory, 'default-font.png'), fullPage: true });
  const defaultFont = await page.locator('.action-summary').evaluate(element => getComputedStyle(element).fontSize);
  assert.equal(defaultFont, '15px');
  assert.equal(await page.locator('.activity-label').evaluate(element => getComputedStyle(element).fontSize), '14px');
  checks.push('default readable font sizes');

  await page.getByRole('button', { name: 'HUD 设置', exact: true }).click();
  const font = page.getByRole('slider', { name: '界面字号', exact: true });
  for (const size of [12, 15, 20]) {
    await font.evaluate((element, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(value));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, size);
    await page.waitForFunction(value => getComputedStyle(document.querySelector('.action-summary')).fontSize === `${value}px`, size);
    for (const width of [900, 372, 320, 280]) {
      await page.setViewportSize({ width, height: 1100 });
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      if (!fits) {
        await page.screenshot({ path: path.join(outputDirectory, 'overflow.png'), fullPage: true });
        console.log(await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('body *')].filter(element => element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent.slice(0, 50), client: element.clientWidth, scroll: element.scrollWidth })).slice(-25) })));
      }
      assert.ok(fits, `horizontal overflow at font ${size}, viewport ${width}`);
      checks.push(`font ${size} / width ${width}: no horizontal overflow`);
    }
  }
  await page.reload();
  await page.locator('.action-summary').waitFor();
  assert.equal(await page.locator('.action-summary').evaluate(element => getComputedStyle(element).fontSize), '20px');
  checks.push('font preference survives reload');
  await page.setViewportSize({ width: 900, height: 1100 });
  await page.getByRole('button', { name: '会话详情', exact: false }).first().click();
  const state = page.getByRole('combobox', { name: 'DEMO 会话状态', exact: true });
  for (const value of ['THINKING', 'TOOL_RUNNING', 'RESPONDING', 'IDLE']) {
    await state.selectOption(value);
    await page.locator('.detail-drawer').waitFor();
    assert.equal(await page.locator('.hud-shell').getAttribute('data-mode'), 'expanded');
    checks.push(`details survive ${value}`);
  }
  for (const value of ['WAITING_USER', 'ERROR', 'DONE']) {
    await state.selectOption(value);
    await page.locator('.attention-banner').waitFor();
    assert.equal(await page.locator('.detail-drawer').count(), 1);
    checks.push(`expanded retains details and shows ${value}`);
  }
  await state.selectOption('THINKING');
  await page.getByRole('button', { name: 'No session', exact: true }).click();
  await page.locator('.empty-card').waitFor();
  await page.getByRole('button', { name: '重置 DEMO', exact: true }).click();
  await page.locator('.project-name').waitFor();
  assert.equal(await page.locator('.detail-drawer').count(), 0);
  checks.push('removed session does not resurrect old details');
  await page.screenshot({ path: path.join(outputDirectory, 'large-font.png'), fullPage: true });

  const selected = await page.locator('.hud-card').getAttribute('data-primary');
  assert.equal(await page.getByRole('button', { name: '拖动窗口', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '取消窗口置顶', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '窗口置顶', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.hud-card').getAttribute('data-primary'), selected);
  checks.push('DEMO drag disabled; topmost independent of session selection');
  await page.getByRole('button', { name: '会话详情', exact: false }).first().click();
  await state.selectOption('TOOL_RUNNING');
  await page.waitForFunction(() => document.querySelector('.track-particle').getAnimations().length === 1);
  const origin = await page.evaluate(() => {
    const node = document.querySelector('.track-particle');
    window.__particle = node;
    const animation = node.getAnimations()[0];
    animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) * 0.5;
    const rect = node.getBoundingClientRect();
    return { local: new DOMMatrixReadOnly(getComputedStyle(node).transform).m41, screen: rect.x + rect.width / 2 };
  });
  await state.selectOption('RESPONDING');
  const reverse = await page.locator('.track-particle').evaluate(node => {
    const animation = node.getAnimations()[0];
    animation.pause(); animation.currentTime = 0;
    const frames = animation.effect.getKeyframes();
    const rect = node.getBoundingClientRect();
    return { same: node === window.__particle, from: new DOMMatrixReadOnly(frames[0].transform).m41, to: new DOMMatrixReadOnly(frames.at(-1).transform).m41, screen: rect.x + rect.width / 2 };
  });
  assert.ok(reverse.same && Math.abs(reverse.from - origin.local) < 0.1 && reverse.to < reverse.from, 'tool -> response continuity and direction');
  assert.ok(Math.abs(reverse.screen - origin.screen) < 0.1, 'particle screen position must not jump when Bash changes to Model');
  await state.selectOption('TOOL_RUNNING');
  const forward = await page.locator('.track-particle').evaluate(node => {
    const animation = node.getAnimations()[0];
    animation.pause(); animation.currentTime = 0;
    const frames = animation.effect.getKeyframes();
    const rect = node.getBoundingClientRect();
    return { same: node === window.__particle, from: new DOMMatrixReadOnly(frames[0].transform).m41, to: new DOMMatrixReadOnly(frames.at(-1).transform).m41, screen: rect.x + rect.width / 2 };
  });
  assert.ok(forward.same && Math.abs(forward.from - reverse.from) < 0.1 && forward.to > forward.from, 'response -> tool continuity and direction');
  assert.ok(Math.abs(forward.screen - reverse.screen) < 0.1, 'particle screen position must not jump when Model changes to Bash');
  checks.push('same particle retargets continuously in local and screen coordinates in both directions');
  for (const value of ['IDLE', 'WAITING_USER', 'ERROR', 'DONE']) {
    await state.selectOption('TOOL_RUNNING');
    await state.selectOption(value);
    assert.equal(await page.locator('.track-particle').evaluate(node => node.getAnimations().length), 0);
    assert.ok((await page.locator('.activity-label').textContent()).length > 0);
    checks.push(`${value}: no stale moving animation`);
  }
  await state.selectOption('THINKING');
  await page.waitForFunction(() => document.querySelector('.track-particle').getAnimations()[0]?.effect.getTiming().iterations === Infinity);
  assert.equal(await page.locator('.track-particle').evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41), 0);
  checks.push('thinking centers then breathes without a frame loop');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('.track-particle').getAnimations().length === 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await state.selectOption('TOOL_RUNNING');
  await page.getByRole('button', { name: 'HUD 设置', exact: true }).click();
  const reduced = page.getByRole('checkbox', { name: '减少动态效果', exact: false });
  await reduced.check();
  assert.equal(await page.locator('.track-particle').evaluate(node => node.getAnimations().length), 0);
  await reduced.uncheck();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  checks.push('system and application reduced motion stop WAAPI');
  await page.evaluate(() => document.activeElement.blur());
  assert.ok(await page.evaluate(() => document.activeElement === document.body));
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.track-particle').evaluate(node => node.getAnimations().length), 0);
  await page.locator('.project-name').dispatchEvent('pointerdown', { button: 0 });
  await page.waitForFunction(() => document.querySelector('.track-particle').getAnimations().length === 1);
  checks.push('first Tab from body stops motion; pointer resumes latest state');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.locator('.track-particle').evaluate(node => node.getAnimations().length), 0);
  await state.selectOption('RESPONDING');
  assert.equal(await page.locator('.track-particle').evaluate(node => node.getAnimations().length), 0);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('.track-particle').getAnimations().length === 1);
  checks.push('synthetic hidden/resume uses current state without replay');
  await page.evaluate(() => { window.__oldParticle = document.querySelector('.track-particle'); });
  await page.locator('.secondary-row').first().click();
  assert.equal(await page.locator('.detail-drawer').count(), 0);
  assert.ok(await page.evaluate(() => !window.__oldParticle.isConnected && window.__oldParticle.getAnimations().length === 0));
  await page.locator('.secondary-row').filter({ hasText: 'ai-experience-qa' }).click();
  assert.equal(await page.locator('.detail-drawer').count(), 0);
  checks.push('App session switch clears details and old particle; switching back does not resurrect');
  await page.getByRole('button', { name: 'No session', exact: true }).click();
  assert.equal(await page.locator('.track-particle').count(), 0);
  checks.push('session removal cancels particle lifecycle');
  assert.deepEqual(errors, []);
  const result = { checks, count: checks.length, pageErrors: errors, syntheticOnly: true, modelCalls: 0 };
  fs.writeFileSync(path.join(outputDirectory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); });
