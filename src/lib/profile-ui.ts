import { avatarRequest, prepareAvatar } from './profile'

// Optional first/last names are Better Auth additional fields; the verified
// email is shown read-only because it is the account's identity and access key.
const name = (field: 'givenName' | 'familyName', label: string) => ({
  name: field,
  type: 'string' as const,
  label,
  defaultValue: '',
  validateDebounceMs: 0,
  validate: (value: unknown) => {
    if (typeof value === 'string' && value.length > 100)
      throw new Error('Use up to 100 characters.')
  }
})

export const profileFields = [
  name('givenName', 'First name'),
  name('familyName', 'Last name'),
  {
    name: 'email',
    type: 'string' as const,
    label: 'Verified email',
    readOnly: true,
    copyable: true
  }
]

// Better Auth UI's avatar hooks, backed by Paddock's private photo endpoint.
// Upload returns the server-owned image URL, which update-user then confirms.
export const profileAvatar = {
  enabled: true,
  size: 512,
  extension: 'jpg' as const,
  resize: async (file: File) =>
    new File([await prepareAvatar(file)], 'avatar.jpg', { type: 'image/jpeg' }),
  upload: async (file: File) => {
    const { image } = await avatarRequest({
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: file
    })
    if (!image) throw new Error('The photo could not be uploaded.')
    return image
  },
  delete: async () => {
    await avatarRequest({ method: 'DELETE' })
  }
}
