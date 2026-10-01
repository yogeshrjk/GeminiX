import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Run the actual built webview and HTML with only the VS Code bridge mocked.
const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'src/extension.ts'), 'utf8');
const template = source.match(/return `(<\!doctype html>[\s\S]*?<\/html>)`;/)?.[1];
assert.ok(template, 'Could not locate the extension webview HTML');
const substitutions = {
  'webview.cspSource': "'self'", nonce: 'test-nonce',
  'styleUri.toString()': '/dist/styles.css',
  'scriptUri.toString()': '/dist/webview.js',
  'logoUri.toString()': '/media/gemini-x.png'
};
const html = template.replace(/\$\{([^}]+)\}/g, (_match, key) => {
  assert.ok(key in substitutions, `Unknown HTML substitution: ${key}`);
  return substitutions[key];
});
let browser;
let base;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
    const files = { '/dist/styles.css': 'text/css', '/dist/webview.js': 'text/javascript', '/media/gemini-x.png': 'image/png' };
    if (!(url.pathname in files)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', files[url.pathname]);
    response.end(await readFile(resolve(root, `.${url.pathname}`)));
  } catch { response.writeHead(500).end(); }
});
const prefs = { voice: 'Kore', preferredLanguage: 'English', autoInterrupt: true, behavior: 'professional', liveModel: 'gemini-3.8-live-extended-thinking', thinkingLevel: 'high' };
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.GEMINIX_TEST_BROWSER ? { executablePath: process.env.GEMINIX_TEST_BROWSER } : {}) });
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
async function emit(page, data) { await page.evaluate(data => window.postMessage(data, '*'), data); }
async function open(t) {
  const page = await browser.newPage({ viewport: { width: 460, height: 900 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ postMessage: message => window.hostMessages.push(message), getState: () => undefined, setState: () => {} });
  });
  await page.goto(base);
  await page.waitForFunction(() => window.hostMessages.some(message => message.type === 'ready'));
  await emit(page, { type: 'initialState', apiConfigured: true, preferences: prefs, attachments: [], chats: [] });
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  return page;
}
async function submit(page) {
  await page.locator('#textInput').fill('Explain this code');
  await page.locator('#sendButton').click();
  await page.waitForFunction(() => window.hostMessages.some(message => message.type === 'startSession'));
  assert.equal(await page.evaluate(() => window.hostMessages.find(message => message.type === 'startSession').voiceEnabled), false);
  await emit(page, { type: 'serverMessage', payload: { setupComplete: {} } });
  await page.waitForFunction(() => window.hostMessages.some(message => message.type === 'sendText'));
  return page.evaluate(() => window.hostMessages.find(message => message.type === 'sendText').requestId);
}

test('Thinking keeps Stop active during intermediate turns and renders same-event Markdown before finishing', async t => {
  const page = await open(t);
  const requestId = await submit(page);
  await emit(page, { type: 'textAccepted', requestId });
  await emit(page, { type: 'serverMessage', payload: { serverContent: { outputTranscription: { text: 'I am checking the implementation.' }, turnComplete: true, interactionStatus: 'IN_PROGRESS' } } });
  assert.equal(await page.locator('#sendButton').getAttribute('title'), 'Stop response');
  await emit(page, { type: 'serverMessage', payload: {
    toolCall: { functionCalls: [{ id: 'render-1', name: 'render_markdown', args: { markdown: '```python\nprint("Hello")\n```' } }] },
    serverContent: { interactionStatus: 'IDLE', turnComplete: true }
  } });
  await page.waitForFunction(() => document.querySelector('#sendButton').title === 'Send');
  assert.equal(await page.locator('.message.model').count(), 1);
  assert.equal(await page.locator('.message.model pre').count(), 1);
  assert.equal(await page.evaluate(() => window.hostMessages.filter(message => message.type === 'sendToolResponse').length), 1);
  await mkdir(resolve(root, 'test-artifacts'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'test-artifacts/chat-panel.png'), animations: 'disabled' });
});

for (const type of ['sessionError', 'sessionClosed', 'sessionStopped', 'textRejected']) {
  test(`${type} releases the processing state and composer`, async t => {
    const page = await open(t);
    const requestId = await submit(page);
    await emit(page, { type, requestId, message: 'Test failure', code: 1006 });
    await page.waitForFunction(() => document.querySelector('#sendButton').title === 'Send');
    await page.locator('#textInput').fill('Try again');
    assert.equal(await page.locator('#sendButton').isEnabled(), true);
  });
}

test('Stop before setup clears the queued submission and late setup cannot send it', async t => {
  const page = await open(t);
  await page.locator('#textInput').fill('Question');
  await page.locator('#sendButton').click();
  await page.waitForFunction(() => window.hostMessages.some(message => message.type === 'startSession'));
  await page.locator('#sendButton').click();
  await emit(page, { type: 'serverMessage', payload: { setupComplete: {} } });
  assert.equal(await page.evaluate(() => window.hostMessages.filter(message => message.type === 'sendText').length), 0);
  assert.equal(await page.locator('#sendButton').getAttribute('title'), 'Send');
});

test('late render after Stop is suppressed and Enter while drafting does not interrupt', async t => {
  const page = await open(t);
  await submit(page);
  await page.locator('#textInput').fill('Next question');
  await page.locator('#textInput').press('Enter');
  assert.equal(await page.evaluate(() => window.hostMessages.some(message => message.type === 'interruptTurn')), false);
  await page.locator('#sendButton').click();
  await emit(page, { type: 'serverMessage', payload: { toolCall: { functionCalls: [{ id: 'late-1', name: 'render_markdown', args: { markdown: 'This must not appear' } }] } } });
  assert.equal(await page.locator('.message.model').count(), 0);
});

test('new chat closes the previous session and ignores late output', async t => {
  const page = await open(t);
  await submit(page);
  await emit(page, { type: 'newChat' });
  assert.equal(await page.evaluate(() => window.hostMessages.some(message => message.type === 'stopSession')), true);
  await emit(page, { type: 'serverMessage', payload: { serverContent: { outputTranscription: { text: 'Old answer' } } } });
  assert.equal(await page.locator('.message').count(), 0);
  assert.equal(await page.locator('#sendButton').getAttribute('title'), 'Send');
});

test('attachment-only image submission stays visually empty and sends local text samples', async t => {
  const page = await open(t);
  const dataUri = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 10; return canvas.toDataURL('image/png'); });
  await emit(page, { type: 'attachmentsChanged', attachments: [{ id: 'image-1', kind: 'image', label: 'sample.png', dataUri }] });
  await page.locator('#sendButton').click();
  await page.waitForFunction(() => window.hostMessages.some(message => message.type === 'startSession'));
  await emit(page, { type: 'serverMessage', payload: { setupComplete: {} } });
  await page.waitForFunction(() => window.hostMessages.some(message => message.type === 'sendText'));
  const submission = await page.evaluate(() => window.hostMessages.find(message => message.type === 'sendText'));
  assert.equal(submission.value, '');
  assert.match(submission.imageContexts['image-1'], /Local raster samples only/);
  assert.equal(await page.locator('.message.user img').count(), 1);
  assert.doesNotMatch(await page.locator('.message.user').innerText(), /Analyze|examine|summarize/);
});
