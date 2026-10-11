import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { FakeRepo } from './support'
import { BAND, endTurn, fakeEngine, recorder, startSession } from './support'

// A Python repo. format_money in billing/money.py is used by stripe_sync.py,
// csv_export.py (through the module) and mrr.py (renamed on import);
// churn.py only mentions it in a comment.
const ROOT = '/py'
const MONEY = 'def format_money(cents: int) -> str:\n    return f"${cents / 100:,.2f}"\n\n\ndef sum_cents(values):\n    return sum(values)\n'
const CONTENTS: Record<string, string> = {
  'billing/money.py': MONEY,
  'billing/stripe_sync.py': 'from billing.money import format_money\n\n\ndef unit_amount(cents):\n    label = format_money(cents)\n    return float(label.replace("$", ""))\n',
  'exports/csv_export.py': 'import billing.money as money\n\n\ndef row(invoice_id, cents):\n    return ",".join([invoice_id, money.format_money(cents)])\n',
  'reports/mrr.py': 'from billing.money import format_money as fmt\n\n\ndef mrr(total):\n    return "MRR " + fmt(total)\n',
  'reports/churn.py': '# TODO: use format_money here once finance agrees on rounding\nfrom billing.money import sum_cents\n',
  'tests/test_money.py': 'from billing.money import format_money\n\n\ndef test_format():\n    assert format_money(123400) == "$1,234.00"\n',
}
const DIFF = '@@ -2 +2 @@ def format_money(cents: int) -> str:\n-    return f"${cents / 100:.2f}"\n+    return f"${cents / 100:,.2f}"'
// What Pyright answered for format_money in a real session.
const PYRIGHT = [
  'Found 6 references across 5 files:',
  '',
  'billing/money.py:',
  '  Line 1:5',
  '',
  'billing/stripe_sync.py:',
  '  Line 1:27',
  '  Line 5:13',
  '',
  'exports/csv_export.py:',
  '  Line 5:40',
  '',
  'reports/mrr.py:',
  '  Line 1:27',
  '',
  'tests/test_money.py:',
  '  Line 1:27',
].join('\n')
const GREP = Object.entries(CONTENTS)
  .flatMap(([path, text]) => text.split('\n').map((line, i) => ({ path, n: i + 1, line })))
  .filter(({ line }) => /\bformat_money\b/.test(line))
  .map(({ path, n, line }) => `${path}:${n}:${line}`)
  .join('\n')

const repo = (lsp?: FakeRepo['lsp']): FakeRepo => ({
  root: ROOT,
  files: Object.keys(CONTENTS),
  contents: CONTENTS,
  lsp,
  git: args => (args.startsWith('diff') && args.endsWith('billing/money.py') ? DIFF : args.startsWith('grep') ? GREP : null),
})

