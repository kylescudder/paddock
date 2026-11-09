import { expect, test } from 'bun:test'
import { adminHome, safeAppPath } from '../src/lib/auth/safe-path.ts'

test('sign-in redirects stay on this site', () => {
  expect(adminHome).toBe('/admin')
  expect(safeAppPath('/profile')).toBe('/profile')
  expect(safeAppPath('/admin?studio=2026-monaco')).toBe(
    '/admin?studio=2026-monaco'
  )
  for (const target of [
    'https://attacker.example/',
    '//attacker.example/',
    '/.//attacker.example/',
    '/./../attacker.example/..//attacker.example/',
    '/%2e//attacker.example/',
    '/\t/attacker.example/',
    '/\n/attacker.example/',
    '/\\attacker.example/',
    'javascript:alert(1)',
    ''
  ])
    expect(safeAppPath(target)).toBe(adminHome)
})
