import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, addWatchedTabs, deferred, settle } from './helpers/source-harness.mjs';

function fixture(native) {
  const io = {
    read: async path => path.endsWith('A.svg') ? 'A original' : 'B original',
    stat: async () => 1,
    getFile: async () => ({ lastModified: 1, text: async () => 'A original' }),
  };
  const h = createHarness({ native, invoke: (command, args) => {
    if (command === 'read_text_file') return io.read(args.path);
    if (command === 'file_mtime') return io.stat(args.path);
    if (command === 'initial_file') return null;
    throw new Error('Unexpected fixture IPC: ' + command);
  } });
  const { a, b } = addWatchedTabs(h, native);
  if (!native) a.handle.getFile = () => io.getFile();
  return { h, a, b, io };
}

function delayRead(io, native, stage = 'text') {
  const gate = deferred();
  if (native) {
    io.stat = async () => stage === 'metadata' ? gate.promise : 2;
    io.read = async () => stage === 'metadata' ? 'A late' : gate.promise;
  } else {
    io.getFile = async () => stage === 'metadata' ? gate.promise : { lastModified: 2, text: () => gate.promise };
  }
  return {
    reject: gate.reject,
    resolve() { gate.resolve(stage === 'metadata' ? (native ? 2 : { lastModified: 2, text: async () => 'A late' }) : 'A late'); },
  };
}

for (const native of [true, false]) {
  const backend = native ? 'native' : 'browser handle';
  const poll = native ? 'pollNative' : 'pollHandle';
  for (const operation of ['reloadNow', poll]) {
    for (const transition of ['A → B', 'close A → B', 'A → B → A', 'final close']) {
      test(`${backend}: delayed ${operation} cannot mutate after ${transition}`, async () => {
        const { h, a, b, io } = fixture(native);
        const gate = delayRead(io, native);
        const work = h.call(operation);
        await settle();
        if (transition === 'A → B') h.activate(b);
        if (transition === 'close A → B') h.call('closeTab', a.id);
        if (transition === 'A → B → A') { h.activate(b); h.activate(a); }
        if (transition === 'final close') { h.call('closeTab', b.id); h.call('closeTab', a.id); }
        const active = h.state;
        const timer = h.run('watchTimer');
        const rendered = h.element('#doc').textContent;
        const savedWrites = h.writes.length;
        gate.resolve();
        await work;
        h.flushFrames();
        assert.equal(a.text, 'A original');
        assert.equal(b.text, 'B original');
        assert.equal(h.state, active);
        assert.equal(h.element('#doc').textContent, rendered);
        assert.equal(h.run('watchTimer'), timer);
        assert.equal(h.writes.length, savedWrites);
        assert.equal(h.notices.length, 0);
        if (transition === 'final close') {
          assert.equal(h.state.text, '');
          assert.equal(h.element('#empty').classList.contains('gone'), false);
          assert.equal(h.nativeWindow.closeCalls, 0);
          assert.equal(h.document.title, 'SVG Viewer');
        } else {
          assert.equal(h.state.lastModified, 1);
        }
      });
    }
  }

  test(`${backend}: active polling still tolerates 19 failures and stops at 20`, async () => {
    const { h, io } = fixture(native);
    io.stat = async () => { throw new Error('atomic rename gap'); };
    io.getFile = async () => { throw new Error('atomic rename gap'); };
    for (let i = 0; i < 19; i++) await h.call(poll);
    assert.equal(h.run('watchFails'), 19);
    assert.notEqual(h.run('watchTimer'), null);
    await h.call(poll);
    assert.equal(h.run('watchTimer'), null);
    assert.equal(h.element('#live').classList.contains('on'), false);
    assert.deepEqual(h.notices, ['Stopped watching — file unreadable']);
  });
}

