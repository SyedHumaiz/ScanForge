export function normalizeTestCaseId(value) {
  if (typeof value !== "string") throw new Error("Test Case ID must be text.");
  return value.trim().replace(/\s*-\s*/g, "-").replace(/\s+/g, "-").toUpperCase();
}

export function validateTestCaseId(value, { optional = false } = {}) {
  const key = normalizeTestCaseId(value);
  if (!key) {
    if (optional) return "";
    throw new Error("Enter a Test Case ID, such as TC-001 or TC-LOGIN-01.");
  }
  if (key.length > 64 || !/^TC(?:-[A-Z0-9]+)+$/.test(key)) {
    throw new Error("Test Case ID must start with TC- and contain letters or numbers separated by hyphens (for example, TC-001 or TC-LOGIN-01; maximum 64 characters).");
  }
  return key;
}

export function resolveNewTestCaseId(value, generate = () => `TC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`) {
  return validateTestCaseId(value ?? "", { optional: true }) || generate();
}

export function testCaseWriteError(error) {
  if (error?.code === "23505") {
    return { message: "This Test Case ID already exists in this project. Choose a different ID.", status: 409 };
  }
  return { message: error?.message || "Unable to save test case.", status: 400 };
}
