// Paddock trusts every allowed account as an administrator, so access is the
// allowlist itself. Removing an address revokes access on the next request.
export function isAllowedEmail(
  email: string,
  allowedEmails: readonly string[],
) {
  return allowedEmails.includes(email.trim().toLowerCase());
}

export function isVerifiedAllowedUser(
  user: { email: string; emailVerified: boolean } | null | undefined,
  allowedEmails: readonly string[],
) {
  return !!user?.emailVerified && isAllowedEmail(user.email, allowedEmails);
}
