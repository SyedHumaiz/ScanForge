import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const LOGIN_CONFIG_TTL_MS = 30 * 60 * 1000;
const fields = {
  E2E_EMAIL: "validUsername", E2E_LOGIN_USER: "validUsername",
  E2E_PASSWORD: "validPassword", E2E_LOGIN_PASSWORD: "validPassword",
  E2E_UNREGISTERED_USER: "invalidUsername", E2E_INVALID_USER: "invalidUsername",
  E2E_INVALID_PASSWORD: "invalidPassword",
};
const labels = { validUsername: "Valid username/email", validPassword: "Valid password", invalidUsername: "Invalid username/email", invalidPassword: "Invalid password" };

export function requiredLoginFields(cases) {
  const references = new Set((cases || []).filter(testCase => testCase.automation_type === "playwright").flatMap(testCase => (Array.isArray(testCase.steps) ? testCase.steps : [])
    .filter(step => step?.action === "fill")
    .map(step => /^\{\{env:(E2E_[A-Z0-9_]+)\}\}$/.exec(step.value || "")?.[1])
    .filter(Boolean)));
  return { fields: [...new Set([...references].map(name => fields[name]).filter(Boolean))], unmapped: [...references].filter(name => !fields[name]) };
}

export function validateLoginConfig(cases, config) {
  const required = requiredLoginFields(cases);
  if (required.unmapped.length) throw new Error(`No login configuration field maps ${required.unmapped.join(", ")}. Update these cases to use supported login references.`);
  for (const field of required.fields) {
    if (typeof config?.[field] !== "string" || !config[field].trim()) throw new Error(`${labels[field]} is required by this cycle.`);
    if (config[field].length > 1024) throw new Error(`${labels[field]} must be 1024 characters or fewer.`);
  }
  return Object.fromEntries(required.fields.map(key => [key, config[key]]));
}

export function loginSecretValues(config) {
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => config?.[field]).map(([name, field]) => [name, config[field]]));
}

function encryptionKey(key) {
  const bytes = Buffer.from(key || "", "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== key) throw new Error("RUN_CONFIG_ENCRYPTION_KEY must be a base64 encoded 32-byte key.");
  return bytes;
}

export function encryptLoginConfig(config, { runId, projectId, expiresAt }, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  cipher.setAAD(Buffer.from(`${runId}:${projectId}:${expiresAt}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ciphertext.toString("base64")}`;
}

export function decryptLoginConfig(payload, { runId, projectId, expiresAt }, key, now = Date.now()) {
  if (now >= Date.parse(expiresAt)) throw new Error("Run login configuration has expired.");
  const [ivPart, tagPart, dataPart, extra] = String(payload).split(".");
  if (extra !== undefined || !ivPart || !tagPart || !dataPart) throw new Error("Run login configuration is invalid.");
  const iv = Buffer.from(ivPart, "base64"), tag = Buffer.from(tagPart, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Run login configuration is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(key), iv);
  decipher.setAAD(Buffer.from(`${runId}:${projectId}:${expiresAt}`));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8"));
}