async function editMoney($: Engine) {
  await startSession($, ROOT)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/billing/money.py`, old_string: '.2f', new_string: ',.2f' })
  await endTurn($)
}

test('with a language server: the exact users of the changed function, code before tests', async ($, on) => {
  const rec = recorder()
  fakeEngine(on, repo(() => PYRIGHT), rec)
  await editMoney($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /4 files use format_money, which Claude changed/ })).toBeDefined()
  // A line that calls it beats the import line.
  expect(await ui.find({ text: /billing\/stripe_sync\.py:5/ })).toBeDefined()
  expect(await ui.find({ text: /churn\.py/ })).toBeUndefined()
  await ui.press({ key: 'ask' })
  expect(rec.submitted[0]).toContain('exports/csv_export.py:5 uses format_money: `return ",".join([invoice_id, money.format_money(cents)])`')
  expect(rec.submitted[0]).toContain('reports/mrr.py:1 uses format_money')
  expect(rec.submitted[0]?.indexOf('reports/mrr.py')).toBeLessThan(rec.submitted[0]?.indexOf('tests/test_money.py') ?? -1)
})

test('a cold language server is asked again', async ($, on) => {
  let asked = 0
  fakeEngine(on, repo(() => (++asked === 1 ? 'Found 1 reference:\n  billing/money.py:1:5' : PYRIGHT)))
  await editMoney($)
  expect(asked).toBe(2)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /4 files use format_money/ })).toBeDefined()
})

test('with no language server: a search for the name, comments left out', async ($, on) => {
  fakeEngine(on, repo())
  await editMoney($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /4 files use format_money/ })).toBeDefined()
  expect(await ui.find({ text: /churn\.py/ })).toBeUndefined()
})

test('a private helper stands for the functions that call it', async ($, on) => {
  const helper = 'def _cents(v):\n    return round(v)\n\n\ndef format_money(cents):\n    return str(_cents(cents))\n'
  fakeEngine(on, {
    ...repo(),
    contents: { ...CONTENTS, 'billing/money.py': helper },
    git: args =>
      args.startsWith('diff') ? '@@ -2 +2 @@ def _cents(v):\n-    return int(v)\n+    return round(v)' : args.includes('_cents') ? 'billing/money.py:1:def _cents(v):\nbilling/money.py:6:    return str(_cents(cents))' : args.startsWith('grep') ? GREP : null,
  })
  await editMoney($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /use format_money, which Claude changed/ })).toBeDefined()
})

test('with no language server, a function of the same name elsewhere: only the files that import this one', async ($, on) => {
  // legacy/format.py declares its own format_money, and legacy/report.py uses that one.
  const contents: Record<string, string> = {
    ...CONTENTS,
    'legacy/format.py': 'def format_money(amount):\n    return str(amount)\n',
    'legacy/report.py': 'from legacy.format import format_money\n\n\ndef total(x):\n    return format_money(x)\n',
  }
  const lines = Object.entries(contents).flatMap(([path, text]) => text.split('\n').map((line, i) => ({ path, n: i + 1, line })))
  const grep = lines.filter(({ line }) => /\bformat_money\b/.test(line)).map(({ path, n, line }) => `${path}:${n}:${line}`)
  const naming = [...new Set(lines.filter(({ line }) => /\b(money|billing)\b/.test(line)).map(({ path }) => path))]
  fakeEngine(on, {
    ...repo(),
    files: Object.keys(contents),
    contents,
    git: args => (args.startsWith('diff') && args.endsWith('billing/money.py') ? DIFF : args.startsWith('grep -l') ? naming.join('\n') : args.startsWith('grep') ? grep.join('\n') : null),
  })
  await editMoney($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /4 files use format_money/ })).toBeDefined()
  expect(await ui.find({ text: /legacy\// })).toBeUndefined()
})

// format_money renamed to format_amount: its callers still use the old name.
const RENAMED = MONEY.replace('def format_money', 'def format_amount')
const RENAME = '@@ -1 +1 @@\n-def format_money(cents: int) -> str:\n+def format_amount(cents: int) -> str:'
const renamed = (lsp?: FakeRepo['lsp']): FakeRepo => {
  const contents = { ...CONTENTS, 'billing/money.py': RENAMED }
  const lines = Object.entries(contents).flatMap(([path, text]) => text.split('\n').map((line, i) => ({ path, n: i + 1, line })))
  const grep = (name: string) => lines.filter(({ line }) => new RegExp(`\\b${name}\\b`).test(line)).map(({ path, n, line }) => `${path}:${n}:${line}`)
  return { ...repo(lsp), contents, git: args => (args.startsWith('diff') ? RENAME : args.startsWith('grep') ? grep(args.split(' ').at(-1) ?? '').join('\n') : null) }
}

test('a renamed function: its callers, found by its old name', async ($, on) => {
  fakeEngine(on, renamed())
  await editMoney($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /files use format_money, which Claude changed/ })).toBeDefined()
  expect(await ui.find({ text: /billing\/stripe_sync\.py:5/ })).toBeDefined()
})

test('a renamed function, with a language server that knows only the new name', async ($, on) => {
  fakeEngine(on, renamed(() => 'Found 1 reference:\n  billing/money.py:1:5'))
  await editMoney($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /files use format_money, which Claude changed/ })).toBeDefined()
})

test('a language server that knows only the declarations is waited for once a scan', async ($, on) => {
  const rec = recorder()
  fakeEngine(
    on,
    {
      ...repo((_, line) => `Found 1 reference:\n  billing/money.py:${line}:5`),
      git: args => (args.startsWith('diff') ? '@@ -2 +2 @@\n-a\n+b\n@@ -6 +6 @@\n-c\n+d' : null),
    },
    rec,
  )
  await editMoney($)
  expect(rec.slept).toEqual([2500])
})

test('a scan stops looking when its time is up', async ($, on) => {
  const rec = recorder()
  let clock = 0
  fakeEngine(
    on,
    {
      ...repo(),
      // Each look at the clock is 15 seconds on: time for one function of the two.
      now: () => (clock += 15_000),
      git: args => (args.startsWith('diff') ? '@@ -2 +2 @@\n-a\n+b\n@@ -6 +6 @@\n-c\n+d' : args.startsWith('grep') ? GREP : null),
    },
    rec,
  )
  await editMoney($)
  expect(rec.git.filter(args => args.includes('grep')).length).toBe(1)
})

test('a language server that never answers is given up on once, and the name search finds the users', async ($, on) => {
  const rec = recorder()
  fakeEngine(on, { ...repo(), lspHangs: true, git: args => (args.startsWith('diff') ? '@@ -2 +2 @@\n-a\n+b\n@@ -6 +6 @@\n-c\n+d' : args.startsWith('grep') ? GREP : null) }, rec)
  await editMoney($)
  // format_money timed out; sum_cents didn't wait on it again.
  expect(rec.lsp).toEqual(['billing/money.py:1'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /4 files use format_money/ })).toBeDefined()
})
