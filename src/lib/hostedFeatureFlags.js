function enabled(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

export function hostedPlatformFlags(env = process.env) {
  return Object.freeze({
    hostedBuildsEnabled: enabled(env.HOSTED_BUILDS_ENABLED),
    jamHostingEnabled: enabled(env.JAM_HOSTING_ENABLED),
  });
}