test('native: whole-window close closes only this window and can be reopened with Ctrl+Shift+T', async () => {
  const h = createHarness();
  const { a, b } = addWatchedTabs(h);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.session')), { main: [a.path, b.path] });
  h.call('closeWindow');
  assert.equal(h.nativeWindow.destroyCalls, 1);
  assert.equal(h.nativeWindow.closeCalls, 0);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.session')), {});
  assert.deepEqual(JSON.parse(h.storage.get('svgv.closed')), [[a.path, b.path]]);
});

test('native: title-bar close of one of several windows closes only that window, with bookkeeping', async () => {
  const h = createHarness();
  const { a, b } = addWatchedTabs(h);
  h.context.getAllWebviewWindows = async () => [{ label: 'main' }, { label: 'doc-1' }];
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await h.nativeWindow.closeRequestedHandler(event);
  assert.equal(event.prevented, true);
  assert.equal(h.nativeWindow.destroyCalls, 1);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.session')), {});
  assert.deepEqual(JSON.parse(h.storage.get('svgv.closed')), [[a.path, b.path]]);
});

test('native: title-bar close of the last window leaves quitting and the session to Rust', async () => {
  const h = createHarness();
  const { a, b } = addWatchedTabs(h);
  h.context.getAllWebviewWindows = async () => [{ label: 'main' }];
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await h.nativeWindow.closeRequestedHandler(event);
  assert.equal(h.nativeWindow.destroyCalls, 0);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.session')), { main: [a.path, b.path] });
});

test('native: closed tabs reopen most recent first with Ctrl+Shift+T', async () => {
  const h = createHarness();
  const { a, b } = addWatchedTabs(h);
  h.call('closeTab', a.id);
  assert.equal(h.nativeWindow.destroyCalls, 0);
  const event = h.key({ target: h.element('#doc'), key: 'T', shiftKey: true });
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.deepEqual(Array.from(h.tabs, tab => tab.path), [b.path, a.path]);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.closed')), []);
});

test('native: simultaneous case-insensitive same-path opens create one tab', async () => {
  const gate = deferred();
  let reads = 0;
  const h = createHarness({ invoke: async (command) => {
    if (command === 'read_text_file') { reads++; return gate.promise; }
    if (command === 'file_mtime') return 1;
    throw new Error('Unexpected IPC');
  } });
  const first = h.call('openPath', 'C:/fixture/Same.svg');
  const second = h.call('openPath', 'c:/FIXTURE/same.SVG');
  await settle();
  assert.ok(reads >= 1 && reads <= 2);
  gate.resolve('<svg>same</svg>');
  await Promise.all([first, second]);
  assert.equal(h.tabs.length, 1);
  assert.equal(h.state, h.tabs[0]);
  assert.equal(h.state.text, '<svg>same</svg>');
  assert.equal(JSON.parse(h.storage.get('svgv.session')).main.length, 1);
  await h.call('openPath', 'C:/FIXTURE/SAME.svg');
  assert.equal(h.tabs.length, 1);
});

test('final close releases actual Find matches, resets navigation and retains the open Find panel', () => {
  const h = createHarness();
  const a = h.addTab({ name: 'A.svg', path: 'C:/fixture/A.svg', text: 'apple' });
  h.activate(a);
  h.element('#find-input').value = 'apple';
  h.call('openFind');
  assert.equal(h.run('findMarks.length'), 2, 'matches in stage text and source block');
  h.call('findStep', 1);
  assert.equal(h.element('#find-count').textContent, '2/2');
  h.call('closeTab', a.id);
  h.flushFrames();
  assert.equal(h.run('findMarks.length'), 0);
  assert.equal(h.run('findIndex'), -1);
  assert.equal(h.element('#find-count').textContent, '0/0');
  assert.equal(h.element('#find').classList.contains('on'), true);
  assert.equal(h.element('#doc').textContent, '');
  assert.equal(h.element('#docmeta').textContent, '');
  assert.equal(h.nativeWindow.destroyCalls, 1);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.session')), {});
});
