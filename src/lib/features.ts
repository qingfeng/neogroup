export function isSocialPaymentEnabled(env: { SOCIAL_PAYMENTS_ENABLED?: string }): boolean {
  const value = env.SOCIAL_PAYMENTS_ENABLED?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'on' || value === 'enabled'
}
