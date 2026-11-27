import { test, expect } from '@playwright/test'

// Covers the signed-out email-code sign-in form, which is built on the
// TanStack form library: field validation on submit and the send-code request.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: 'null'
    })
  )
})

test('sign-in rejects a malformed email address without requesting a code', async ({
  page
}) => {
  let sendRequests = 0
  await page.route('**/api/auth/email-otp/send-verification-otp', (route) => {
    sendRequests += 1
    return route.fulfill({ status: 200, json: { success: true } })
  })
  await page.goto('/auth/email-otp')
  await page.waitForLoadState('networkidle')
  await page.locator('#email').fill('owner@')
  await page.getByRole('button', { name: 'Send code', exact: true }).click()
  await expect(
    page.getByText('Please enter a valid email address')
  ).toBeVisible()
  expect(sendRequests).toBe(0)
})

test('a valid email requests a sign-in code and shows the code step', async ({
  page
}) => {
  const bodies: unknown[] = []
  await page.route('**/api/auth/email-otp/send-verification-otp', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ status: 200, json: { success: true } })
  })
  await page.goto('/auth/email-otp')
  await page.waitForLoadState('networkidle')
  await page.locator('#email').fill('Owner@Paddock.test')
  await page.getByRole('button', { name: 'Send code', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Verify code', exact: true })
  ).toBeVisible()
  expect(bodies).toEqual([{ email: 'owner@paddock.test', type: 'sign-in' }])
})
