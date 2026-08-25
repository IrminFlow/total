import { timingSafeEqual } from "node:crypto";

const privilegedSecretNames = [
  "INTAKE_ADMIN_SECRET",
  "CRON_SECRET",
  "INTAKE_SECURITY_SECRET",
] as const;

const providerSecretNames = [
  "SUPPORT_PROVIDER_SECRET",
  "FEEDBACK_PROVIDER_SECRET",
  "COHORT_PROVIDER_SECRET",
] as const;

type PrivilegedSecretName = (typeof privilegedSecretNames)[number];

/** A configuration error must fail closed rather than collapse separate trust boundaries. */
export function serverSecretConfigurationError(): string | null {
  for (const name of privilegedSecretNames) {
    const value = process.env[name];
    if (value && value.length < 32) return `${name} must contain at least 32 characters`;
  }
  const configured = [...privilegedSecretNames, ...providerSecretNames].flatMap(
    (name) => {
      const value = process.env[name];
      return value ? [[name, value] as const] : [];
    },
  );
  const values = new Map<string, string>();
  for (const [name, value] of configured) {
    const previous = values.get(value);
    if (previous) return `${name} must not equal ${previous}`;
    values.set(value, name);
  }
  return null;
}

/** Compare a privileged credential only when every configured boundary is sound. */
export function privilegedSecretMatches(
  name: PrivilegedSecretName,
  supplied: string,
): boolean {
  if (serverSecretConfigurationError()) return false;
  const expected = process.env[name];
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export function bearerFrom(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

export function providerAuthorization(secret: string | undefined): Record<string, string> {
  if (serverSecretConfigurationError()) return {};
  return secret ? { authorization: `Bearer ${secret}` } : {};
}
