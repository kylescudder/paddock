import { test, expect } from '@playwright/test'

test('signed-out visitors can open the owner sign-in page at desktop and phone widths', async ({
  page
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/auth/sign-in')
  await expect(
    page.getByRole('heading', { name: 'Welcome back.' })
  ).toBeVisible()
  await expect(
    page.getByText('Sign in with your approved account to manage Paddock.')
  ).toBeVisible()
  const form = page.locator('.paddock-auth')
  await expect(form.locator('input, button').first()).toBeVisible()
  await page.screenshot({
    path: '.local/sign-in/desktop.png',
    fullPage: true
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole('heading', { name: 'Welcome back.' })
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    )
    .toBe(true)
  await page.screenshot({
    path: '.local/sign-in/mobile.png',
    fullPage: true
  })
  expect(errors).toEqual([])
})
