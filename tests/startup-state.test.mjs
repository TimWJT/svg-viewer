import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, settle } from './helpers/source-harness.mjs';

const launch = 'C:/fixture/Launch.svg';
const first = 'C:/fixture/First.svg';
const second = 'C:/fixture/Second.svg';

function startup({ openTabs, initial = launch, rawSaved, label = 'main', search = '', unreadable = [] } = {}) {
  return createHarness({
    label, search, rawSaved,
    saved: { openTabs, cfg: { openIn: 'window', restoreTabs: true }, customPreference: { retain: 42 } },
    invoke: async (command, args) => {
      if (command === 'external_open_ready') return;
      if (command === 'initial_file') return initial;
      if (command === 'read_text_file') {
        assert.equal(typeof args.path, 'string');
        assert.ok(args.path.trim());
        if (unreadable.includes(args.path)) throw new Error('fixture missing file');
        return '<svg>' + args.path + '</svg>';
      }
      if (command === 'file_mtime') return 1;
      throw new Error('Unexpected startup IPC: ' + command);
    },
  });
}

const malformed = [
  ['object', { arbitrary: first }, []],
  ['null', null, []],
  ['number', 42, []],
  ['boolean', true, []],
  ['bare string', first, []],
  ['null member', [null, first], [first]],
  ['mixed members', [first, null, 12, {}, false, second], [first, second]],
  ['empty and whitespace strings', ['', '   ', '\t\n', first], [first]],
  ['nested array', [[first], second], [second]],
];

for (const [name, value, valid] of malformed) {
  for (const initial of [launch, null]) {
    test(`startup: ${name} saved paths recover ${initial ? 'with launch file' : 'without launch file'}`, async () => {
      const h = startup({ openTabs: value, initial });
      await h.boot();
      const expected = [...valid, ...(initial ? [initial] : [])];
      assert.deepEqual(Array.from(h.tabs, tab => tab.path), expected);
      const readPaths = h.calls.filter(c => c.command === 'read_text_file').map(c => c.path);
      assert.deepEqual(readPaths, expected);
      assert.deepEqual(JSON.parse(h.storage.get('svgv.customPreference')), { retain: 42 });
      if (initial) assert.equal(h.state.path, launch);
      else if (!valid.length) {
        assert.equal(h.state.text, '');
        assert.equal(h.element('#empty').classList.contains('gone'), false);
      }
    });
  }
}

test('startup: invalid JSON falls back to an empty saved list and still opens the launch file', async () => {
  const h = startup({ rawSaved: { openTabs: '{not JSON' } });
  await h.boot();
  assert.deepEqual(Array.from(h.tabs, tab => tab.path), [launch]);
});

test('startup: valid restore order is preserved, launch-path overlap is compared case-insensitively', async () => {
  const h = startup({ openTabs: [first, launch.toLowerCase(), second] });
  await h.boot();
  assert.deepEqual(Array.from(h.tabs, tab => tab.path), [first, second, launch]);
  assert.deepEqual(h.calls.filter(c => c.command === 'read_text_file').map(c => c.path), [first, second, launch]);
  assert.equal(h.state.path, launch);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.session')), { main: [first, second, launch] });
  assert.equal(h.nativeWindow.closeCalls, 0);
});

test('startup: missing saved and launch files do not prevent remaining restores or the empty viewer', async () => {
  const h = startup({ openTabs: [first, second], unreadable: [first, launch] });
  await h.boot();
  assert.deepEqual(Array.from(h.tabs, tab => tab.path), [second]);
  const empty = startup({ openTabs: [first], unreadable: [first, launch] });
  await empty.boot();
  assert.equal(empty.tabs.length, 0);
  assert.equal(empty.element('#empty').classList.contains('gone'), false);
  assert.equal(empty.nativeWindow.closeCalls, 0);
});

test('startup: secondary URL window opens only its requested file and never owns main saved paths', async () => {
  const h = startup({ openTabs: [first, second], label: 'doc-fixture', search: '?file=' + encodeURIComponent(launch) });
  await h.boot();
  assert.deepEqual(Array.from(h.tabs, tab => tab.path), [launch]);
  assert.equal(h.calls.some(c => c.command === 'initial_file'), false);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.openTabs')), [first, second]);
  h.call('closeTab', h.state.id);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.openTabs')), [first, second]);
  assert.equal(h.nativeWindow.destroyCalls, 1);
});

for (const manual of [true, false]) {
  test(`updater: offer → no update clears the old offer (${manual ? 'manual' : 'automatic'} check)`, async () => {
    const results = [{ version: '9.0.0' }, null];
    let checks = 0;
    const h = createHarness({ checkUpdate: async () => { checks++; return results.shift(); } });
    await h.call('checkForUpdate', { manual: true });
    assert.equal(h.element('#update').classList.contains('on'), true);
    assert.equal(h.run('pendingUpdate.version'), '9.0.0');
    h.run("store.set('updateCheckedAt', 0)");
    await h.call('checkForUpdate', { manual });
    assert.equal(checks, 2);
    assert.equal(h.run('pendingUpdate'), null);
    assert.equal(h.element('#update').classList.contains('on'), false);
    assert.equal(h.element('#cfg-update-hint').textContent, 'You are on the latest version');
    assert.equal(h.run('updateBusy'), false);
  });
}

test('startup: by default the last session is not reopened but Ctrl+Shift+T brings it back', async () => {
  const h = createHarness({
    saved: { session: { main: [first], 'doc-1': [second, first.toLowerCase()] } },
    invoke: async (command, args) => {
      if (command === 'initial_file') return null;
      if (command === 'read_text_file') return '<svg>' + args.path + '</svg>';
      if (command === 'file_mtime') return 1;
      throw new Error('Unexpected IPC: ' + command);
    },
  });
  await h.boot();
  assert.equal(h.tabs.length, 0);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.session')), {});
  assert.deepEqual(JSON.parse(h.storage.get('svgv.closed')), [[first, second]]);
  await h.call('reopenClosed');
  assert.deepEqual(Array.from(h.tabs, tab => tab.path), [first, second]);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.closed')), []);
  assert.deepEqual(JSON.parse(h.storage.get('svgv.session')), { main: [first, second] });
});

test('startup: restore setting reopens tabs from every window from the last run', async () => {
  const h = createHarness({
    saved: { cfg: { restoreTabs: true }, session: { main: [first], 'doc-1': [second] } },
    invoke: async (command, args) => {
      if (command === 'initial_file') return null;
      if (command === 'read_text_file') return '<svg>' + args.path + '</svg>';
      if (command === 'file_mtime') return 1;
      throw new Error('Unexpected IPC: ' + command);
    },
  });
  await h.boot();
  assert.deepEqual(Array.from(h.tabs, tab => tab.path), [first, second]);
  assert.equal(h.storage.has('svgv.closed'), false);
});
