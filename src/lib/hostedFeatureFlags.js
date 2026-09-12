export function hostedPlatformEnabled(env = process.env) {
  return typeof env.HOSTED_BUILDS_ENABLED === 'string'
    && env.HOSTED_BUILDS_ENABLED.trim().toLowerCase() === 'true';
}
