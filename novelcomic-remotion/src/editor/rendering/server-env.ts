export function requireServerEnv() {
  const region = process.env.REMOTION_AWS_REGION
  if (!region) throw new Error('REMOTION_AWS_REGION is not set')
  return {
    REMOTION_AWS_REGION: region,
  }
}
