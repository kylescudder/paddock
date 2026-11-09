// Client side of /api/profile/avatar. The browser crops and shrinks the photo
// before upload; the server still validates, resizes and re-encodes it.
export const avatarTypes = ['image/jpeg', 'image/png', 'image/webp']

export async function avatarRequest(init: RequestInit) {
  const response = await fetch('/api/profile/avatar', init)
  const body = (await response.json().catch(() => ({}))) as {
    image?: string | null
    error?: string
  }
  if (!response.ok)
    throw new Error(body.error || 'Unable to update your profile photo.')
  return body
}

export async function prepareAvatar(file: File, size = 512) {
  if (!avatarTypes.includes(file.type))
    throw new Error('Choose a JPEG, PNG or WebP photo.')
  if (file.size > 10 * 1024 * 1024)
    throw new Error('Choose a photo smaller than 10 MB.')
  const image = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Your browser could not prepare this photo.')
    // Centre square crop.
    const side = Math.min(image.width, image.height)
    context.drawImage(
      image,
      (image.width - side) / 2,
      (image.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size
    )
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error('This photo could not be prepared.')),
        'image/jpeg',
        0.85
      )
    )
  } finally {
    image.close()
  }
}
